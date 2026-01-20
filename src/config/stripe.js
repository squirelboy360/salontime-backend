const Stripe = require('stripe');
const config = require('./index');

// Initialize Stripe (will be null if no secret key)
const stripe = config.stripe.secret_key 
  ? new Stripe(config.stripe.secret_key, {
      apiVersion: '2025-12-15.clover', // Updated to match Stripe dashboard
    })
  : null;

// Test Stripe connection
const testStripeConnection = async () => {
  if (!stripe) {
    console.log('⚠️  Stripe not configured - payments will be disabled');
    return;
  }

  try {
    await stripe.accounts.list({ limit: 1 });
    console.log('✅ Stripe connection established');
  } catch (error) {
    console.log('⚠️  Stripe connection failed - payments will be disabled');
    console.log('   Fix: Add valid STRIPE_SECRET_KEY to .env file');
  }
};

// Test connection on startup
testStripeConnection();

module.exports = {
  stripe,
  isStripeEnabled: !!stripe
};

