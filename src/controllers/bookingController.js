const supabaseService = require('../services/supabaseService');
const emailService = require('../services/emailService');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { supabase, supabaseAdmin, getAuthenticatedClient } = require('../config/database');

class BookingController {
  // Create new booking
  createBooking = asyncHandler(async (req, res) => {
    const {
      salon_id,
      service_id,
      staff_id,
      appointment_date,
      start_time,
      client_notes,
      family_member_id,
      payment_intent_id
    } = req.body;

    // Validate required fields
    if (!salon_id || !service_id || !appointment_date || !start_time) {
      throw new AppError('Missing required booking information', 400, 'MISSING_BOOKING_INFO');
    }

    try {
      // Get service details (without join to avoid RLS issues)
      const { data: service, error: serviceError } = await supabase
        .from('services')
        .select('*')
        .eq('id', service_id)
        .single();

      if (serviceError || !service) {
        console.error(`❌ Service lookup error:`, serviceError);
        throw new AppError('Service not found', 404, 'SERVICE_NOT_FOUND');
      }

      // Verify service belongs to salon
      if (service.salon_id !== salon_id) {
        throw new AppError('Service does not belong to this salon', 404, 'SERVICE_NOT_FOUND');
      }

      // Get salon details separately (needed for email)
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('*')
        .eq('id', salon_id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Attach salon to service for email service
      service.salons = salon;

      // Calculate end time
      const startTime = new Date(`${appointment_date}T${start_time}`);
      const endTime = new Date(startTime.getTime() + service.duration * 60000);
      const endTimeStr = endTime.toTimeString().split(' ')[0].slice(0, 5);

      // Get authenticated Supabase client with user's token for RLS
      const authenticatedSupabase = getAuthenticatedClient(req.token);

      // Check for conflicts - proper overlap detection
      // Two time slots overlap if: start1 < end2 AND start2 < end1
      const { data: conflicts } = await authenticatedSupabase
        .from('bookings')
        .select('id')
        .eq('salon_id', salon_id)
        .eq('appointment_date', appointment_date)
        .neq('status', 'cancelled')
        .lt('start_time', endTimeStr)
        .gt('end_time', start_time);

      if (conflicts && conflicts.length > 0) {
        throw new AppError('Time slot not available', 409, 'TIME_SLOT_CONFLICT');
      }

      // Determine client ID (could be family member)
      let clientId = req.user.id;
      if (family_member_id) {
        const { data: familyMember } = await authenticatedSupabase
          .from('family_members')
          .select('id')
          .eq('id', family_member_id)
          .eq('parent_id', req.user.id)
          .single();

        if (!familyMember) {
          throw new AppError('Family member not found', 404, 'FAMILY_MEMBER_NOT_FOUND');
        }
      }

      // Create booking
      console.log('📅 Creating booking:', {
        client_id: clientId,
        salon_id,
        service_id,
        staff_id,
        appointment_date,
        start_time,
        end_time: endTimeStr,
      });

      const { data: booking, error: bookingError } = await authenticatedSupabase
        .from('bookings')
        .insert([{
          client_id: clientId,
          salon_id,
          service_id,
          staff_id,
          appointment_date,
          start_time,
          end_time: endTimeStr,
          client_notes,
          status: 'confirmed' // Auto-approve bookings
        }])
        .select(`
          *,
          services(*),
          salons(*),
          staff(*)
        `)
        .single();

      if (bookingError) {
        console.error('❌ Booking creation error:', bookingError);
        console.error('❌ Booking error details:', JSON.stringify(bookingError, null, 2));
        throw new AppError(`Failed to create booking: ${bookingError.message}`, 500, 'BOOKING_CREATION_FAILED');
      }

      console.log('✅ Booking created successfully:', booking?.id);

      // Increment salon booking count for analytics
      try {
        await supabaseAdmin.rpc('increment_salon_booking_count', {
          salon_id_param: salon_id
        });
      } catch (countError) {
        console.error('⚠️ Failed to increment booking count:', countError);
        // Don't fail the booking if count increment fails
      }

      // Create pending payment record linked to booking
      let paymentRecord = null;
      try {
        const paymentData = {
          booking_id: booking.id,
          amount: service.price,
          currency: service.currency || 'EUR',
          status: 'pending'
        };

        // Link payment intent if provided
        if (payment_intent_id) {
          paymentData.stripe_payment_intent_id = payment_intent_id;
        }

        // Payment records don't need RLS auth context - use admin or base client
        // Actually, payments might have RLS too, let's use authenticated client
        const { data: payment, error: paymentError } = await authenticatedSupabase
          .from('payments')
          .insert([paymentData])
          .select()
          .single();

        if (paymentError) {
          console.warn('⚠️ Could not create payment record (non-critical):', paymentError.message);
          // Don't fail booking creation if payment record fails
        } else {
          paymentRecord = payment;
        }
      } catch (paymentErr) {
        console.warn('⚠️ Payment record creation skipped:', paymentErr.message);
      }

      // If payment intent was provided but payment record creation failed, try to link via webhook later
      // The webhook handler will catch payment_intent.succeeded and link it to the booking

      // Send confirmation email
      const { data: client } = await authenticatedSupabase
        .from('user_profiles')
        .select('*')
        .eq('id', clientId)
        .single();

      emailService.sendBookingConfirmation(
        { ...booking, service_name: service.name, total_amount: service.price },
        client,
        service.salons
      );

      res.status(201).json({
        success: true,
        data: { booking }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to create booking', 500, 'BOOKING_CREATION_FAILED');
    }
  });

  // Get user's bookings
  getMyBookings = asyncHandler(async (req, res) => {
    const { status, upcoming, page = 1, limit = 100 } = req.query; // Increased limit to 100
    const offset = (page - 1) * limit;

    try {
      // Get authenticated Supabase client with user's token for RLS
      const authenticatedSupabase = getAuthenticatedClient(req.token);

      let query = authenticatedSupabase
        .from('bookings')
        .select(`
          *,
          services(*),
          salons(*),
          staff(*),
          payments(*)
        `)
        .eq('client_id', req.user.id)
        // Don't exclude cancelled by default - let the UI decide
        .order('appointment_date', { ascending: false })
        .order('start_time', { ascending: false });

      if (status) {
        query = query.eq('status', status);
      }

      // Don't apply pagination yet - we need to filter by date first
      const { data: allBookings, error } = await query;

      console.log(`📋 getMyBookings - Querying for user ID: ${req.user.id}`);
      console.log(`📋 getMyBookings - User email: ${req.user.email}`);
      console.log(`📋 getMyBookings - Found ${allBookings?.length || 0} total bookings for user ${req.user.id}, upcoming=${upcoming}`);
      
      if (allBookings && allBookings.length > 0) {
        console.log(`📋 Sample booking client_id: ${allBookings[0].client_id}`);
      }

      if (error) {
        console.error('❌ Error fetching bookings:', error);
        throw new AppError('Failed to fetch bookings', 500, 'BOOKINGS_FETCH_FAILED');
      }

      // Filter by upcoming/past in JavaScript (more reliable than complex SQL)
      let filteredBookings = allBookings || [];
      if (upcoming !== undefined) {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const now = new Date();
        const currentDateTime = now;
        
        filteredBookings = filteredBookings.filter(booking => {
          const appointmentDate = booking.appointment_date;
          const [hours, minutes, seconds] = (booking.start_time || '00:00:00').split(':').map(Number);
          const appointmentDateTime = new Date(
            appointmentDate + 'T' + 
            `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
          );
          
          const isUpcoming = appointmentDateTime >= currentDateTime;
          return upcoming === 'true' || upcoming === true ? isUpcoming : !isUpcoming;
        });
      }

      // Apply pagination after filtering
      const paginatedBookings = filteredBookings.slice(offset, offset + limit);

      console.log(`📋 After filtering: ${filteredBookings.length} bookings, returning ${paginatedBookings.length} (page ${page})`);

      // Flatten the nested data for easier frontend consumption
      const flattenedBookings = paginatedBookings.map(booking => ({
        ...booking,
        salonName: booking.salons?.business_name || 'Unknown Salon',
        serviceName: booking.services?.name || 'Unknown Service',
        servicePrice: booking.services?.price || 0,
        serviceDuration: booking.services?.duration || 0,
        staffName: booking.staff?.name || 'Any Staff',
        paymentStatus: booking.payments?.[0]?.status || 'pending',
        paymentAmount: booking.payments?.[0]?.amount || 0,
      }));

      res.status(200).json({
        success: true,
        data: {
          bookings: flattenedBookings,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: filteredBookings.length,
            totalPages: Math.ceil(filteredBookings.length / limit)
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch bookings', 500, 'BOOKINGS_FETCH_FAILED');
    }
  });

  // Get salon's bookings (for salon owners)
  getSalonBookings = asyncHandler(async (req, res) => {
    const { status, date, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    try {
      // Get user's salon
      const { data: salon, error: salonError } = await supabaseAdmin
        .from('salons')
        .select('id')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      console.log(`📋 Fetching bookings for salon: ${salon.id}, status: ${status || 'all'}, date: ${date || 'all'}`);

      let query = supabaseAdmin
        .from('bookings')
        .select(`
          *,
          services(*),
          user_profiles!bookings_client_id_fkey(id, first_name, last_name, phone, avatar_url),
          staff(*),
          payments(*)
        `)
        .eq('salon_id', salon.id)
        .order('appointment_date', { ascending: true })
        .order('start_time', { ascending: true })
        .range(offset, offset + limit - 1);

      if (status) {
        query = query.eq('status', status);
      }

      if (date) {
        query = query.eq('appointment_date', date);
      }

      const { data: bookings, error } = await query;

      if (error) {
        console.error('❌ Failed to fetch salon bookings:', error);
        throw new AppError('Failed to fetch salon bookings', 500, 'SALON_BOOKINGS_FETCH_FAILED');
      }

      console.log(`✅ Found ${bookings?.length || 0} bookings for salon ${salon.id}`);

      res.status(200).json({
        success: true,
        data: {
          bookings,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit)
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch salon bookings', 500, 'SALON_BOOKINGS_FETCH_FAILED');
    }
  });

  // Reschedule booking (client can change date/time)
  rescheduleBooking = asyncHandler(async (req, res) => {
    const { bookingId } = req.params;
    const { appointment_date, start_time } = req.body;

    if (!appointment_date || !start_time) {
      throw new AppError('Missing required fields: appointment_date, start_time', 400, 'MISSING_FIELDS');
    }

    try {
      console.log('📋 Reschedule booking - bookingId:', bookingId, 'newDate:', appointment_date, 'newTime:', start_time);
      
      // Get booking - use supabaseAdmin to bypass RLS
      const { data: booking, error: bookingError } = await supabaseAdmin
        .from('bookings')
        .select(`
          *,
          salons(owner_id),
          services(*)
        `)
        .eq('id', bookingId)
        .single();

      console.log('📋 Booking lookup result:', booking ? 'found' : 'not found', bookingError ? `error: ${bookingError.message}` : '');

      if (bookingError || !booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Only client can reschedule their own booking
      if (booking.client_id !== req.user.id) {
        throw new AppError('Only the client can reschedule this booking', 403, 'INSUFFICIENT_PERMISSIONS');
      }

      // Can only reschedule pending or confirmed bookings
      if (!['pending', 'confirmed'].includes(booking.status)) {
        throw new AppError('Can only reschedule pending or confirmed bookings', 400, 'INVALID_STATUS');
      }

      // Calculate new end time
      const startTime = new Date(`${appointment_date}T${start_time}`);
      const endTime = new Date(startTime.getTime() + booking.services.duration * 60000);
      const endTimeStr = endTime.toTimeString().split(' ')[0].slice(0, 5);

      console.log('📋 Checking for conflicts - salon:', booking.salon_id, 'date:', appointment_date, 'time:', start_time, '-', endTimeStr);

      // Check for conflicts at new time - use supabaseAdmin
      const { data: conflicts } = await supabaseAdmin
        .from('bookings')
        .select('id')
        .eq('salon_id', booking.salon_id)
        .eq('appointment_date', appointment_date)
        .neq('status', 'cancelled')
        .neq('id', bookingId) // Exclude current booking
        .or(`start_time.lte.${start_time},end_time.gte.${endTimeStr}`)
        .or(`start_time.lt.${endTimeStr},end_time.gt.${start_time}`);

      console.log('📋 Conflicts found:', conflicts ? conflicts.length : 0);

      if (conflicts && conflicts.length > 0) {
        throw new AppError('Time slot not available', 409, 'TIME_SLOT_CONFLICT');
      }

      console.log('📋 Updating booking with new date/time');

      // Update booking - use supabaseAdmin
      const { data: updatedBooking, error: updateError } = await supabaseAdmin
        .from('bookings')
        .update({
          appointment_date,
          start_time,
          end_time: endTimeStr,
          status: 'pending' // Reset to pending for salon to reconfirm
        })
        .eq('id', bookingId)
        .select(`
          *,
          services(*),
          salons(*),
          user_profiles!client_id(*)
        `)
        .single();

      console.log('📋 Update result:', updatedBooking ? 'success' : 'failed', updateError ? `error: ${updateError.message}` : '');

      if (updateError) {
        throw new AppError('Failed to reschedule booking', 500, 'RESCHEDULE_FAILED');
      }

      // Send notification email
      emailService.sendBookingRescheduleNotice(
        { ...updatedBooking, service_name: booking.services.name },
        updatedBooking.user_profiles,
        updatedBooking.salons,
        booking.appointment_date,
        booking.start_time
      );

      res.status(200).json({
        success: true,
        data: { booking: updatedBooking }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to reschedule booking', 500, 'RESCHEDULE_FAILED');
    }
  });

  // Update booking status
  updateBookingStatus = asyncHandler(async (req, res) => {
    const { bookingId } = req.params;
    const { status, staff_notes, cancellation_reason } = req.body;

    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
    if (!validStatuses.includes(status)) {
      throw new AppError('Invalid booking status', 400, 'INVALID_STATUS');
    }

    try {
      console.log('📋 Update booking status - bookingId:', bookingId, 'status:', status);
      
      // Check if user owns the salon or is the client
      // Use supabaseAdmin to bypass RLS and get booking details
      const { data: booking, error: bookingError } = await supabaseAdmin
        .from('bookings')
        .select(`
          *,
          salons(owner_id),
          services(*),
          user_profiles!client_id(*)
        `)
        .eq('id', bookingId)
        .single();

      console.log('📋 Booking lookup result:', booking ? 'found' : 'not found', bookingError ? `error: ${bookingError.message}` : '');

      if (bookingError || !booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Check permissions - owner, client, or staff at the salon
      const isOwner = booking.salons.owner_id === req.user.id;
      const isClient = booking.client_id === req.user.id;

      // Check if user is staff at this salon
      let isStaff = false;
      if (!isOwner && !isClient) {
        const { data: staffMember } = await supabaseAdmin
          .from('staff')
          .select('id')
          .eq('salon_id', booking.salon_id)
          .eq('user_id', req.user.id)
          .single();
        isStaff = !!staffMember;
      }

      console.log('📋 Permissions check - isOwner:', isOwner, 'isClient:', isClient, 'isStaff:', isStaff);

      if (!isOwner && !isClient && !isStaff) {
        throw new AppError('Insufficient permissions', 403, 'INSUFFICIENT_PERMISSIONS');
      }

      // Clients can only cancel their own bookings
      if (isClient && !isOwner && !isStaff && status !== 'cancelled') {
        throw new AppError('Clients can only cancel bookings', 403, 'CLIENT_CAN_ONLY_CANCEL');
      }

      // Staff and owners can update status and add notes
      const updateData = { status };
      if (staff_notes && (isOwner || isStaff)) {
        updateData.salon_notes = staff_notes;
      }
      
      // Store cancellation reason if provided (for both clients and salon owners)
      if (status === 'cancelled' && cancellation_reason) {
        updateData.cancellation_reason = cancellation_reason;
      }

      console.log('📋 Updating booking with data:', updateData);

      const { data: updatedBooking, error: updateError } = await supabaseAdmin
        .from('bookings')
        .update(updateData)
        .eq('id', bookingId)
        .select(`
          *,
          services(*),
          salons(*),
          user_profiles!client_id(*)
        `)
        .single();

      console.log('📋 Update result:', updatedBooking ? 'success' : 'failed', updateError ? `error: ${updateError.message}` : '');

      if (updateError) {
        throw new AppError('Failed to update booking', 500, 'BOOKING_UPDATE_FAILED');
      }

      // Send notification email if cancelled
      if (status === 'cancelled') {
        emailService.sendCancellationNotice(
          { ...updatedBooking, service_name: booking.services.name },
          booking.user_profiles,
          booking.salons,
          staff_notes || 'Booking cancelled'
        );

        // Process waitlist for cancelled booking
        const waitlistController = require('./waitlistController');
        await waitlistController.processWaitlistForCancelledBooking(
          booking.salon_id,
          booking.service_id,
          booking.appointment_date,
          booking.start_time
        );
      }

      res.status(200).json({
        success: true,
        data: { booking: updatedBooking }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to update booking', 500, 'BOOKING_UPDATE_FAILED');
    }
  });

  // Get available time slots
  getAvailableSlots = asyncHandler(async (req, res) => {
    const { salon_id, service_id, date, staff_id } = req.query;

    if (!salon_id || !service_id || !date) {
      throw new AppError('Missing required parameters', 400, 'MISSING_PARAMETERS');
    }

    try {
      // Use authenticated client for RLS compliance
      const authenticatedSupabase = getAuthenticatedClient(req.token);

      // Get service duration
      const { data: service, error: serviceError } = await authenticatedSupabase
        .from('services')
        .select('duration')
        .eq('id', service_id)
        .single();

      if (serviceError || !service) {
        throw new AppError('Service not found', 404, 'SERVICE_NOT_FOUND');
      }

      // Get salon business hours
      const { data: salon, error: salonError } = await authenticatedSupabase
        .from('salons')
        .select('business_hours')
        .eq('id', salon_id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Get existing bookings for the date with timeout protection
      let bookingsQuery = authenticatedSupabase
        .from('bookings')
        .select('start_time, end_time')
        .eq('salon_id', salon_id)
        .eq('appointment_date', date)
        .neq('status', 'cancelled')
        .limit(1000); // Limit to prevent timeout

      if (staff_id) {
        bookingsQuery = bookingsQuery.eq('staff_id', staff_id);
      }

      const { data: existingBookings, error: bookingsError } = await bookingsQuery;
      
      let bookings = existingBookings || [];
      if (bookingsError) {
        console.error('❌ Error fetching bookings for available slots:', bookingsError);
        // Continue with empty bookings array if query fails
        bookings = [];
      }

      // Calculate available slots
      // Get day name (monday, tuesday, etc.) from date string
      // Parse date as local date (not UTC) to avoid timezone issues
      const [year, month, day] = date.split('-').map(Number);
      const dateObj = new Date(year, month - 1, day); // Month is 0-indexed in Date
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const dayOfWeek = days[dateObj.getDay()];
      const businessHours = salon.business_hours?.[dayOfWeek];

      if (!businessHours || businessHours.closed === true || businessHours.closed === 'true') {
        return res.status(200).json({
          success: true,
          data: { available_slots: [] }
        });
      }

      // Handle both formats: {open: "09:00", close: "18:00"} or "09:00-18:00"
      let openTime, closeTime;
      if (typeof businessHours === 'string') {
        [openTime, closeTime] = businessHours.split('-');
      } else {
        openTime = businessHours.open || businessHours.opening;
        closeTime = businessHours.close || businessHours.closing;
      }

      if (!openTime || !closeTime) {
        return res.status(200).json({
          success: true,
          data: { available_slots: [] }
        });
      }

      const slots = this._calculateAvailableSlots(
        openTime,
        closeTime,
        service.duration,
        bookings,
        date // Pass date to allow current time booking for today
      );

      console.log(`📅 Calculated ${slots.length} available slots for ${date} (${dayOfWeek}), service duration: ${service.duration} mins, business hours: ${openTime}-${closeTime}`);
      if (slots.length > 0) {
        console.log(`📅 First slot: ${slots[0].start_time}, Last slot: ${slots[slots.length - 1].start_time}`);
      } else {
        const now = new Date();
        const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        console.log(`📅 No slots available for ${date} (${dayOfWeek}) with business hours ${openTime}-${closeTime}, service duration: ${service.duration} mins`);
        console.log(`📅 Current time: ${currentTimeStr}, Closing time: ${closeTime}`);
        if (currentTimeStr > closeTime) {
          console.log(`📅 ⚠️ It's past closing time - that's why no slots are available`);
        }
      }

      res.status(200).json({
        success: true,
        data: { available_slots: slots }
      });

    } catch (error) {
      console.error('❌ Error in getAvailableSlots:', error);
      console.error('❌ Error stack:', error.stack);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(`Failed to get available slots: ${error.message}`, 500, 'AVAILABLE_SLOTS_FETCH_FAILED');
    }
  });

  // Helper method to calculate available slots
  _calculateAvailableSlots(openTime, closeTime, serviceDuration, existingBookings, appointmentDate = null) {
    try {
      const slots = [];
      const slotInterval = 15; // 15-minute intervals for more flexibility
      
      // Define slotInterval before it's used in the today booking adjustment

      const [openHour, openMinute] = openTime.split(':').map(Number);
      const [closeHour, closeMinute] = closeTime.split(':').map(Number);

      if (isNaN(openHour) || isNaN(openMinute) || isNaN(closeHour) || isNaN(closeMinute)) {
        console.error(`❌ Invalid time format - openTime: ${openTime}, closeTime: ${closeTime}`);
        return [];
      }

      let currentTime = openHour * 60 + openMinute; // Convert to minutes
      const endTime = closeHour * 60 + closeMinute;

      // Get current time if booking for today - allow booking at current time
      if (appointmentDate) {
        // Get today's date in YYYY-MM-DD format (using local timezone)
        // Use UTC methods but interpret as local time for date comparison
        const now = new Date();
        // Get local date components (UTC methods return local time when date is constructed locally)
        const localYear = now.getFullYear();
        const localMonth = now.getMonth() + 1;
        const localDay = now.getDate();
        const today = `${localYear}-${String(localMonth).padStart(2, '0')}-${String(localDay).padStart(2, '0')}`;
        
        // Normalize appointmentDate to YYYY-MM-DD format (handle both date strings and Date objects)
        let appointmentDateStr = appointmentDate;
        if (appointmentDate instanceof Date) {
          appointmentDateStr = `${appointmentDate.getFullYear()}-${String(appointmentDate.getMonth() + 1).padStart(2, '0')}-${String(appointmentDate.getDate()).padStart(2, '0')}`;
        } else if (typeof appointmentDate === 'string') {
          // Ensure format is YYYY-MM-DD (remove time if present)
          appointmentDateStr = appointmentDate.split('T')[0].split(' ')[0];
        }
        
        console.log(`📅 Checking if today - appointmentDateStr: "${appointmentDateStr}", today: "${today}"`);
        if (appointmentDateStr === today) {
          // Use local time for current time calculation
          const localHours = now.getHours();
          const localMinutes = now.getMinutes();
          const currentMinutes = localHours * 60 + localMinutes;
          // Allow booking at current time or very soon (5 minute buffer for processing)
          const minBookingTime = currentMinutes - 5;
          console.log(`📅 TODAY BOOKING DETECTED - Local time: ${localHours}:${String(localMinutes).padStart(2, '0')} (${currentMinutes} min = ${this._minutesToTimeString(currentMinutes)}), minBookingTime: ${minBookingTime} (${this._minutesToTimeString(minBookingTime)}), opening: ${this._minutesToTimeString(currentTime)}, closing: ${this._minutesToTimeString(endTime)}`);
          // Round minBookingTime up to next 15-minute interval to ensure we start from a valid slot time
          const roundedMinBookingTime = Math.ceil(minBookingTime / slotInterval) * slotInterval;
          // Start from minimum of (opening time, rounded current time with buffer)
          // But ensure we don't go past closing time
          const oldCurrentTime = currentTime;
          currentTime = Math.max(currentTime, roundedMinBookingTime);
          console.log(`📅 Adjusted currentTime from ${this._minutesToTimeString(oldCurrentTime)} to ${this._minutesToTimeString(currentTime)} (rounded from ${this._minutesToTimeString(minBookingTime)})`);
          // If minBookingTime is past closing time, no slots available
          if (currentTime >= endTime) {
            console.log(`📅 No slots available - currentTime (${this._minutesToTimeString(currentTime)}) >= endTime (${this._minutesToTimeString(endTime)}) - IT'S PAST CLOSING TIME`);
            return [];
          }
        } else {
          console.log(`📅 Not today - will calculate all slots from opening to closing`);
        }
      }

      while (currentTime + serviceDuration <= endTime) {
        const timeStr = this._minutesToTimeString(currentTime);
        const endTimeStr = this._minutesToTimeString(currentTime + serviceDuration);

        // Check if slot conflicts with existing bookings
        const hasConflict = existingBookings.some(booking => {
          const bookingStart = this._timeStringToMinutes(booking.start_time);
          const bookingEnd = this._timeStringToMinutes(booking.end_time);

          return (currentTime < bookingEnd && currentTime + serviceDuration > bookingStart);
        });

        if (!hasConflict) {
          slots.push({
            start_time: timeStr,
            end_time: endTimeStr
          });
        }

        currentTime += slotInterval;
      }

      return slots;
    } catch (error) {
      console.error('❌ Error in _calculateAvailableSlots:', error);
      console.error('❌ Parameters - openTime:', openTime, 'closeTime:', closeTime, 'serviceDuration:', serviceDuration);
      throw error;
    }
  }

  _minutesToTimeString(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  }

  _timeStringToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  }

  // Get available slots count for multiple dates (for calendar heat map)
  getAvailableSlotsCount = asyncHandler(async (req, res) => {
    const { salon_id, service_id, start_date, end_date, staff_id } = req.query;

    if (!salon_id || !service_id || !start_date || !end_date) {
      throw new AppError('Missing required parameters', 400, 'MISSING_PARAMETERS');
    }

    try {
      // Get service duration
      console.log(`📅 Looking up service: ${service_id} for salon: ${salon_id}`);
      const { data: service, error: serviceError } = await supabase
        .from('services')
        .select('duration, id, name, salon_id')
        .eq('id', service_id)
        .single();

      if (serviceError) {
        console.error(`❌ Service lookup error:`, serviceError);
        throw new AppError(`Service not found: ${serviceError.message}`, 404, 'SERVICE_NOT_FOUND');
      }
      
      if (!service) {
        console.error(`❌ Service not found: ${service_id}`);
        throw new AppError('Service not found', 404, 'SERVICE_NOT_FOUND');
      }
      
      // Verify service belongs to the salon
      if (service.salon_id !== salon_id) {
        console.error(`❌ Service ${service_id} does not belong to salon ${salon_id}. Service belongs to: ${service.salon_id}`);
        throw new AppError('Service does not belong to this salon', 404, 'SERVICE_NOT_FOUND');
      }
      
      console.log(`✅ Found service: ${service.name} (duration: ${service.duration} mins)`);

      // Get salon business hours
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('business_hours')
        .eq('id', salon_id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Get all bookings in date range
      let bookingsQuery = supabase
        .from('bookings')
        .select('appointment_date, start_time, end_time')
        .eq('salon_id', salon_id)
        .gte('appointment_date', start_date)
        .lte('appointment_date', end_date)
        .neq('status', 'cancelled');

      if (staff_id) {
        bookingsQuery = bookingsQuery.eq('staff_id', staff_id);
      }

      const { data: allBookings } = await bookingsQuery;
      
      // Group bookings by date
      const bookingsByDate = {};
      if (allBookings) {
        allBookings.forEach(booking => {
          if (!bookingsByDate[booking.appointment_date]) {
            bookingsByDate[booking.appointment_date] = [];
          }
          bookingsByDate[booking.appointment_date].push({
            start_time: booking.start_time,
            end_time: booking.end_time
          });
        });
      }

      // Calculate slots count for each date
      const slotsCountByDate = {};
      const start = new Date(start_date);
      const end = new Date(end_date);
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const dayOfWeek = days[d.getDay()];
        const businessHours = salon.business_hours?.[dayOfWeek];

        if (!businessHours || businessHours.closed === true || businessHours.closed === 'true') {
          slotsCountByDate[dateStr] = 0;
          continue;
        }

        // Handle both formats
        let openTime, closeTime;
        if (typeof businessHours === 'string') {
          [openTime, closeTime] = businessHours.split('-');
        } else {
          openTime = businessHours.open || businessHours.opening;
          closeTime = businessHours.close || businessHours.closing;
        }

        if (!openTime || !closeTime) {
          slotsCountByDate[dateStr] = 0;
          continue;
        }

        const existingBookings = bookingsByDate[dateStr] || [];
        const slots = this._calculateAvailableSlots(
          openTime,
          closeTime,
          service.duration,
          existingBookings
        );

        slotsCountByDate[dateStr] = slots.length;
      }

      res.status(200).json({
        success: true,
        data: { slots_count_by_date: slotsCountByDate }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to get available slots count', 500, 'SLOTS_COUNT_FETCH_FAILED');
    }
  });

  // Send booking reminders (admin/manual trigger - for testing)
  sendBookingReminders = asyncHandler(async (req, res) => {
    const bookingRemindersService = require('../services/bookingRemindersService');
    
    try {
      const { hoursAhead } = req.query;
      const hours = hoursAhead ? parseInt(hoursAhead) : 24;
      
      const result = await bookingRemindersService.sendRemindersForHoursAhead(hours);
      
      res.status(200).json({
        success: true,
        message: `Sent ${result.count} booking reminders`,
        data: result
      });
    } catch (error) {
      throw new AppError('Failed to send booking reminders', 500, 'REMINDERS_FAILED');
    }
  });

  // Get booking statistics for user (including favorites count)
  getBookingStats = asyncHandler(async (req, res) => {
    try {
      const userId = req.user.id;
      
      console.log('📊 Fetching booking stats for user:', userId);
      
      // First, let's verify the user exists and check what data we can see
      const { data: userCheck, error: userCheckError } = await supabaseAdmin
        .from('user_profiles')
        .select('id, email, user_type')
        .eq('id', userId)
        .single();
      
      console.log('📊 User check:', { userCheck, userCheckError });
      
      // First, let's check if there are ANY bookings for this user (no filters)
      const { data: allBookingsCheck, count: allBookingsCount, error: allBookingsError } = await supabaseAdmin
        .from('bookings')
        .select('id, client_id, status, appointment_date, created_at', { count: 'exact' })
        .eq('client_id', userId);
      
      console.log('📊 ALL bookings for user (no filters):', { 
        count: allBookingsCount, 
        sample: allBookingsCheck?.slice(0, 3),
        error: allBookingsError 
      });
      
      // Use supabaseAdmin to bypass RLS and ensure we can read the data
      // Get total bookings count - also try to get actual data to debug
      const { data: bookingsData, count: totalBookingsCount, error: totalError } = await supabaseAdmin
        .from('bookings')
        .select('id, client_id, status, appointment_date', { count: 'exact' })
        .eq('client_id', userId)
        .limit(5); // Get a few samples for debugging
      
      console.log('📊 Bookings query result:', { 
        count: totalBookingsCount, 
        sampleData: bookingsData,
        error: totalError 
      });

      if (totalError) {
        console.error('Error fetching total bookings:', totalError);
        throw new AppError('Failed to fetch booking statistics', 500, 'BOOKING_STATS_FAILED');
      }

      console.log('📊 Total bookings count:', totalBookingsCount);

      // Get upcoming bookings count
      const today = new Date().toISOString().split('T')[0];
      const { count: upcomingBookingsCount, error: upcomingError } = await supabaseAdmin
        .from('bookings')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', userId)
        .gte('appointment_date', today);

      if (upcomingError) {
        console.error('Error fetching upcoming bookings:', upcomingError);
        throw new AppError('Failed to fetch upcoming bookings', 500, 'UPCOMING_BOOKINGS_FAILED');
      }

      console.log('📊 Upcoming bookings count:', upcomingBookingsCount);

      // Get completed bookings count
      const { count: completedBookingsCount, error: completedError } = await supabaseAdmin
        .from('bookings')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', userId)
        .eq('status', 'completed');

      if (completedError) {
        console.error('Error fetching completed bookings:', completedError);
        throw new AppError('Failed to fetch completed bookings', 500, 'COMPLETED_BOOKINGS_FAILED');
      }

      console.log('📊 Completed bookings count:', completedBookingsCount);

      // Get favorites count - use supabaseAdmin to bypass RLS
      // Also get sample data for debugging
      // First check ALL favorites for this user
      const { data: allFavoritesCheck, count: allFavoritesCount, error: allFavoritesError } = await supabaseAdmin
        .from('user_favorites')
        .select('id, user_id, salon_id, created_at', { count: 'exact' })
        .eq('user_id', userId);
      
      console.log('📊 ALL favorites for user (no filters):', { 
        count: allFavoritesCount, 
        sample: allFavoritesCheck?.slice(0, 3),
        error: allFavoritesError 
      });
      
      const { data: favoritesData, count: favoritesCount, error: favoritesError } = await supabaseAdmin
        .from('user_favorites')
        .select('id, user_id, salon_id', { count: 'exact' })
        .eq('user_id', userId)
        .limit(5); // Get a few samples for debugging
      
      console.log('📊 Favorites query result:', { 
        count: favoritesCount, 
        sampleData: favoritesData,
        error: favoritesError 
      });

      if (favoritesError) {
        console.error('Error fetching favorites count:', favoritesError);
        // Don't fail the whole request if favorites count fails, but log it
      }

      console.log('📊 Favorites count:', favoritesCount);

      const stats = {
        total_bookings: totalBookingsCount ?? 0,
        upcoming_bookings: upcomingBookingsCount ?? 0,
        completed_bookings: completedBookingsCount ?? 0,
        favorite_salons: favoritesCount ?? 0,
      };

      console.log('📊 Final stats:', stats);
      console.log('📊 Sending response for user:', userId, 'Stats:', JSON.stringify(stats));

      res.status(200).json({
        success: true,
        data: stats
      });

    } catch (error) {
      console.error('❌ Error in getBookingStats:', error);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch booking statistics', 500, 'BOOKING_STATS_FAILED');
    }
  });

  // Salon owner cancel booking with reason
  cancelBookingAsSalonOwner = asyncHandler(async (req, res) => {
    const { bookingId } = req.params;
    const { cancellation_reason } = req.body;

    try {
      // Fetch booking with salon info
      const { data: booking, error: bookingError } = await supabase
        .from('bookings')
        .select(`
          *,
          salons(owner_id, name),
          services(name, price),
          user_profiles!client_id(email, first_name, last_name)
        `)
        .eq('id', bookingId)
        .single();

      if (bookingError || !booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Verify user is the salon owner
      if (booking.salons.owner_id !== req.user.id) {
        throw new AppError('Only salon owners can cancel bookings', 403, 'INSUFFICIENT_PERMISSIONS');
      }

      // Check if booking is already cancelled
      if (booking.status === 'cancelled') {
        throw new AppError('Booking is already cancelled', 400, 'BOOKING_ALREADY_CANCELLED');
      }

      // Update booking status to cancelled with reason
      const updateData = {
        status: 'cancelled',
        cancellation_reason: cancellation_reason || 'Cancelled by salon'
      };

      const { data: updatedBooking, error: updateError } = await supabase
        .from('bookings')
        .update(updateData)
        .eq('id', bookingId)
        .select(`
          *,
          services(name),
          salons(name),
          user_profiles!client_id(email, first_name, last_name)
        `)
        .single();

      if (updateError) {
        console.error('Error cancelling booking:', updateError);
        throw new AppError('Failed to cancel booking', 500, 'BOOKING_CANCEL_FAILED');
      }

      // Send cancellation email to client
      try {
        await emailService.sendCancellationNotice(
          { ...updatedBooking, service_name: booking.services.name },
          booking.user_profiles,
          booking.salons,
          cancellation_reason || 'Booking cancelled by salon'
        );
      } catch (emailError) {
        console.error('Failed to send cancellation email:', emailError);
        // Don't fail the request if email fails
      }

      // Process waitlist for cancelled booking
      try {
        const waitlistController = require('./waitlistController');
        await waitlistController.processWaitlistForCancelledBooking(
          booking.salon_id,
          booking.service_id,
          booking.appointment_date,
          booking.start_time
        );
      } catch (waitlistError) {
        console.error('Failed to process waitlist:', waitlistError);
        // Don't fail the request if waitlist processing fails
      }

      res.status(200).json({
        success: true,
        message: 'Booking cancelled successfully',
        data: updatedBooking
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('Cancel booking error:', error);
      throw new AppError('Failed to cancel booking', 500, 'BOOKING_CANCEL_FAILED');
    }
  });

  // Mark booking as paid with cash (salon owner only)
  markAsPaidCash = asyncHandler(async (req, res) => {
    const { bookingId } = req.params;

    console.log(`💵 markAsPaidCash called for booking: ${bookingId}`);

    try {
      // Step 1: Get booking
      const { data: booking, error: bookingError } = await supabaseAdmin
        .from('bookings')
        .select('*')
        .eq('id', bookingId)
        .single();

      console.log(`💵 Step 1 - Booking query result:`, { found: !!booking, error: bookingError });

      if (bookingError || !booking) {
        console.error('❌ Booking not found:', bookingError);
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Step 2: Get salon to verify ownership
      const { data: salon, error: salonError } = await supabaseAdmin
        .from('salons')
        .select('owner_id')
        .eq('id', booking.salon_id)
        .single();

      console.log(`💵 Step 2 - Salon query result:`, { found: !!salon, error: salonError });

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Verify the user owns the salon
      if (salon.owner_id !== req.user.id) {
        console.log(`❌ Unauthorized: salon owner=${salon.owner_id}, user=${req.user.id}`);
        throw new AppError('Unauthorized', 403, 'UNAUTHORIZED');
      }

      console.log(`✅ Authorization passed for cash payment`);

      console.log(`💵 Marking booking ${bookingId} as paid cash`);

      // Update or create payment record
      const { data: existingPayment } = await supabaseAdmin
        .from('payments')
        .select('id')
        .eq('booking_id', bookingId)
        .single();

      if (existingPayment) {
        // Update existing payment
        const { error: updateError } = await supabaseAdmin
          .from('payments')
          .update({
            payment_status: 'paid',
            payment_method: 'cash',
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingPayment.id);

        if (updateError) {
          console.error('❌ Error updating payment:', updateError);
          throw new AppError('Failed to update payment', 500, 'PAYMENT_UPDATE_FAILED');
        }
      } else {
        // Create new payment record
        const { error: createError } = await supabaseAdmin
          .from('payments')
          .insert({
            booking_id: bookingId,
            amount: booking.total_price || 0,
            status: 'paid',
            payment_method: 'cash',
          });

        if (createError) {
          console.error('❌ Error creating payment:', createError);
          throw new AppError('Failed to create payment', 500, 'PAYMENT_CREATE_FAILED');
        }
      }

      console.log(`✅ Booking ${bookingId} marked as paid cash`);

      res.status(200).json({
        success: true,
        message: 'Booking marked as paid with cash',
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('Error marking as paid cash:', error);
      throw new AppError('Failed to mark as paid cash', 500, 'MARK_PAID_CASH_FAILED');
    }
  });

  // Send payment request to client (salon owner only)
  sendPaymentRequest = asyncHandler(async (req, res) => {
    const { bookingId } = req.params;
    const { amount } = req.body;

    console.log(`💳 sendPaymentRequest called for booking: ${bookingId}, amount: ${amount}`);

    try {
      // Step 1: Get booking
      const { data: booking, error: bookingError } = await supabaseAdmin
        .from('bookings')
        .select('*')
        .eq('id', bookingId)
        .single();

      console.log(`💳 Step 1 - Booking query result:`, { found: !!booking, error: bookingError });

      if (bookingError || !booking) {
        console.error('❌ Booking not found:', bookingError);
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Step 2: Get salon to verify ownership
      const { data: salon, error: salonError } = await supabaseAdmin
        .from('salons')
        .select('owner_id, business_name, stripe_account_id')
        .eq('id', booking.salon_id)
        .single();

      console.log(`💳 Step 2 - Salon query result:`, { found: !!salon, error: salonError });

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Verify the user owns the salon
      if (salon.owner_id !== req.user.id) {
        console.log(`❌ Unauthorized: salon owner=${salon.owner_id}, user=${req.user.id}`);
        throw new AppError('Unauthorized', 403, 'UNAUTHORIZED');
      }

      // Check if salon has connected Stripe account
      if (!salon.stripe_account_id) {
        throw new AppError('Salon has not connected Stripe account', 400, 'STRIPE_NOT_CONNECTED');
      }

      console.log(`✅ Authorization passed, salon has Stripe: ${salon.stripe_account_id}`);

      console.log(`💳 Sending payment request for booking ${bookingId}, amount: €${amount}`);

      // Update or create payment record with status 'requested'
      const { data: existingPayment, error: checkError } = await supabaseAdmin
        .from('payments')
        .select('id')
        .eq('booking_id', bookingId)
        .maybeSingle();

      console.log(`💳 Existing payment check:`, { exists: !!existingPayment, error: checkError });

      if (existingPayment) {
        // Update existing payment
        console.log(`💳 Updating existing payment: ${existingPayment.id}`);
        const { error: updateError } = await supabaseAdmin
          .from('payments')
          .update({
            payment_status: 'requested',
            amount: amount,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingPayment.id);

        if (updateError) {
          console.error('❌ Error updating payment:', updateError);
          throw new AppError('Failed to update payment', 500, 'PAYMENT_UPDATE_FAILED');
        }
        console.log(`✅ Payment updated to 'requested'`);
      } else {
        // Create new payment record
        console.log(`💳 Creating new payment record for booking ${bookingId}`);
        const paymentData = {
          booking_id: bookingId,
          amount: amount,
          status: 'requested',
          payment_method: 'ideal', // Default, client can choose
        };
        console.log(`💳 Payment data:`, paymentData);

        const { data: newPayment, error: createError } = await supabaseAdmin
          .from('payments')
          .insert(paymentData)
          .select()
          .single();

        if (createError) {
          console.error('❌ Error creating payment:', createError);
          console.error('❌ Payment data:', paymentData);
          throw new AppError('Failed to create payment', 500, 'PAYMENT_CREATE_FAILED');
        }
        console.log(`✅ Payment created:`, newPayment.id);
      }

      console.log(`✅ Payment request sent for booking ${bookingId}`);

      // TODO: Send notification to client (push notification, email, etc.)

      res.status(200).json({
        success: true,
        message: 'Payment request sent to client',
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('Error sending payment request:', error);
      throw new AppError('Failed to send payment request', 500, 'SEND_PAYMENT_REQUEST_FAILED');
    }
  });
}

module.exports = new BookingController();

