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

// Protected routes (require authentication)
router.use(authenticateToken);

// Personalized recommendations (requires auth) - must be before /:salonId route
router.get('/recommendations/personalized', salonController.getPersonalizedRecommendations);

// Salon owner routes
router.post('/', salonController.createSalon);
router.get('/my/salon', salonController.getMySalon);
router.put('/my/salon', salonController.updateSalon);
router.get('/clients', salonController.getSalonClients);

// Stripe Connect routes
router.post('/stripe/account', salonController.createStripeAccount);
router.get('/stripe/onboarding-link', salonController.generateStripeOnboardingLink);
router.get('/stripe/check-status', salonController.checkStripeAccountStatus);
router.get('/stripe/dashboard-link', salonController.getStripeDashboardLink);

// Salon image routes
router.post('/images', salonImageUpload, salonController.uploadSalonImage);
router.delete('/images', salonController.deleteSalonImage);

module.exports = router;

