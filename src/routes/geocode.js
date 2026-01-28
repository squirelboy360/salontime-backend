const express = require('express');
const { reverseGeocode } = require('../utils/geocoding');

const router = express.Router();

/**
 * GET /api/geocode/reverse?lat=...&lon=...
 * Coords → place name / address (OpenStreetMap API, no hardcoding).
 */
router.get('/reverse', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        success: false,
        error: { message: 'lat and lon query params required (numbers)' },
      });
    }
    const place = await reverseGeocode(lat, lon);
    if (!place) {
      return res.status(404).json({
        success: false,
        error: { message: 'No place found for coordinates' },
      });
    }
    return res.status(200).json({ success: true, data: place });
  } catch (e) {
    console.error('Geocode reverse error:', e);
    return res.status(500).json({
      success: false,
      error: { message: e?.message ?? 'Reverse geocode failed' },
    });
  }
});

module.exports = router;
