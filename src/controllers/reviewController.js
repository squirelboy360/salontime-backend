const { supabase, supabaseAdmin } = require('../config/database');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

class ReviewController {
  // Get reviews for a salon
  getSalonReviews = asyncHandler(async (req, res) => {
    const { salonId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    if (!salonId) {
      throw new AppError('Salon ID is required', 400, 'MISSING_SALON_ID');
    }

    try {
      const { data: reviews, error } = await supabase
        .from('reviews')
        .select(`
          *,
          client:user_profiles!reviews_client_id_fkey(
            id,
            first_name,
            last_name,
            avatar_url
          ),
          booking:bookings!reviews_booking_id_fkey(
            id,
            appointment_date,
            service_id
          ),
          service:services!bookings_service_id_fkey(
            id,
            name
          )
        `)
        .eq('salon_id', salonId)
        .eq('is_visible', true)
        .order('created_at', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

      if (error) {
        console.error('Error fetching salon reviews:', error);
        throw new AppError('Failed to fetch reviews', 500, 'REVIEWS_FETCH_FAILED');
      }

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
          reviews: reviews || [],
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

        // Check if review already exists for this booking
        const { data: existingReview, error: existingError } = await supabase
          .from('reviews')
          .select('id')
          .eq('booking_id', booking_id)
          .single();

        if (existingReview) {
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

      // Create review
      const { data: review, error: reviewError } = await supabase
        .from('reviews')
        .insert([{
          client_id: clientId,
          salon_id,
          booking_id: booking_id || null,
          rating: parseInt(rating),
          comment: comment || null,
          is_visible: true,
        }])
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

      if (reviewError) {
        console.error('Error creating review:', reviewError);
        throw new AppError('Failed to create review', 500, 'REVIEW_CREATION_FAILED');
      }

      // Update salon rating_average and rating_count
      await this._updateSalonRating(salon_id);

      res.status(201).json({
        success: true,
        data: {
          review,
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
          const { data: salon } = await supabaseAdmin
            .from('salons')
            .select('id, business_name, image_url')
            .eq('id', review.salon_id)
            .single();

          // Get booking and service info if booking_id exists
          let booking = null;
          let service = null;
          
          if (review.booking_id) {
            const { data: bookingData } = await supabaseAdmin
              .from('bookings')
              .select('id, appointment_date, service_id')
              .eq('id', review.booking_id)
              .single();

            if (bookingData) {
              booking = bookingData;
              
              // Get service info
              if (bookingData.service_id) {
                const { data: serviceData } = await supabaseAdmin
                  .from('services')
                  .select('id, name')
                  .eq('id', bookingData.service_id)
                  .single();
                
                if (serviceData) {
                  service = serviceData;
                }
              }
            }
          }

          const enrichedReview = {
            ...review,
            salon: salon || null,
            booking: booking || null,
            service: service || null,
          };
          
          // Debug logging
          if (!salon) {
            console.warn(`⚠️ No salon data found for review ${review.id}, salon_id: ${review.salon_id}`);
          }
          
          return enrichedReview;
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
}

module.exports = new ReviewController();

