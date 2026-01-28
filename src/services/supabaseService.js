const { supabase, supabaseAdmin, getAuthenticatedClient } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

class SupabaseService {
  // User Profile Operations
  async getUserProfile(userId) {
    console.log('🔍 SupabaseService.getUserProfile called with userId:', userId);
    console.log('🔍 User ID type:', typeof userId);

    // Use supabaseAdmin to bypass RLS
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    console.log('🔍 Supabase query result - data:', data);
    console.log('🔍 Supabase query result - error:', error);

    if (error) {
      console.log('❌ Supabase error code:', error.code);
      console.log('❌ Supabase error message:', error.message);

      if (error.code === 'PGRST116') {
        console.log('❌ No user profile found for ID:', userId);
        throw new AppError('User profile not found', 404, 'PROFILE_NOT_FOUND');
      }
      throw new AppError('Failed to fetch user profile', 500, 'DATABASE_ERROR');
    }

    console.log('✅ User profile found:', data);
    return data;
  }

  // Auto-create user profile if it doesn't exist (for new users)
  async getUserProfileOrCreate(userId) {
    try {
      // First try to get existing profile
      return await this.getUserProfile(userId);
    } catch (error) {
      if (error.code === 'PROFILE_NOT_FOUND') {
        console.log('🔧 Profile not found, attempting to create automatically...');

        // Try to get user info from auth to create profile
        try {
          // Use admin client to get user by ID (no token needed)
          const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);
          if (authError || !authUser.user) {
            console.log('❌ Failed to get user from auth:', authError);
            throw new AppError('User not found in auth system', 404, 'USER_NOT_FOUND');
          }

          // Create basic profile with auth data
          const profileData = {
            id: userId,
            first_name: authUser.user.user_metadata?.first_name || 'User',
            last_name: authUser.user.user_metadata?.last_name || '',
            email: authUser.user.email,
            user_type: 'client', // Default role (use user_type, not role)
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          console.log('🔧 Creating profile with data:', profileData);
          // Use supabaseAdmin to bypass RLS when creating profile
          const { data: newProfile, error: createError } = await supabaseAdmin
            .from('user_profiles')
            .insert([profileData])
            .select()
            .single();

          if (createError) {
            console.log('❌ Failed to create profile:', createError);
            throw new AppError('Failed to create user profile', 500, 'PROFILE_CREATE_FAILED');
          }

          console.log('✅ Profile created successfully:', newProfile);
          return newProfile;
        } catch (createError) {
          console.log('❌ Error creating profile:', createError);
          throw new AppError('User profile not found and could not be created', 404, 'PROFILE_NOT_FOUND');
        }
      }
      throw error;
    }
  }

  async createUserProfile(profileData) {
    console.log('SupabaseService.createUserProfile called with:', profileData);

    // Use upsert to handle existing profiles and prevent duplicates
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .upsert([profileData], {
        onConflict: 'id',
        ignoreDuplicates: false
      })
      .select()
      .single();

    console.log('Supabase upsert result:', { data: !!data, error });

    if (error) {
      if (error.code === '23505') { // Unique violation
        throw new AppError('User profile already exists', 409, 'PROFILE_EXISTS');
      }
      if (error.code === '23503') { // Foreign key violation
        throw new AppError('User not found in auth system', 500, 'USER_NOT_FOUND');
      }
      throw new AppError('Failed to create user profile', 500, 'DATABASE_ERROR');
    }

    return data;
  }

  async updateUserProfile(userId, updates) {
    // Use supabaseAdmin to bypass RLS policies for user profile updates
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating user profile:', error);
      throw new AppError('Failed to update user profile', 500, 'DATABASE_ERROR');
    }

    return data;
  }

  // Upload avatar to Supabase Storage
  async uploadAvatar(userId, fileBuffer, mimeType, originalFileName) {
    const config = require('../config');
    const bucketName = config.supabase.storage_bucket;

    // Get file extension from mime type
    const extMap = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif'
    };
    const ext = extMap[mimeType] || 'jpg';

    // Create file path: {user_id}/avatar.{ext}
    const filePath = `${userId}/avatar.${ext}`;

    // Delete old avatar if exists
    const { data: oldFiles } = await supabaseAdmin.storage
      .from(bucketName)
      .list(userId);

    if (oldFiles && oldFiles.length > 0) {
      // Delete all files in user's folder (in case of multiple formats)
      const filesToDelete = oldFiles.map(file => `${userId}/${file.name}`);
      await supabaseAdmin.storage
        .from(bucketName)
        .remove(filesToDelete);
    }

    // Upload new avatar
    const { data, error } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(filePath, fileBuffer, {
        contentType: mimeType,
        upsert: true,
        cacheControl: '3600'
      });

    if (error) {
      console.error('Error uploading avatar:', error);
      throw new AppError('Failed to upload avatar', 500, 'AVATAR_UPLOAD_FAILED');
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    return urlData.publicUrl;
  }

  // Upload salon image to salons_assets bucket
  async uploadSalonImage(userId, fileBuffer, mimeType, originalFileName, imageIndex = 0) {
    const bucketName = 'salons_assets'; // Use salons_assets bucket

    // Get file extension from mime type
    const extMap = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif'
    };
    const ext = extMap[mimeType] || 'jpg';

    // Create file path: {user_id}/image_{index}.{ext}
    const filePath = `${userId}/image_${imageIndex}.${ext}`;

    // Upload image
    const { data, error } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(filePath, fileBuffer, {
        contentType: mimeType,
        upsert: true,
        cacheControl: '3600'
      });

    if (error) {
      console.error('Error uploading salon image:', error);
      throw new AppError('Failed to upload salon image', 500, 'SALON_IMAGE_UPLOAD_FAILED');
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    return urlData.publicUrl;
  }

  // Get all salon images for a user
  async getSalonImages(userId) {
    const bucketName = 'salons_assets';
    
    try {
      const { data: files, error } = await supabaseAdmin.storage
        .from(bucketName)
        .list(userId);

      if (error) {
        console.error('Error listing salon images:', error);
        return [];
      }

      if (!files || files.length === 0) {
        return [];
      }

      // Get public URLs for all images
      const imageUrls = files.map((file) => {
        const { data: urlData } = supabaseAdmin.storage
          .from(bucketName)
          .getPublicUrl(`${userId}/${file.name}`);
        return urlData.publicUrl;
      });

      return imageUrls;
    } catch (error) {
      console.error('Error getting salon images:', error);
      return [];
    }
  }

  // Delete salon image
  async deleteSalonImage(userId, imageUrl) {
    const bucketName = 'salons_assets';
    
    try {
      // Extract file path from URL
      // URL format: https://...supabase.co/storage/v1/object/public/salons_assets/{userId}/{fileName}
      const urlParts = imageUrl.split('/');
      const bucketIndex = urlParts.findIndex(part => part === 'salons_assets');
      
      let filePath;
      if (bucketIndex !== -1 && bucketIndex < urlParts.length - 1) {
        // Extract path after salons_assets (should be userId/fileName)
        filePath = urlParts.slice(bucketIndex + 1).join('/');
      } else {
        // Fallback: look for userId in URL
        const userIdIndex = urlParts.findIndex(part => part === userId);
        if (userIdIndex === -1 || userIdIndex === urlParts.length - 1) {
          throw new AppError('Invalid image URL format', 400, 'INVALID_IMAGE_URL');
        }
        const fileName = urlParts.slice(userIdIndex + 1).join('/');
        filePath = `${userId}/${fileName}`;
      }
      
      console.log(`🗑️ Deleting image from path: ${filePath} (extracted from URL: ${imageUrl.substring(0, 100)}...)`);

      const { error } = await supabaseAdmin.storage
        .from(bucketName)
        .remove([filePath]);

      if (error) {
        console.error('Error deleting salon image:', error);
        throw new AppError('Failed to delete salon image', 500, 'SALON_IMAGE_DELETE_FAILED');
      }

      return true;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('Error in deleteSalonImage:', error);
      throw new AppError('Failed to delete salon image', 500, 'SALON_IMAGE_DELETE_FAILED');
    }
  }

  // Delete all user avatars from storage
  async deleteUserAvatars(userId) {
    const config = require('../config');
    const bucketName = config.supabase.storage_bucket;

    try {
      // List all files in user's folder
      const { data: files, error: listError } = await supabaseAdmin.storage
        .from(bucketName)
        .list(userId);

      if (listError) {
        console.error('Error listing user avatars:', listError);
        throw new AppError('Failed to list avatars', 500, 'AVATAR_LIST_FAILED');
      }

      // Delete all files if any exist
      if (files && files.length > 0) {
        const filesToDelete = files.map(file => `${userId}/${file.name}`);
        const { error: deleteError } = await supabaseAdmin.storage
          .from(bucketName)
          .remove(filesToDelete);

        if (deleteError) {
          console.error('Error deleting avatars:', deleteError);
          throw new AppError('Failed to delete avatars', 500, 'AVATAR_DELETE_FAILED');
        }

        console.log(`✅ Deleted ${files.length} avatar(s) for user ${userId}`);
      }

      return true;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('Error in deleteUserAvatars:', error);
      throw new AppError('Failed to delete avatars', 500, 'AVATAR_DELETE_FAILED');
    }
  }

  // Authentication helpers
  async checkUserExists(email) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserByEmail(email);

    if (error && error.status !== 400) {
      throw new AppError('Failed to check user existence', 500, 'AUTH_ERROR');
    }

    return !!data.user;
  }

  // OAuth URL generation
  async generateOAuthUrl(provider, redirectUrl) {
    try {
      console.log(`🔗 Generating OAuth URL for provider: ${provider}, redirectUrl: ${redirectUrl}`);
      
      // Apple doesn't support access_type and prompt parameters
      const options = {
        redirectTo: redirectUrl,
      };
      
      // Only add Google-specific parameters for Google provider
      if (provider === 'google') {
        options.queryParams = {
          access_type: 'offline',
          prompt: 'consent',
        };
      }
      
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: provider,
        options: options
      });

      if (error) {
        console.error(`❌ Supabase OAuth error for ${provider}:`, error);
        throw new AppError(`Failed to generate ${provider} OAuth URL: ${error.message}`, 500, 'OAUTH_ERROR');
      }

      if (!data || !data.url) {
        console.error(`❌ No OAuth URL returned for ${provider}`);
        throw new AppError(`Failed to generate ${provider} OAuth URL: No URL returned`, 500, 'OAUTH_ERROR');
      }

      console.log(`✅ Generated OAuth URL for ${provider}`);
      return data.url;
    } catch (err) {
      console.error(`❌ Exception generating OAuth URL for ${provider}:`, err);
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError(`Failed to generate ${provider} OAuth URL: ${err.message}`, 500, 'OAUTH_ERROR');
    }
  }

  // Session management
  async refreshSession(refreshToken) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });

    if (error) {
      throw new AppError('Failed to refresh session', 401, 'REFRESH_FAILED');
    }

    return data;
  }

  async signOut(token) {
    const { error } = await supabase.auth.signOut(token);

    if (error) {
      throw new AppError('Failed to sign out', 500, 'SIGNOUT_ERROR');
    }

    return true;
  }

  // User Settings Operations
  async getUserSettings(userId, accessToken) {
    try {
      console.log(`🔍 Fetching user settings for userId: ${userId}`);
      
      if (!accessToken) {
        throw new AppError('Access token required for user settings', 401, 'MISSING_TOKEN');
      }
      
      // Always use authenticated client with user's token for RLS
      const client = getAuthenticatedClient(accessToken);
      
      const { data, error } = await client
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No settings found, create default settings
          console.log('📝 No settings found, creating default settings...');
          return await this.createUserSettings(userId, accessToken);
      }
        console.error('❌ Error fetching user settings:', error);
        throw new AppError(
          `Failed to fetch user settings: ${error.message} (code: ${error.code})`,
          500,
          'DATABASE_ERROR'
        );
    }

      console.log('✅ User settings fetched successfully');
      return data;
    } catch (err) {
      console.error('❌ Exception in getUserSettings:', err);
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError(`Failed to fetch user settings: ${err.message}`, 500, 'DATABASE_ERROR');
    }
  }

  async createUserSettings(userId, accessToken) {
    try {
      console.log(`📝 Creating user settings for userId: ${userId}`);
      
      if (!accessToken) {
        throw new AppError('Access token required for user settings', 401, 'MISSING_TOKEN');
      }
      
      // Check if settings already exist
      const client = getAuthenticatedClient(accessToken);
      const { data: existingSettings, error: checkError } = await client
        .from('user_settings')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      
      if (checkError && checkError.code !== 'PGRST116') {
        console.error('❌ Error checking existing settings:', checkError);
        throw new AppError(
          `Failed to check existing user settings: ${checkError.message}`,
          500,
          'DATABASE_ERROR'
        );
      }
      
      // If settings already exist, return them instead of creating new ones
      if (existingSettings) {
        console.log('✅ User settings already exist, returning existing settings');
        return existingSettings;
      }
      
    const defaultSettings = {
      user_id: userId,
      language: 'en',
      theme: 'light',
        color_scheme: 'orange', // Match database default
      notifications_enabled: true,
      email_notifications: true,
      sms_notifications: false,
      push_notifications: true,
      booking_reminders: true,
      marketing_emails: false,
      location_sharing: true,
      data_analytics: true
    };

      // Always use authenticated client with user's token for RLS
      const { data, error } = await client
      .from('user_settings')
      .insert([defaultSettings])
      .select()
      .single();

    if (error) {
        console.error('❌ Error creating user settings:', error);
        console.error('❌ Error details:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        
        // If it's a unique constraint violation, try to fetch existing settings
        if (error.code === '23505' || error.message?.includes('duplicate') || error.message?.includes('unique')) {
          console.log('⚠️ Settings might already exist, attempting to fetch...');
          const { data: existing, error: fetchError } = await client
            .from('user_settings')
            .select('*')
            .eq('user_id', userId)
            .single();
          
          if (!fetchError && existing) {
            console.log('✅ Found existing settings after duplicate error');
            return existing;
          }
        }
        
        throw new AppError(
          `Failed to create user settings: ${error.message} (code: ${error.code})`,
          500,
          'DATABASE_ERROR'
        );
    }

      console.log('✅ User settings created successfully');
    return data;
    } catch (err) {
      console.error('❌ Exception in createUserSettings:', err);
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError(`Failed to create user settings: ${err.message}`, 500, 'DATABASE_ERROR');
    }
  }

  async updateUserSettings(userId, updates, accessToken) {
    try {
      console.log(`🔧 Updating user settings for userId: ${userId}`, updates);
      
      if (!accessToken) {
        throw new AppError('Access token required for user settings', 401, 'MISSING_TOKEN');
      }
      
      // Always use authenticated client with user's token for RLS
      const client = getAuthenticatedClient(accessToken);
      
      const { data, error } = await client
      .from('user_settings')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
        console.error('❌ Error updating user settings:', error);
      if (error.code === 'PGRST116') {
        // Settings don't exist, create them first
          console.log('📝 Creating default settings for user...');
        await this.createUserSettings(userId, accessToken);
        // Try update again
        return await this.updateUserSettings(userId, updates, accessToken);
      }
        throw new AppError(`Failed to update user settings: ${error.message}`, 500, 'DATABASE_ERROR');
    }

      console.log('✅ User settings updated successfully');
    return data;
    } catch (err) {
      console.error('❌ Exception in updateUserSettings:', err);
      throw err;
    }
  }

  // Track user interactions for personalization
  async trackUserInteraction(interactionData) {
    const { user_id, action, salon_id, timestamp } = interactionData;

    const { data, error } = await supabase
      .from('user_interactions')
      .insert({
        user_id,
        action,
        salon_id,
        timestamp: new Date(timestamp),
        created_at: new Date()
      })
      .select()
      .single();

    if (error) {
      console.error('Error tracking user interaction:', error);
      throw new AppError('Failed to track user interaction', 500, 'INTERACTION_TRACKING_FAILED');
    }

    return data;
  }

  // Family Members Operations
  async getFamilyMembers(userId) {
    const { data, error } = await supabaseAdmin
      .from('family_members')
      .select('*')
      .eq('parent_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching family members:', error);
      throw new AppError('Failed to fetch family members', 500, 'DATABASE_ERROR');
    }

    return data;
  }

  async addFamilyMember(userId, memberData) {
    // Map fields to match database schema
    const dbData = {
      parent_id: userId,
      name: memberData.name,
      relationship: memberData.relation || memberData.relationship || '',
      date_of_birth: memberData.date_of_birth || null
    };

    console.log('Adding family member with data:', dbData);

    const { data, error } = await supabaseAdmin
      .from('family_members')
      .insert([dbData])
      .select()
      .single();

    if (error) {
      console.error('Error adding family member:', error);
      throw new AppError('Failed to add family member: ' + error.message, 500, 'DATABASE_ERROR');
    }

    return data;
  }

  async updateFamilyMember(userId, memberId, updates) {
    // Map fields to match database schema
    const dbUpdates = {};
    if (updates.name) dbUpdates.name = updates.name;
    if (updates.relation || updates.relationship) dbUpdates.relationship = updates.relation || updates.relationship;
    if (updates.date_of_birth) dbUpdates.date_of_birth = updates.date_of_birth;

    const { data, error } = await supabaseAdmin
      .from('family_members')
      .update(dbUpdates)
      .eq('id', memberId)
      .eq('parent_id', userId) // Ensure ownership
      .select()
      .single();

    if (error) {
      console.error('Error updating family member:', error);
      throw new AppError('Failed to update family member', 500, 'DATABASE_ERROR');
    }

    return data;
  }

  async deleteFamilyMember(userId, memberId) {
    const { error } = await supabaseAdmin
      .from('family_members')
      .delete()
      .eq('id', memberId)
      .eq('parent_id', userId); // Ensure ownership

    if (error) {
      console.error('Error deleting family member:', error);
      throw new AppError('Failed to delete family member', 500, 'DATABASE_ERROR');
    }

    return true;
  }
}

module.exports = new SupabaseService();

