const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { authenticateToken } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateToken);

// Get comprehensive salon analytics
router.get('/', analyticsController.getSalonAnalytics);

// Get reviews with pagination
router.get('/reviews', analyticsController.getReviews);

module.exports = router;
