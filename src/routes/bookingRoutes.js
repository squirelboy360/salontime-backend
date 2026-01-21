const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { authenticateToken } = require('../middleware/auth');

// All booking routes require authentication
router.use(authenticateToken);

// Client booking routes
router.post('/', bookingController.createBooking);
router.get('/', bookingController.getMyBookings); // Alias for /my-bookings
router.get('/my-bookings', bookingController.getMyBookings);
router.get('/available-slots', bookingController.getAvailableSlots);
router.get('/available-slots-count', bookingController.getAvailableSlotsCount);
router.get('/stats', bookingController.getBookingStats);
router.get('/reminders', bookingController.sendBookingReminders); // Admin/testing endpoint
router.patch('/:bookingId/status', bookingController.updateBookingStatus);
router.patch('/:bookingId/reschedule', bookingController.rescheduleBooking);

// Salon owner booking routes
router.get('/salon', bookingController.getSalonBookings);
router.patch('/:bookingId/cancel', bookingController.cancelBookingAsSalonOwner);
router.post('/:bookingId/mark-paid-cash', bookingController.markAsPaidCash);
router.post('/:bookingId/request-payment', bookingController.sendPaymentRequest);

// Client payment routes
router.post('/:bookingId/create-payment-intent', bookingController.createPaymentIntent);

module.exports = router;

