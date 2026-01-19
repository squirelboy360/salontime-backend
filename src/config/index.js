/**
 * Centralized configuration module
 * All environment variables and app configuration in one place
 */

const config = {
  // Server Configuration
  server: {
    node_env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT) || 3000,
    api_base_url: process.env.API_BASE_URL || 'http://localhost:3000',
    api_version: process.env.API_VERSION || '1.0.0'
  },

  // Supabase Configuration
  supabase: {
    url: process.env.SUPABASE_URL,
    anon_key: process.env.SUPABASE_ANON_KEY,
    service_role_key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    storage_bucket: process.env.SUPABASE_STORAGE_BUCKET || 'avatars'
    // Note: storage_url not needed - Supabase's getPublicUrl() automatically constructs it
  },

  // Stripe Configuration
  stripe: {
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY,
    secret_key: process.env.STRIPE_SECRET_KEY,
    webhook_secret: process.env.STRIPE_WEBHOOK_SECRET,
    plus_plan_price_id: process.env.STRIPE_PLUS_PLAN_PRICE_ID || 'price_plus_plan',
    premium_plan_price_id: process.env.STRIPE_PREMIUM_PLAN_PRICE_ID || 'price_premium_plan',
    enterprise_plan_price_id: process.env.STRIPE_ENTERPRISE_PLAN_PRICE_ID || 'price_enterprise_plan'
  },

  // Subscription Configuration
  subscription: {
    trial_days: parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS) || 7,
    currency: process.env.SUBSCRIPTION_CURRENCY || 'usd',
    enable_trials: process.env.SUBSCRIPTION_ENABLE_TRIALS === 'true'
  },

  // Payment Configuration
  payment: {
    currency: process.env.PAYMENT_CURRENCY || 'usd',
    application_fee_percent: parseFloat(process.env.PAYMENT_APPLICATION_FEE_PERCENT) || 0,
    platform_fee_enabled: process.env.PLATFORM_FEE_ENABLED === 'true',
    commission_rate: parseFloat(process.env.COMMISSION_RATE) || 0.00
  },

  // Email Configuration
  email: {
    smtp_host: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtp_port: parseInt(process.env.SMTP_PORT) || 587,
    smtp_user: process.env.SMTP_USER,
    smtp_pass: process.env.SMTP_PASS,
    from_email: process.env.FROM_EMAIL || 'noreply@example.com'
  },

  // Frontend URLs
  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:3000',
    oauth_redirect_url: process.env.OAUTH_REDIRECT_URL || 'http://localhost:3000/auth/callback'
  },

  // CORS Configuration
  cors: {
    allowed_origins: process.env.ALLOWED_ORIGINS ? 
      process.env.ALLOWED_ORIGINS.split(',') : 
      ['http://localhost:3000', 'http://localhost:8080']
  },

  // Rate Limiting Configuration
  rateLimit: {
    window_ms: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
    max_requests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    prod_max_requests: parseInt(process.env.RATE_LIMIT_PROD_MAX_REQUESTS) || 100,
    dev_max_requests: parseInt(process.env.RATE_LIMIT_DEV_MAX_REQUESTS) || 1000
  },

  // Request Size Limits
  request: {
    size_limit: process.env.REQUEST_SIZE_LIMIT || '10mb',
    url_limit: process.env.REQUEST_URL_LIMIT || '10mb'
  },

  // File Upload Configuration
  upload: {
    max_avatar_size: parseInt(process.env.MAX_AVATAR_SIZE) || 5242880, // 5 MB default
    allowed_avatar_types: process.env.ALLOWED_AVATAR_TYPES 
      ? process.env.ALLOWED_AVATAR_TYPES.split(',').map(t => t.trim())
      : ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']
  },

  // Analytics Configuration
  analytics: {
    default_period_days: parseInt(process.env.DEFAULT_ANALYTICS_PERIOD_DAYS) || 30,
    max_period_days: parseInt(process.env.MAX_ANALYTICS_PERIOD_DAYS) || 365
  },

  // Business Configuration
  business: {
    name: process.env.BUSINESS_NAME || 'SalonTime',
    support_email: process.env.SUPPORT_EMAIL || 'support@example.com',
    company_address: process.env.COMPANY_ADDRESS || ''
  },

  // Security Configuration
  security: {
    jwt_expiry: process.env.JWT_EXPIRY || '24h',
    refresh_token_expiry: process.env.REFRESH_TOKEN_EXPIRY || '30d',
    bcrypt_salt_rounds: parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12
  },

  // Booking Configuration
  booking: {
    max_advance_booking_days: parseInt(process.env.MAX_ADVANCE_BOOKING_DAYS) || 90,
    min_advance_booking_hours: parseInt(process.env.MIN_ADVANCE_BOOKING_HOURS) || 2,
    default_duration_minutes: parseInt(process.env.DEFAULT_BOOKING_DURATION_MINUTES) || 60,
    max_duration_minutes: parseInt(process.env.MAX_BOOKING_DURATION_MINUTES) || 480
  },

  // Cache Configuration
  cache: {
    ttl_seconds: parseInt(process.env.CACHE_TTL_SECONDS) || 3600,
    redis_url: process.env.REDIS_URL || 'redis://localhost:6379'
  },

  // Feature Flags
  features: {
    enable_email_notifications: process.env.ENABLE_EMAIL_NOTIFICATIONS !== 'false',
    enable_analytics: process.env.ENABLE_ANALYTICS !== 'false',
    enable_subscriptions: process.env.ENABLE_SUBSCRIPTIONS !== 'false',
    enable_webhooks: process.env.ENABLE_WEBHOOKS !== 'false',
    enable_ai: process.env.ENABLE_AI !== 'false'
  },

  // AI Configuration (Gemini)
  ai: {
    gemini_api_key: process.env.GEMINI_API_KEY,
    gemini_model: process.env.GEMINI_MODEL || 'gemini-2.5-pro', // Updated to latest stable model
    max_tokens: parseInt(process.env.AI_MAX_TOKENS) || 2048,
    temperature: parseFloat(process.env.AI_TEMPERATURE) || 0.8, // Increased for more proactive behavior
    max_conversation_history: parseInt(process.env.AI_MAX_CONVERSATION_HISTORY) || 10
  },

  // Helper methods
  isDevelopment: () => process.env.NODE_ENV === 'development',
  isProduction: () => process.env.NODE_ENV === 'production',
  isTest: () => process.env.NODE_ENV === 'test',

  // Validate required environment variables
  validate: () => {
    const required = [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY'
    ];

    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // Warn about optional but recommended variables
    const recommended = [
      'STRIPE_SECRET_KEY',
      'SMTP_USER',
      'SMTP_PASS'
    ];

    const missingRecommended = recommended.filter(key => !process.env[key]);
    
    if (missingRecommended.length > 0 && process.env.NODE_ENV === 'production') {
      console.warn(`Warning: Missing recommended environment variables for production: ${missingRecommended.join(', ')}`);
    }

    return true;
  }
};

module.exports = config;

