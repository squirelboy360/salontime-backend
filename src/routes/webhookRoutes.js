const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// Stripe webhook - NO authentication, uses signature verification instead
// IMPORTANT: Must use express.raw() middleware for this route in app.js
router.post('/stripe', webhookController.handleStripeWebhook);

module.exports = router;
