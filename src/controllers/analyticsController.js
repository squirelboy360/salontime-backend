const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { supabase, supabaseAdmin } = require('../config/database');

class AnalyticsController {
  /**
   * Get comprehensive analytics for salon owner
   * Returns revenue, bookings, views, favorites, and review metrics
   */
  getSalonAnalytics = asyncHandler(async (req, res) => {
    try {
      // Get salon ID for the authenticated user
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('id')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      const salonId = salon.id;
      const { period = '30' } = req.query; // Default to last 30 days
      const daysAgo = parseInt(period);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysAgo);

      // Fetch all analytics data in parallel
      const [
        revenueData,
        bookingsData,
        viewsData,
        favoritesData,
        reviewsData,
        salonMetrics
      ] = await Promise.all([
        this._getRevenueMetrics(salonId, startDate),
        this._getBookingMetrics(salonId, startDate),
        this._getViewMetrics(salonId, startDate),
        this._getFavoritesMetrics(salonId),
        this._getReviewMetrics(salonId, startDate),
        this._getSalonMetrics(salonId)
      ]);

      res.status(200).json({
        success: true,
        data: {
          revenue: revenueData,
          bookings: bookingsData,
          views: viewsData,
          favorites: favoritesData,
          reviews: reviewsData,
          metrics: salonMetrics,
          period: {
            days: daysAgo,
            start: startDate.toISOString(),
            end: new Date().toISOString()
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('Analytics error:', error);
      throw new AppError('Failed to fetch analytics', 500, 'ANALYTICS_ERROR');
    }
  });

  /**
   * Get revenue metrics from payments table
   */
  _getRevenueMetrics = async (salonId, startDate) => {
    // Get total revenue
    const { data: payments, error } = await supabaseAdmin
      .from('payments')
      .select(`
        amount,
        currency,
        status,
        created_at,
        booking_id,
        bookings!inner(salon_id)
      `)
      .eq('bookings.salon_id', salonId)
      .eq('status', 'succeeded')
      .gte('created_at', startDate.toISOString());

    if (error) {
      console.error('Revenue query error:', error);
      return { total: 0, count: 0, currency: 'EUR', timeline: [] };
    }

    const total = payments?.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0) || 0;
    
    // Group by date for timeline
    const timeline = this._groupByDate(payments || [], 'created_at', 'amount');

    return {
      total: parseFloat(total.toFixed(2)),
      count: payments?.length || 0,
      currency: payments?.[0]?.currency || 'EUR',
      timeline
    };
  };

  /**
   * Get booking metrics
   */
  _getBookingMetrics = async (salonId, startDate) => {
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('salon_id', salonId)
      .gte('created_at', startDate.toISOString());

    if (error) {
      console.error('Bookings query error:', error);
      return { total: 0, byStatus: {}, timeline: [] };
    }

    // Count by status
    const byStatus = {
      pending: 0,
      confirmed: 0,
      completed: 0,
      cancelled: 0,
      no_show: 0
    };

    bookings?.forEach(booking => {
      if (byStatus.hasOwnProperty(booking.status)) {
        byStatus[booking.status]++;
      }
    });

    // Group by date for timeline
    const timeline = this._groupByDate(bookings || [], 'created_at', null, true);

    return {
      total: bookings?.length || 0,
      byStatus,
      timeline
    };
  };

  /**
   * Get view/impression metrics
   */
  _getViewMetrics = async (salonId, startDate) => {
    const { data: views, error } = await supabase
      .from('salon_views')
      .select('*')
      .eq('salon_id', salonId)
      .gte('viewed_at', startDate.toISOString());

    if (error) {
      console.error('Views query error:', error);
      return { total: 0, unique: 0, timeline: [] };
    }

    // Count unique users
    const uniqueUsers = new Set(views?.filter(v => v.user_id).map(v => v.user_id));
    
    // Group by date for timeline
    const timeline = this._groupByDate(views || [], 'viewed_at', null, true);

    return {
      total: views?.length || 0,
      unique: uniqueUsers.size,
      timeline
    };
  };

  /**
   * Get favorites metrics
   */
  _getFavoritesMetrics = async (salonId) => {
    const { data: favorites, error, count } = await supabase
      .from('user_favorites')
      .select('*, user_profiles(first_name, last_name, avatar_url)', { count: 'exact' })
      .eq('salon_id', salonId);

    if (error) {
      console.error('Favorites query error:', error);
      return { total: 0, recent: [] };
    }

    // Get 5 most recent favorites
    const recent = (favorites || [])
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5)
      .map(fav => ({
        user_id: fav.user_id,
        name: `${fav.user_profiles?.first_name || ''} ${fav.user_profiles?.last_name || ''}`.trim(),
        avatar: fav.user_profiles?.avatar_url,
        created_at: fav.created_at
      }));

    return {
      total: count || 0,
      recent
    };
  };

  /**
   * Get review metrics
   */
  _getReviewMetrics = async (salonId, startDate) => {
    const { data: reviews, error } = await supabase
      .from('reviews')
      .select(`
        *,
        user_profiles!reviews_client_id_fkey(first_name, last_name, avatar_url),
        bookings(service_id, services(name))
      `)
      .eq('salon_id', salonId)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Reviews query error:', error);
      return { total: 0, average: 0, byRating: {}, recent: [] };
    }

    // Calculate average rating
    const totalRating = reviews?.reduce((sum, r) => sum + (r.rating || 0), 0) || 0;
    const average = reviews?.length ? (totalRating / reviews.length).toFixed(1) : 0;

    // Count by rating
    const byRating = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    reviews?.forEach(review => {
      if (review.rating >= 1 && review.rating <= 5) {
        byRating[review.rating]++;
      }
    });

    // Get 10 most recent reviews
    const recent = (reviews || []).slice(0, 10).map(review => ({
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      created_at: review.created_at,
      client: {
        name: `${review.user_profiles?.first_name || ''} ${review.user_profiles?.last_name || ''}`.trim(),
        avatar: review.user_profiles?.avatar_url
      },
      service: review.bookings?.services?.name || 'Unknown Service'
    }));

    return {
      total: reviews?.length || 0,
      average: parseFloat(average),
      byRating,
      recent
    };
  };

  /**
   * Get salon-level metrics (from salons table)
   */
  _getSalonMetrics = async (salonId) => {
    const { data: salon, error } = await supabase
      .from('salons')
      .select('view_count, booking_count, favorite_count, trending_score, rating_average, rating_count')
      .eq('id', salonId)
      .single();

    if (error) {
      console.error('Salon metrics query error:', error);
      return {};
    }

    return {
      view_count: salon?.view_count || 0,
      booking_count: salon?.booking_count || 0,
      favorite_count: salon?.favorite_count || 0,
      trending_score: salon?.trending_score || 0,
      rating_average: salon?.rating_average || 0,
      rating_count: salon?.rating_count || 0
    };
  };

  /**
   * Helper to group data by date for timeline charts
   */
  _groupByDate = (data, dateField, sumField = null, count = false) => {
    const grouped = {};

    data.forEach(item => {
      const date = new Date(item[dateField]).toISOString().split('T')[0];
      
      if (!grouped[date]) {
        grouped[date] = count ? 0 : (sumField ? 0 : []);
      }

      if (count) {
        grouped[date]++;
      } else if (sumField) {
        grouped[date] += parseFloat(item[sumField] || 0);
      } else {
        grouped[date].push(item);
      }
    });

    // Convert to array format for charts
    return Object.keys(grouped)
      .sort()
      .map(date => ({
        date,
        value: typeof grouped[date] === 'number' ? grouped[date] : grouped[date].length
      }));
  };

  /**
   * Get reviews with pagination for managing/replying
   */
  getReviews = asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      // Get salon ID
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('id')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Get reviews with pagination
      const { data: reviews, error, count } = await supabase
        .from('reviews')
        .select(`
          *,
          user_profiles!reviews_client_id_fkey(first_name, last_name, avatar_url),
          bookings(appointment_date, service_id, services(name))
        `, { count: 'exact' })
        .eq('salon_id', salon.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw error;
      }

      res.status(200).json({
        success: true,
        data: {
          reviews: reviews || [],
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count || 0,
            pages: Math.ceil((count || 0) / limit)
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch reviews', 500, 'REVIEWS_FETCH_ERROR');
    }
  });
}

module.exports = new AnalyticsController();
