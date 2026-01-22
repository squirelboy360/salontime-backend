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
      console.log('📊 Fetching analytics for salon:', salonId, 'owner:', req.user.id);
      
      const { period = '30' } = req.query; // Default to last 30 days
      const daysAgo = parseInt(period);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysAgo);
      
      console.log('📅 Date range:', startDate.toISOString(), 'to', new Date().toISOString());

      // Fetch all analytics data in parallel
      const [
        revenueData,
        bookingsData,
        viewsData,
        favoritesData,
        reviewsData,
        salonMetrics,
        peakHoursData,
        servicePopularityData,
        clientRetentionData,
        performanceMetrics
      ] = await Promise.all([
        this._getRevenueMetrics(salonId, startDate),
        this._getBookingMetrics(salonId, startDate),
        this._getViewMetrics(salonId, startDate),
        this._getFavoritesMetrics(salonId),
        this._getReviewMetrics(salonId, startDate),
        this._getSalonMetrics(salonId),
        this._getPeakHours(salonId, startDate),
        this._getServicePopularity(salonId, startDate),
        this._getClientRetention(salonId, startDate),
        this._getPerformanceMetrics(salonId, startDate)
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
          peakHours: peakHoursData,
          servicePopularity: servicePopularityData,
          clientRetention: clientRetentionData,
          performance: performanceMetrics,
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
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select('*')
      .eq('salon_id', salonId)
      .gte('created_at', startDate.toISOString());

    if (error) {
      console.error('❌ Bookings query error:', error);
      return { total: 0, byStatus: {}, timeline: [] };
    }

    console.log(`📋 Found ${bookings?.length || 0} bookings for salon ${salonId}`);

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
    const { data: views, error } = await supabaseAdmin
      .from('salon_views')
      .select('*')
      .eq('salon_id', salonId)
      .gte('viewed_at', startDate.toISOString());

    if (error) {
      console.error('❌ Views query error:', error);
      return { total: 0, unique: 0, timeline: [] };
    }

    console.log(`👁️ Found ${views?.length || 0} views for salon ${salonId}`);

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
    const { data: favorites, error, count } = await supabaseAdmin
      .from('user_favorites')
      .select('*, user_profiles(first_name, last_name, avatar_url)', { count: 'exact' })
      .eq('salon_id', salonId);

    if (error) {
      console.error('❌ Favorites query error:', error);
      return { total: 0, recent: [] };
    }

    console.log(`❤️ Found ${count || 0} favorites for salon ${salonId}`);

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
    const { data: reviews, error } = await supabaseAdmin
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
    const { data: salon, error } = await supabaseAdmin
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
  /**
   * Get peak hours analytics
   */
  _getPeakHours = async (salonId, startDate) => {
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select('start_time, appointment_date')
      .eq('salon_id', salonId)
      .gte('appointment_date', startDate.toISOString().split('T')[0])
      .not('status', 'eq', 'cancelled');

    if (error || !bookings) {
      return { hourly: [], daily: [] };
    }

    // Group by hour (0-23)
    const hourCounts = Array(24).fill(0);
    bookings.forEach(b => {
      if (b.start_time) {
        const hour = parseInt(b.start_time.split(':')[0]);
        if (!isNaN(hour) && hour >= 0 && hour < 24) {
          hourCounts[hour]++;
        }
      }
    });

    // Group by day of week (0=Sun, 6=Sat)
    const dayCounts = Array(7).fill(0);
    bookings.forEach(b => {
      if (b.appointment_date) {
        const date = new Date(b.appointment_date);
        const day = date.getDay();
        dayCounts[day]++;
      }
    });

    return {
      hourly: hourCounts.map((count, hour) => ({ hour, count })),
      daily: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => ({
        day,
        count: dayCounts[index]
      }))
    };
  };

  /**
   * Get service popularity and revenue
   */
  _getServicePopularity = async (salonId, startDate) => {
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select(`
        service_id,
        total_price,
        services(name, category, price)
      `)
      .eq('salon_id', salonId)
      .gte('appointment_date', startDate.toISOString().split('T')[0])
      .not('status', 'eq', 'cancelled');

    if (error || !bookings) {
      return { topServices: [], byCategory: [] };
    }

    // Group by service
    const serviceStats = {};
    bookings.forEach(b => {
      const serviceId = b.service_id;
      const serviceName = b.services?.name || 'Unknown';
      const category = b.services?.category || 'Other';
      const price = parseFloat(b.total_price || b.services?.price || 0);

      if (!serviceStats[serviceId]) {
        serviceStats[serviceId] = {
          id: serviceId,
          name: serviceName,
          category,
          bookings: 0,
          revenue: 0
        };
      }
      serviceStats[serviceId].bookings++;
      serviceStats[serviceId].revenue += price;
    });

    const topServices = Object.values(serviceStats)
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 10);

    // Group by category
    const categoryStats = {};
    bookings.forEach(b => {
      const category = b.services?.category || 'Other';
      const price = parseFloat(b.total_price || b.services?.price || 0);

      if (!categoryStats[category]) {
        categoryStats[category] = { category, bookings: 0, revenue: 0 };
      }
      categoryStats[category].bookings++;
      categoryStats[category].revenue += price;
    });

    const byCategory = Object.values(categoryStats)
      .sort((a, b) => b.revenue - a.revenue);

    return { topServices, byCategory };
  };

  /**
   * Get client retention metrics
   */
  _getClientRetention = async (salonId, startDate) => {
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select('client_id, appointment_date')
      .eq('salon_id', salonId)
      .gte('appointment_date', startDate.toISOString().split('T')[0])
      .eq('status', 'completed');

    if (error || !bookings) {
      return { newClients: 0, returningClients: 0, retentionRate: 0, topClients: [] };
    }

    // Get unique clients in this period
    const clientIds = [...new Set(bookings.map(b => b.client_id))];
    
    // Check which clients had bookings before this period
    const { data: previousBookings, error: prevError } = await supabaseAdmin
      .from('bookings')
      .select('client_id')
      .eq('salon_id', salonId)
      .lt('appointment_date', startDate.toISOString().split('T')[0])
      .in('client_id', clientIds)
      .eq('status', 'completed');

    const returningClientIds = new Set(previousBookings?.map(b => b.client_id) || []);
    const newClients = clientIds.filter(id => !returningClientIds.has(id)).length;
    const returningClients = clientIds.filter(id => returningClientIds.has(id)).length;
    const retentionRate = clientIds.length > 0 ? (returningClients / clientIds.length) * 100 : 0;

    // Get top clients by booking count
    const clientBookingCounts = {};
    bookings.forEach(b => {
      clientBookingCounts[b.client_id] = (clientBookingCounts[b.client_id] || 0) + 1;
    });

    const topClients = Object.entries(clientBookingCounts)
      .map(([clientId, count]) => ({ clientId, bookings: count }))
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 10);

    return { newClients, returningClients, retentionRate, topClients };
  };

  /**
   * Get performance metrics (cancellation rate, completion rate, etc.)
   */
  _getPerformanceMetrics = async (salonId, startDate) => {
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select('status, created_at, appointment_date')
      .eq('salon_id', salonId)
      .gte('appointment_date', startDate.toISOString().split('T')[0]);

    if (error || !bookings) {
      return {
        cancellationRate: 0,
        completionRate: 0,
        noShowRate: 0,
        totalBookings: 0
      };
    }

    const total = bookings.length;
    const cancelled = bookings.filter(b => b.status === 'cancelled').length;
    const completed = bookings.filter(b => b.status === 'completed').length;
    const noShow = bookings.filter(b => b.status === 'no_show').length;

    return {
      cancellationRate: total > 0 ? (cancelled / total) * 100 : 0,
      completionRate: total > 0 ? (completed / total) * 100 : 0,
      noShowRate: total > 0 ? (noShow / total) * 100 : 0,
      totalBookings: total,
      statusBreakdown: {
        cancelled,
        completed,
        noShow,
        confirmed: bookings.filter(b => b.status === 'confirmed').length,
        pending: bookings.filter(b => b.status === 'pending').length
      }
    };
  };
}

module.exports = new AnalyticsController();
