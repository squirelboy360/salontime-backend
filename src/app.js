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
const reportRoutes = require('./routes/reportRoutes');
const aiRoutes = require('./routes/aiRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const geocodeRoutes = require('./routes/geocode');

const path = require('path');

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

// Static files for landing page
app.use('/salontime-landing', express.static(path.join(__dirname, '../salontime-landing')));
app.use(express.static(path.join(__dirname, '../salontime-landing')));

// Apply rate limiting to API routes
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: config.request.size_limit }));
app.use(express.urlencoded({ extended: true, limit: config.request.url_limit }));

// Compression middleware
app.use(compression());

// Logging middleware
app.use(logger);

// Favicon (avoid 404 logs from Vercel/browsers)
app.get('/favicon.ico', (req, res) => { res.status(204).end(); });
app.get('/favicon.png', (req, res) => { res.status(204).end(); });

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

// Password reset redirect page: Supabase sends user here with #access_token=...&refresh_token=...
// JavaScript reads the hash and redirects to salontime://auth/reset-password?access_token=...&refresh_token=...
// Query params are passed to the app reliably (unlike the hash on iOS). Set PASSWORD_RESET_REDIRECT_URL to this route's URL.
app.get('/auth/reset-password', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reset password - SalonTime</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
    .msg { color: #666; margin: 16px 0; }
    .err { color: #c00; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <div id="out"><p class="msg">Opening SalonTime…</p></div>
  <script>
    (function() {
      var hash = (window.location.hash || '').replace(/^#/, '');
      var params = {};
      hash.split('&').forEach(function(p) {
        var i = p.indexOf('=');
        if (i > 0) params[decodeURIComponent(p.slice(0,i))] = decodeURIComponent((p.slice(i+1) || ''));
      });
      var at = params.access_token;
      var rt = params.refresh_token;
      if (at && rt) {
        var q = 'access_token=' + encodeURIComponent(at) + '&refresh_token=' + encodeURIComponent(rt);
        window.location.href = 'salontime://auth/reset-password?' + q;
        return;
      }
      document.getElementById('out').innerHTML = '<p class="err">Invalid or expired link.</p><p class="msg">Open the SalonTime app and request a new password reset from the login screen.</p>';
    })();
  </script>
</body>
</html>`);
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
app.use('/api/reports', reportRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/geocode', geocodeRoutes);

// Root endpoint: Serve landing page if exists, otherwise JSON
app.get('/', (req, res) => {
  const landingPath = path.join(__dirname, '../salontime-landing/index.html');
  if (require('fs').existsSync(landingPath)) {
    return res.sendFile(landingPath);
  }
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

