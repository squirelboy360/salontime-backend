const { supabaseAdmin } = require('../config/database');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

// Get user's favorite salons
const getFavorites = asyncHandler(async (req, res) => {
  try {
    console.log('🔍 Fetching favorites for user:', req.user?.id);
    
    if (!req.user || !req.user.id) {
      console.error('❌ No user in request');
      throw new AppError('User not authenticated', 401, 'UNAUTHORIZED');
    }

    const userId = req.user.id;
    console.log('🔍 User ID:', userId);
    
    const { data: favorites, error } = await supabaseAdmin
      .from('user_favorites')
      .select(`
        *,
        salons (
          id,
          business_name,
          description,
          address,
          city,
          state,
          zip_code,
          country,
          phone,
          email,
          images,
          rating_average,
          rating_count,
          is_active,
          owner_id,
          created_at,
          updated_at,
          is_featured,
          featured_until,
          trending_score,
          view_count,
          business_hours,
          latitude,
          longitude
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Supabase error fetching favorites:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      throw new AppError(`Failed to fetch favorites: ${error.message} (code: ${error.code})`, 500, 'FAVORITES_FETCH_FAILED');
    }

    console.log(`✅ Found ${(favorites || []).length} favorites`);

    // Handle empty favorites
    if (!favorites || favorites.length === 0) {
      return res.status(200).json({
        success: true,
        data: []
      });
    }

    // Use coordinates from database - DO NOT geocode on read requests
    // Salons already have coordinates stored from creation/update
    res.status(200).json({
      success: true,
      data: favorites
    });
  } catch (error) {
    console.error('❌ Error in getFavorites:', error);
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(`Failed to fetch favorites: ${error.message}`, 500, 'FAVORITES_FETCH_FAILED');
  }
});

// Add salon to favorites
const addFavorite = asyncHandler(async (req, res) => {
  const { salon_id, salonId } = req.body;
  const salonIdToUse = salon_id || salonId; // Support both field names

  if (!salonIdToUse) {
    throw new AppError('Salon ID is required', 400, 'MISSING_SALON_ID');
  }

  try {
    console.log('Adding favorite:', { user_id: req.user.id, salon_id: salonIdToUse });
    
    const { data, error } = await supabaseAdmin
      .from('user_favorites')
      .insert({
        user_id: req.user.id,
        salon_id: salonIdToUse
      })
      .select()
      .single();

    if (error) {
      console.error('Supabase error adding favorite:', error);
      if (error.code === '23505') { // Unique constraint violation
        throw new AppError('Salon is already in favorites', 409, 'ALREADY_FAVORITE');
      }
      throw new AppError(`Failed to add favorite: ${error.message}`, 500, 'FAVORITE_ADD_FAILED');
    }

    res.status(201).json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Error in addFavorite:', error);
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to add favorite', 500, 'FAVORITE_ADD_FAILED');
  }
});

// Remove salon from favorites
const removeFavorite = asyncHandler(async (req, res) => {
  const { salonId } = req.params;

  if (!salonId) {
    throw new AppError('Salon ID is required', 400, 'MISSING_SALON_ID');
  }

  try {
    const { error } = await supabaseAdmin
      .from('user_favorites')
      .delete()
      .eq('user_id', req.user.id)
      .eq('salon_id', salonId);

    if (error) {
      console.error('Supabase error removing favorite:', error);
      throw new AppError('Failed to remove favorite', 500, 'FAVORITE_REMOVE_FAILED');
    }

    res.status(200).json({
      success: true,
      message: 'Favorite removed successfully'
    });
  } catch (error) {
    console.error('Error in removeFavorite:', error);
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to remove favorite', 500, 'FAVORITE_REMOVE_FAILED');
  }
});

// Check if salon is favorited
const checkFavorite = asyncHandler(async (req, res) => {
  const { salonId } = req.params;

  if (!salonId) {
    throw new AppError('Salon ID is required', 400, 'MISSING_SALON_ID');
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('user_favorites')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('salon_id', salonId)
      .single();

    if (error && error.code !== 'PGRST116') { // Not found error
      console.error('Supabase error checking favorite:', error);
      throw new AppError('Failed to check favorite status', 500, 'FAVORITE_CHECK_FAILED');
    }

    res.status(200).json({
      success: true,
      data: {
        isFavorite: !!data
      }
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to check favorite status', 500, 'FAVORITE_CHECK_FAILED');
  }
});

module.exports = {
  getFavorites,
  addFavorite,
  removeFavorite,
  checkFavorite
};
