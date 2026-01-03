const { supabaseAdmin } = require('../config/database');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

// Get user's favorite salons
const getFavorites = asyncHandler(async (req, res) => {
  try {
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
          latitude,
          longitude,
          phone,
          email,
          image_url,
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
          metadata
        )
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase error fetching favorites:', error);
      throw new AppError(`Failed to fetch favorites: ${error.message}`, 500, 'FAVORITES_FETCH_FAILED');
    }

    // Add coordinates to favorite salons
    const { geocodeSalons } = require('../utils/geocoding');
    const favoritesWithCoords = (favorites || []).map(fav => {
      if (fav.salons) {
        const salonArray = Array.isArray(fav.salons) ? fav.salons : [fav.salons];
        const geocodedSalons = geocodeSalons(salonArray);
        return {
          ...fav,
          salons: geocodedSalons[0] || fav.salons
        };
      }
      return fav;
    });

    res.status(200).json({
      success: true,
      data: favoritesWithCoords
    });
  } catch (error) {
    console.error('Error in getFavorites:', error);
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to fetch favorites', 500, 'FAVORITES_FETCH_FAILED');
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

