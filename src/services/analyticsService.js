const { supabase } = require('../config/database');

/**
 * Analytics Service
 * Handles tracking of salon views, bookings, and favorites
 */

/**
 * Track salon view
 */
async function trackSalonView(salonId, userId = null, metadata = {}) {
  try {
    const { session_id, source = 'unknown', device_type = 'unknown' } = metadata;
    
    const viewData = {
      salon_id: salonId,
      user_id: userId,
      session_id: session_id,
      source: source,
      device_type: device_type,
      viewed_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('salon_views')
      .insert([viewData])
      .select()
      .single();

    if (error) {
      console.error('Error tracking salon view:', error);
      return { success: false, error };
    }

    return { success: true, data };
  } catch (error) {
    console.error('Error in trackSalonView:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get salon view count (total and recent)
 */
async function getSalonViewStats(salonId) {
  try {
    // Get total views
    const { count: totalViews, error: totalError } = await supabase
      .from('salon_views')
      .select('*', { count: 'exact', head: true })
      .eq('salon_id', salonId);

    if (totalError) throw totalError;

    // Get views from last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { count: recentViews, error: recentError } = await supabase
      .from('salon_views')
      .select('*', { count: 'exact', head: true })
      .eq('salon_id', salonId)
      .gte('viewed_at', sevenDaysAgo.toISOString());

    if (recentError) throw recentError;

    // Get unique viewers (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: uniqueViewers, error: uniqueError } = await supabase
      .from('salon_views')
      .select('user_id')
      .eq('salon_id', salonId)
      .gte('viewed_at', thirtyDaysAgo.toISOString())
      .not('user_id', 'is', null);

    if (uniqueError) throw uniqueError;

    const uniqueViewerCount = new Set(uniqueViewers.map(v => v.user_id)).size;

    return {
      success: true,
      data: {
        total_views: totalViews || 0,
        views_last_7_days: recentViews || 0,
        unique_viewers_last_30_days: uniqueViewerCount,
      },
    };
  } catch (error) {
    console.error('Error getting salon view stats:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get trending salons based on calculated score
 */
async function getTrendingSalons(limit = 10, latitude = null, longitude = null, radius = 50) {
  try {
    let query = supabase
      .from('salons')
      .select(`
        *,
        owner:user_profiles!salons_owner_id_fkey(first_name, last_name)
      `)
      .eq('is_active', true)
      .order('trending_score', { ascending: false })
      .limit(limit);

    // If location provided, filter by radius
    if (latitude && longitude) {
      // Use PostGIS earth_distance for accurate distance calculation
      query = query.rpc('salons_within_radius', {
        lat: latitude,
        lng: longitude,
        radius_km: radius,
      });
    }

    const { data, error } = await query;

    if (error) throw error;

    return {
      success: true,
      data: {
        salons: data || [],
        metadata: {
          category: 'trending',
          total_count: data?.length || 0,
          filters_applied: { latitude, longitude, radius, limit },
        },
      },
    };
  } catch (error) {
    console.error('Error getting trending salons:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get new salons (created in last N days)
 */
async function getNewSalons(days = 30, limit = 10, latitude = null, longitude = null, radius = 25) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    let query = supabase
      .from('salons')
      .select(`
        *,
        owner:user_profiles!salons_owner_id_fkey(first_name, last_name)
      `)
      .eq('is_active', true)
      .gte('created_at', cutoffDate.toISOString())
      .order('created_at', { ascending: false })
      .limit(limit);

    const { data, error } = await query;

    if (error) throw error;

    // Filter by distance if location provided (client-side for now)
    let filteredData = data || [];
    if (latitude && longitude && filteredData.length > 0) {
      filteredData = filteredData.filter(salon => {
        if (!salon.latitude || !salon.longitude) return false;
        const distance = calculateDistance(latitude, longitude, salon.latitude, salon.longitude);
        salon.distance = distance;
        return distance <= radius;
      });
    }

    return {
      success: true,
      data: {
        salons: filteredData,
        metadata: {
          category: 'new',
          days_threshold: days,
          total_count: filteredData.length,
          filters_applied: { latitude, longitude, radius, limit },
        },
      },
    };
  } catch (error) {
    console.error('Error getting new salons:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get featured salons (paid subscribers)
 */
async function getFeaturedSalons(limit = 10, latitude = null, longitude = null, radius = 50) {
  try {
    const now = new Date().toISOString();

    let query = supabase
      .from('salons')
      .select(`
        *,
        owner:user_profiles!salons_owner_id_fkey(first_name, last_name)
      `)
      .eq('is_active', true)
      .eq('is_featured', true)
      .or(`featured_until.is.null,featured_until.gte.${now}`)
      .order('trending_score', { ascending: false })
      .limit(limit);

    const { data, error } = await query;

    if (error) throw error;

    // Filter by distance if location provided
    let filteredData = data || [];
    if (latitude && longitude && filteredData.length > 0) {
      filteredData = filteredData.filter(salon => {
        if (!salon.latitude || !salon.longitude) return false;
        const distance = calculateDistance(latitude, longitude, salon.latitude, salon.longitude);
        salon.distance = distance;
        return distance <= radius;
      });
    }

    return {
      success: true,
      data: {
        salons: filteredData,
        metadata: {
          category: 'featured',
          total_count: filteredData.length,
          filters_applied: { latitude, longitude, radius, limit },
        },
      },
    };
  } catch (error) {
    console.error('Error getting featured salons:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get popular salons (high ratings with many reviews)
 */
async function getPopularSalons(minRating = 4.5, minReviews = 10, limit = 10, latitude = null, longitude = null, radius = 50) {
  try {
    let query = supabase
      .from('salons')
      .select(`
        *,
        owner:user_profiles!salons_owner_id_fkey(first_name, last_name)
      `)
      .eq('is_active', true)
      .gte('rating_average', minRating)
      .gte('rating_count', minReviews)
      .order('rating_average', { ascending: false })
      .order('rating_count', { ascending: false })
      .limit(limit);

    const { data, error } = await query;

    if (error) throw error;

    // Filter by distance if location provided
    let filteredData = data || [];
    if (latitude && longitude && filteredData.length > 0) {
      filteredData = filteredData.filter(salon => {
        if (!salon.latitude || !salon.longitude) return false;
        const distance = calculateDistance(latitude, longitude, salon.latitude, salon.longitude);
        salon.distance = distance;
        return distance <= radius;
      });
    }

    return {
      success: true,
      data: {
        salons: filteredData,
        metadata: {
          category: 'popular',
          min_rating: minRating,
          min_reviews: minReviews,
          total_count: filteredData.length,
          filters_applied: { latitude, longitude, radius, limit },
        },
      },
    };
  } catch (error) {
    console.error('Error getting popular salons:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Update trending scores for all salons (called by scheduled job)
 */
async function updateAllTrendingScores() {
  try {
    const { data, error } = await supabase.rpc('update_all_trending_scores');

    if (error) throw error;

    console.log('✅ Successfully updated trending scores for all salons');
    return { success: true, message: 'Trending scores updated successfully' };
  } catch (error) {
    console.error('Error updating trending scores:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get salon analytics summary
 */
async function getSalonAnalytics(salonId) {
  try {
    const { data, error } = await supabase
      .from('salon_analytics_summary')
      .select('*')
      .eq('id', salonId)
      .single();

    if (error) throw error;

    return { success: true, data };
  } catch (error) {
    console.error('Error getting salon analytics:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Helper: Calculate distance between two coordinates (Haversine formula)
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return degrees * (Math.PI / 180);
}

module.exports = {
  trackSalonView,
  getSalonViewStats,
  getTrendingSalons,
  getNewSalons,
  getFeaturedSalons,
  getPopularSalons,
  updateAllTrendingScores,
  getSalonAnalytics,
};

