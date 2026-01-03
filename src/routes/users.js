const express = require('express');
const userController = require('../controllers/userController');
const { authenticateToken } = require('../middleware/auth');
const { avatarUpload } = require('../middleware/upload');

const router = express.Router();

// All user routes require authentication
router.use(authenticateToken);

// User profile management
router.put('/profile', userController.updateProfile);
router.get('/profile', userController.getProfile);
router.get('/dashboard', userController.getDashboard);

// Avatar upload (multipart/form-data)
router.post('/avatar', avatarUpload, userController.uploadAvatar);
router.delete('/avatar', userController.deleteAvatar);

// Notification settings
router.get('/notification-settings', userController.getNotificationSettings);
router.put('/notification-settings', userController.updateNotificationSettings);

// User interactions for personalization
router.post('/interactions', userController.trackUserInteraction);

// Family members
router.get('/family-members', userController.getFamilyMembers);
router.post('/family-members', userController.addFamilyMember);
router.put('/family-members/:memberId', userController.updateFamilyMember);
router.delete('/family-members/:memberId', userController.deleteFamilyMember);

// Account deletion
router.delete('/account', userController.deleteAccount);

module.exports = router;

