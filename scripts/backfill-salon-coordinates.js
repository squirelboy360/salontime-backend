/**
 * Backfill script to geocode existing salons without coordinates.
 * Uses OpenStreetMap (no API key). Works globally (NL, US, etc.).
 *
 * Run: node scripts/backfill-salon-coordinates.js
 * Optional: BATCH=50 node scripts/backfill-salon-coordinates.js  (default 50 per run)
 * Loops until no salons remain without coordinates.
 */

require('dotenv').config();
const { supabaseAdmin } = require('../src/config/database');
const { geocodeAddress } = require('../src/utils/geocoding');

const BATCH_SIZE = parseInt(process.env.BATCH || '50', 10) || 50;

async function processBatch() {
  const { data: salons, error } = await supabaseAdmin
    .from('salons')
    .select('id, business_name, address, city, zip_code, country, latitude, longitude')
    .or('latitude.is.null,longitude.is.null')
    .limit(BATCH_SIZE);

  if (error) {
    console.error('❌ Error fetching salons:', error);
    return { success: 0, fail: 0, total: 0, hasMore: false };
  }

  if (!salons || salons.length === 0) {
    return { success: 0, fail: 0, total: 0, hasMore: false };
  }

  let successCount = 0;
  let failCount = 0;

  for (const salon of salons) {
    try {
      if (salon.latitude && salon.longitude) continue;

      let coords = await geocodeAddress(
        salon.address || '',
        salon.city || '',
        salon.zip_code || '',
        salon.country || 'NL'
      );

      if (!coords?.latitude || !coords?.longitude) {
        coords = await geocodeAddress('', salon.city || '', '', salon.country || 'NL');
      }

      if (coords?.latitude && coords?.longitude) {
        const { error: updateError } = await supabaseAdmin
          .from('salons')
          .update({
            latitude: coords.latitude,
            longitude: coords.longitude,
            updated_at: new Date().toISOString()
          })
          .eq('id', salon.id);

        if (updateError) {
          console.error(`❌ Update ${salon.business_name}:`, updateError.message);
          failCount++;
        } else {
          console.log(`✅ ${salon.business_name}: ${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`);
          successCount++;
        }
      } else {
        console.log(`⚠️ No coords: ${salon.business_name} (${salon.city}, ${salon.country || 'NL'})`);
        failCount++;
      }

      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.error(`❌ ${salon.business_name}:`, e?.message ?? String(e));
      failCount++;
    }
  }

  return { success: successCount, fail: failCount, total: salons.length, hasMore: salons.length >= BATCH_SIZE };
}

async function backfillSalonCoordinates() {
  console.log('🔍 Geocoding salons without coordinates (OpenStreetMap, global). Batch size:', BATCH_SIZE);
  let round = 0;
  let totalSuccess = 0;
  let totalFail = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    round++;
    console.log(`\n--- Batch ${round} ---`);
    const { success, fail, total, hasMore } = await processBatch();
    totalSuccess += success;
    totalFail += fail;

    if (total === 0) {
      console.log('✅ No more salons to geocode.');
      break;
    }

    console.log(`   Done: +${success} ok, ${fail} failed (${total} in batch)`);
    if (!hasMore) break;
  }

  if (round > 0) {
    console.log(`\n✅ Backfill complete. Success: ${totalSuccess}, Failed: ${totalFail}`);
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
