const supabaseService = require('../services/supabaseService');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

class UserSettingsController {
  // Get user settings
  getSettings = asyncHandler(async (req, res) => {
    try {
      const settings = await supabaseService.getUserSettings(req.user.id, req.token);
      
      res.status(200).json({
        success: true,
        data: {
          settings: settings
        }
      });
    } catch (error) {
      console.error('Error fetching user settings:', error);
      throw new AppError('Failed to fetch user settings', 500, 'SETTINGS_FETCH_FAILED');
    }
  });

  // Update user settings
  updateSettings = asyncHandler(async (req, res) => {
    const {
      language,
      theme,
      color_scheme,
      notifications_enabled,
      email_notifications,
      sms_notifications,
      push_notifications,
      booking_reminders,
      marketing_emails,
      location_sharing,
      data_analytics
    } = req.body;

    // Validate input
    const allowedUpdates = [
      'language', 'theme', 'color_scheme', 'notifications_enabled',
      'email_notifications', 'sms_notifications', 'push_notifications',
      'booking_reminders', 'marketing_emails', 'location_sharing', 'data_analytics'
    ];
    
    const updates = {};
    Object.keys(req.body).forEach(key => {
      if (allowedUpdates.includes(key) && req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    });

    if (Object.keys(updates).length === 0) {
      throw new AppError('No valid fields to update', 400, 'NO_UPDATES_PROVIDED');
    }

    try {
      const updatedSettings = await supabaseService.updateUserSettings(req.user.id, updates, req.token);

      res.status(200).json({
        success: true,
        data: {
          settings: updatedSettings
        }
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to update settings', 500, 'SETTINGS_UPDATE_FAILED');
    }
  });

  // Create default settings for new user
  createDefaultSettings = asyncHandler(async (req, res) => {
    try {
      const defaultSettings = await supabaseService.createUserSettings(req.user.id, req.token);

      res.status(201).json({
        success: true,
        data: {
          settings: defaultSettings
        }
      });
    } catch (error) {
      console.error('Error creating default settings:', error);
      throw new AppError('Failed to create default settings', 500, 'SETTINGS_CREATE_FAILED');
    }
  });
}

module.exports = new UserSettingsController();
