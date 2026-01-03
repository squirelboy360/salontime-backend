const supabaseService = require('../services/supabaseService');
const { supabaseAdmin } = require('../config/database');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const multer = require('multer');
const config = require('../config');

class UserController {
  // Update user profile
  updateProfile = asyncHandler(async (req, res) => {
    const { first_name, last_name, phone, language, role, user_type } = req.body;

    // Validate input - BLOCK role/user_type changes
    const allowedUpdates = ['first_name', 'last_name', 'phone', 'language', 'avatar_url'];
    const updates = {};

    Object.keys(req.body).forEach(key => {
      if (allowedUpdates.includes(key) && req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    });

    // Explicitly block role/user_type changes
    if (role !== undefined || user_type !== undefined) {
      throw new AppError('User role cannot be changed after registration', 403, 'ROLE_CHANGE_NOT_ALLOWED');
    }

    if (Object.keys(updates).length === 0) {
      throw new AppError('No valid fields to update', 400, 'NO_UPDATES_PROVIDED');
    }

    try {
      const updatedProfile = await supabaseService.updateUserProfile(req.user.id, updates);

      res.status(200).json({
        success: true,
        data: {
          user: updatedProfile
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to update profile', 500, 'PROFILE_UPDATE_FAILED');
    }
  });

  // Get user dashboard data (placeholder for now)
  getDashboard = asyncHandler(async (req, res) => {
    try {
      const userProfile = await supabaseService.getUserProfile(req.user.id);

      // Return different dashboard data based on user type
      const dashboardData = {
        user_type: userProfile.user_type,
        user_name: `${userProfile.first_name} ${userProfile.last_name}`,
        message: `Welcome to your ${userProfile.user_type === 'salon_owner' ? 'salon owner' : 'client'} dashboard!`
      };

      res.status(200).json({
        success: true,
        data: dashboardData
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to fetch dashboard data', 500, 'DASHBOARD_FETCH_FAILED');
    }
  });

  // Get user profile
  getProfile = asyncHandler(async (req, res) => {
    try {
      const userProfile = await supabaseService.getUserProfileOrCreate(req.user.id);

      res.status(200).json({
        success: true,
        data: {
          user: userProfile  // Wrap in 'user' key to match OAuth response format
        }
      });
    } catch (error) {
      console.error('Error fetching user profile:', error);
      throw new AppError('Failed to fetch user profile', 500, 'PROFILE_FETCH_FAILED');
    }
  });

  // Get notification settings
  getNotificationSettings = asyncHandler(async (req, res) => {
    try {
      // Fetch actual settings from user_settings table
      const settings = await supabaseService.getUserSettings(req.user.id);

      res.status(200).json({
        success: true,
        data: {
          settings: {
            notifications_enabled: settings.notifications_enabled,
            email_notifications: settings.email_notifications,
            sms_notifications: settings.sms_notifications,
            push_notifications: settings.push_notifications,
            booking_reminders: settings.booking_reminders,
            marketing_emails: settings.marketing_emails
          }
        }
      });
    } catch (error) {
      console.error('Error fetching notification settings:', error);
      throw new AppError('Failed to fetch notification settings', 500, 'NOTIFICATION_SETTINGS_FETCH_FAILED');
    }
  });

  // Update notification settings
  updateNotificationSettings = asyncHandler(async (req, res) => {
    const {
      notifications_enabled,
      email_notifications,
      sms_notifications,
      push_notifications,
      booking_reminders,
      marketing_emails
    } = req.body;

    try {
      // Save notification settings to user_settings table
      const updatedSettings = await supabaseService.updateUserSettings(req.user.id, {
        notifications_enabled,
        email_notifications,
        sms_notifications,
        push_notifications,
        booking_reminders,
        marketing_emails
      });

      res.status(200).json({
        success: true,
        data: {
          settings: updatedSettings
        }
      });
    } catch (error) {
      console.error('Error updating notification settings:', error);
      throw new AppError('Failed to update notification settings', 500, 'NOTIFICATION_SETTINGS_UPDATE_FAILED');
    }
  });

  // Track user interactions for personalization
  trackUserInteraction = asyncHandler(async (req, res) => {
    const { action, salon_id, timestamp } = req.body;

    // Validate input
    if (!action || !salon_id) {
      throw new AppError('Action and salon_id are required', 400, 'MISSING_REQUIRED_FIELDS');
    }

    const validActions = ['view', 'book', 'favorite', 'unfavorite'];
    if (!validActions.includes(action)) {
      throw new AppError('Invalid action. Must be one of: view, book, favorite, unfavorite', 400, 'INVALID_ACTION');
    }

    try {
      // Store user interaction in database
      const interaction = await supabaseService.trackUserInteraction({
        user_id: req.user.id,
        action,
        salon_id,
        timestamp: timestamp || new Date().toISOString()
      });

      res.status(200).json({
        success: true,
        data: {
          interaction
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to track user interaction', 500, 'INTERACTION_TRACKING_FAILED');
    }
  });

  // Upload avatar image
  uploadAvatar = asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new AppError('No file uploaded', 400, 'NO_FILE_UPLOADED');
    }

    const userId = req.user.id;
    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const originalFileName = req.file.originalname;

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
      // Upload to Supabase Storage (will delete old avatar automatically)
      const avatarUrl = await supabaseService.uploadAvatar(userId, fileBuffer, mimeType, originalFileName);

      // Update user profile with new avatar URL
      const updatedProfile = await supabaseService.updateUserProfile(userId, {
        avatar_url: avatarUrl
      });

      res.status(200).json({
        success: true,
        data: {
          user: updatedProfile,
          avatar_url: avatarUrl
        }
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to upload avatar', 500, 'AVATAR_UPLOAD_FAILED');
    }
  });

  // Delete user avatar
  deleteAvatar = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      // Delete all avatars from storage bucket
      await supabaseService.deleteUserAvatars(userId);

      // Update user profile to remove avatar URL
      const updatedProfile = await supabaseService.updateUserProfile(userId, {
        avatar_url: null
      });

      res.status(200).json({
        success: true,
        data: {
          user: updatedProfile
        },
        message: 'Avatar deleted successfully'
      });

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to delete avatar', 500, 'AVATAR_DELETE_FAILED');
    }
  });

  // Get family members
  getFamilyMembers = asyncHandler(async (req, res) => {
    try {
      const members = await supabaseService.getFamilyMembers(req.user.id);
      // Map relationship -> relation for frontend compatibility
      const mappedMembers = members.map(m => ({
        ...m,
        relation: m.relationship
      }));
      
      res.status(200).json({
        success: true,
        data: { members: mappedMembers }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to fetch family members', 500, 'FAMILY_MEMBERS_FETCH_FAILED');
    }
  });

  // Add family member
  addFamilyMember = asyncHandler(async (req, res) => {
    const { name, relation, relationship, date_of_birth } = req.body;
    
    if (!name) {
      throw new AppError('Name is required', 400, 'MISSING_REQUIRED_FIELDS');
    }

    try {
      const member = await supabaseService.addFamilyMember(req.user.id, {
        name, 
        relation: relation || relationship, 
        date_of_birth
      });
      
      // Map relationship -> relation for frontend compatibility
      const mappedMember = {
        ...member,
        relation: member.relationship
      };

      res.status(201).json({
        success: true,
        data: { member: mappedMember }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to add family member', 500, 'FAMILY_MEMBER_ADD_FAILED');
    }
  });

  // Update family member
  updateFamilyMember = asyncHandler(async (req, res) => {
    const { memberId } = req.params;
    const updates = req.body;

    try {
      const member = await supabaseService.updateFamilyMember(req.user.id, memberId, updates);
      
      // Map relationship -> relation for frontend compatibility
      const mappedMember = {
        ...member,
        relation: member.relationship
      };

      res.status(200).json({
        success: true,
        data: { member: mappedMember }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to update family member', 500, 'FAMILY_MEMBER_UPDATE_FAILED');
    }
  });

  // Delete family member
  deleteFamilyMember = asyncHandler(async (req, res) => {
    const { memberId } = req.params;

    try {
      await supabaseService.deleteFamilyMember(req.user.id, memberId);
      res.status(200).json({
        success: true,
        message: 'Family member deleted successfully'
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to delete family member', 500, 'FAMILY_MEMBER_DELETE_FAILED');
    }
  });

  // Delete user account
  deleteAccount = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { reason } = req.body;

    try {
      console.log(`🗑️  Deleting account for user: ${userId}`);
      if (reason) {
        console.log(`📝 Deletion reason: ${reason}`);
      }

      // 1. Delete all user's bookings (set status to cancelled or delete)
      const { error: bookingsError } = await supabaseAdmin
        .from('bookings')
        .delete()
        .eq('client_id', userId);

      if (bookingsError) {
        console.error('⚠️  Error deleting bookings:', bookingsError);
        // Continue even if this fails
      }

      // 2. Delete all user's reviews
      const { error: reviewsError } = await supabaseAdmin
        .from('reviews')
        .delete()
        .eq('client_id', userId);

      if (reviewsError) {
        console.error('⚠️  Error deleting reviews:', reviewsError);
      }

      // 3. Delete all user's favorites
      const { error: favoritesError } = await supabaseAdmin
        .from('user_favorites')
        .delete()
        .eq('user_id', userId);

      if (favoritesError) {
        console.error('⚠️  Error deleting favorites:', favoritesError);
      }

      // 4. Delete all family members
      const { error: familyError } = await supabaseAdmin
        .from('family_members')
        .delete()
        .eq('user_id', userId);

      if (familyError) {
        console.error('⚠️  Error deleting family members:', familyError);
      }

      // 5. Delete user avatars from storage
      try {
        await supabaseService.deleteUserAvatars(userId);
      } catch (avatarError) {
        console.error('⚠️  Error deleting avatars:', avatarError);
      }

      // 6. Delete user profile
      const { error: profileError } = await supabaseAdmin
        .from('user_profiles')
        .delete()
        .eq('id', userId);

      if (profileError) {
        throw new AppError('Failed to delete user profile', 500, 'PROFILE_DELETE_FAILED');
      }

      // 7. Delete from Supabase Auth (this will invalidate all tokens)
      const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);

      if (authError) {
        console.error('⚠️  Error deleting auth user:', authError);
        // Continue even if auth deletion fails - profile is already deleted
      }

      console.log(`✅ Account deleted successfully for user: ${userId}`);

      res.status(200).json({
        success: true,
        message: 'Account deleted successfully'
      });

    } catch (error) {
      console.error('❌ Error deleting account:', error);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to delete account', 500, 'ACCOUNT_DELETE_FAILED');
    }
  });
}

module.exports = new UserController();

