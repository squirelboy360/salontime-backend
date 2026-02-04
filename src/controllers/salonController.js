const crypto = require('crypto');
const { supabase, supabaseAdmin } = require('../config/database');
const stripeService = require('../services/stripeService');
const supabaseService = require('../services/supabaseService');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const config = require('../config');

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function generateJoinCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** Parse "HH:mm" to [hour, minute]. Handles invalid values. */
function parseClosingTime(str) {
  if (!str || typeof str !== 'string') return [17, 0];
  const parts = str.trim().split(':');
  const hour = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
  const minute = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
  return [hour, minute];
}

/**
 * Clear clocked_in_at for staff who are past their salon's closing time (auto clock-out).
 * Uses salon business_hours; if current time (UTC) is past closing for the day they clocked in, clear.
 */
async function clearStaleClockInsForSalon(salonId, businessHours, staffRows) {
  if (!staffRows?.length || !businessHours || typeof businessHours !== 'object') return staffRows;
  const now = new Date();
  const updated = [];
  for (const s of staffRows) {
    if (!s.clocked_in_at) {
      updated.push(s);
      continue;
    }
    const clockedIn = new Date(s.clocked_in_at);
    const dayIndex = clockedIn.getUTCDay();
    const dayKey = DAY_KEYS[dayIndex];
    const dayHours = businessHours[dayKey];
    if (dayHours?.closed) {
      await supabaseAdmin.from('staff').update({ clocked_in_at: null }).eq('id', s.id);
      updated.push({ ...s, clocked_in_at: null });
      continue;
    }
    const closingStr = dayHours?.closing ?? dayHours?.close ?? '17:00';
    const [closeHour, closeMinute] = parseClosingTime(closingStr);
    const closingAt = new Date(clockedIn);
    closingAt.setUTCHours(closeHour, closeMinute, 0, 0);
    if (closeHour < 6) closingAt.setUTCDate(closingAt.getUTCDate() + 1);
    if (now >= closingAt) {
      await supabaseAdmin.from('staff').update({ clocked_in_at: null }).eq('id', s.id);
      updated.push({ ...s, clocked_in_at: null });
    } else {
      updated.push(s);
    }
  }
  return updated;
}

class SalonController {
  // Create salon profile
  createSalon = asyncHandler(async (req, res) => {
    const {
      business_name,
      description,
      address,
      city,
      state,
      zip_code,
      country,
      phone,
      email,
      business_hours,
      latitude: providedLatitude,
      longitude: providedLongitude
    } = req.body;

    // Validate required fields
    if (!business_name) {
      throw new AppError('Business name is required', 400, 'MISSING_BUSINESS_NAME');
    }
    if (!city) {
      throw new AppError('City is required', 400, 'MISSING_CITY');
    }
    if (!state) {
      throw new AppError('State is required', 400, 'MISSING_STATE');
    }
    if (!zip_code) {
      throw new AppError('Zip code is required', 400, 'MISSING_ZIP_CODE');
    }

    try {
      // Debug logging
      console.log('Salon creation request:', {
        userId: req.user.id,
        businessName: business_name,
        city: city,
        state: state,
        zipCode: zip_code
      });

      // Check if user already has a salon
      const { data: existingSalon, error: existingSalonError } = await supabase
        .from('salons')
        .select('id')
        .eq('owner_id', req.user.id)
        .single();

      console.log('Existing salon check:', {
        existingSalon: existingSalon,
        existingSalonError: existingSalonError
      });

      if (existingSalon) {
        throw new AppError('User already has a salon registered', 409, 'SALON_ALREADY_EXISTS');
      }

      // Get coordinates: use provided coordinates from frontend, or geocode if not provided
      const { geocodeAddress } = require('../utils/geocoding');
      let latitude = null;
      let longitude = null;
      
      // If frontend provided coordinates, use them
      if (providedLatitude !== undefined && providedLongitude !== undefined && 
          !isNaN(parseFloat(providedLatitude)) && !isNaN(parseFloat(providedLongitude))) {
        latitude = parseFloat(providedLatitude);
        longitude = parseFloat(providedLongitude);
        console.log('✅ Using coordinates from frontend:', latitude, longitude);
      } else if (address && city) {
        // Otherwise, geocode the address
        console.log('🌍 Geocoding address for salon creation...');
        const coords = await geocodeAddress(address, city, zip_code, country || 'NL');
        if (coords) {
          latitude = coords.latitude;
          longitude = coords.longitude;
          console.log('✅ Geocoded coordinates:', latitude, longitude);
        } else {
          console.log('⚠️ Geocoding failed, salon will be created without coordinates');
        }
      }

      // Create salon record (use admin client to bypass RLS)
      const { data: salon, error } = await supabaseAdmin
        .from('salons')
        .insert([{
          owner_id: req.user.id,
          business_name,
          description,
          address,
          city,
          state,
          zip_code,
          country: country || 'US',
          phone,
          email,
          business_hours,
          latitude,
          longitude
        }])
        .select()
        .single();

      console.log('Salon creation result:', {
        salon: salon,
        error: error
      });

      if (error) {
        console.error('Database insert error:', error);
        throw new AppError('Failed to create salon', 500, 'SALON_CREATION_FAILED');
      }

      // Automatically create Stripe Connect account for the salon
      let stripeAccountData = null;
      let onboardingUrl = null;

      try {
        // Get user profile for Stripe account creation
        const { data: userProfile } = await supabase
          .from('user_profiles')
          .select('*')
          .eq('id', req.user.id)
          .single();

        // Create Stripe Connect account
        const stripeAccount = await stripeService.createConnectAccount({
          business_name: salon.business_name,
          salon_id: salon.id,
          owner_id: req.user.id,
          email: email || userProfile?.email,
          country: salon.country || 'US',
          business_type: req.body.business_type || 'individual'
        });

        // Update salon with Stripe account ID
        await supabaseAdmin
          .from('salons')
          .update({
            stripe_account_id: stripeAccount.id,
            stripe_account_status: 'pending'
          })
          .eq('id', salon.id);

        // Create Stripe account record in database
        await supabaseAdmin
          .from('stripe_accounts')
          .insert([{
            salon_id: salon.id,
            stripe_account_id: stripeAccount.id,
            account_status: 'pending',
            onboarding_completed: false
          }]);

        // Generate onboarding link for immediate setup
        // Redirect to web app root - it will route salon owners to their dashboard
        const returnUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}`;
        const refreshUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}`;

        const accountLink = await stripeService.createAccountLink(
          stripeAccount.id,
          returnUrl,
          refreshUrl
        );

        stripeAccountData = {
          stripe_account_id: stripeAccount.id,
          account_status: 'pending',
          onboarding_completed: false
        };

        onboardingUrl = accountLink.url;

      } catch (stripeError) {
        console.error('Stripe account creation failed during salon setup:', stripeError);
        // Don't fail salon creation if Stripe setup fails - salon owner can set it up later
      }

      res.status(201).json({
        success: true,
        data: {
          salon: {
            ...salon,
            stripe_account_id: stripeAccountData?.stripe_account_id || null,
            stripe_account_status: stripeAccountData?.account_status || null
          },
          stripe_setup: {
            required: true,
            account_created: !!stripeAccountData,
            onboarding_url: onboardingUrl,
            message: stripeAccountData
              ? 'Stripe account created. Complete onboarding to receive payments.'
              : 'Salon created successfully. Set up Stripe account to receive payments.'
          }
        }
      });

    } catch (error) {
      console.error('Salon creation error:', error);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to create salon', 500, 'SALON_CREATION_FAILED');
    }
  });

  // Get salon profile
  getSalon = asyncHandler(async (req, res) => {
    const { salonId } = req.params;

    try {
      const { data: salon, error } = await supabase
        .from('salons')
        .select('*')
        .eq('id', salonId)
        .eq('is_active', true)
        .single();

      if (error || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Use coordinates from database - DO NOT geocode on read requests
      // Coordinates are stored during salon creation/update
      res.status(200).json({
        success: true,
        data: salon  // Return salon data directly, not wrapped in { salon: ... }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch salon', 500, 'SALON_FETCH_FAILED');
    }
  });

  // Get current user's salon
  getMySalon = asyncHandler(async (req, res) => {
    try {
      console.log('Looking for salon with owner_id:', req.user.id);

      const { data: salon, error } = await supabaseAdmin
        .from('salons')
        .select('*')
        .eq('owner_id', req.user.id)
        .single();

      console.log('Salon query result:', { salon, error });

      if (error || !salon) {
        // Let's also check what salons exist in the database
        const { data: allSalons, error: allSalonsError } = await supabaseAdmin
          .from('salons')
          .select('id, owner_id, business_name')
          .limit(5);

        console.log('All salons in database:', { allSalons, allSalonsError });
        throw new AppError('No salon found for this user', 404, 'SALON_NOT_FOUND');
      }

      // Normalize business hours - remove old 'close' field and ensure consistent format
      if (salon.business_hours && typeof salon.business_hours === 'object') {
        const businessHours = salon.business_hours;
        const normalizedBusinessHours = {};
        for (const [day, hours] of Object.entries(businessHours)) {
          if (hours && typeof hours === 'object') {
            normalizedBusinessHours[day] = {
              opening: hours.opening || null,
              closing: hours.closing || hours.close || null, // Use closing, fallback to close
              closed: hours.closed === true || hours.closed === 'true'
            };
          }
        }
        salon.business_hours = normalizedBusinessHours;
      }

      res.status(200).json({
        success: true,
        data: { salon }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch salon', 500, 'SALON_FETCH_FAILED');
    }
  });

  // Update salon profile
  updateSalon = asyncHandler(async (req, res) => {
    const {
      business_name,
      description,
      address,
      city,
      state,
      zip_code,
      phone,
      email,
      website,
      business_hours,
      amenities,
      images,
      latitude: providedLatitude,
      longitude: providedLongitude,
      whatsapp_phone_number_id
    } = req.body;

    try {
      // Get coordinates: use provided coordinates from frontend, or geocode if not provided
      let latitude = undefined;
      let longitude = undefined;
      
      // If frontend provided coordinates, use them
      if (providedLatitude !== undefined && providedLongitude !== undefined && 
          !isNaN(parseFloat(providedLatitude)) && !isNaN(parseFloat(providedLongitude))) {
        latitude = parseFloat(providedLatitude);
        longitude = parseFloat(providedLongitude);
        console.log('✅ Using coordinates from frontend:', latitude, longitude);
      } else if (address !== undefined || city !== undefined) {
        // Otherwise, geocode address if address or city changed
        // Get current salon to use existing values if not provided
        const { data: currentSalon } = await supabaseAdmin
          .from('salons')
          .select('address, city, zip_code, country')
          .eq('owner_id', req.user.id)
          .single();
        
        const addressToGeocode = address !== undefined ? address : (currentSalon?.address || '');
        const cityToGeocode = city !== undefined ? city : (currentSalon?.city || '');
        const zipCodeToGeocode = req.body.zip_code !== undefined ? req.body.zip_code : (currentSalon?.zip_code || '');
        const countryToGeocode = req.body.country !== undefined ? req.body.country : (currentSalon?.country || 'NL');
        
        if (addressToGeocode && cityToGeocode) {
          console.log('🌍 Geocoding address for salon update...');
          const { geocodeAddress } = require('../utils/geocoding');
          const coords = await geocodeAddress(addressToGeocode, cityToGeocode, zipCodeToGeocode, countryToGeocode);
          if (coords) {
            latitude = coords.latitude;
            longitude = coords.longitude;
            console.log('✅ Geocoded coordinates:', latitude, longitude);
          } else {
            console.log('⚠️ Geocoding failed, coordinates will not be updated');
          }
        }
      }

      const updateData = {
        business_name,
        description,
        address,
        city,
        zip_code,
        phone,
        email,
        website,
        updated_at: new Date().toISOString()
      };

      // Only update business_hours when explicitly provided (avoids overwriting with null)
      if (business_hours !== undefined) updateData.business_hours = business_hours;

      // Add coordinates if geocoded
      if (latitude !== undefined) updateData.latitude = latitude;
      if (longitude !== undefined) updateData.longitude = longitude;

      // Add optional fields if provided
      if (state !== undefined) updateData.state = state;
      if (amenities !== undefined) updateData.amenities = amenities;
      if (images !== undefined) updateData.images = images;
      if (whatsapp_phone_number_id !== undefined) updateData.whatsapp_phone_number_id = whatsapp_phone_number_id || null;

      const { data: salon, error } = await supabaseAdmin
        .from('salons')
        .update(updateData)
        .eq('owner_id', req.user.id)
        .select()
        .single();

      if (error || !salon) {
        throw new AppError('Failed to update salon or salon not found', 400, 'SALON_UPDATE_FAILED');
      }

      res.status(200).json({
        success: true,
        data: { salon }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to update salon', 500, 'SALON_UPDATE_FAILED');
    }
  });

  // Search salons with comprehensive filtering - ALL FILTERS APPLIED AT DATABASE LEVEL
  searchSalons = asyncHandler(async (req, res) => {
    const {
      q, // search query
      search, // alias for q
      location,
      city,
      latitude,
      lat,
      longitude,
      lng,
      min_rating,
      minRating,
      max_distance,
      maxDistance,
      min_distance,
      minDistance,
      services,
      service, // single service (backward compatibility)
      sort, // sortBy: distance, rating, name, created_at
      sortBy,
      featured,
      trending,
      new_only,
      newOnly,
      popular_only,
      popularOnly,
      open_now,
      openNow,
      page = 1,
      limit = 50
    } = req.query;

    // Validate and parse pagination parameters
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const validLimit = Math.min(Math.max(limitNum, 1), 100); // Clamp between 1 and 100
    const offset = (Math.max(pageNum, 1) - 1) * validLimit;
    
    const searchQuery = q || search;
    
    // Parse and validate numeric values, defaulting to null/0 if invalid
    const userLatRaw = parseFloat(latitude || lat);
    const userLngRaw = parseFloat(longitude || lng);
    const userLat = !isNaN(userLatRaw) && isFinite(userLatRaw) ? userLatRaw : null;
    const userLng = !isNaN(userLngRaw) && isFinite(userLngRaw) ? userLngRaw : null;
    
    const minRatingFilterRaw = parseFloat(min_rating || minRating || 0);
    const minRatingFilter = !isNaN(minRatingFilterRaw) && isFinite(minRatingFilterRaw) && minRatingFilterRaw > 0 ? minRatingFilterRaw : 0;
    
    const maxDistanceFilterRaw = parseFloat(max_distance || maxDistance || 1000);
    const maxDistanceFilter = !isNaN(maxDistanceFilterRaw) && isFinite(maxDistanceFilterRaw) && maxDistanceFilterRaw > 0 ? maxDistanceFilterRaw : 1000;
    
    const minDistanceFilterRaw = parseFloat(min_distance || minDistance || 0);
    const minDistanceFilter = !isNaN(minDistanceFilterRaw) && isFinite(minDistanceFilterRaw) && minDistanceFilterRaw >= 0 ? minDistanceFilterRaw : 0;
    
    const sortByValue = sort || sortBy || 'distance';

    // Helper function to calculate distance (for sorting/final distance calculation)
    const calculateDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371; // Earth's radius in km
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    // Helper to calculate bounding box for distance filtering (approximation)
    // This allows us to filter at DB level before calculating exact distance
    const getBoundingBox = (lat, lng, radiusKm) => {
      const latDelta = radiusKm / 111; // ~111 km per degree latitude
      const lngDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
      return {
        minLat: lat - latDelta,
        maxLat: lat + latDelta,
        minLng: lng - lngDelta,
        maxLng: lng + lngDelta
      };
    };

    try {
      // Build base query with all DB-level filters
      let query = supabase
        .from('salons')
        .select('*')
        .eq('is_active', true);

      // Text search - use OR for multiple fields at DB level
      // Supabase or() syntax: field.operator.value,field2.operator.value2
      // For ilike with wildcards, use % for pattern matching
      if (searchQuery && searchQuery.trim().length > 0) {
        // Escape special characters that could break the query (%, _ are SQL wildcards)
        // We escape user input % and _ so they don't interfere with our wildcard pattern
        const escapedQuery = String(searchQuery)
          .replace(/\\/g, '\\\\')  // Escape backslashes first
          .replace(/%/g, '\\%')    // Escape % in user input
          .replace(/_/g, '\\_');   // Escape _ in user input
        
        const searchPattern = `%${escapedQuery}%`;
        
        console.log('🔍 Search query:', searchQuery);
        console.log('🔍 Escaped query:', escapedQuery);
        console.log('🔍 Search pattern:', searchPattern);
        
        // Use Supabase's or() to search across multiple fields: name, description, city, address
        // So users can search by salon name (e.g. "echt"), city, or location text
        query = query.or(`business_name.ilike.${searchPattern},description.ilike.${searchPattern},city.ilike.${searchPattern},address.ilike.${searchPattern}`);
        
        console.log('🔍 Applied search filter with pattern:', searchPattern);
      }

      // Location/City filter
      if (location || city) {
        const locationValue = location || city;
        query = query.ilike('city', `%${locationValue}%`);
      }

      // Rating filter
      if (minRatingFilter > 0) {
        query = query.gte('rating_average', minRatingFilter);
      }

      // Featured filter
      if (featured === 'true' || featured === true) {
        const now = new Date().toISOString();
        // Use proper Supabase or() syntax for date comparison
        query = query.eq('is_featured', true)
          .or(`featured_until.is.null,featured_until.gte.${now}`);
      }

      // Trending filter
      if (trending === 'true' || trending === true) {
        query = query.gt('trending_score', 0);
      }

      // New salons filter
      if (new_only === 'true' || newOnly === 'true' || new_only === true || newOnly === true) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        query = query.gte('created_at', thirtyDaysAgo.toISOString());
      }

      // Popular filter
      if (popular_only === 'true' || popularOnly === 'true' || popular_only === true || popularOnly === true) {
        query = query.gte('rating_average', 4.5)
          .gte('rating_count', 10);
      }

      // Distance filtering using bounding box (DB level)
      // This is an approximation but much faster than fetching all salons
      if (userLat !== null && userLng !== null && !isNaN(userLat) && !isNaN(userLng) && (maxDistanceFilter < 1000 || minDistanceFilter > 0)) {
        const box = getBoundingBox(userLat, userLng, maxDistanceFilter);
        query = query
          .gte('latitude', box.minLat)
          .lte('latitude', box.maxLat)
          .gte('longitude', box.minLng)
          .lte('longitude', box.maxLng)
          .not('latitude', 'is', null)
          .not('longitude', 'is', null);
      }

      // Service filtering - fetch matching salon IDs first, then filter main query
      // Only use explicit services/service params here. Do NOT use searchQuery as service filter
      // (searchQuery is for name/city/description text search above) so e.g. "echt" finds salons
      // with "echt" in business_name instead of requiring a service named "echt"
      let serviceFilteredSalonIds = null;
      if (services || service) {
        const serviceList = services ? services.split(',') : (service ? [service] : []);
        const allServiceFilters = [...serviceList];

        if (allServiceFilters.length > 0) {
          // First, try to find matching category IDs from service_categories table
          const serviceNames = allServiceFilters.map(s => s.toLowerCase().trim());
          const matchingSalonIds = new Set();
          
          // Query service_categories directly to find matching categories
          const { data: matchingCategories, error: categoryError } = await supabase
            .from('service_categories')
            .select('id, name, slug')
            .eq('is_active', true);
          
          const categoryIds = new Set();
          if (!categoryError && matchingCategories) {
            matchingCategories.forEach(cat => {
              const catName = (cat.name || '').toLowerCase();
              const catSlug = (cat.slug || '').toLowerCase();
              
              serviceNames.forEach(filterName => {
                if (catName.includes(filterName) || catSlug.includes(filterName)) {
                  categoryIds.add(cat.id);
                  console.log(`✅ Category match: "${cat.name}" (slug: ${catSlug}) matches "${filterName}"`);
                }
              });
            });
          }
          
          // Fetch all active services to find matching salons
          const { data: allServices, error: servicesError } = await supabase
            .from('services')
            .select('salon_id, name, category_id, service_categories(name, slug)')
            .eq('is_active', true);

          if (servicesError) {
            console.error('❌ Error fetching services for filtering:', servicesError);
          }

          if (!servicesError && allServices) {
            console.log(`🔍 Service filtering: Looking for ${serviceNames.join(', ')} in ${allServices.length} services`);
            console.log(`🔍 Found ${categoryIds.size} matching category IDs: ${Array.from(categoryIds).join(', ')}`);
            
            allServices.forEach(svc => {
              const svcName = (svc.name || '').toLowerCase();
              const svcCategory = (svc.service_categories?.name || '').toLowerCase();
              const svcCategorySlug = (svc.service_categories?.slug || '').toLowerCase();
              
              // Check if service's category_id matches any of our found category IDs
              const matchesCategoryId = svc.category_id && categoryIds.has(svc.category_id);
              
              serviceNames.forEach(filterName => {
                // Check service name, category name, category slug, or category ID match
                if (svcName.includes(filterName) || 
                    svcCategory.includes(filterName) || 
                    svcCategorySlug.includes(filterName) ||
                    matchesCategoryId) {
                  matchingSalonIds.add(svc.salon_id);
                  console.log(`✅ Match found: Service "${svc.name}" (category: ${svc.service_categories?.name || 'none'}, slug: ${svcCategorySlug || 'none'}, category_id: ${svc.category_id}) matches "${filterName}" for salon ${svc.salon_id}`);
                }
              });
            });
            
            console.log(`🔍 Found ${matchingSalonIds.size} matching salons for service filter`);
            
            if (matchingSalonIds.size > 0) {
              serviceFilteredSalonIds = Array.from(matchingSalonIds);
              query = query.in('id', serviceFilteredSalonIds);
            } else {
              // No matching services, return empty result
              console.log('⚠️ No matching services found, returning empty result');
              query = query.eq('id', '00000000-0000-0000-0000-000000000000');
            }
          } else if (!allServices) {
            console.log('⚠️ No services found in database');
            query = query.eq('id', '00000000-0000-0000-0000-000000000000');
          }
        }
      }

      // Price filtering - fetch services first, then filter salons
      const minPriceFilterRaw = parseFloat(req.query.min_price || req.query.minPrice || 0);
      const maxPriceFilterRaw = parseFloat(req.query.max_price || req.query.maxPrice || 10000);
      const minPriceFilter = !isNaN(minPriceFilterRaw) && minPriceFilterRaw >= 0 ? minPriceFilterRaw : 0;
      const maxPriceFilter = !isNaN(maxPriceFilterRaw) && maxPriceFilterRaw > 0 ? maxPriceFilterRaw : 10000;
      
      let priceFilteredSalonIds = null;
      if (minPriceFilter > 0 || maxPriceFilter < 10000) {
        // Get salon IDs to check (either from service filter or all salons)
        const salonsToCheck = serviceFilteredSalonIds || null;
        
        // Fetch services for price range check
        let priceQuery = supabase
          .from('services')
          .select('salon_id, price')
          .eq('is_active', true);
        
        if (salonsToCheck) {
          priceQuery = priceQuery.in('salon_id', salonsToCheck);
        }

        const { data: allServices, error: priceError } = await priceQuery;
        
        if (!priceError && allServices && allServices.length > 0) {
          // Group services by salon to calculate price ranges
          const salonPriceRanges = {};
          allServices.forEach(svc => {
            const salonId = svc.salon_id;
            if (!salonPriceRanges[salonId]) {
              salonPriceRanges[salonId] = { min: svc.price, max: svc.price };
            } else {
              salonPriceRanges[salonId].min = Math.min(salonPriceRanges[salonId].min, svc.price);
              salonPriceRanges[salonId].max = Math.max(salonPriceRanges[salonId].max, svc.price);
            }
          });

          // Filter salons where price range overlaps with filter
          const finalSalonIds = [];
          Object.keys(salonPriceRanges).forEach(salonId => {
            const range = salonPriceRanges[salonId];
            // Salon matches if its price range overlaps with filter range
            if (range.min <= maxPriceFilter && range.max >= minPriceFilter) {
              finalSalonIds.push(salonId);
            }
          });

          if (finalSalonIds.length > 0) {
            priceFilteredSalonIds = finalSalonIds;
            // Combine with service filter if both exist
            if (serviceFilteredSalonIds) {
              const combinedIds = serviceFilteredSalonIds.filter(id => finalSalonIds.includes(id));
              query = query.in('id', combinedIds.length > 0 ? combinedIds : ['00000000-0000-0000-0000-000000000000']);
            } else {
              query = query.in('id', finalSalonIds);
            }
          } else {
            query = query.eq('id', '00000000-0000-0000-0000-000000000000');
          }
        } else if (minPriceFilter > 0 || maxPriceFilter < 10000) {
          query = query.eq('id', '00000000-0000-0000-0000-000000000000');
        }
      }

      // Apply sorting at DB level
      switch (sortByValue.toLowerCase()) {
        case 'rating':
          query = query.order('rating_average', { ascending: false })
            .order('rating_count', { ascending: false });
          break;
        case 'name':
          query = query.order('business_name', { ascending: true });
          break;
        case 'created_at':
        case 'newest':
          query = query.order('created_at', { ascending: false });
          break;
        case 'distance':
        default:
          if (userLat !== null && userLng !== null && !isNaN(userLat) && !isNaN(userLng)) {
            // Will sort by distance after fetching
            query = query.order('rating_average', { ascending: false });
          } else {
            query = query.order('rating_average', { ascending: false })
              .order('rating_count', { ascending: false });
          }
      }

      // Apply limit and offset at DB level
      // Note: We fetch more than needed to account for post-filtering (distance, open_now)
      // This ensures we have enough results after final filtering
      // Strategy: Always fetch from offset 0 for early pages to build up filtered results
      // For later pages, we still fetch from 0 but with a larger limit to cover more pages
      // This is simpler and works well for lazy loading where users typically don't go too deep
      const bufferMultiplier = 5; // Fetch 5x to account for filtering reducing results
      const fetchLimit = Math.max(validLimit * bufferMultiplier * (pageNum + 1), 200); // Fetch enough for current page + buffer
      // Always start from 0 for consistent filtering and pagination
      // The filtered results will be paginated in memory
      const fetchOffset = 0;
      query = query.range(fetchOffset, fetchOffset + fetchLimit - 1);

      const { data: salons, error } = await query;

      if (error) {
        console.error('❌ Database query error:', error);
        console.error('❌ Error details:', {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
          searchQuery: searchQuery,
          filters: {
            minRating: minRatingFilter,
            maxDistance: maxDistanceFilter,
            sort: sortByValue,
            userLat,
            userLng
          }
        });
        throw new AppError(`Failed to search salons: ${error.message}`, 500, 'SALON_SEARCH_FAILED');
      }

      // Use coordinates from database - DO NOT geocode on read requests
      // Geocoding only happens during salon creation/update
      const salonsWithCoords = salons || [];

      // Calculate exact distances and apply final distance filter (for accuracy)
      let filteredSalons = salonsWithCoords;
      if (userLat !== null && userLng !== null && !isNaN(userLat) && !isNaN(userLng)) {
        filteredSalons = salonsWithCoords.map(salon => {
          if (salon.latitude && salon.longitude && !isNaN(salon.latitude) && !isNaN(salon.longitude)) {
            const distance = calculateDistance(userLat, userLng, salon.latitude, salon.longitude);
            return { ...salon, distance };
          }
          return salon;
        });

        // Apply exact distance filter (refinement after bounding box)
        if (maxDistanceFilter < 1000 || minDistanceFilter > 0) {
          filteredSalons = filteredSalons.filter(salon => {
            if (!salon.distance || isNaN(salon.distance)) return false; // Exclude salons without valid coordinates
            return salon.distance >= minDistanceFilter && salon.distance <= maxDistanceFilter;
          });
        }

        // Sort by distance if requested
        if (sortByValue.toLowerCase() === 'distance') {
          filteredSalons.sort((a, b) => {
            const distA = a.distance && !isNaN(a.distance) ? a.distance : 9999;
            const distB = b.distance && !isNaN(b.distance) ? b.distance : 9999;
            return distA - distB;
          });
        }
      }

      // Filter by open_now (business hours check - requires JSON parsing)
      if (open_now === 'true' || openNow === 'true' || open_now === true || openNow === true) {
        const now = new Date();
        const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        
            filteredSalons = filteredSalons.filter(salon => {
          if (!salon.business_hours) return false;
          const dayHours = salon.business_hours[dayOfWeek];
          if (!dayHours || dayHours.closed === true || dayHours.closed === 'true') return false;
          const openTime = dayHours.open || dayHours.opening;
          const closeTime = dayHours.close || dayHours.closing;
          if (!openTime || !closeTime) return false;
          return currentTime >= openTime && currentTime <= closeTime;
        });
      }

      // Apply pagination after all filtering
      // Since we always fetch from offset 0, we can directly slice the filtered results
      // The filtered results are already sorted and filtered, so we just need to paginate them
      const paginatedSalons = offset < filteredSalons.length
        ? filteredSalons.slice(offset, offset + validLimit)
        : []; // Return empty if offset is beyond filtered results
      
      // For hasMore, check if there are more results after the current page
      // Since we fetched a large batch, if we're near the end, there might be more in the DB
      const hasMore = paginatedSalons.length === validLimit && (offset + validLimit < filteredSalons.length || filteredSalons.length >= fetchLimit);
      
      // Estimate total based on filtered results
      // If we got a full batch and there might be more, estimate higher
      const estimatedTotal = hasMore 
        ? Math.max(filteredSalons.length, offset + validLimit + 50)
        : filteredSalons.length;

      console.log(`✅ Found ${filteredSalons.length} salons after filtering (fetched ${fetchLimit} from offset ${fetchOffset})`);
      console.log(`📄 Returning ${paginatedSalons.length} salons for page ${pageNum} (offset: ${offset}, total filtered: ${filteredSalons.length}, hasMore: ${hasMore})`);

      res.status(200).json({
        success: true,
        data: paginatedSalons,
        pagination: {
          page: pageNum,
          limit: validLimit,
          total: estimatedTotal,
          hasMore: hasMore
        }
      });

    } catch (error) {
      console.error('❌ Search salons error:', error);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to search salons', 500, 'SALON_SEARCH_FAILED');
    }
  });

  // Create Stripe Connect account
  createStripeAccount = asyncHandler(async (req, res) => {
    try {
      // Get user's salon
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('*')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found. Create a salon profile first.', 404, 'SALON_NOT_FOUND');
      }

      if (!salon.country) {
        throw new AppError('Country is required for Stripe account creation. Please update your salon address.', 400, 'MISSING_COUNTRY');
      }

      // Check if Stripe account already exists
      if (salon.stripe_account_id) {
        throw new AppError('Stripe account already exists for this salon', 409, 'STRIPE_ACCOUNT_EXISTS');
      }

      // Create Stripe Connect account
      const stripeAccount = await stripeService.createConnectAccount({
        business_name: salon.business_name,
        salon_id: salon.id,
        owner_id: req.user.id,
        country: salon.country
      });

      // Update salon with Stripe account ID
      console.log('Updating salon with Stripe account ID:', stripeAccount.id);
      console.log('Salon ID:', salon.id);

      // First, let's check if the salon exists with this ID
      const { data: checkSalon, error: checkError } = await supabaseAdmin
        .from('salons')
        .select('id, stripe_account_id, stripe_account_status')
        .eq('id', salon.id);

      console.log('Salon check result:', { checkSalon, checkError });

      const { data: updateData, error: updateError } = await supabaseAdmin
        .from('salons')
        .update({
          stripe_account_id: stripeAccount.id,
          stripe_account_status: 'pending'
        })
        .eq('id', salon.id)
        .select('id, stripe_account_id, stripe_account_status');

      console.log('Salon update result:', { updateData, updateError });

      if (updateError) {
        console.error('Salon update error:', updateError);
        throw new AppError('Failed to update salon with Stripe account', 500, 'SALON_UPDATE_FAILED');
      }

      // Create Stripe account record
      await supabaseAdmin
        .from('stripe_accounts')
        .insert([{
          salon_id: salon.id,
          stripe_account_id: stripeAccount.id,
          account_status: 'pending',
          onboarding_completed: false
        }]);

      res.status(201).json({
        success: true,
        data: {
          stripe_account_id: stripeAccount.id,
          message: 'Stripe Connect account created successfully'
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to create Stripe account', 500, 'STRIPE_ACCOUNT_CREATION_FAILED');
    }
  });

  // Generate Stripe onboarding link
  generateStripeOnboardingLink = asyncHandler(async (req, res) => {
    try {
      // Get user's salon
      const { data: salon, error: salonError } = await supabaseAdmin
        .from('salons')
        .select('*')
        .eq('owner_id', req.user.id)
        .single();

      console.log('Salon lookup result:', { salon, salonError });
      console.log('User ID:', req.user.id);

      if (salonError) {
        console.error('Salon lookup error:', salonError);
        throw new AppError(`Salon lookup failed: ${salonError.message}`, 404, 'SALON_NOT_FOUND');
      }

      if (!salon) {
        console.error('No salon found for user:', req.user.id);
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      let stripeAccountId = salon.stripe_account_id;

      // If no Stripe account ID or account doesn't exist in current Stripe project, create a new one
      if (!stripeAccountId) {
        console.log('No Stripe account ID found, creating new account...');
        // Create new Stripe Connect account
        const { data: userProfile } = await supabaseAdmin
          .from('user_profiles')
          .select('*')
          .eq('id', req.user.id)
          .single();

        const stripeAccount = await stripeService.createConnectAccount({
          business_name: salon.business_name,
          salon_id: salon.id,
          owner_id: req.user.id,
          email: salon.email || userProfile?.email,
          country: salon.country || 'NL',
          business_type: 'individual'
        });

        // Update salon with new Stripe account ID
        await supabaseAdmin
          .from('salons')
          .update({
            stripe_account_id: stripeAccount.id,
            stripe_account_status: 'pending'
          })
          .eq('id', salon.id);

        // Create or update Stripe account record
        await supabaseAdmin
          .from('stripe_accounts')
          .upsert({
            salon_id: salon.id,
            stripe_account_id: stripeAccount.id,
            account_status: 'pending',
            onboarding_completed: false,
            country: salon.country || 'NL',
            updated_at: new Date().toISOString()
          });

        stripeAccountId = stripeAccount.id;
        console.log('✅ Created new Stripe account:', stripeAccountId);
      } else {
        // Verify the account exists in Stripe
        try {
          await stripeService.getAccountStatus(stripeAccountId);
          console.log('✅ Existing Stripe account verified:', stripeAccountId);
        } catch (error) {
          console.warn('⚠️ Stripe account not found in current project, creating new one...', error.message);
          
          // Account doesn't exist, create a new one
          const { data: userProfile } = await supabaseAdmin
            .from('user_profiles')
            .select('*')
            .eq('id', req.user.id)
            .single();

          const stripeAccount = await stripeService.createConnectAccount({
            business_name: salon.business_name,
            salon_id: salon.id,
            owner_id: req.user.id,
            email: salon.email || userProfile?.email,
            country: salon.country || 'NL',
            business_type: 'individual'
          });

          // Update salon with new Stripe account ID
          await supabaseAdmin
            .from('salons')
            .update({
              stripe_account_id: stripeAccount.id,
              stripe_account_status: 'pending'
            })
            .eq('id', salon.id);

          // Update Stripe account record
          await supabaseAdmin
            .from('stripe_accounts')
            .update({
              stripe_account_id: stripeAccount.id,
              account_status: 'pending',
              onboarding_completed: false,
              updated_at: new Date().toISOString()
            })
            .eq('salon_id', salon.id);

          stripeAccountId = stripeAccount.id;
          console.log('✅ Created new Stripe account:', stripeAccountId);
        }
      }

      // Redirect to web app after Stripe onboarding
      // The web app will automatically route salon owners to their dashboard
      const frontendUrl = process.env.FRONTEND_URL || 'https://www.salontime.nl';
      
      // Ensure URLs are valid and complete
      const returnUrl = frontendUrl.startsWith('http') 
        ? `${frontendUrl}/salon/onboarding/success`
        : `https://${frontendUrl}/salon/onboarding/success`;
      const refreshUrl = frontendUrl.startsWith('http')
        ? `${frontendUrl}/salon/onboarding/retry`
        : `https://${frontendUrl}/salon/onboarding/retry`;

      if (!returnUrl || !refreshUrl || !returnUrl.match(/^https?:\/\//)) {
        throw new AppError('Invalid FRONTEND_URL configuration. Must be a valid URL.', 500, 'INVALID_FRONTEND_URL');
      }

      const accountLink = await stripeService.createAccountLink(
        stripeAccountId,
        returnUrl,
        refreshUrl
      );

      res.status(200).json({
        success: true,
        data: {
          onboarding_url: accountLink.url,
          expires_at: accountLink.expires_at
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to generate onboarding link', 500, 'STRIPE_ONBOARDING_LINK_FAILED');
    }
  });

  // Check and sync Stripe account status
  checkStripeAccountStatus = asyncHandler(async (req, res) => {
    try {
      // Get user's salon
      const { data: salon, error: salonError } = await supabaseAdmin
        .from('salons')
        .select('*')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      if (!salon.stripe_account_id) {
        throw new AppError('Stripe account not found for this salon', 404, 'STRIPE_ACCOUNT_NOT_FOUND');
      }

      // Get actual account status from Stripe
      const accountStatus = await stripeService.getAccountStatus(salon.stripe_account_id);

      // Determine status
      const isActive = accountStatus.charges_enabled && accountStatus.payouts_enabled;
      const status = isActive ? 'active' : 'pending';

      // Update salons table
      await supabaseAdmin
        .from('salons')
        .update({
          stripe_account_status: status,
          updated_at: new Date().toISOString()
        })
        .eq('id', salon.id);

      // Update stripe_accounts table
      await supabaseAdmin
        .from('stripe_accounts')
        .update({
          account_status: status,
          charges_enabled: accountStatus.charges_enabled,
          payouts_enabled: accountStatus.payouts_enabled,
          onboarding_completed: accountStatus.details_submitted,
          capabilities: accountStatus.capabilities,
          requirements: accountStatus.requirements,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_account_id', salon.stripe_account_id);

      // Get updated salon data
      const { data: updatedSalon } = await supabaseAdmin
        .from('salons')
        .select('*')
        .eq('id', salon.id)
        .single();

      res.status(200).json({
        success: true,
        data: {
          salon: updatedSalon,
          account_status: {
            status,
            details_submitted: accountStatus.details_submitted,
            charges_enabled: accountStatus.charges_enabled,
            payouts_enabled: accountStatus.payouts_enabled,
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(`Failed to check Stripe account status: ${error.message}`, 500, 'STRIPE_STATUS_CHECK_FAILED');
    }
  });

  // Get Stripe dashboard link (or onboarding link only if account really not ready)
  // Uses Stripe as source of truth so we don't send users to onboarding when they're already done.
  getStripeDashboardLink = asyncHandler(async (req, res) => {
    try {
      const { data: salon, error: salonError } = await supabaseAdmin
        .from('salons')
        .select('*')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError) {
        throw new AppError(`Salon lookup failed: ${salonError.message}`, 404, 'SALON_NOT_FOUND');
      }

      if (!salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      if (!salon.stripe_account_id) {
        throw new AppError('Stripe account not found for this salon', 404, 'STRIPE_ACCOUNT_NOT_FOUND');
      }

      // Prefer Stripe as source of truth: if onboarding is done, always return dashboard (login) link
      let useDashboardLink = salon.stripe_account_status === 'active';
      try {
        const accountStatus = await stripeService.getAccountStatus(salon.stripe_account_id);
        if (accountStatus.details_submitted || (accountStatus.charges_enabled && accountStatus.payouts_enabled)) {
          useDashboardLink = true;
          // Optionally sync our DB if we had stale 'pending'
          if (salon.stripe_account_status !== 'active') {
            await supabaseAdmin.from('salons').update({
              stripe_account_status: 'active',
              updated_at: new Date().toISOString()
            }).eq('id', salon.id);
          }
        }
      } catch (statusErr) {
        // If we can't fetch status, fall back to DB: use dashboard only when DB says active
      }

      if (useDashboardLink) {
        const dashboardLink = await stripeService.createDashboardLink(salon.stripe_account_id);
        return res.status(200).json({
          success: true,
          data: {
            dashboard_url: dashboardLink.url,
            onboarding_url: null,
            expires_at: dashboardLink.expires_at
          }
        });
      }

      // Account not ready in Stripe: return onboarding link so owner can complete verification
      const frontendUrl = process.env.FRONTEND_URL || 'https://www.salontime.nl';
      const returnUrl = frontendUrl.startsWith('http')
        ? `${frontendUrl}/salon/onboarding/success`
        : `https://${frontendUrl}/salon/onboarding/success`;
      const refreshUrl = frontendUrl.startsWith('http')
        ? `${frontendUrl}/salon/onboarding/retry`
        : `https://${frontendUrl}/salon/onboarding/retry`;

      if (!returnUrl.match(/^https?:\/\//) || !refreshUrl.match(/^https?:\/\//)) {
        throw new AppError('Invalid FRONTEND_URL for onboarding link', 500, 'DASHBOARD_LINK_FAILED');
      }

      const accountLink = await stripeService.createAccountLink(
        salon.stripe_account_id,
        returnUrl,
        refreshUrl
      );

      res.status(200).json({
        success: true,
        data: {
          dashboard_url: null,
          onboarding_url: accountLink.url,
          expires_at: accountLink.expires_at
        }
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to generate dashboard link', 500, 'DASHBOARD_LINK_FAILED');
    }
  });

  // Get Stripe account status
  getStripeAccountStatus = asyncHandler(async (req, res) => {
    try {
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('stripe_account_id, stripe_accounts(*)')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError || !salon || !salon.stripe_account_id) {
        return res.status(200).json({
          success: true,
          data: {
            has_stripe_account: false,
            account_status: 'not_created'
          }
        });
      }

      const accountStatus = await stripeService.getAccountStatus(salon.stripe_account_id);

      res.status(200).json({
        success: true,
        data: {
          has_stripe_account: true,
          account_status: accountStatus.charges_enabled ? 'active' : 'pending',
          details_submitted: accountStatus.details_submitted,
          charges_enabled: accountStatus.charges_enabled,
          payouts_enabled: accountStatus.payouts_enabled,
          requirements: accountStatus.requirements
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to get Stripe account status', 500, 'STRIPE_STATUS_FETCH_FAILED');
    }
  });

  // Get salon clients
  getSalonClients = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    try {
      // Get user's salon
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('id')
        .eq('owner_id', req.user.id)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Get clients who have bookings at this salon
      const { data: clients, error } = await supabase
        .from('bookings')
        .select(`
          client_id,
          user_profiles!client_id(
            id,
            first_name,
            last_name,
            email,
            phone,
            avatar
          )
        `)
        .eq('salon_id', salon.id)
        .not('client_id', 'is', null)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw new AppError('Failed to fetch salon clients', 500, 'SALON_CLIENTS_FETCH_FAILED');
      }

      // Remove duplicates and flatten the data
      const uniqueClients = clients.reduce((acc, booking) => {
        const clientId = booking.client_id;
        if (!acc.find(c => c.id === clientId)) {
          acc.push({
            id: booking.user_profiles.id,
            first_name: booking.user_profiles.first_name,
            last_name: booking.user_profiles.last_name,
            email: booking.user_profiles.email,
            phone: booking.user_profiles.phone,
            avatar: booking.user_profiles.avatar
          });
        }
        return acc;
      }, []);

      res.status(200).json({
        success: true,
        data: {
          clients: uniqueClients,
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
      throw new AppError('Failed to fetch salon clients', 500, 'SALON_CLIENTS_FETCH_FAILED');
    }
  });

  // Get nearby salons
  getNearbySalons = asyncHandler(async (req, res) => {
    try {
      const { latitude, longitude, radius = 10 } = req.query;

      if (!latitude || !longitude) {
        throw new AppError('Latitude and longitude are required', 400, 'MISSING_COORDINATES');
      }

      const { data: salons, error } = await supabase
        .from('salons')
        .select('*')
        .eq('is_active', true)
        .limit(20);

      if (error) {
        throw error;
      }

      // Use coordinates from database - DO NOT geocode on read requests
      // Coordinates are stored during salon creation/update
      res.json({
        success: true,
        data: salons || []
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch nearby salons', 500, 'NEARBY_SALONS_FETCH_FAILED');
    }
  });

  // Get popular salons
  getPopularSalons = asyncHandler(async (req, res) => {
    try {
      const { data: salons, error } = await supabase
        .from('salons')
        .select('*')
        .eq('is_active', true)
        .order('rating_average', { ascending: false })
        .order('rating_count', { ascending: false })
        .limit(10);

      if (error) {
        throw error;
      }

      // Use coordinates from database - DO NOT geocode on read requests
      // Coordinates are stored during salon creation/update
      res.json({
        success: true,
        data: salons || []
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch popular salons', 500, 'POPULAR_SALONS_FETCH_FAILED');
    }
  });

  // Get services for a specific salon (public endpoint)
  getSalonServices = asyncHandler(async (req, res) => {
    const { salonId } = req.params;

    console.log('🔍 Getting services for salon:', salonId);

    try {
      // First check if salon exists and is active
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('id, is_active')
        .eq('id', salonId)
        .single();

      if (salonError || !salon) {
        console.log('❌ Salon not found:', salonId, salonError);
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      if (!salon.is_active) {
        console.log('❌ Salon not active:', salonId);
        throw new AppError('Salon is not active', 403, 'SALON_NOT_ACTIVE');
      }

      console.log('✅ Salon exists and is active:', salonId);

      // Get all active services for this salon
      const { data: services, error } = await supabaseAdmin
        .from('services')
        .select('*')
        .eq('salon_id', salonId)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('❌ Error fetching salon services:', error);
        throw new AppError('Failed to fetch services', 500, 'SERVICES_FETCH_FAILED');
      }

      console.log('✅ Found services for salon', salonId, ':', services?.length || 0);

      res.status(200).json({
        success: true,
        data: services || []
      });

    } catch (error) {
      console.error('❌ Get salon services error:', error);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch salon services', 500, 'SERVICES_FETCH_FAILED');
    }
  });

  // Get staff/employees for a salon (public - for booking flow)
  getSalonStaff = asyncHandler(async (req, res) => {
    const { salonId } = req.params;

    try {
      const { data: salon, error: salonError } = await supabase
        .from('salons')
        .select('id, owner_id, is_active')
        .eq('id', salonId)
        .single();

      if (salonError || !salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }
      if (!salon.is_active) {
        throw new AppError('Salon is not active', 403, 'SALON_NOT_ACTIVE');
      }

      const staffList = [];

      // Include owner as first option (if they have a profile)
      const { data: ownerProfile } = await supabaseAdmin
        .from('user_profiles')
        .select('id, first_name, last_name, avatar_url')
        .eq('id', salon.owner_id)
        .single();
      if (ownerProfile) {
        const ownerName = [ownerProfile.first_name, ownerProfile.last_name].filter(Boolean).join(' ') || 'Owner';
        staffList.push({
          id: null,
          name: ownerName,
          avatar_url: ownerProfile.avatar_url,
          is_owner: true,
        });
      }

      // Add employees (staff with user_id)
      const { data: employees } = await supabaseAdmin
        .from('staff')
        .select('id, name, user_id')
        .eq('salon_id', salonId)
        .eq('is_active', true)
        .not('user_id', 'is', null)
        .order('created_at');

      for (const emp of employees || []) {
        let avatarUrl = null;
        if (emp.user_id) {
          const { data: up } = await supabaseAdmin
            .from('user_profiles')
            .select('avatar_url')
            .eq('id', emp.user_id)
            .single();
          avatarUrl = up?.avatar_url;
        }
        staffList.push({
          id: emp.id,
          name: emp.name || 'Staff',
          avatar_url: avatarUrl,
          is_owner: false,
        });
      }

      res.status(200).json({
        success: true,
        data: { staff: staffList }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to fetch salon staff', 500, 'STAFF_FETCH_FAILED');
    }
  });

  // Get personalized salon recommendations for user
  getPersonalizedRecommendations = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      latitude,
      lat,
      longitude,
      lng,
      limit = 20
    } = req.query;

    const userLat = parseFloat(latitude || lat);
    const userLng = parseFloat(longitude || lng);

    try {
      const recommendationService = require('../services/recommendationService');

      let recommendations;
      if (userLat && userLng) {
        // Get nearby personalized recommendations
        const radius = parseFloat(req.query.radius) || 50; // Default 50km radius
        recommendations = await recommendationService.getNearbyRecommendations(
          userId,
          userLat,
          userLng,
          radius,
          parseInt(limit)
        );
      } else {
        // Get general personalized recommendations
        recommendations = await recommendationService.getRecommendations(
          userId,
          parseInt(limit)
        );
      }

      // If no personalized recommendations, fall back to popular salons
      if (!recommendations || recommendations.length === 0) {
        const analyticsService = require('../services/analyticsService');
        const popularResult = await analyticsService.getPopularSalons(
          4.0, // Lower threshold for fallback
          5,   // Minimum reviews
          parseInt(limit),
          userLat || null,
          userLng || null,
          50   // 50km radius
        );
        // Extract salons array from the result structure
        recommendations = popularResult?.data?.salons || popularResult?.salons || [];
      }

      res.status(200).json({
        success: true,
        data: Array.isArray(recommendations) ? recommendations : [],
        personalized: Array.isArray(recommendations) && recommendations.length > 0
      });
    } catch (error) {
      // If recommendations fail, fall back to popular salons
      console.error('Error getting personalized recommendations:', error);
      try {
        const analyticsService = require('../services/analyticsService');
        const fallbackResult = await analyticsService.getPopularSalons(
          4.0,
          5,
          parseInt(limit),
          userLat || null,
          userLng || null,
          50
        );
        // Extract salons array from the result structure
        const fallbackSalons = fallbackResult?.data?.salons || fallbackResult?.salons || [];
        res.status(200).json({
          success: true,
          data: Array.isArray(fallbackSalons) ? fallbackSalons : [],
          personalized: false
        });
      } catch (fallbackError) {
        console.error('Error in fallback to popular salons:', fallbackError);
        // Return empty array instead of throwing error
        res.status(200).json({
          success: true,
          data: [],
          personalized: false
        });
      }
    }
  });

  // Upload salon image
  uploadSalonImage = asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new AppError('No file uploaded', 400, 'NO_FILE_UPLOADED');
    }

    const userId = req.user.id;
    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const imageIndex = parseInt(req.body.index) || 0;

    // Validate file type
    if (!config.upload.allowed_avatar_types.includes(mimeType)) {
      throw new AppError(
        `Invalid file type. Allowed types: ${config.upload.allowed_avatar_types.join(', ')}`,
        400,
        'INVALID_FILE_TYPE'
      );
    }

    // Validate file size
    if (fileBuffer.length > config.upload.max_avatar_size) {
      throw new AppError(
        `File too large. Maximum size: ${config.upload.max_avatar_size / 1024 / 1024}MB`,
        400,
        'FILE_TOO_LARGE'
      );
    }

    try {
      // Get user's salon to ensure they have one
      const { data: salon } = await supabaseAdmin
        .from('salons')
        .select('id, images')
        .eq('owner_id', userId)
        .single();

      if (!salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Upload to Supabase Storage (salons_assets bucket)
      const imageUrl = await supabaseService.uploadSalonImage(userId, fileBuffer, mimeType, req.file.originalname, imageIndex);

      // Update salon images array
      const currentImages = Array.isArray(salon.images) ? salon.images : [];
      const updatedImages = [...currentImages];
      
      // Replace or add image at index
      if (imageIndex < updatedImages.length) {
        updatedImages[imageIndex] = imageUrl;
      } else {
        updatedImages.push(imageUrl);
      }

      // Update salon with new image URL
      await supabaseAdmin
        .from('salons')
        .update({
          images: updatedImages,
          updated_at: new Date().toISOString()
        })
        .eq('id', salon.id);

      res.status(200).json({
        success: true,
        data: {
          image_url: imageUrl,
          images: updatedImages
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to upload salon image', 500, 'SALON_IMAGE_UPLOAD_FAILED');
    }
  });

  // Delete salon image
  deleteSalonImage = asyncHandler(async (req, res) => {
    // Try body first, then query params, then check raw body
    let imageUrl = req.body?.imageUrl || req.query?.imageUrl;
    
    // If still not found, try parsing body manually (some DELETE requests don't parse body automatically)
    if (!imageUrl && req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      imageUrl = req.body.imageUrl;
    }
    
    // Log for debugging
    console.log('🗑️ Delete image request - body:', req.body, 'query:', req.query, 'imageUrl:', imageUrl);

    if (!imageUrl || (typeof imageUrl === 'string' && imageUrl.trim() === '')) {
      throw new AppError('Image URL is required', 400, 'MISSING_IMAGE_URL');
    }

    const userId = req.user.id;

    try {
      // Get user's salon
      const { data: salon } = await supabaseAdmin
        .from('salons')
        .select('id, images')
        .eq('owner_id', userId)
        .single();

      if (!salon) {
        throw new AppError('Salon not found', 404, 'SALON_NOT_FOUND');
      }

      // Delete from storage
      await supabaseService.deleteSalonImage(userId, imageUrl);

      // Update salon images array (remove the deleted image)
      const currentImages = Array.isArray(salon.images) ? salon.images : [];
      const updatedImages = currentImages.filter(img => img !== imageUrl);

      // Update salon
      await supabaseAdmin
        .from('salons')
        .update({
          images: updatedImages,
          updated_at: new Date().toISOString()
        })
        .eq('id', salon.id);

      res.status(200).json({
        success: true,
        data: {
          images: updatedImages
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to delete salon image', 500, 'SALON_IMAGE_DELETE_FAILED');
    }
  });

  /**
   * Track salon view/impression
   * Records in salon_views table and increments salon.view_count
   */
  trackSalonView = asyncHandler(async (req, res) => {
    const { salonId } = req.params;

    try {
      // Record view in salon_views table
      const viewData = {
        salon_id: salonId,
        user_id: req.user?.id || null, // null for anonymous views
        session_id: req.headers['x-session-id'] || null,
        source: req.headers['x-source'] || 'app',
        device_type: req.headers['x-device-type'] || 'mobile',
        viewed_at: new Date().toISOString(),
      };

      await supabaseAdmin
        .from('salon_views')
        .insert(viewData);

      // Increment view_count on salon
      await supabaseAdmin.rpc('increment_salon_view_count', {
        salon_id_param: salonId
      });

      res.status(200).json({
        success: true,
        message: 'View tracked'
      });

    } catch (error) {
      console.error('Error tracking salon view:', error);
      // Don't throw error - view tracking should not block the app
      res.status(200).json({
        success: false,
        message: 'View tracking failed but continuing'
      });
    }
  });

  /**
   * Track salon favorite
   * Increments salon.favorite_count
   */
  trackSalonFavorite = asyncHandler(async (req, res) => {
    const { salonId } = req.params;
    const { action } = req.body; // 'add' or 'remove'

    try {
      if (action === 'add') {
        // Increment favorite_count
        await supabaseAdmin.rpc('increment_salon_favorite_count', {
          salon_id_param: salonId
        });
      } else if (action === 'remove') {
        // Decrement favorite_count
        await supabaseAdmin.rpc('decrement_salon_favorite_count', {
          salon_id_param: salonId
        });
      }

      res.status(200).json({
        success: true,
        message: 'Favorite tracked'
      });

    } catch (error) {
      console.error('Error tracking salon favorite:', error);
      res.status(200).json({
        success: false,
        message: 'Favorite tracking failed but continuing'
      });
    }
  });

  // Get or create join code for owner's salon (for inviting employees)
  getJoinCode = asyncHandler(async (req, res) => {
    const { data: salon, error: fetchError } = await supabaseAdmin
      .from('salons')
      .select('id, join_code')
      .eq('owner_id', req.user.id)
      .single();

    if (fetchError || !salon) {
      throw new AppError('No salon found for this user', 404, 'SALON_NOT_FOUND');
    }

    let joinCode = salon.join_code;
    if (!joinCode) {
      let attempts = 0;
      while (attempts < 5) {
        joinCode = generateJoinCode();
        const { error: updateError } = await supabaseAdmin
          .from('salons')
          .update({ join_code: joinCode })
          .eq('id', salon.id);
        if (!updateError) break;
        if (updateError.code === '23505') { /* unique violation, retry */ attempts++; continue; }
        throw new AppError('Failed to generate join code', 500, 'JOIN_CODE_FAILED');
      }
    }

    res.status(200).json({
      success: true,
      data: { join_code: joinCode, salon_id: salon.id }
    });
  });

  // Join a salon as employee using join code
  joinSalonByCode = asyncHandler(async (req, res) => {
    const { code } = req.body;
    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';

    if (!normalizedCode) {
      throw new AppError('Join code is required', 400, 'MISSING_JOIN_CODE');
    }

    const { data: salon, error: salonError } = await supabaseAdmin
      .from('salons')
      .select('id, owner_id, business_name')
      .eq('join_code', normalizedCode)
      .single();

    if (salonError || !salon) {
      throw new AppError('Invalid join code', 404, 'INVALID_JOIN_CODE');
    }

    if (salon.owner_id === req.user.id) {
      throw new AppError('You cannot join your own salon as employee', 400, 'OWNER_CANNOT_JOIN');
    }

    const { data: existingStaff } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('salon_id', salon.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existingStaff) {
      return res.status(200).json({
        success: true,
        data: { salon_id: salon.id, business_name: salon.business_name, already_member: true }
      });
    }

    const userProfile = await supabaseService.getUserProfile(req.user.id).catch(() => null);
    const displayName = userProfile ? [userProfile.first_name, userProfile.last_name].filter(Boolean).join(' ') : req.user.email?.split('@')[0] || 'Employee';

    const { data: staff, error: insertError } = await supabaseAdmin
      .from('staff')
      .insert({
        salon_id: salon.id,
        user_id: req.user.id,
        name: displayName,
        email: req.user.email || null,
        is_active: true
      })
      .select()
      .single();

    if (insertError) {
      console.error('Staff insert error:', insertError);
      throw new AppError('Failed to join salon', 500, 'JOIN_SALON_FAILED');
    }

    res.status(200).json({
      success: true,
      data: { salon_id: salon.id, business_name: salon.business_name, staff_id: staff.id }
    });
  });

  // Leave a salon (remove staff link for current user)
  leaveSalon = asyncHandler(async (req, res) => {
    const { salonId } = req.params;

    const { data: staff, error: fetchError } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('salon_id', salonId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (fetchError || !staff) {
      throw new AppError('You are not a member of this salon', 404, 'NOT_STAFF');
    }

    const { error: deleteError } = await supabaseAdmin
      .from('staff')
      .delete()
      .eq('id', staff.id);

    if (deleteError) {
      throw new AppError('Failed to leave salon', 500, 'LEAVE_SALON_FAILED');
    }

    res.status(200).json({ success: true, message: 'Left salon successfully' });
  });

  // List employees (staff with user_id set) for owner's salon
  getMyEmployees = asyncHandler(async (req, res) => {
    const { data: salon } = await supabaseAdmin
      .from('salons')
      .select('id, business_hours')
      .eq('owner_id', req.user.id)
      .single();

    if (!salon) {
      throw new AppError('No salon found for this user', 404, 'SALON_NOT_FOUND');
    }

    let { data: staffList, error } = await supabaseAdmin
      .from('staff')
      .select('id, name, email, phone, is_active, user_id, created_at, clocked_in_at, availability_schedule')
      .eq('salon_id', salon.id)
      .not('user_id', 'is', null)
      .order('created_at', { ascending: false });

    if (error) {
      throw new AppError('Failed to fetch employees', 500, 'EMPLOYEES_FETCH_FAILED');
    }

    staffList = await clearStaleClockInsForSalon(salon.id, salon.business_hours || {}, staffList || []);

    // Enrich with avatar from user_profiles
    const enriched = [];
    for (const emp of staffList || []) {
      let avatar_url = null;
      if (emp.user_id) {
        const { data: up } = await supabaseAdmin.from('user_profiles').select('avatar_url, avatar').eq('id', emp.user_id).single();
        avatar_url = up?.avatar_url || up?.avatar || null;
      }
      enriched.push({ ...emp, avatar_url });
    }

    res.status(200).json({
      success: true,
      data: { employees: enriched }
    });
  });

  // Get single employee by staff ID (for owner viewing employee details)
  getEmployeeById = asyncHandler(async (req, res) => {
    const { staffId } = req.params;

    const { data: salon } = await supabaseAdmin
      .from('salons')
      .select('id, business_hours')
      .eq('owner_id', req.user.id)
      .single();

    if (!salon) {
      throw new AppError('No salon found for this user', 404, 'SALON_NOT_FOUND');
    }

    const { data: staff, error } = await supabaseAdmin
      .from('staff')
      .select('id, name, email, phone, is_active, user_id, created_at, clocked_in_at, availability_schedule')
      .eq('id', staffId)
      .eq('salon_id', salon.id)
      .single();

    if (error || !staff) {
      throw new AppError('Employee not found', 404, 'EMPLOYEE_NOT_FOUND');
    }

    // Get avatar from user_profiles
    let avatar_url = null;
    if (staff.user_id) {
      const { data: up } = await supabaseAdmin
        .from('user_profiles')
        .select('avatar_url, avatar')
        .eq('id', staff.user_id)
        .single();
      avatar_url = up?.avatar_url || up?.avatar || null;
    }

    res.status(200).json({
      success: true,
      data: { employee: { ...staff, avatar_url } }
    });
  });

  // Employee performance stats (bookings count, revenue per staff) for owner
  getEmployeeStats = asyncHandler(async (req, res) => {
    const { data: salon } = await supabaseAdmin
      .from('salons')
      .select('id, business_hours')
      .eq('owner_id', req.user.id)
      .single();

    if (!salon) {
      throw new AppError('No salon found for this user', 404, 'SALON_NOT_FOUND');
    }

    const period = parseInt(req.query.period) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);
    const startIso = startDate.toISOString();

    let { data: staffList, error: staffError } = await supabaseAdmin
      .from('staff')
      .select('id, name, email, phone, is_active, user_id, created_at, clocked_in_at, availability_schedule')
      .eq('salon_id', salon.id)
      .not('user_id', 'is', null)
      .order('name');

    if (staffError) {
      throw new AppError('Failed to fetch employees', 500, 'EMPLOYEES_FETCH_FAILED');
    }

    staffList = await clearStaleClockInsForSalon(salon.id, salon.business_hours || {}, staffList || []);

    const { data: bookings, error: bookError } = await supabaseAdmin
      .from('bookings')
      .select('id, staff_id, appointment_date, status')
      .eq('salon_id', salon.id)
      .gte('appointment_date', startIso.split('T')[0]);

    if (bookError) {
      throw new AppError('Failed to fetch bookings for stats', 500, 'STATS_FETCH_FAILED');
    }

    const bookingIds = (bookings || []).map(b => b.id).filter(Boolean);
    let paymentByBooking = {};
    if (bookingIds.length > 0) {
      const { data: payments, error: payError } = await supabaseAdmin
        .from('payments')
        .select('booking_id, amount, status')
        .in('booking_id', bookingIds)
        .in('status', ['succeeded', 'paid', 'completed']);

      if (!payError && payments) {
        payments.forEach(p => {
          if (p.booking_id) paymentByBooking[p.booking_id] = parseFloat(p.amount || 0);
        });
      }
    }

    const bookingById = {};
    (bookings || []).forEach(b => { bookingById[b.id] = b; });

    const statsByStaff = {};
    for (const s of staffList || []) {
      let avatar_url = null;
      if (s.user_id) {
        const { data: up } = await supabaseAdmin.from('user_profiles').select('avatar_url, avatar').eq('id', s.user_id).single();
        avatar_url = up?.avatar_url || up?.avatar || null;
      }
      statsByStaff[s.id] = {
        staff_id: s.id,
        id: s.id, // Also include as 'id' for consistency
        name: s.name,
        email: s.email,
        phone: s.phone,
        is_active: s.is_active,
        user_id: s.user_id,
        created_at: s.created_at,
        clocked_in_at: s.clocked_in_at || null,
        availability_schedule: s.availability_schedule || null, // Include availability!
        avatar_url,
        bookings_count: 0,
        completed_count: 0,
        revenue: 0
      };
    }

    (bookings || []).forEach(b => {
      if (!b.staff_id) return;
      if (!statsByStaff[b.staff_id]) return;
      statsByStaff[b.staff_id].bookings_count++;
      if (b.status === 'completed') statsByStaff[b.staff_id].completed_count++;
      const amt = paymentByBooking[b.id];
      if (amt) statsByStaff[b.staff_id].revenue += amt;
    });

    const list = Object.values(statsByStaff);
    list.forEach(s => { s.revenue = Math.round(s.revenue * 100) / 100; });
    list.sort((a, b) => (b.bookings_count || 0) - (a.bookings_count || 0));

    res.status(200).json({
      success: true,
      data: {
        employees: list,
        period_days: period,
        start_date: startIso,
        end_date: new Date().toISOString()
      }
    });
  });

  // Current user's staff record for a salon (for employee dashboard)
  getStaffMe = asyncHandler(async (req, res) => {
    const salonId = req.query.salon_id;
    let query = supabaseAdmin
      .from('staff')
      .select('id, name, email, phone, is_active, user_id, salon_id, created_at, availability_schedule, clocked_in_at')
      .eq('user_id', req.user.id)
      .eq('is_active', true);
    if (salonId) query = query.eq('salon_id', salonId);
    const { data: rows, error } = await query.limit(1);
    let staffRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (error || !staffRow) {
      throw new AppError('Staff record not found for this salon', 404, 'STAFF_NOT_FOUND');
    }
    if (staffRow.clocked_in_at && staffRow.salon_id) {
      const { data: salonRow } = await supabaseAdmin.from('salons').select('business_hours').eq('id', staffRow.salon_id).single();
      const [updated] = await clearStaleClockInsForSalon(staffRow.salon_id, salonRow?.business_hours || {}, [staffRow]);
      staffRow = updated;
    }
    let avatar_url = null;
    // First try to get avatar from staff's user_id
    if (staffRow.user_id) {
      const { data: up } = await supabaseAdmin.from('user_profiles').select('avatar_url, avatar').eq('id', staffRow.user_id).single();
      avatar_url = up?.avatar_url || up?.avatar || null;
    }
    // Fallback: try getting avatar from the authenticated user's profile (req.user.id)
    if (!avatar_url && req.user?.id) {
      const { data: authUp } = await supabaseAdmin.from('user_profiles').select('avatar_url, avatar').eq('id', req.user.id).single();
      avatar_url = authUp?.avatar_url || authUp?.avatar || null;
    }
    res.status(200).json({
      success: true,
      data: {
        staff_id: staffRow.id,
        name: staffRow.name,
        email: staffRow.email,
        phone: staffRow.phone,
        is_active: staffRow.is_active,
        user_id: staffRow.user_id,
        salon_id: staffRow.salon_id,
        created_at: staffRow.created_at,
        avatar_url,
        availability_schedule: staffRow.availability_schedule || null,
        clocked_in_at: staffRow.clocked_in_at || null
      }
    });
  });

  // Get current staff's availability schedule
  getStaffAvailability = asyncHandler(async (req, res) => {
    const salonId = req.query.salon_id;
    let query = supabaseAdmin
      .from('staff')
      .select('id, availability_schedule')
      .eq('user_id', req.user.id)
      .eq('is_active', true);
    if (salonId) query = query.eq('salon_id', salonId);
    const { data: rows, error } = await query.limit(1);
    const staffRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (error || !staffRow) {
      throw new AppError('Staff record not found for this salon', 404, 'STAFF_NOT_FOUND');
    }
    res.status(200).json({
      success: true,
      data: { availability_schedule: staffRow.availability_schedule || null }
    });
  });

  // Update current staff's availability schedule. Staff hours must be within salon opening/closing (cannot override).
  updateStaffAvailability = asyncHandler(async (req, res) => {
    const { salon_id: salonId, availability_schedule } = req.body;
    if (!salonId) {
      throw new AppError('salon_id is required', 400, 'MISSING_SALON_ID');
    }
    const { data: staffRows, error: fetchErr } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('salon_id', salonId)
      .eq('is_active', true)
      .limit(1);
    const staffRow = Array.isArray(staffRows) && staffRows.length > 0 ? staffRows[0] : null;
    if (fetchErr || !staffRow) {
      throw new AppError('Staff record not found for this salon', 404, 'STAFF_NOT_FOUND');
    }
    const { data: salonRow } = await supabaseAdmin
      .from('salons')
      .select('business_hours')
      .eq('id', salonId)
      .single();
    const salonHours = salonRow?.business_hours || {};
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const clamped = {};
    for (const day of days) {
      const staffDay = availability_schedule?.[day];
      const salonDay = salonHours[day];
      const salonClosed = salonDay?.closed === true;
      const salonOpen = (salonDay?.opening ?? salonDay?.open) || '00:00';
      const salonClose = (salonDay?.closing ?? salonDay?.close) || '23:59';
      if (!staffDay) {
        clamped[day] = salonClosed ? { closed: true, opening: salonOpen, closing: salonClose } : { closed: false, opening: salonOpen, closing: salonClose };
        continue;
      }
      if (salonClosed) {
        clamped[day] = { closed: true, opening: salonOpen, closing: salonClose };
        continue;
      }
      let open = staffDay.opening ?? staffDay.open ?? salonOpen;
      let close = staffDay.closing ?? staffDay.close ?? salonClose;
      open = typeof open === 'number' ? `${Math.floor(open / 60).toString().padStart(2, '0')}:${(open % 60).toString().padStart(2, '0')}` : String(open ?? salonOpen).trim();
      close = typeof close === 'number' ? `${Math.floor(close / 60).toString().padStart(2, '0')}:${(close % 60).toString().padStart(2, '0')}` : String(close ?? salonClose).trim();
      if (staffDay.closed) {
        clamped[day] = { closed: true, opening: salonOpen, closing: salonClose };
        continue;
      }
      if (open < salonOpen) open = salonOpen;
      if (close > salonClose) close = salonClose;
      if (open >= close) {
        open = salonOpen;
        close = salonClose;
      }
      clamped[day] = { closed: false, opening: open, closing: close };
    }
    const { error: updateErr } = await supabaseAdmin
      .from('staff')
      .update({ availability_schedule: clamped })
      .eq('id', staffRow.id);
    if (updateErr) {
      throw new AppError('Failed to update availability', 500, 'AVAILABILITY_UPDATE_FAILED');
    }
    res.status(200).json({
      success: true,
      data: { availability_schedule: clamped }
    });
  });

  // Staff clock in: set clocked_in_at, notify salon owner
  clockIn = asyncHandler(async (req, res) => {
    const { salon_id: salonId } = req.body;
    if (!salonId) {
      throw new AppError('salon_id is required', 400, 'MISSING_SALON_ID');
    }
    const { data: staffRows, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, salon_id')
      .eq('user_id', req.user.id)
      .eq('salon_id', salonId)
      .eq('is_active', true)
      .limit(1);
    const staffRow = Array.isArray(staffRows) && staffRows.length > 0 ? staffRows[0] : null;
    if (staffErr || !staffRow) {
      throw new AppError('Staff record not found for this salon', 404, 'STAFF_NOT_FOUND');
    }
    const now = new Date().toISOString();
    const { error: updateErr } = await supabaseAdmin
      .from('staff')
      .update({ clocked_in_at: now })
      .eq('id', staffRow.id);
    if (updateErr) {
      throw new AppError('Failed to clock in', 500, 'CLOCK_IN_FAILED');
    }
    const { data: salonRow } = await supabaseAdmin
      .from('salons')
      .select('owner_id')
      .eq('id', salonId)
      .single();
    if (salonRow?.owner_id) {
      const { error: notifErr } = await supabaseAdmin.from('notifications').insert({
        user_id: salonRow.owner_id,
        type: 'staff_clock_in',
        title: 'Medewerker ingeklokt',
        body: `${staffRow.name || 'Medewerker'} is ingeklokt.`,
        data: { staff_id: staffRow.id, staff_name: staffRow.name, salon_id: salonId, clocked_in_at: now }
      });
      if (notifErr) console.warn('Could not create clock-in notification for owner:', notifErr.message);
    }
    res.status(200).json({
      success: true,
      data: { clocked_in_at: now, staff_id: staffRow.id }
    });
  });

  // Staff clock out: clear clocked_in_at
  clockOut = asyncHandler(async (req, res) => {
    const { salon_id: salonId } = req.body;
    if (!salonId) {
      throw new AppError('salon_id is required', 400, 'MISSING_SALON_ID');
    }
    const { data: staffRows, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('salon_id', salonId)
      .eq('is_active', true)
      .limit(1);
    const staffRow = Array.isArray(staffRows) && staffRows.length > 0 ? staffRows[0] : null;
    if (staffErr || !staffRow) {
      throw new AppError('Staff record not found for this salon', 404, 'STAFF_NOT_FOUND');
    }
    const { error: updateErr } = await supabaseAdmin
      .from('staff')
      .update({ clocked_in_at: null })
      .eq('id', staffRow.id);
    if (updateErr) {
      throw new AppError('Failed to clock out', 500, 'CLOCK_OUT_FAILED');
    }
    res.status(200).json({
      success: true,
      data: { clocked_in_at: null, staff_id: staffRow.id }
    });
  });

  // Current user's stats as staff (for employee dashboard)
  getStaffMyStats = asyncHandler(async (req, res) => {
    const salonId = req.query.salon_id;
    const period = parseInt(req.query.period) || 30;
    let query = supabaseAdmin
      .from('staff')
      .select('id, salon_id')
      .eq('user_id', req.user.id)
      .eq('is_active', true);
    if (salonId) query = query.eq('salon_id', salonId);
    const { data: staffRows, error: staffErr } = await query.limit(1);
    const staffRow = Array.isArray(staffRows) && staffRows.length > 0 ? staffRows[0] : null;
    if (staffErr || !staffRow) {
      throw new AppError('Staff record not found for this salon', 404, 'STAFF_NOT_FOUND');
    }
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);
    const startIso = startDate.toISOString();
    const { data: bookings, error: bookError } = await supabaseAdmin
      .from('bookings')
      .select('id, status')
      .eq('salon_id', staffRow.salon_id || salonId)
      .eq('staff_id', staffRow.id)
      .gte('appointment_date', startIso.split('T')[0]);
    if (bookError) {
      throw new AppError('Failed to fetch staff stats', 500, 'STATS_FETCH_FAILED');
    }
    const bookingIds = (bookings || []).map(b => b.id).filter(Boolean);
    let revenue = 0;
    if (bookingIds.length > 0) {
      const { data: payments } = await supabaseAdmin
        .from('payments')
        .select('booking_id, amount')
        .in('booking_id', bookingIds)
        .in('status', ['succeeded', 'paid', 'completed']);
      const paymentByBooking = {};
      (payments || []).forEach(p => { if (p.booking_id) paymentByBooking[p.booking_id] = parseFloat(p.amount || 0); });
      revenue = (bookings || []).reduce((sum, b) => sum + (paymentByBooking[b.id] || 0), 0);
    }
    const completed_count = (bookings || []).filter(b => b.status === 'completed').length;
    res.status(200).json({
      success: true,
      data: {
        staff_id: staffRow.id,
        salon_id: staffRow.salon_id || salonId,
        bookings_count: (bookings || []).length,
        completed_count,
        revenue: Math.round(revenue * 100) / 100,
        period_days: period
      }
    });
  });
}

module.exports = new SalonController();

