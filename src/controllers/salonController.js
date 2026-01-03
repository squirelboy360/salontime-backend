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

  // Search salons with comprehensive filtering
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

    // Helper function to calculate distance
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

    // Helper function to check if salon is open now
    const isOpenNow = (businessHours) => {
      if (!businessHours) return false;
      const now = new Date();
      const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
      const dayHours = businessHours[dayOfWeek];
      if (!dayHours || dayHours.closed === true || dayHours.closed === 'true') return false;

      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      const openTime = dayHours.open || dayHours.opening;
      const closeTime = dayHours.close || dayHours.closing;

      if (!openTime || !closeTime) return false;
      return currentTime >= openTime && currentTime <= closeTime;
    };

    try {
      let query = supabase
        .from('salons')
        .select('*')
        .eq('is_active', true);

      // Text search filter (name, description, city)
      // Note: We'll filter in JavaScript after fetching to avoid Supabase or() syntax issues
      // Service search will be handled after fetching salons

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

      // Trending filter (high trending_score)
      if (trending === 'true' || trending === true) {
        query = query.gt('trending_score', 0)
          .order('trending_score', { ascending: false });
      }

      // New salons filter (created in last 30 days)
      if (new_only === 'true' || newOnly === 'true' || new_only === true || newOnly === true) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        query = query.gte('created_at', thirtyDaysAgo.toISOString());
      }

      // Popular filter (high rating + many reviews)
      if (popular_only === 'true' || popularOnly === 'true' || popular_only === true || popularOnly === true) {
        query = query.gte('rating_average', 4.5)
          .gte('rating_count', 10);
      }

      // Apply sorting
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
          // Default: by distance if location provided, else by rating
          if (userLat && userLng) {
            query = query.order('rating_average', { ascending: false });
          } else {
            query = query.order('rating_average', { ascending: false })
              .order('rating_count', { ascending: false });
          }
      }

      // If there's a search query, use database-level text search on business_name
      // This is the most common search field and will catch most cases
      // We'll also filter by description and city in JavaScript as backup
      // For search queries, we need to fetch enough results to ensure we find all matches
      // For non-search queries, fetch all salons first, then filter and paginate in JavaScript
      // This ensures proper pagination when there are 1000+ salons
      if (searchQuery) {
        // Search business_name at database level (most efficient)
        query = query.ilike('business_name', `%${searchQuery}%`)
          .limit(5000); // High limit to ensure we get all matching salons
      } else {
        // Don't apply pagination at database level - fetch all, filter, then paginate
        // This ensures hasMore is calculated correctly when there are many salons
        query = query.limit(10000); // Fetch up to 10k salons, then filter and paginate
      }

      const { data: salons, error } = await query;

      if (error) {
        throw new AppError('Failed to search salons', 500, 'SALON_SEARCH_FAILED');
      }

      // Add coordinates based on city if missing
      const { geocodeSalons } = require('../utils/geocoding');
      let salonsWithCoords = geocodeSalons(salons || []);

      // Apply additional text search filter if searchQuery provided
      // Database should have already filtered by business_name, description, and city using or()
      // But we keep this as a backup filter in case the database query didn't work as expected
      if (searchQuery) {
        const searchLower = searchQuery.toLowerCase();
        salonsWithCoords = salonsWithCoords.filter(salon => {
          const businessName = (salon.business_name || '').toLowerCase();
          const description = (salon.description || '').toLowerCase();
          const city = (salon.city || '').toLowerCase();
          // Check if search matches any field (backup filter)
          return businessName.includes(searchLower) ||
            description.includes(searchLower) ||
            city.includes(searchLower);
        });
      }

      // Filter by distance if location provided AND distance filter explicitly set
      let filteredSalons = salonsWithCoords;
      if (userLat && userLng) {
        filteredSalons = salonsWithCoords.map(salon => {
          if (salon.latitude && salon.longitude) {
            const distance = calculateDistance(userLat, userLng, salon.latitude, salon.longitude);
            return { ...salon, distance };
          }
          return salon;
        });

        // Only filter by distance if explicitly provided in request
        if (max_distance || maxDistance || min_distance || minDistance) {
          filteredSalons = filteredSalons.filter(salon => {
            // Keep salons without coordinates
            if (!salon.distance) return true;
            // Apply distance range filter
            return salon.distance >= minDistanceFilter && salon.distance <= maxDistanceFilter;
          });
        }

        // Re-sort by distance if location provided
        if (sortByValue.toLowerCase() === 'distance') {
          filteredSalons.sort((a, b) => (a.distance || 9999) - (b.distance || 9999));
        }
      }

      // Filter by services if provided OR search query matches a service name
      if (services || service || searchQuery) {
        const serviceList = services ? services.split(',') : (service ? [service] : []);
        // If search query exists and no explicit service filter, check if it matches a service
        const searchAsService = searchQuery && !services && !service ? [searchQuery] : [];
        const allServiceFilters = [...serviceList, ...searchAsService];

        if (allServiceFilters.length > 0) {
          // Fetch services for all salons to filter
          const salonIds = filteredSalons.map(s => s.id);

          if (salonIds.length > 0) {
            const { data: salonServicesData, error: servicesError } = await supabase
              .from('services')
              .select('salon_id, name, category_id, service_categories(name)')
              .in('salon_id', salonIds)
              .eq('is_active', true);

            // Group services by salon_id
            const servicesBySalon = {};
            if (!servicesError && salonServicesData) {
              salonServicesData.forEach(service => {
                if (!servicesBySalon[service.salon_id]) {
                  servicesBySalon[service.salon_id] = [];
                }
                servicesBySalon[service.salon_id].push({
                  name: service.name,
                  category: service.service_categories?.name || ''
                });
              });
            }

            // Filter salons that have matching services
            filteredSalons = filteredSalons.filter(salon => {
              const salonServices = servicesBySalon[salon.id] || [];
              return allServiceFilters.some(filterService => {
                const filterLower = filterService.toLowerCase();
                return salonServices.some(s =>
                  (s.name || '').toLowerCase().includes(filterLower) ||
                  (s.category || '').toLowerCase().includes(filterLower)
                );
              });
            });
          }
        }
      }

      // Filter by price range if provided
      const minPriceFilter = parseFloat(req.query.min_price || req.query.minPrice || 0);
      const maxPriceFilter = parseFloat(req.query.max_price || req.query.maxPrice || 10000);

      if (minPriceFilter > 0 || maxPriceFilter < 10000) {
        const salonIds = filteredSalons.map(s => s.id);

        if (salonIds.length > 0) {
          // Fetch services to check price range
          const { data: salonServicesData, error: servicesError } = await supabase
            .from('services')
            .select('salon_id, price')
            .in('salon_id', salonIds)
            .eq('is_active', true);

          if (!servicesError && salonServicesData) {
            // Group min/max prices by salon
            const pricesBySalon = {};
            salonServicesData.forEach(service => {
              if (!pricesBySalon[service.salon_id]) {
                pricesBySalon[service.salon_id] = { min: service.price, max: service.price };
              } else {
                pricesBySalon[service.salon_id].min = Math.min(pricesBySalon[service.salon_id].min, service.price);
                pricesBySalon[service.salon_id].max = Math.max(pricesBySalon[service.salon_id].max, service.price);
              }
            });

            // Filter salons where price range overlaps with filter
            filteredSalons = filteredSalons.filter(salon => {
              const salonPrices = pricesBySalon[salon.id];
              if (!salonPrices) return true; // Keep salons without services
              // Salon matches if its price range overlaps with filter range
              return salonPrices.min <= maxPriceFilter && salonPrices.max >= minPriceFilter;
            });
          }
        }
      }

      // Filter by open_now if requested
      if (open_now === 'true' || openNow === 'true' || open_now === true || openNow === true) {
        filteredSalons = filteredSalons.filter(salon => isOpenNow(salon.business_hours));
      }

      // Apply pagination after all filtering (especially important when search query is used)
      console.log(`🔍 Fetching salons with backend filters:`, {
        page: parseInt(page),
        limit: parseInt(limit),
        offset,
        totalFiltered: filteredSalons.length,
        services: services || service,
        searchQuery,
        sortBy: sortByValue
      });

      const paginatedSalons = filteredSalons.slice(offset, offset + parseInt(limit));
      const hasMore = (offset + parseInt(limit)) < filteredSalons.length;

      console.log(`✅ Found ${filteredSalons.length} salons with backend filters`);
      console.log(`📄 Returning ${paginatedSalons.length} salons for page ${page}`);
      console.log(`📊 Has more pages: ${hasMore}`);

      res.status(200).json({
        success: true,
        data: paginatedSalons,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: filteredSalons.length,
          hasMore: hasMore
        }
      });

    } catch (error) {
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

