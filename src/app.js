const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const config = require('./config');

// Import middleware
const { errorHandler, notFound } = require('./middleware/errorHandler');
const logger = require('./middleware/logger');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const salonRoutes = require('./routes/salonRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const onboardingRoutes = require('./routes/onboardingRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const waitlistRoutes = require('./routes/waitlistRoutes');
const chatRoutes = require('./routes/chatRoutes');
const userSettingsRoutes = require('./routes/userSettings');
const sampleDataRoutes = require('./routes/sampleData');
const favoritesRoutes = require('./routes/favorites');
const analyticsRoutes = require('./routes/analyticsRoutes');
const cronRoutes = require('./routes/cronRoutes');
const businessHoursRoutes = require('./routes/businessHours');
const reviewRoutes = require('./routes/reviewRoutes');
const aiRoutes = require('./routes/aiRoutes');

// Validate configuration
config.validate();

const app = express();

// Trust proxy for Heroku/AWS deployments
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration
app.use(cors({
  origin: config.cors.allowed_origins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.window_ms,
  max: config.isDevelopment() ? config.rateLimit.dev_max_requests : config.rateLimit.prod_max_requests,
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Stripe webhook endpoint (MUST be before JSON parsing middleware)
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  console.log('Webhook received:', req.headers['stripe-signature']);
  console.log('Webhook body type:', typeof req.body);
  console.log('Webhook body length:', req.body ? req.body.length : 'No body');
  
  // This will be handled by the Stripe service
  const stripeService = require('./services/stripeService');
  stripeService.handleWebhook(req, res);
});

// Apply rate limiting to API routes
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: config.request.size_limit }));
app.use(express.urlencoded({ extended: true, limit: config.request.url_limit }));

// Compression middleware
app.use(compression());

// Logging middleware
app.use(logger);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: `${config.business.name} API is running`,
    timestamp: new Date().toISOString(),
    version: config.server.api_version,
    environment: config.server.node_env
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/user', userSettingsRoutes);
app.use('/api/salons', salonRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/sample-data', sampleDataRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/salon', businessHoursRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/ai', aiRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Welcome to SalonTime API',
    version: '1.0.0',
    documentation: '/api/docs',
    endpoints: {
      auth: '/api/auth',
      salons: '/api/salons',
      services: '/api/services',
      bookings: '/api/bookings',
      payments: '/api/payments'
    }
  });
});

// 404 handler
app.use(notFound);

// Global error handler
app.use(errorHandler);

module.exports = app;

