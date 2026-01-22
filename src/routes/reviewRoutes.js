const express = require('express');
const router = express.Router();
const reviewController = require('../controllers/reviewController');
const { authenticateToken } = require('../middleware/auth');

// Public route - get reviews for a salon (no auth required)
router.get('/salon/:salonId', reviewController.getSalonReviews);

// All other routes require authentication
router.use(authenticateToken);

// User review routes
router.post('/', reviewController.createReview);
router.get('/my-reviews', reviewController.getMyReviews);
router.get('/booking/:bookingId/can-review', reviewController.canReviewBooking);
router.put('/:reviewId', reviewController.updateReview);
router.delete('/:reviewId', reviewController.deleteReview);

// Salon owner reply to review
router.post('/:reviewId/reply', reviewController.replyToReview);

module.exports = router;

