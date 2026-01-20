const { supabase } = require('../config/database');
const stripeService = require('../services/stripeService');
const emailService = require('../services/emailService');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

class OnboardingController {
  // Complete salon owner onboarding process
  completeSalonOwnerOnboarding = asyncHandler(async (req, res) => {
    const {
      // Personal Information
      full_name,
      phone,
      
      // Business Information
      business_name,
      business_type = 'individual', // 'individual' or 'company'
      business_description,
      business_email,
      business_phone,
      
      // Address Information
      street_address,
      city,
      state,
      zip_code,
      country,
      
      // Business Details
      business_hours,
      services_offered = [],
      amenities = [],
      website,
      
      // Stripe Information
      bank_country = country,
      currency
    } = req.body;

    if (!business_name || !full_name) {
      throw new AppError('Business name and full name are required', 400, 'MISSING_REQUIRED_INFO');
    }

    if (!country) {
      throw new AppError('Country is required for Stripe account creation', 400, 'MISSING_COUNTRY');
    }

    try {
      // Start transaction-like process
      let salon, stripeAccount, stripeAccountRecord, onboardingUrl;

      // 1. Update user profile
      const { error: profileError } = await supabase
        .from('user_profiles')
        .update({
          full_name,
          phone,
          user_type: 'salon_owner',
          onboarding_completed: true
        })
        .eq('id', req.user.id);

      if (profileError) {
        throw new AppError('Failed to update user profile', 500, 'PROFILE_UPDATE_FAILED');
      }

      // 2. Create salon profile
      const { data: salonData, error: salonError } = await supabase
        .from('salons')
        .insert([{
          owner_id: req.user.id,
          business_name,
          description: business_description,
          address: {
            street: street_address,
            city,
            state,
            zip_code,
            country
          },
          phone: business_phone,
          email: business_email,
          website,
          business_hours,
          amenities,
          is_active: false, // Will be activated after Stripe setup
          verification_status: 'pending'
        }])
        .select()
        .single();

      // Debug logging
      console.log('Salon creation:', {
        userId: req.user.id,
        salonData: salonData,
        salonError: salonError
      });

      if (salonError) {
        throw new AppError('Failed to create salon profile', 500, 'SALON_CREATION_FAILED');
      }

      salon = salonData;

      // 3. Create initial services if provided
      if (services_offered.length > 0) {
        const servicesData = services_offered.map(service => ({
          salon_id: salon.id,
          name: service.name,
          description: service.description || '',
          price: service.price,
          duration: service.duration,
          category: service.category || 'General',
          is_active: true
        }));

        await supabase
          .from('services')
          .insert(servicesData);
      }

      // 4. Create Stripe Connect account
      try {
        stripeAccount = await stripeService.createConnectAccount({
          business_name,
          business_type,
          salon_id: salon.id,
          owner_id: req.user.id,
          email: business_email,
          country: bank_country,
          website: website
        });

        // 5. Update salon with Stripe account info
        await supabase
          .from('salons')
          .update({
            stripe_account_id: stripeAccount.id,
            stripe_account_status: 'pending'
          })
          .eq('id', salon.id);

        // 6. Create Stripe account record
        const { data: stripeData, error: stripeDbError } = await supabase
          .from('stripe_accounts')
          .insert([{
            salon_id: salon.id,
            stripe_account_id: stripeAccount.id,
            account_status: 'pending',
            onboarding_completed: false,
            country: bank_country,
            currency: currency
          }])
          .select()
          .single();

        if (stripeDbError) {
          throw new AppError('Failed to save Stripe account info', 500, 'STRIPE_DB_ERROR');
        }

        stripeAccountRecord = stripeData;

        // 7. Generate onboarding link
        const frontendUrl = process.env.FRONTEND_URL || 'https://www.salontime.nl';
        const returnUrl = frontendUrl.startsWith('http') 
          ? `${frontendUrl}/salon/onboarding/success`
          : `https://${frontendUrl}/salon/onboarding/success`;
        const refreshUrl = frontendUrl.startsWith('http')
          ? `${frontendUrl}/salon/onboarding/retry`
          : `https://${frontendUrl}/salon/onboarding/retry`;
        
        if (!returnUrl.match(/^https?:\/\//) || !refreshUrl.match(/^https?:\/\//)) {
          throw new Error('Invalid FRONTEND_URL configuration');
        }
        
        const accountLink = await stripeService.createAccountLink(
          stripeAccount.id,
          returnUrl,
          refreshUrl
        );

        onboardingUrl = accountLink.url;

      } catch (stripeError) {
        console.error('Stripe setup failed during onboarding:', stripeError);
        // Continue without Stripe - can be set up later
      }

      // 8. Send welcome email
      try {
        const userProfile = await supabase
          .from('user_profiles')
          .select('*')
          .eq('id', req.user.id)
          .single();

        if (userProfile.data) {
          emailService.sendWelcomeEmail(
            userProfile.data,
            salon,
            {
              stripe_setup_required: !stripeAccount,
              onboarding_url: onboardingUrl
            }
          );
        }
      } catch (emailError) {
        console.error('Welcome email failed:', emailError);
        // Continue without email
      }

      // 9. Return complete onboarding response
      res.status(201).json({
        success: true,
        data: {
          user: {
            id: req.user.id,
            full_name,
            user_type: 'salon_owner',
            onboarding_completed: true
          },
          salon: {
            ...salon,
            services_count: services_offered.length,
            stripe_account_id: stripeAccount?.id || null,
            stripe_account_status: stripeAccountRecord?.account_status || null
          },
          stripe_setup: {
            account_created: !!stripeAccount,
            onboarding_required: !!stripeAccount,
            onboarding_url: onboardingUrl,
            status: stripeAccountRecord?.account_status || 'not_created'
          },
          next_steps: [
            stripeAccount 
              ? 'Complete Stripe onboarding to receive payments'
              : 'Set up Stripe account for payment processing',
            'Add more services to your salon',
            'Set up your business hours',
            'Activate your salon for bookings'
          ]
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('Onboarding error:', error);
      throw new AppError('Failed to complete onboarding', 500, 'ONBOARDING_FAILED');
    }
  });

  // Check onboarding status
  getOnboardingStatus = asyncHandler(async (req, res) => {
    try {
      // Get user profile
      const { data: userProfile, error: userError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', req.user.id)
        .single();

      if (userError) {
        throw new AppError('User profile not found', 404, 'USER_NOT_FOUND');
      }

      // Get salon if exists
      const { data: salon, error: salonQueryError } = await supabase
        .from('salons')
        .select(`
          *,
          stripe_accounts(*)
        `)
        .eq('owner_id', req.user.id)
        .single();

      // Debug logging
      console.log('Onboarding status check:', {
        userId: req.user.id,
        salonFound: !!salon,
        salonData: salon,
        salonQueryError: salonQueryError
      });

      // Get services count
      let servicesCount = 0;
      if (salon) {
        const { count } = await supabase
          .from('services')
          .select('*', { count: 'exact', head: true })
          .eq('salon_id', salon.id);
        servicesCount = count || 0;
      }

      const onboardingStatus = {
        user_profile_completed: !!(userProfile.full_name && userProfile.phone),
        salon_created: !!salon,
        stripe_account_created: !!(salon?.stripe_account_id),
        stripe_onboarding_completed: salon?.stripe_accounts?.[0]?.onboarding_completed || false,
        services_added: servicesCount > 0,
        salon_activated: salon?.is_active || false,
        overall_completed: !!(
          userProfile.full_name && 
          userProfile.phone && 
          salon && 
          salon.stripe_account_id && 
          salon.stripe_accounts?.[0]?.onboarding_completed &&
          servicesCount > 0
        )
      };

      let nextAction = null;
      let actionUrl = null;

      if (!onboardingStatus.salon_created) {
        nextAction = 'complete_salon_setup';
      } else if (!onboardingStatus.stripe_account_created) {
        nextAction = 'create_stripe_account';
      } else if (!onboardingStatus.stripe_onboarding_completed) {
        nextAction = 'complete_stripe_onboarding';
        // Generate fresh onboarding link
        try {
          const frontendUrl = process.env.FRONTEND_URL || 'https://www.salontime.nl';
          const returnUrl = frontendUrl.startsWith('http') 
            ? `${frontendUrl}/salon/onboarding/success`
            : `https://${frontendUrl}/salon/onboarding/success`;
          const refreshUrl = frontendUrl.startsWith('http')
            ? `${frontendUrl}/salon/onboarding/retry`
            : `https://${frontendUrl}/salon/onboarding/retry`;
          
          if (!returnUrl.match(/^https?:\/\//) || !refreshUrl.match(/^https?:\/\//)) {
            throw new Error('Invalid FRONTEND_URL configuration');
          }
          
          const accountLink = await stripeService.createAccountLink(
            salon.stripe_account_id,
            returnUrl,
            refreshUrl
          );
          actionUrl = accountLink.url;
        } catch (error) {
          console.error('Failed to generate onboarding link:', error);
        }
      } else if (!onboardingStatus.services_added) {
        nextAction = 'add_services';
      } else if (!onboardingStatus.salon_activated) {
        nextAction = 'activate_salon';
      }

      res.status(200).json({
        success: true,
        data: {
          user: userProfile,
          salon,
          onboarding_status: onboardingStatus,
          next_action: nextAction,
          action_url: actionUrl,
          completion_percentage: Math.round(
            (Object.values(onboardingStatus).filter(Boolean).length - 1) / 
            (Object.keys(onboardingStatus).length - 1) * 100
          )
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to get onboarding status', 500, 'ONBOARDING_STATUS_FAILED');
    }
  });

  // Complete Stripe onboarding (webhook handler)
  completeStripeOnboarding = asyncHandler(async (req, res) => {
    const { account_id } = req.body;

    if (!account_id) {
      throw new AppError('Account ID is required', 400, 'ACCOUNT_ID_REQUIRED');
    }

    try {
      // Get account status from Stripe
      const accountStatus = await stripeService.getAccountStatus(account_id);

      // Update database
      await supabase
        .from('stripe_accounts')
        .update({
          account_status: accountStatus.charges_enabled && accountStatus.payouts_enabled ? 'active' : 'pending',
          onboarding_completed: accountStatus.details_submitted,
          capabilities: accountStatus.capabilities,
          requirements: accountStatus.requirements
        })
        .eq('stripe_account_id', account_id);

      // If onboarding is complete, activate the salon
      if (accountStatus.charges_enabled && accountStatus.payouts_enabled) {
        await supabase
          .from('salons')
          .update({
            is_active: true,
            stripe_account_status: 'active'
          })
          .eq('stripe_account_id', account_id);
      }

      res.status(200).json({
        success: true,
        data: {
          account_status: accountStatus.charges_enabled && accountStatus.payouts_enabled ? 'active' : 'pending',
          onboarding_completed: accountStatus.details_submitted,
          salon_activated: accountStatus.charges_enabled && accountStatus.payouts_enabled
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to complete Stripe onboarding', 500, 'STRIPE_ONBOARDING_FAILED');
    }
  });
}

module.exports = new OnboardingController();

