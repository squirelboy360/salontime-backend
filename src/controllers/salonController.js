const { supabase, supabaseAdmin } = require('../config/database');
const stripeService = require('../services/stripeService');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

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
      business_hours
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
          business_hours
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

      // Add coordinates based on city
      const { geocodeSalon } = require('../utils/geocoding');
      const salonWithCoords = geocodeSalon(salon);

      res.status(200).json({
        success: true,
        data: salonWithCoords  // Return salon data directly, not wrapped in { salon: ... }
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
      zip_code,
      phone,
      email,
      website,
      business_hours
    } = req.body;

    try {
      const { data: salon, error } = await supabase
        .from('salons')
        .update({
          business_name,
          description,
          address,
          city,
          zip_code,
          phone,
          email,
          website,
          business_hours
        })
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

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const searchQuery = q || search;
    const userLat = parseFloat(latitude || lat);
    const userLng = parseFloat(longitude || lng);
    const minRatingFilter = parseFloat(min_rating || minRating || 0);
    const maxDistanceFilter = parseFloat(max_distance || maxDistance || 1000);
    const minDistanceFilter = parseFloat(min_distance || minDistance || 0);
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
      if (searchQuery) {
        const searchLower = searchQuery.toLowerCase();
        // Use Supabase's or() to search across multiple fields
        query = query.or(`business_name.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%,city.ilike.%${searchQuery}%`);
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
      if (userLat && userLng && (maxDistanceFilter < 1000 || minDistanceFilter > 0)) {
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
      // This is more efficient than fetching all salons then filtering
      let serviceFilteredSalonIds = null;
      if (services || service || (searchQuery && !searchQuery.includes(' '))) {
        const serviceList = services ? services.split(',') : (service ? [service] : []);
        const searchAsService = searchQuery && !services && !service ? [searchQuery] : [];
        const allServiceFilters = [...serviceList, ...searchAsService];

        if (allServiceFilters.length > 0) {
          // Fetch all active services to find matching salons
          const { data: allServices, error: servicesError } = await supabase
            .from('services')
            .select('salon_id, name, category_id, service_categories(name)')
            .eq('is_active', true);

          if (!servicesError && allServices) {
            const serviceNames = allServiceFilters.map(s => s.toLowerCase());
            const matchingSalonIds = new Set();
            
            allServices.forEach(svc => {
              const svcName = (svc.name || '').toLowerCase();
              const svcCategory = (svc.service_categories?.name || '').toLowerCase();
              serviceNames.forEach(filterName => {
                if (svcName.includes(filterName) || svcCategory.includes(filterName)) {
                  matchingSalonIds.add(svc.salon_id);
                }
              });
            });
            
            if (matchingSalonIds.size > 0) {
              serviceFilteredSalonIds = Array.from(matchingSalonIds);
              query = query.in('id', serviceFilteredSalonIds);
            } else {
              // No matching services, return empty result
              query = query.eq('id', '00000000-0000-0000-0000-000000000000');
            }
          }
        }
      }

      // Price filtering - fetch services first, then filter salons
      const minPriceFilter = parseFloat(req.query.min_price || req.query.minPrice || 0);
      const maxPriceFilter = parseFloat(req.query.max_price || req.query.maxPrice || 10000);
      
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
          if (userLat && userLng) {
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
      const fetchLimit = Math.max(parseInt(limit) * 3, 150); // Fetch 3x the limit or min 150
      query = query.limit(fetchLimit);

      const { data: salons, error } = await query;

      if (error) {
        console.error('❌ Database query error:', error);
        throw new AppError('Failed to search salons', 500, 'SALON_SEARCH_FAILED');
      }

      // Add coordinates if missing (geocoding)
      const { geocodeSalons } = require('../utils/geocoding');
      let salonsWithCoords = geocodeSalons(salons || []);

      // Calculate exact distances and apply final distance filter (for accuracy)
      let filteredSalons = salonsWithCoords;
      if (userLat && userLng) {
        filteredSalons = salonsWithCoords.map(salon => {
          if (salon.latitude && salon.longitude) {
            const distance = calculateDistance(userLat, userLng, salon.latitude, salon.longitude);
            return { ...salon, distance };
          }
          return salon;
        });

        // Apply exact distance filter (refinement after bounding box)
        if (maxDistanceFilter < 1000 || minDistanceFilter > 0) {
          filteredSalons = filteredSalons.filter(salon => {
            if (!salon.distance) return false; // Exclude salons without coordinates
            return salon.distance >= minDistanceFilter && salon.distance <= maxDistanceFilter;
          });
        }

        // Sort by distance if requested
        if (sortByValue.toLowerCase() === 'distance') {
          filteredSalons.sort((a, b) => (a.distance || 9999) - (b.distance || 9999));
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
      const paginatedSalons = filteredSalons.slice(offset, offset + parseInt(limit));
      const total = filteredSalons.length;
      const hasMore = (offset + parseInt(limit)) < filteredSalons.length;

      console.log(`✅ Found ${filteredSalons.length} salons with DB-level filters`);
      console.log(`📄 Returning ${paginatedSalons.length} salons for page ${page} (total: ${total}, hasMore: ${hasMore})`);

      res.status(200).json({
        success: true,
        data: paginatedSalons,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: total,
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

      if (!salon.stripe_account_id) {
        console.error('No Stripe account ID found for salon:', salon.id);
        throw new AppError('Stripe account not found for this salon', 404, 'STRIPE_ACCOUNT_NOT_FOUND');
      }

      // Redirect to web app after Stripe onboarding
      // The web app will automatically route salon owners to their dashboard
      const returnUrl = `${process.env.FRONTEND_URL}`;
      const refreshUrl = `${process.env.FRONTEND_URL}`;

      const accountLink = await stripeService.createAccountLink(
        salon.stripe_account_id,
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

  // Get Stripe dashboard link
  getStripeDashboardLink = asyncHandler(async (req, res) => {
    try {
      // Get user's salon
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

      // Check if account is fully onboarded
      if (salon.stripe_account_status !== 'active') {
        throw new AppError('Stripe account not fully onboarded', 400, 'ACCOUNT_NOT_READY');
      }

      // Generate dashboard link using Stripe's createLoginLink
      const dashboardLink = await stripeService.createDashboardLink(salon.stripe_account_id);

      res.status(200).json({
        success: true,
        data: {
          dashboard_url: dashboardLink.url,
          expires_at: dashboardLink.expires_at
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

      // Add coordinates based on city
      const { geocodeSalons } = require('../utils/geocoding');
      const salonsWithCoords = geocodeSalons(salons || []);

      res.json({
        success: true,
        data: salonsWithCoords
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

      // Add coordinates based on city
      const { geocodeSalons } = require('../utils/geocoding');
      const salonsWithCoords = geocodeSalons(salons || []);

      res.json({
        success: true,
        data: salonsWithCoords
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
}

module.exports = new SalonController();

