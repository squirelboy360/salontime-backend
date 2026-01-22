const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticateToken } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateToken);

// Report routes
router.post('/review/:reviewId', reportController.submitReviewReport);

module.exports = router;
