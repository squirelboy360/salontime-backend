const { supabase } = require('../config/database');

// Get salon's business hours
exports.getBusinessHours = async (req, res) => {
  const { salonId } = req.params;

  try {
    const { data: salon, error } = await supabase
      .from('salons')
      .select('business_hours')
      .eq('id', salonId)
      .single();

    if (error || !salon) {
      return res.status(404).json({
        success: false,
        message: 'Salon not found'
      });
    }

    res.json({
      success: true,
      data: {
        business_hours: salon.business_hours || {}
      }
    });
  } catch (error) {
    console.error('Error getting business hours:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve business hours',
      error: error.message
    });
  }
};

// Update salon's business hours
exports.updateBusinessHours = async (req, res) => {
  const { salonId } = req.params;
  const { business_hours } = req.body;

  try {
    // Validate business_hours structure
    if (!business_hours || typeof business_hours !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Invalid business hours format'
      });
    }

    // Validate each day's hours
    const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    
    for (const [day, hours] of Object.entries(business_hours)) {
      if (!validDays.includes(day.toLowerCase())) {
        return res.status(400).json({
          success: false,
          message: `Invalid day: ${day}`
        });
      }

      if (typeof hours !== 'object' || !hours.opening || !hours.closing) {
        return res.status(400).json({
          success: false,
          message: `Invalid hours format for ${day}`
        });
      }

      // Validate time format (HH:MM)
      const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(hours.opening) || !timeRegex.test(hours.closing)) {
        return res.status(400).json({
          success: false,
          message: `Invalid time format for ${day}. Use HH:MM format`
        });
      }
    }

    // Update business hours
    const { data: updatedSalon, error: updateError } = await supabase
      .from('salons')
      .update({ 
        business_hours: business_hours,
        updated_at: new Date().toISOString()
      })
      .eq('id', salonId)
      .select('business_hours')
      .single();

    if (updateError || !updatedSalon) {
      return res.status(404).json({
        success: false,
        message: 'Salon not found'
      });
    }

    res.json({
      success: true,
      message: 'Business hours updated successfully',
      data: {
        business_hours: updatedSalon.business_hours
      }
    });
  } catch (error) {
    console.error('Error updating business hours:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update business hours',
      error: error.message
    });
  }
};

