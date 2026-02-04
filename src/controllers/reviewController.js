const { supabase, supabaseAdmin } = require('../config/database');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const emailService = require('../services/emailService');
const supabaseService = require('../services/supabaseService');
const aiService = require('../services/aiService');

class ReviewController {
  // Get reviews for a salon
  getSalonReviews = asyncHandler(async (req, res) => {
    const { salonId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    if (!salonId) {
      throw new AppError('Salon ID is required', 400, 'MISSING_SALON_ID');
    }

    try {
      // First, get reviews with basic data
      const { data: reviews, error } = await supabase
        .from('reviews')
        .select('*')
        .eq('salon_id', salonId)
        .eq('is_visible', true)
        .order('created_at', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

      if (error) {
        console.error('Error fetching salon reviews:', error);
        console.error('Error details:', JSON.stringify(error, null, 2));
        throw new AppError('Failed to fetch reviews', 500, 'REVIEWS_FETCH_FAILED');
      }

      // Then enrich with client, booking, and service data
      const enrichedReviews = await Promise.all(
        (reviews || []).map(async (review) => {
          // Get client info using supabaseAdmin to bypass RLS
          let client = null;
          try {
            // Use .maybeSingle() instead of .single() to avoid errors when no data exists
            // Use select('*') to get all columns and handle any column name variations
            const { data: clientData, error: clientError } = await supabaseAdmin
              .from('user_profiles')
              .select('*')
              .eq('id', review.client_id)
              .maybeSingle();
            
            if (clientError) {
              console.error(`❌ Error fetching client for review ${review.id}:`, JSON.stringify(clientError, null, 2));
              console.error(`   Client ID: ${review.client_id}`);
              console.error(`   Error code: ${clientError.code}, message: ${clientError.message}`);
            } else if (clientData) {
              // Map avatar field - could be 'avatar' or 'avatar_url'
              client = {
                id: clientData.id,
                first_name: clientData.first_name,
                last_name: clientData.last_name,
                avatar_url: clientData.avatar_url || clientData.avatar || null,
              };
              console.log(`✅ Fetched client for review ${review.id}: ${clientData.first_name} ${clientData.last_name}`);
            } else {
              console.warn(`⚠️ Client not found for review ${review.id}, client_id: ${review.client_id}`);
            }
          } catch (e) {
            console.error(`❌ Exception fetching client for review ${review.id}:`, e);
            console.error(`   Stack: ${e.stack}`);
          }

          // Get booking and service info if booking_id exists
          let booking = null;
          let service = null;
          
          if (review.booking_id) {
            try {
              const { data: bookingData, error: bookingError } = await supabaseAdmin
                .from('bookings')
                .select('id, appointment_date, service_id')
                .eq('id', review.booking_id)
                .maybeSingle();

              if (bookingError) {
                console.error(`Error fetching booking for review ${review.id}:`, bookingError);
              } else if (bookingData && bookingData.service_id) {
                booking = bookingData;
                
                // Get service info
                const { data: serviceData, error: serviceError } = await supabaseAdmin
                  .from('services')
                  .select('id, name')
                  .eq('id', bookingData.service_id)
                  .maybeSingle();
                
                if (serviceError) {
                  console.error(`Error fetching service for review ${review.id}:`, serviceError);
                } else if (serviceData) {
                  service = serviceData;
                }
              }
            } catch (e) {
              console.error(`Exception fetching booking/service for review ${review.id}:`, e);
            }
          }

          return {
            ...review,
            client: client,
            booking: booking,
            service: service,
          };
        })
      );

      // Calculate average rating and count
      const { data: stats, error: statsError } = await supabase
        .from('reviews')
        .select('rating')
        .eq('salon_id', salonId)
        .eq('is_visible', true);

      let averageRating = 0;
      let reviewCount = 0;

      if (!statsError && stats && stats.length > 0) {
        reviewCount = stats.length;
        const sum = stats.reduce((acc, review) => acc + review.rating, 0);
        averageRating = sum / reviewCount;
      }

      res.status(200).json({
        success: true,
        data: {
          reviews: enrichedReviews || [],
          stats: {
            average_rating: parseFloat(averageRating.toFixed(2)),
            total_reviews: reviewCount,
          },
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch reviews', 500, 'REVIEWS_FETCH_FAILED');
    }
  });

  // Create a review (only for past bookings)
  createReview = asyncHandler(async (req, res) => {
    const {
      salon_id,
      booking_id,
      rating,
      comment,
    } = req.body;

    const clientId = req.user.id;

    // Validate required fields
    if (!salon_id || !rating) {
      throw new AppError('Salon ID and rating are required', 400, 'MISSING_REQUIRED_FIELDS');
    }

    if (rating < 1 || rating > 5) {
      throw new AppError('Rating must be between 1 and 5', 400, 'INVALID_RATING');
    }

    try {
      // If booking_id is provided, verify it belongs to the user and is completed
      if (booking_id) {
        // Use supabaseAdmin to bypass RLS for past bookings
        const { data: booking, error: bookingError } = await supabaseAdmin
          .from('bookings')
          .select('*')
          .eq('id', booking_id)
          .eq('client_id', clientId)
          .single();

        if (bookingError || !booking) {
          throw new AppError('Booking not found or does not belong to you', 404, 'BOOKING_NOT_FOUND');
        }

        // Check if booking is completed or in the past
        const bookingDate = new Date(`${booking.appointment_date}T${booking.start_time}`);
        const now = new Date();
        
        if (bookingDate > now && booking.status !== 'completed') {
          throw new AppError('You can only review completed or past bookings', 400, 'BOOKING_NOT_COMPLETED');
        }

        // Check if review already exists for THIS SPECIFIC booking (use supabaseAdmin)
        // This allows multiple reviews for different booking instances (e.g., booking same service twice)
        const { data: existingReview, error: existingError } = await supabaseAdmin
          .from('reviews')
          .select('id')
          .eq('booking_id', booking_id) // Only check THIS booking_id, not other bookings
          .maybeSingle(); // Use maybeSingle to avoid errors when no review exists

        if (existingError && existingError.code !== 'PGRST116') {
          // PGRST116 is "not found" which is fine - means no review exists yet
          console.error('Error checking for existing review:', existingError);
        }

        if (existingReview) {
          // Review already exists for THIS specific booking
          throw new AppError('Review already exists for this booking', 409, 'REVIEW_ALREADY_EXISTS');
        }

        // Verify booking belongs to the salon
        if (booking.salon_id !== salon_id) {
          throw new AppError('Booking does not belong to this salon', 400, 'INVALID_SALON');
        }
      } else {
        // If no booking_id, check if user has any completed bookings for this salon
        const { data: pastBookings, error: bookingsError } = await supabase
          .from('bookings')
          .select('id')
          .eq('salon_id', salon_id)
          .eq('client_id', clientId)
          .in('status', ['completed'])
          .limit(1);

        if (bookingsError || !pastBookings || pastBookings.length === 0) {
          throw new AppError('You can only review salons you have completed bookings with', 400, 'NO_COMPLETED_BOOKINGS');
        }
      }

      // Create review (use supabaseAdmin to bypass RLS)
      const { data: review, error: reviewError } = await supabaseAdmin
        .from('reviews')
        .insert([{
          client_id: clientId,
          salon_id,
          booking_id: booking_id || null,
          rating: parseInt(rating),
          comment: comment || null,
          is_visible: true,
        }])
        .select('*')
        .single();

      if (reviewError) {
        console.error('Error creating review:', reviewError);
        console.error('Review error details:', JSON.stringify(reviewError, null, 2));
        throw new AppError('Failed to create review', 500, 'REVIEW_CREATION_FAILED');
      }
      
      // Get client info separately if needed
      const { data: clientData } = await supabaseAdmin
        .from('user_profiles')
        .select('*')
        .eq('id', clientId)
        .single();
      
      const enrichedReview = {
        ...review,
        client: clientData || null,
      };

      // Update salon rating_average and rating_count
      await this._updateSalonRating(salon_id);

      // Trigger AI analysis of the review (async, don't wait)
      if (comment && comment.trim().length > 0) {
        this._analyzeReviewWithAI(review.id, comment).catch(err => {
          console.error('Error in AI analysis:', err);
        });
      }

      // Send email notification to salon owner
      try {
        await this._sendReviewNotificationEmail(review, clientData, salon_id);
      } catch (emailError) {
        console.error('Failed to send review notification email:', emailError);
        // Don't fail the review creation if email fails
      }

      res.status(201).json({
        success: true,
        data: {
          review: enrichedReview,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to create review', 500, 'REVIEW_CREATION_FAILED');
    }
  });

  // Update a review
  updateReview = asyncHandler(async (req, res) => {
    const { reviewId } = req.params;
    const { rating, comment } = req.body;
    const clientId = req.user.id;

    if (!reviewId) {
      throw new AppError('Review ID is required', 400, 'MISSING_REVIEW_ID');
    }

    try {
      // Verify review belongs to user
      const { data: existingReview, error: existingError } = await supabase
        .from('reviews')
        .select('*')
        .eq('id', reviewId)
        .eq('client_id', clientId)
        .single();

      if (existingError || !existingReview) {
        throw new AppError('Review not found or you do not have permission to update it', 404, 'REVIEW_NOT_FOUND');
      }

      // Validate rating if provided
      if (rating !== undefined && (rating < 1 || rating > 5)) {
        throw new AppError('Rating must be between 1 and 5', 400, 'INVALID_RATING');
      }

      // Update review
      const updateData = {};
      if (rating !== undefined) updateData.rating = parseInt(rating);
      if (comment !== undefined) updateData.comment = comment;
      updateData.updated_at = new Date().toISOString();

      const { data: review, error: updateError } = await supabase
        .from('reviews')
        .update(updateData)
        .eq('id', reviewId)
        .select(`
          *,
          client:user_profiles!reviews_client_id_fkey(
            id,
            first_name,
            last_name,
            avatar_url
          )
        `)
        .single();

      if (updateError) {
        console.error('Error updating review:', updateError);
        throw new AppError('Failed to update review', 500, 'REVIEW_UPDATE_FAILED');
      }

      // Update salon rating
      await this._updateSalonRating(existingReview.salon_id);

      res.status(200).json({
        success: true,
        data: {
          review,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to update review', 500, 'REVIEW_UPDATE_FAILED');
    }
  });

  // Delete a review (soft delete by setting is_visible to false)
  deleteReview = asyncHandler(async (req, res) => {
    const { reviewId } = req.params;
    const clientId = req.user.id;

    if (!reviewId) {
      throw new AppError('Review ID is required', 400, 'MISSING_REVIEW_ID');
    }

    try {
      // Verify review belongs to user
      const { data: existingReview, error: existingError } = await supabase
        .from('reviews')
        .select('salon_id')
        .eq('id', reviewId)
        .eq('client_id', clientId)
        .single();

      if (existingError || !existingReview) {
        throw new AppError('Review not found or you do not have permission to delete it', 404, 'REVIEW_NOT_FOUND');
      }

      // Soft delete by setting is_visible to false
      const { error: deleteError } = await supabase
        .from('reviews')
        .update({ is_visible: false, updated_at: new Date().toISOString() })
        .eq('id', reviewId);

      if (deleteError) {
        console.error('Error deleting review:', deleteError);
        throw new AppError('Failed to delete review', 500, 'REVIEW_DELETE_FAILED');
      }

      // Update salon rating
      await this._updateSalonRating(existingReview.salon_id);

      res.status(200).json({
        success: true,
        message: 'Review deleted successfully',
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to delete review', 500, 'REVIEW_DELETE_FAILED');
    }
  });

  // Get user's reviews
  getMyReviews = asyncHandler(async (req, res) => {
    const clientId = req.user.id;

    try {
      // Current user is the client for all "my reviews" - fetch once for response
      let client = null;
      try {
        const userProfile = await supabaseService.getUserProfile(clientId);
        if (userProfile) {
          client = {
            id: userProfile.id,
            first_name: userProfile.first_name,
            last_name: userProfile.last_name,
            avatar_url: userProfile.avatar_url || userProfile.avatar || null,
          };
        }
      } catch (e) {
        console.error('Error fetching client profile for my-reviews:', e);
      }

      // Use supabaseAdmin to bypass RLS and ensure we can fetch all reviews
      // First, get the reviews
      const { data: reviews, error } = await supabaseAdmin
        .from('reviews')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching user reviews:', error);
        console.error('Error details:', JSON.stringify(error, null, 2));
        throw new AppError('Failed to fetch reviews', 500, 'REVIEWS_FETCH_FAILED');
      }

      // Then, enrich with related data
      const enrichedReviews = await Promise.all(
        (reviews || []).map(async (review) => {
          // Get salon info
          let salon = null;
          try {
            // Use .maybeSingle() instead of .single() to avoid errors when no data exists
            // Use select('*') to get all columns
            const { data: salonData, error: salonError } = await supabaseAdmin
              .from('salons')
              .select('*')
              .eq('id', review.salon_id)
              .maybeSingle();
            
            if (salonError) {
              console.error(`❌ Error fetching salon for review ${review.id}:`, JSON.stringify(salonError, null, 2));
              console.error(`   Salon ID: ${review.salon_id}`);
              console.error(`   Error code: ${salonError.code}, message: ${salonError.message}`);
            } else if (salonData) {
              salon = {
                id: salonData.id,
                business_name: salonData.business_name,
                images: salonData.images,
              };
              console.log(`✅ Fetched salon for review ${review.id}: ${salonData.business_name}`);
            } else {
              console.warn(`⚠️ Salon not found for review ${review.id}, salon_id: ${review.salon_id}`);
            }
          } catch (e) {
            console.error(`❌ Exception fetching salon for review ${review.id}:`, e);
            console.error(`   Stack: ${e.stack}`);
          }

          // Get booking and service info if booking_id exists
          let booking = null;
          let service = null;
          
          if (review.booking_id) {
            try {
              const { data: bookingData, error: bookingError } = await supabaseAdmin
                .from('bookings')
                .select('id, appointment_date, service_id')
                .eq('id', review.booking_id)
                .maybeSingle();

              if (bookingError) {
                console.error(`❌ Error fetching booking for review ${review.id}:`, bookingError);
              } else if (bookingData) {
                booking = bookingData;
                
                // Get service info
                if (bookingData.service_id) {
                  const { data: serviceData, error: serviceError } = await supabaseAdmin
                    .from('services')
                    .select('id, name')
                    .eq('id', bookingData.service_id)
                    .maybeSingle();
                  
                  if (serviceError) {
                    console.error(`❌ Error fetching service for review ${review.id}:`, serviceError);
                  } else if (serviceData) {
                    service = serviceData;
                  }
                }
              }
            } catch (e) {
              console.error(`❌ Exception fetching booking/service for review ${review.id}:`, e);
            }
          }

          return {
            ...review,
            client,
            salon: salon,
            booking: booking,
            service: service,
          };
        })
      );

      res.status(200).json({
        success: true,
        data: {
          reviews: enrichedReviews || [],
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch reviews', 500, 'REVIEWS_FETCH_FAILED');
    }
  });

  // Check if user can review a booking
  canReviewBooking = asyncHandler(async (req, res) => {
    const { bookingId } = req.params;
    const clientId = req.user.id;

    if (!bookingId) {
      throw new AppError('Booking ID is required', 400, 'MISSING_BOOKING_ID');
    }

    try {
      // Get booking (use supabaseAdmin to bypass RLS for past bookings)
      const { data: booking, error: bookingError } = await supabaseAdmin
        .from('bookings')
        .select('*')
        .eq('id', bookingId)
        .eq('client_id', clientId)
        .single();

      if (bookingError || !booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Check if booking is completed or in the past
      const bookingDate = new Date(`${booking.appointment_date}T${booking.start_time}`);
      const now = new Date();
      const isPast = bookingDate < now || booking.status === 'completed';

      // Check if review already exists
      const { data: existingReview, error: existingError } = await supabase
        .from('reviews')
        .select('id')
        .eq('booking_id', bookingId)
        .single();

      const hasReview = !!existingReview;

      res.status(200).json({
        success: true,
        data: {
          can_review: isPast && !hasReview,
          has_review: hasReview,
          is_past: isPast,
          booking_status: booking.status,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to check review eligibility', 500, 'REVIEW_CHECK_FAILED');
    }
  });

  // Helper method to update salon rating_average and rating_count
  async _updateSalonRating(salonId) {
    try {
      // Get all visible reviews for this salon
      const { data: reviews, error } = await supabaseAdmin
        .from('reviews')
        .select('rating')
        .eq('salon_id', salonId)
        .eq('is_visible', true);

      if (error) {
        console.error('Error fetching reviews for rating update:', error);
        return;
      }

      let averageRating = 0;
      let reviewCount = 0;

      if (reviews && reviews.length > 0) {
        reviewCount = reviews.length;
        const sum = reviews.reduce((acc, review) => acc + review.rating, 0);
        averageRating = sum / reviewCount;
      }

      // Update salon
      const { error: updateError } = await supabaseAdmin
        .from('salons')
        .update({
          rating_average: parseFloat(averageRating.toFixed(2)),
          rating_count: reviewCount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', salonId);

      if (updateError) {
        console.error('Error updating salon rating:', updateError);
      }
    } catch (error) {
      console.error('Error in _updateSalonRating:', error);
    }
  }

  // Send email notification to salon owner when they receive a review
  async _sendReviewNotificationEmail(review, client, salonId) {
    try {
      // Get salon information
      const { data: salon, error: salonError } = await supabaseAdmin
        .from('salons')
        .select('id, business_name, email, owner_id')
        .eq('id', salonId)
        .maybeSingle();

      if (salonError || !salon) {
        console.error('Error fetching salon for review notification:', salonError);
        return;
      }

      // Get salon owner information (including language preference)
      const { data: owner, error: ownerError } = await supabaseAdmin
        .from('user_profiles')
        .select('id, first_name, last_name, email, language')
        .eq('id', salon.owner_id)
        .maybeSingle();

      if (ownerError || !owner) {
        console.error('Error fetching salon owner for review notification:', ownerError);
        return;
      }

      // Get service name if booking_id exists
      let serviceName = 'Service';
      if (review.booking_id) {
        const { data: booking } = await supabaseAdmin
          .from('bookings')
          .select('service_id')
          .eq('id', review.booking_id)
          .maybeSingle();
        
        if (booking && booking.service_id) {
          const { data: service } = await supabaseAdmin
            .from('services')
            .select('name')
            .eq('id', booking.service_id)
            .maybeSingle();
          
          if (service) {
            serviceName = service.name;
          }
        }
      }

      // Use salon email if available, otherwise use owner email
      const recipientEmail = salon.email || owner.email;
      if (!recipientEmail) {
        console.warn('No email found for salon owner, skipping review notification');
        return;
      }

      // Get owner's language preference (default to 'en' if not set)
      const ownerLanguage = owner.language || 'en';

      // Send email notification
      await emailService.sendReviewNotification({
        salon: {
          business_name: salon.business_name,
          email: recipientEmail,
        },
        owner: {
          first_name: owner.first_name,
          last_name: owner.last_name,
          language: ownerLanguage,
        },
        client: {
          first_name: client?.first_name || 'A client',
          last_name: client?.last_name || '',
        },
        review: {
          rating: review.rating,
          comment: review.comment,
          service_name: serviceName,
          created_at: review.created_at,
        },
      });

      console.log(`✅ Review notification email sent to ${recipientEmail}`);
    } catch (error) {
      console.error('Error sending review notification email:', error);
      // Don't throw - email failure shouldn't break review creation
    }
  }

  // Salon owner reply to a review
  replyToReview = asyncHandler(async (req, res) => {
    const { reviewId } = req.params;
    const { reply } = req.body;
    const userId = req.user.id;

    if (!reviewId) {
      throw new AppError('Review ID is required', 400, 'MISSING_REVIEW_ID');
    }

    if (!reply || reply.trim().length === 0) {
      throw new AppError('Reply text is required', 400, 'MISSING_REPLY');
    }

    try {
      console.log(`🔍 Reply to review: reviewId=${reviewId}, userId=${userId}`);
      
      // Get the review
      const { data: review, error: reviewError } = await supabaseAdmin
        .from('reviews')
        .select('id, salon_id')
        .eq('id', reviewId)
        .single();

      if (reviewError) {
        console.error('❌ Review query error:', JSON.stringify(reviewError, null, 2));
        throw new AppError('Review not found', 404, 'REVIEW_NOT_FOUND');
      }

      if (!review) {
        console.error('❌ Review not found for ID:', reviewId);
        throw new AppError('Review not found', 404, 'REVIEW_NOT_FOUND');
      }

      console.log(`✅ Found review: id=${review.id}, salon_id=${review.salon_id}`);

      // Get the salon to verify ownership
      const { data: salon, error: salonError } = await supabaseAdmin
        .from('salons')
        .select('id, owner_id')
        .eq('id', review.salon_id)
        .single();

      if (salonError) {
        console.error('❌ Salon query error:', JSON.stringify(salonError, null, 2));
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      if (!salon) {
        console.error('❌ Salon not found for salon_id:', review.salon_id);
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      console.log(`✅ Found salon: id=${salon.id}, owner_id=${salon.owner_id}, userId=${userId}`);

      // Check if user is the salon owner
      if (salon.owner_id !== userId) {
        console.error(`❌ Unauthorized: salon.owner_id=${salon.owner_id} !== userId=${userId}`);
        throw new AppError('You do not have permission to reply to this review', 403, 'UNAUTHORIZED');
      }

      // Update review with owner reply
      // Don't manually set updated_at - let the database handle it or use a trigger
      const updateData = {
        owner_reply: reply.trim(),
        owner_reply_at: new Date().toISOString(),
      };
      
      const { data: updatedReview, error: updateError } = await supabaseAdmin
        .from('reviews')
        .update(updateData)
        .eq('id', reviewId)
        .select('*')
        .single();

      if (updateError) {
        console.error('Error updating review with reply:', updateError);
        throw new AppError('Failed to add reply', 500, 'REPLY_UPDATE_FAILED');
      }

      res.status(200).json({
        success: true,
        data: {
          review: updatedReview,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to reply to review', 500, 'REPLY_FAILED');
    }
  });

  // AI analysis helper (called asynchronously)
  async _analyzeReviewWithAI(reviewId, comment) {
    try {
      console.log(`🤖 Starting AI analysis for review ${reviewId} with comment: "${comment?.substring(0, 50)}..."`);
      
      // Check if already analyzed - skip only if already flagged (to avoid redundant work)
      // But always analyze on first pass or if not flagged yet
      const { data: existing } = await supabaseAdmin
        .from('reviews')
        .select('ai_analyzed, ai_flag_type')
        .eq('id', reviewId)
        .single();

      if (existing?.ai_analyzed && existing?.ai_flag_type) {
        console.log(`ℹ️ Review ${reviewId} already analyzed and flagged, skipping re-analysis`);
        return; // Already flagged, no need to re-analyze
      }

      // If analyzed but not flagged, or not analyzed yet, proceed with analysis
      if (existing?.ai_analyzed && !existing?.ai_flag_type) {
        console.log(`⚠️ Review ${reviewId} was analyzed but not flagged - re-analyzing to ensure accuracy`);
      }

      // Use AI service to analyze the comment
      const analysis = await aiService.analyzeReviewContent(comment);

      // Update review with AI analysis
      const updateData = {
        ai_analyzed: true,
        updated_at: new Date().toISOString(),
      };

      if (analysis.flagged) {
        updateData.ai_flag_type = analysis.flagType;
        updateData.ai_confidence = analysis.confidence;
        updateData.ai_notes = analysis.notes;
        updateData.is_visible = false; // Hide flagged reviews until human review

        // Create automatic report if AI flags something serious
        if (analysis.flagType === 'hateful' || analysis.flagType === 'suicidal' || analysis.flagType === 'inappropriate') {
          // Get review to find client_id
          const { data: review } = await supabaseAdmin
            .from('reviews')
            .select('client_id')
            .eq('id', reviewId)
            .single();

          if (review) {
            await supabaseAdmin
              .from('review_reports')
              .insert([{
                review_id: reviewId,
                reporter_id: null, // System-generated report
                reportee_id: review.client_id,
                reason: analysis.flagType,
                description: `AI automatically flagged: ${analysis.notes}`,
                status: 'pending',
                ai_flagged: true,
                ai_flag_reason: analysis.notes,
                human_action_required: true, // Always require human review for AI-flagged content
              }]);
          }
        }
      } else {
        updateData.ai_confidence = analysis.confidence || 0.0;
        updateData.ai_notes = analysis.notes || 'No issues detected';
      }

      await supabaseAdmin
        .from('reviews')
        .update(updateData)
        .eq('id', reviewId);

      console.log(`✅ AI analysis completed for review ${reviewId}`);
    } catch (error) {
      console.error('Error in AI analysis:', error);
      // Don't throw - this is async and shouldn't break review creation
    }
  }
}

module.exports = new ReviewController();

