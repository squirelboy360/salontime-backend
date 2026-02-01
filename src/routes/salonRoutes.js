const express = require('express');
const router = express.Router();
const salonController = require('../controllers/salonController');
const { authenticateToken } = require('../middleware/auth');
const { salonImageUpload } = require('../middleware/upload');

// Public routes
router.get('/nearby', salonController.getNearbySalons);
router.get('/popular', salonController.getPopularSalons);
router.get('/search', salonController.searchSalons);
router.get('/:salonId', salonController.getSalon);
router.get('/:salonId/services', salonController.getSalonServices);
router.get('/:salonId/staff', salonController.getSalonStaff);

// Tracking routes (optional auth - tracks anonymous users too)
router.post('/:salonId/track-view', salonController.trackSalonView);
router.post('/:salonId/track-favorite', salonController.trackSalonFavorite);

// Protected routes (require authentication)
router.use(authenticateToken);

// Personalized recommendations (requires auth) - must be before /:salonId route
router.get('/recommendations/personalized', salonController.getPersonalizedRecommendations);

// Salon owner routes
router.post('/', salonController.createSalon);
router.get('/my/salon', salonController.getMySalon);
router.put('/my/salon', salonController.updateSalon);
router.get('/my/join-code', salonController.getJoinCode);
router.get('/my/employees', salonController.getMyEmployees);
router.get('/my/employee-stats', salonController.getEmployeeStats);
router.get('/clients', salonController.getSalonClients);

// Employee join/leave (any authenticated user)
router.post('/join', salonController.joinSalonByCode);
router.delete('/leave/:salonId', salonController.leaveSalon);

// Stripe Connect routes
router.post('/stripe/account', salonController.createStripeAccount);
router.get('/stripe/onboarding-link', salonController.generateStripeOnboardingLink);
router.get('/stripe/check-status', salonController.checkStripeAccountStatus);
router.get('/stripe/dashboard-link', salonController.getStripeDashboardLink);

// Salon image routes
router.post('/images', salonImageUpload, salonController.uploadSalonImage);
router.delete('/images', salonController.deleteSalonImage);

// Tracking routes (can be called with or without auth)
router.post('/:salonId/track-view', salonController.trackSalonView);
router.post('/:salonId/track-favorite', salonController.trackSalonFavorite);

module.exports = router;

