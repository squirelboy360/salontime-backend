const { supabase } = require('../config/database');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

class RecommendationService {
  // Generate embeddings for salon data
  generateSalonEmbeddings = asyncHandler(async (salonData) => {
    try {
      // Create salon description for embedding
      const description = `${salonData.business_name} ${salonData.description} ${salonData.services?.join(' ')} ${salonData.amenities?.join(' ')}`;
      
      // Generate embedding using Supabase AI
      const { data: embedding, error } = await supabase.functions.invoke('generate-embedding', {
        body: { text: description }
      });

      if (error) throw error;

      return embedding;
    } catch (error) {
      throw new AppError('Failed to generate salon embeddings', 500, 'EMBEDDING_GENERATION_FAILED');
    }
  });

  // Generate user preference embeddings
  generateUserEmbeddings = asyncHandler(async (userId) => {
    try {
      // Get user's booking history and preferences
      const { data: bookings, error: bookingsError } = await supabase
        .from('bookings')
        .select(`
          services (name, description),
          salons (business_name, description, services, amenities)
        `)
        .eq('client_id', userId)
        .eq('status', 'completed');

      if (bookingsError) throw bookingsError;

      // Create user preference description
      const preferences = bookings.map(booking => 
        `${booking.salons.business_name} ${booking.salons.description} ${booking.services.name}`
      ).join(' ');

      if (!preferences) {
        // Return default preferences for new users
        return await this.getDefaultUserEmbeddings();
      }

      // Generate embedding for user preferences
      const { data: embedding, error } = await supabase.functions.invoke('generate-embedding', {
        body: { text: preferences }
      });

      if (error) throw error;

      return embedding;
    } catch (error) {
      throw new AppError('Failed to generate user embeddings', 500, 'USER_EMBEDDING_FAILED');
    }
  });

  // Get default user embeddings for new users
  getDefaultUserEmbeddings = asyncHandler(async () => {
    try {
      const { data: embedding, error } = await supabase.functions.invoke('generate-embedding', {
        body: { text: 'beauty salon hair styling professional services' }
      });

      if (error) throw error;
      return embedding;
    } catch (error) {
      throw new AppError('Failed to generate default embeddings', 500, 'DEFAULT_EMBEDDING_FAILED');
    }
  });

  // Get personalized salon recommendations
  getRecommendations = asyncHandler(async (userId, limit = 10) => {
    try {
      // Get user embeddings
      const userEmbedding = await this.generateUserEmbeddings(userId);

      // Perform vector similarity search
      const { data: recommendations, error } = await supabase.rpc('match_salons', {
        query_embedding: userEmbedding,
        match_threshold: 0.7,
        match_count: limit
      });

      if (error) {
        console.error('❌ Error in match_salons RPC:', error);
        // If RPC function doesn't exist or embeddings aren't set up, return empty array
        // This allows the calling code to fall back to other methods
        if (error.code === '42883' || error.message?.includes('function') || error.message?.includes('does not exist')) {
          console.warn('⚠️ match_salons RPC function not available, returning empty recommendations');
          return [];
        }
        throw error;
      }

      return recommendations || [];
    } catch (error) {
      console.error('❌ Error in getRecommendations:', error);
      // Return empty array instead of throwing to allow fallback
      return [];
    }
  });

  // Update salon embeddings when salon data changes
  updateSalonEmbeddings = asyncHandler(async (salonId) => {
    try {
      // Get salon data
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('*')
        .eq('id', salonId)
        .single();

      if (salonError) throw salonError;

      // Generate new embeddings
      const embedding = await this.generateSalonEmbeddings(salon);

      // Update salon embeddings in database
      const { error: updateError } = await supabase
        .from('salon_embeddings')
        .upsert({
          salon_id: salonId,
          embedding: embedding,
          updated_at: new Date().toISOString()
        });

      if (updateError) throw updateError;

      return { success: true };
    } catch (error) {
      throw new AppError('Failed to update salon embeddings', 500, 'EMBEDDING_UPDATE_FAILED');
    }
  });

  // Track user interaction for better recommendations
  trackUserInteraction = asyncHandler(async (userId, salonId, interactionType, metadata = {}) => {
    try {
      const { error } = await supabase
        .from('user_interactions')
        .insert({
          user_id: userId,
          salon_id: salonId,
          interaction_type: interactionType, // 'view', 'book', 'cancel', 'review'
          metadata: metadata,
          created_at: new Date().toISOString()
        });

      if (error) throw error;

      return { success: true };
    } catch (error) {
      throw new AppError('Failed to track user interaction', 500, 'TRACKING_FAILED');
    }
  });

  // Get trending salons based on recent bookings
  getTrendingSalons = asyncHandler(async (limit = 10) => {
    try {
      const { data: trending, error } = await supabase
        .from('salons')
        .select(`
          *,
          bookings!inner(count),
          reviews(rating_average)
        `)
        .gte('bookings.created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .order('bookings.count', { ascending: false })
        .limit(limit);

      if (error) throw error;

      return trending;
    } catch (error) {
      throw new AppError('Failed to get trending salons', 500, 'TRENDING_FAILED');
    }
  });

  // Get nearby salons with recommendations
  getNearbyRecommendations = asyncHandler(async (userId, latitude, longitude, radius = 10, limit = 10) => {
    try {
      // Get personalized recommendations
      let recommendations;
      try {
        recommendations = await this.getRecommendations(userId, limit * 2); // Get more to filter by location
      } catch (recError) {
        console.error('❌ Error getting personalized recommendations, falling back to nearby salons:', recError);
        // Fallback: get nearby salons directly from database
        const { data: nearbySalons, error: nearbyError } = await supabase
          .from('salons')
          .select('*')
          .eq('is_active', true)
          .not('latitude', 'is', null)
          .not('longitude', 'is', null)
          .limit(limit * 2);
        
        if (nearbyError) {
          console.error('❌ Error fetching nearby salons as fallback:', nearbyError);
          return [];
        }
        
        recommendations = nearbySalons || [];
      }

      // Filter by location
      const nearbyRecommendations = recommendations
        .filter(salon => {
          if (!salon.latitude || !salon.longitude) return false;
          const distance = this.calculateDistance(
            latitude, longitude,
            salon.latitude, salon.longitude
          );
          return distance <= radius;
        })
        .slice(0, limit); // Limit to requested amount

      return nearbyRecommendations;
    } catch (error) {
      console.error('❌ Error in getNearbyRecommendations:', error);
      // Return empty array instead of throwing to allow fallback in controller
      return [];
    }
  });

  // Calculate distance between two coordinates
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
}

module.exports = new RecommendationService();
