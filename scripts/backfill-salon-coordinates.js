/**
 * Backfill script to geocode existing salons without coordinates
 * Run with: node scripts/backfill-salon-coordinates.js
 */

require('dotenv').config();
const { supabaseAdmin } = require('../src/config/database');
const { geocodeAddress } = require('../src/utils/geocoding');

async function backfillSalonCoordinates() {
  try {
    console.log('🔍 Fetching salons without coordinates...');
    
    // Get all salons without coordinates
    const { data: salons, error } = await supabaseAdmin
      .from('salons')
      .select('id, business_name, address, city, zip_code, country, latitude, longitude')
      .or('latitude.is.null,longitude.is.null')
      .limit(100); // Process in batches to avoid rate limits

    if (error) {
      console.error('❌ Error fetching salons:', error);
      return;
    }

    if (!salons || salons.length === 0) {
      console.log('✅ No salons need coordinates backfill');
      return;
    }

    console.log(`📋 Found ${salons.length} salons without coordinates`);

    let successCount = 0;
    let failCount = 0;

    for (const salon of salons) {
      try {
        // Skip if already has coordinates
        if (salon.latitude && salon.longitude) {
          continue;
        }

        console.log(`\n🌍 Geocoding: ${salon.business_name} (${salon.address}, ${salon.city})`);

        // Try geocoding with full address first
        let coords = await geocodeAddress(
          salon.address || '',
          salon.city || '',
          salon.zip_code || '',
          salon.country || 'NL'
        );

        // If full address fails, try with just city and country (fallback for fake addresses)
        if (!coords || !coords.latitude || !coords.longitude) {
          console.log(`⚠️ Full address geocoding failed, trying city-only for ${salon.business_name}...`);
          coords = await geocodeAddress(
            '', // No street address
            salon.city || '',
            '', // No zip code
            salon.country || 'NL'
          );
        }

        if (coords && coords.latitude && coords.longitude) {
          // Update salon with coordinates
          const { error: updateError } = await supabaseAdmin
            .from('salons')
            .update({
              latitude: coords.latitude,
              longitude: coords.longitude,
              updated_at: new Date().toISOString()
            })
            .eq('id', salon.id);

          if (updateError) {
            console.error(`❌ Failed to update ${salon.business_name}:`, updateError.message);
            failCount++;
          } else {
            console.log(`✅ Updated ${salon.business_name}: ${coords.latitude}, ${coords.longitude}`);
            successCount++;
          }
        } else {
          console.log(`⚠️ Could not geocode ${salon.business_name} (tried full address and city-only)`);
          failCount++;
        }

        // Add delay to avoid rate limits (1 request per second)
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`❌ Error processing ${salon.business_name}:`, error.message);
        failCount++;
      }
    }

    console.log(`\n✅ Backfill complete!`);
    console.log(`   Success: ${successCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log(`   Total: ${salons.length}`);

  } catch (error) {
    console.error('❌ Fatal error:', error);
  }
}

// Run the backfill
backfillSalonCoordinates()
  .then(() => {
    console.log('\n✅ Script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
