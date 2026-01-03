const { supabase } = require('../config/database');
const supabaseService = require('../services/supabaseService');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { transporter, isEmailEnabled, fromEmail } = require('../config/email');
const cron = require('node-cron');

class AuthController {
  // Generate OAuth URL for WebView
  generateOAuthUrl = asyncHandler(async (req, res) => {
    const { provider, user_type } = req.body;

    // Validate provider
    const supportedProviders = ['google', 'facebook', 'apple'];
    if (!supportedProviders.includes(provider)) {
      throw new AppError('Unsupported OAuth provider', 400, 'UNSUPPORTED_PROVIDER');
    }

    // Validate user type
    const validUserTypes = ['client', 'salon_owner'];
    if (!validUserTypes.includes(user_type)) {
      throw new AppError('Invalid user type', 400, 'INVALID_USER_TYPE');
    }

    // Generate redirect URL with user type
    const redirectUrl = `${process.env.FRONTEND_URL}/auth/callback?user_type=${user_type}`;

    try {
      const oauthUrl = await supabaseService.generateOAuthUrl(provider, redirectUrl);

      res.status(200).json({
        success: true,
        data: {
          oauth_url: oauthUrl,
          provider: provider,
          user_type: user_type
        }
      });
    } catch (error) {
      throw new AppError(`Failed to generate ${provider} OAuth URL`, 500, 'OAUTH_GENERATION_FAILED');
    }
  });

  // Handle OAuth callback from WebView
  handleOAuthCallback = asyncHandler(async (req, res) => {
    const { access_token, refresh_token, user_type } = req.body;

    if (!access_token) {
      throw new AppError('Access token is required', 400, 'MISSING_ACCESS_TOKEN');
    }

    if (!user_type) {
      throw new AppError('User type is required', 400, 'MISSING_USER_TYPE');
    }

    try {
      // Get user from Supabase using the access token
      const { data: { user }, error: userError } = await supabase.auth.getUser(access_token);

      if (userError || !user) {
        throw new AppError('Invalid access token', 401, 'INVALID_ACCESS_TOKEN');
      }

      console.log('OAuth user from Supabase:', { id: user.id, email: user.email, metadata: user.user_metadata });

      // Check if user profile exists
      let userProfile;
      try {
        userProfile = await supabaseService.getUserProfile(user.id);
        
        console.log('Existing profile found:', userProfile);
        
        // If user exists with different role, sign them in anyway (don't block)
        // Just return their actual profile
        if (userProfile.user_type !== user_type) {
          console.log(`⚠️  User tried to sign in as ${user_type} but is actually ${userProfile.user_type}. Signing them in with their actual role.`);
          // Don't throw error - just use their existing profile
        }
      } catch (error) {
        console.log('Profile not found, creating new one. Error:', error);
        
        if (error.code === 'PROFILE_NOT_FOUND') {
          // Create new user profile using upsert (handles duplicates)
          // Only set OAuth avatar for new accounts (no existing uploaded avatar)
          const profileData = {
            id: user.id,
            user_type: user_type,
            first_name: user.user_metadata?.first_name || user.user_metadata?.full_name?.split(' ')[0] || user.user_metadata?.name?.split(' ')[0] || '',
            last_name: user.user_metadata?.last_name || user.user_metadata?.full_name?.split(' ').slice(1).join(' ') || user.user_metadata?.name?.split(' ').slice(1).join(' ') || '',
            // Use OAuth avatar only for new accounts
            avatar_url: user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
            language: 'en' // Default language
          };

          console.log('Creating profile with data:', profileData);
          userProfile = await supabaseService.createUserProfile(profileData);
          console.log('Profile created successfully:', userProfile);
        } else {
          console.error('Unexpected error fetching profile:', error);
          throw error;
        }
      }
      
      // For existing users who sign in with OAuth, DON'T overwrite their avatar
      // Only use OAuth avatar if they don't have one already
      if (userProfile && !userProfile.avatar_url) {
        const oauthAvatar = user.user_metadata?.avatar_url || user.user_metadata?.picture;
        if (oauthAvatar) {
          console.log('User has no avatar, updating with OAuth avatar:', oauthAvatar);
          try {
            await supabaseService.updateUserProfile(user.id, { avatar_url: oauthAvatar });
            userProfile.avatar_url = oauthAvatar;
          } catch (updateError) {
            console.error('Failed to update avatar from OAuth:', updateError);
            // Don't fail the login, just log it
          }
        }
      }

      // Return user data and tokens
      res.status(200).json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            user_type: userProfile.user_type,
            first_name: userProfile.first_name,
            last_name: userProfile.last_name,
            avatar_url: userProfile.avatar_url,
            language: userProfile.language
          },
          session: {
            access_token: access_token,
            refresh_token: refresh_token,
            expires_in: 3600, // 1 hour
            token_type: 'bearer'
          }
        }
      });

    } catch (error) {
      console.error('OAuth callback error:', error);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('OAuth callback processing failed', 500, 'CALLBACK_PROCESSING_FAILED');
    }
  });

  // Refresh access token
  refreshToken = asyncHandler(async (req, res) => {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      throw new AppError('Refresh token is required', 400, 'MISSING_REFRESH_TOKEN');
    }

    try {
      const sessionData = await supabaseService.refreshSession(refresh_token);

      res.status(200).json({
        success: true,
        data: {
          session: {
            access_token: sessionData.session.access_token,
            refresh_token: sessionData.session.refresh_token,
            expires_in: sessionData.session.expires_in,
            token_type: 'bearer'
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Token refresh failed', 401, 'TOKEN_REFRESH_FAILED');
    }
  });

  // Get current user profile
  getProfile = asyncHandler(async (req, res) => {
    try {
      console.log('🔍 AuthController.getProfile called');
      console.log('🔍 req.user:', req.user);
      console.log('🔍 req.user.id:', req.user.id);
      console.log('🔍 req.user.id type:', typeof req.user.id);
      
      const userProfile = await supabaseService.getUserProfile(req.user.id);

      res.status(200).json({
        success: true,
        data: {
          user: {
            id: userProfile.id,
            email: req.user.email,
            user_type: userProfile.user_type,
            first_name: userProfile.first_name,
            last_name: userProfile.last_name,
            phone: userProfile.phone,
            avatar_url: userProfile.avatar_url,
            language: userProfile.language,
            created_at: userProfile.created_at,
            updated_at: userProfile.updated_at
          }
        }
      });

    } catch (error) {
      console.log('❌ AuthController.getProfile error:', error);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch user profile', 500, 'PROFILE_FETCH_FAILED');
    }
  });

  // Sign out user
  signOut = asyncHandler(async (req, res) => {
    try {
      await supabaseService.signOut(req.token);

      res.status(200).json({
        success: true,
        message: 'Successfully signed out'
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Sign out failed', 500, 'SIGNOUT_FAILED');
    }
  });

  // Check authentication status
  checkAuth = asyncHandler(async (req, res) => {
    // If we reach this point, the token is valid (checked by middleware)
    res.status(200).json({
      success: true,
      data: {
        authenticated: true,
        user_id: req.user.id,
        email: req.user.email
      }
    });
  });

  // Email/Password login
  login = asyncHandler(async (req, res) => {
    const { email, password, user_type } = req.body;

    // Validate required fields
    if (!email || !password) {
      throw new AppError('Email and password are required', 400, 'MISSING_CREDENTIALS');
    }

    if (!user_type || !['client', 'salon_owner'].includes(user_type)) {
      throw new AppError('Valid user type is required', 400, 'INVALID_USER_TYPE');
    }

    try {
      // Sign in with Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: email.toLowerCase().trim(),
        password
      });

      if (authError) {
        throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
      }

      // Get user profile
      const userProfile = await supabaseService.getUserProfile(authData.user.id);

      // Enforce role separation - user_type in request must match profile user_type
      if (userProfile.user_type !== user_type) {
        throw new AppError(`Access denied. You are registered as a ${userProfile.user_type}, not a ${user_type}.`, 403, 'ROLE_MISMATCH');
      }

      res.status(200).json({
        success: true,
        data: {
          user: {
            id: authData.user.id,
            email: authData.user.email,
            user_type: userProfile.user_type,
            first_name: userProfile.first_name,
            last_name: userProfile.last_name,
            avatar_url: userProfile.avatar_url,
            language: userProfile.language
          },
          session: {
            access_token: authData.session.access_token,
            refresh_token: authData.session.refresh_token,
            expires_in: authData.session.expires_in,
            token_type: 'bearer'
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Login failed', 500, 'LOGIN_FAILED');
    }
  });

  // Email/Password registration
  register = asyncHandler(async (req, res) => {
    console.log('Registration request body:', req.body);
    const { email, password, full_name, user_type } = req.body;

    // Validate required fields
    if (!email || !password || !full_name) {
      throw new AppError('Email, password, and full name are required', 400, 'MISSING_REQUIRED_FIELDS');
    }

    if (!user_type || !['client', 'salon_owner'].includes(user_type)) {
      throw new AppError('Valid user type is required', 400, 'INVALID_USER_TYPE');
    }

    if (password.length < 6) {
      throw new AppError('Password must be at least 6 characters long', 400, 'PASSWORD_TOO_SHORT');
    }

    try {
      // Split full name into first and last name
      const nameParts = full_name.trim().split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      // Sign up with Supabase Auth using regular client (not admin)
      console.log('Attempting signup with email:', email.toLowerCase().trim());
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: email.toLowerCase().trim(),
        password
      });
      console.log('Auth signup result:', { user: authData?.user?.id, error: authError });
      console.log('Session exists:', !!authData?.session);
      console.log('Email confirmed:', authData?.user?.email_confirmed_at);

      if (authError) {
        console.log('Auth error details:', JSON.stringify(authError, null, 2));
        console.log('Auth error message:', authError.message);
        console.log('Auth error status:', authError.status);
        if (authError.message && (
          authError.message.includes('already registered') ||
          authError.message.includes('already been registered') ||
          authError.message.includes('User already registered') ||
          authError.message.includes('email address is already registered') ||
          authError.message.includes('email already exists') ||
          authError.message.includes('already exists')
        )) {
          throw new AppError('Email already registered', 409, 'EMAIL_ALREADY_EXISTS');
        }
        throw new AppError('Registration failed: ' + (authError.message || 'Unknown error'), 400, 'REGISTRATION_FAILED');
      }

      if (!authData.user) {
        throw new AppError('Registration failed - no user data', 500, 'REGISTRATION_FAILED');
      }

      // Create user profile
      const profileData = {
        id: authData.user.id,
        user_type: user_type,
        first_name: firstName,
        last_name: lastName,
        language: 'en'
      };

      console.log('Creating profile with data:', profileData);
      const userProfile = await supabaseService.createUserProfile(profileData);
      console.log('Profile created successfully:', userProfile);

      // If email confirmation is required, don't return session yet
      if (!authData.session || (authData.user && !authData.user.email_confirmed_at)) {
        console.log(`📧 Email confirmation required for: ${authData.user.email}`);
        console.log(`📧 Email confirmed status: ${authData.user.email_confirmed_at ? 'Yes' : 'No'}`);

        res.status(201).json({
          success: true,
          message: 'Registration successful. Please check your email to confirm your account.',
          data: {
            user: {
              id: authData.user.id,
              email: authData.user.email,
              user_type: userProfile.user_type,
              first_name: userProfile.first_name,
              last_name: userProfile.last_name
            },
            requires_email_confirmation: true
          }
        });
        return;
      }

      // Return session if email confirmation is not required
      res.status(201).json({
        success: true,
        data: {
          user: {
            id: authData.user.id,
            email: authData.user.email,
            user_type: userProfile.user_type,
            first_name: userProfile.first_name,
            last_name: userProfile.last_name,
            avatar_url: userProfile.avatar_url,
            language: userProfile.language
          },
          session: {
            access_token: authData.session.access_token,
            refresh_token: authData.session.refresh_token,
            expires_in: authData.session.expires_in,
            token_type: 'bearer'
          }
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Registration failed', 500, 'REGISTRATION_FAILED');
    }
  });

  // Resend confirmation email
  resendConfirmation = asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
      throw new AppError('Email is required', 400, 'MISSING_EMAIL');
    }

    try {
      let emailSent = false;

      // Try SMTP first if configured
      if (isEmailEnabled && transporter) {
        try {
          const mailOptions = {
            from: fromEmail,
            to: email.toLowerCase().trim(),
            subject: 'Confirm your SalonTime account',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>Welcome to SalonTime!</h2>
                <p>Please confirm your email address to complete your registration.</p>
                <p>If you didn't create an account, you can safely ignore this email.</p>
                <br>
                <p>Best regards,<br>The SalonTime Team</p>
              </div>
            `
          };

          await transporter.sendMail(mailOptions);
          emailSent = true;
          console.log(`✅ Confirmation email sent via SMTP to: ${email}`);
        } catch (smtpError) {
          console.warn('⚠️  SMTP email failed, falling back to Supabase:', smtpError.message);
        }
      }

      // Fallback to Supabase if SMTP failed or not configured
      if (!emailSent) {
        const { error } = await supabase.auth.resend({
          type: 'signup',
          email: email.toLowerCase().trim(),
        });

        if (error) {
          throw new AppError('Failed to resend confirmation email', 400, 'RESEND_FAILED');
        }
        console.log(`✅ Confirmation email sent via Supabase to: ${email}`);
      }

      res.status(200).json({
        success: true,
        message: 'Confirmation email sent successfully',
        method: emailSent ? 'smtp' : 'supabase'
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to resend confirmation email', 500, 'RESEND_FAILED');
    }
  });

  // Cleanup unverified accounts (static method for cron job)
  static async cleanupUnverifiedAccounts() {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Get unverified users older than 7 days
      const { data: unverifiedUsers, error: fetchError } = await supabase
        .from('user_profiles')
        .select('id, created_at, user_type')
        .lt('created_at', sevenDaysAgo.toISOString());

      if (fetchError) {
        throw new Error(`Failed to fetch unverified users: ${fetchError.message}`);
      }

      if (!unverifiedUsers || unverifiedUsers.length === 0) {
        console.log('ℹ️  No unverified accounts to clean up');
        return;
      }

      // Check which users are actually unverified in Supabase Auth
      const userIdsToDelete = [];
      for (const user of unverifiedUsers) {
        try {
          const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(user.id);

          if (authError || !authUser.user) {
            console.log(`⚠️  Auth user not found for profile ${user.id}, skipping`);
            continue;
          }

          // Check if email is confirmed
          if (!authUser.user.email_confirmed_at) {
            userIdsToDelete.push(user.id);
            console.log(`🗑️  Marked unverified account for deletion: ${user.id} (${user.user_type})`);
          }
        } catch (error) {
          console.error(`❌ Error checking auth status for user ${user.id}:`, error.message);
        }
      }

      if (userIdsToDelete.length === 0) {
        console.log('ℹ️  No unverified accounts found to delete');
        return;
      }

      // Delete user profiles
      const { error: deleteError } = await supabase
        .from('user_profiles')
        .delete()
        .in('id', userIdsToDelete);

      if (deleteError) {
        throw new Error(`Failed to delete user profiles: ${deleteError.message}`);
      }

      // Delete from Supabase Auth
      for (const userId of userIdsToDelete) {
        try {
          await supabase.auth.admin.deleteUser(userId);
          console.log(`✅ Deleted unverified account: ${userId}`);
        } catch (error) {
          console.error(`❌ Failed to delete auth user ${userId}:`, error.message);
        }
      }

      console.log(`🧹 Cleaned up ${userIdsToDelete.length} unverified accounts`);

    } catch (error) {
      console.error('❌ Error during unverified account cleanup:', error);
      throw error;
    }
  }
}

module.exports = new AuthController();

// Schedule cleanup of unverified accounts (runs daily at 2 AM)
cron.schedule('0 2 * * *', async () => {
  console.log('🧹 Running scheduled cleanup of unverified accounts...');
  try {
    await AuthController.cleanupUnverifiedAccounts();
    console.log('✅ Unverified account cleanup completed');
  } catch (error) {
    console.error('❌ Error during unverified account cleanup:', error);
  }

  console.log('🧹 Running scheduled cleanup of expired waitlist entries...');
  try {
    const waitlistController = require('./waitlistController');
    await waitlistController.cleanupExpiredWaitlistEntries();
    console.log('✅ Waitlist cleanup completed');
  } catch (error) {
    console.error('❌ Error during waitlist cleanup:', error);
  }
});

