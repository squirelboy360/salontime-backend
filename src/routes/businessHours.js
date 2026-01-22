const express = require('express');
const router = express.Router();
const businessHoursController = require('../controllers/businessHoursController');
const { authenticateToken } = require('../middleware/auth');

// Get salon's business hours
router.get('/:salonId/business-hours', businessHoursController.getBusinessHours);

// Update salon's business hours
router.put('/:salonId/business-hours', authenticateToken, businessHoursController.updateBusinessHours);

module.exports = router;

