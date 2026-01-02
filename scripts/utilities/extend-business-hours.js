// DELETE AFTER: 2025-11-06
// Script to extend business hours for all salons to stay open until 23:00
// This allows testing bookings even in the evening

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

// Validate environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

async function extendBusinessHours() {
  try {
    console.log('🕐 Extending business hours for all salons...\n');

    // Fetch all salons
    const { data: salons, error: fetchError } = await supabase
      .from('salons')
      .select('id, business_name, business_hours');

    if (fetchError) {
      console.error('❌ Error fetching salons:', fetchError);
      throw fetchError;
    }

    if (!salons || salons.length === 0) {
      console.log('⚠️  No salons found');
      return;
    }

    console.log(`📋 Found ${salons.length} salons\n`);

    // Default business hours - all days open until 23:00
    const defaultBusinessHours = {
      monday: { opening: '09:00', closing: '23:00', closed: false },
      tuesday: { opening: '09:00', closing: '23:00', closed: false },
      wednesday: { opening: '09:00', closing: '23:00', closed: false },
      thursday: { opening: '09:00', closing: '23:00', closed: false },
      friday: { opening: '09:00', closing: '23:00', closed: false },
      saturday: { opening: '09:00', closing: '23:00', closed: false },
      sunday: { opening: '10:00', closing: '23:00', closed: false },
    };

    let updated = 0;
    let skipped = 0;

    for (const salon of salons) {
      let businessHours = salon.business_hours || {};

      // If business_hours is null or empty, use defaults
      if (!businessHours || Object.keys(businessHours).length === 0) {
        businessHours = defaultBusinessHours;
      } else {
        // Extend closing times for all days
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        for (const day of days) {
          if (!businessHours[day]) {
            businessHours[day] = day === 'sunday' 
              ? { opening: '10:00', closing: '23:00', closed: false }
              : { opening: '09:00', closing: '23:00', closed: false };
          } else if (businessHours[day].closed !== true && businessHours[day].closed !== 'true') {
            // Update closing time to 23:00 if not closed
            businessHours[day].closing = '23:00';
            businessHours[day].close = '23:00'; // Support both formats
            if (!businessHours[day].opening && !businessHours[day].open) {
              businessHours[day].opening = day === 'sunday' ? '10:00' : '09:00';
              businessHours[day].open = day === 'sunday' ? '10:00' : '09:00';
            }
          }
        }
      }

      // Update salon
      const { error: updateError } = await supabase
        .from('salons')
        .update({ business_hours: businessHours })
        .eq('id', salon.id);

      if (updateError) {
        console.error(`❌ Error updating ${salon.business_name}:`, updateError.message);
        skipped++;
      } else {
        console.log(`✅ Updated ${salon.business_name}`);
        updated++;
      }
    }

    console.log(`\n✅ Completed! Updated ${updated} salons, Skipped ${skipped} salons`);
    console.log('📅 All salons now close at 23:00 (11 PM)\n');

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

extendBusinessHours()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));






