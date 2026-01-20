const express = require('express');
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Public routes (no authentication required)
router.post('/oauth/generate-url', authController.generateOAuthUrl);
router.post('/oauth/callback', authController.handleOAuthCallback);
router.post('/refresh', authController.refreshToken);

// Email/Password authentication routes
router.post('/login', authController.login);
router.post('/register', authController.register);
router.post('/forgot-password', authController.forgotPassword);
router.post('/resend-confirmation', authController.resendConfirmation);

// Protected routes (authentication required)
router.get('/profile', authenticateToken, authController.getProfile);
router.post('/signout', authenticateToken, authController.signOut);
router.get('/check', authenticateToken, authController.checkAuth);

module.exports = router;

