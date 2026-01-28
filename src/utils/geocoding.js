const NodeGeocoder = require('node-geocoder');

// Initialize geocoder with OpenStreetMap provider (free, no API key, works globally)
// Falls back to other providers if needed
const geocoder = NodeGeocoder({
  provider: 'openstreetmap',
  httpAdapter: 'https',
  formatter: null, // Use raw response
  // Optional: Add more providers as fallback
  // You can add Google, Mapbox, etc. if you have API keys
});

/**
 * Geocode a full address - works for ANY country worldwide
 * @param {string} address - Street address
 * @param {string} city - City name
 * @param {string} zipCode - Zip/Postal code
 * @param {string} country - Country name or code (e.g., 'Netherlands', 'USA', 'NL', 'US')
 * @returns {Promise<Object|null>} - { latitude, longitude } or null if not found
 */
async function geocodeAddress(address, city, zipCode, country = null) {
  try {
    // Build full address string for better geocoding accuracy
    const addressParts = [];
    if (address) addressParts.push(address);
    if (zipCode) addressParts.push(zipCode);
    if (city) addressParts.push(city);
    if (country) addressParts.push(country);
    
    const fullAddress = addressParts.join(', ');
    
    if (!fullAddress || fullAddress.trim().length < 5) {
      console.log('⚠️ Address too short for geocoding:', fullAddress);
      return null;
    }

    console.log('🌍 Geocoding address (global):', fullAddress);
    
    // Geocode using node-geocoder (works for all countries)
    const results = await geocoder.geocode(fullAddress);
    
    if (results && results.length > 0) {
      const result = results[0];
      const latitude = parseFloat(result.latitude);
      const longitude = parseFloat(result.longitude);
      
      if (!isNaN(latitude) && !isNaN(longitude)) {
        console.log('✅ Geocoded address:', fullAddress, '→', latitude, longitude, `(${result.country || 'Unknown country'})`);
        
        return {
          latitude,
          longitude
        };
      }
    }
    
    console.log('⚠️ No geocoding results for:', fullAddress);
    return null;
  } catch (error) {
    console.error('❌ Geocoding error:', error.message);
    return null;
  }
}

/**
 * Geocode a salon using full address - works globally
 * @param {Object} salon - Salon object with address, city, zip_code, country fields
 * @returns {Promise<Object>} - Salon with latitude and longitude added
 */
async function geocodeSalonWithAddress(salon) {
  // If salon already has coordinates, return as-is
  if (salon.latitude && salon.longitude && !isNaN(salon.latitude) && !isNaN(salon.longitude)) {
    return salon;
  }

  // Extract address components
  let address = '';
  let city = '';
  let zipCode = '';
  let country = salon.country || null;

  // Handle different address formats
  if (typeof salon.address === 'string') {
    address = salon.address;
  } else if (salon.address && typeof salon.address === 'object') {
    // Address is an object with street, city, etc.
    address = salon.address.street || salon.address.address || '';
    city = salon.address.city || salon.city || '';
    zipCode = salon.address.zip_code || salon.address.zipCode || salon.zip_code || '';
    country = salon.address.country || salon.country || null;
  }

  // Fallback to direct fields
  if (!address) address = salon.address || '';
  if (!city) city = salon.city || '';
  if (!zipCode) zipCode = salon.zip_code || '';

  // Try to geocode using full address
  if (address && city) {
    const coords = await geocodeAddress(address, city, zipCode, country);
    if (coords) {
      return {
        ...salon,
        latitude: coords.latitude,
        longitude: coords.longitude
      };
    }
  }

  // If address geocoding fails, try with just city and country
  if (city && country) {
    console.log('⚠️ Full address geocoding failed, trying city only:', city, country);
    const coords = await geocodeAddress('', city, '', country);
    if (coords) {
      return {
        ...salon,
        latitude: coords.latitude,
        longitude: coords.longitude
      };
    }
  }

  // Return salon without coordinates if geocoding fails
  console.log('⚠️ Geocoding failed for salon, returning without coordinates');
  return salon;
}

/**
 * Geocode multiple salons - works globally
 * @param {Array} salons - Array of salon objects
 * @returns {Promise<Array>} - Array of salons with coordinates
 */
async function geocodeSalons(salons) {
  if (!Array.isArray(salons)) return [];
  
  const geocodedSalons = [];
  for (const salon of salons) {
    if (geocodedSalons.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    const geocoded = await geocodeSalonWithAddress(salon);
    geocodedSalons.push(geocoded);
  }
  return geocodedSalons;
}

/**
 * Reverse geocode: coordinates → place name / address (OpenStreetMap API).
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<Object|null>} - { city, country, formattedAddress, ... } or null
 */
async function reverseGeocode(lat, lon) {
  try {
    if (lat == null || lon == null || isNaN(Number(lat)) || isNaN(Number(lon))) {
      return null;
    }
    const results = await geocoder.reverse({ lat: Number(lat), lon: Number(lon) });
    if (!results || results.length === 0) return null;
    const r = results[0];
    return {
      city: r.city || r.town || r.village || r.county,
      country: r.country,
      countryCode: r.countryCode,
      formattedAddress: r.formattedAddress,
      street: r.streetName,
      zipCode: r.zipcode,
      state: r.administrativeLevels?.level1long,
    };
  } catch (err) {
    console.error('❌ Reverse geocode error:', err?.message ?? err);
    return null;
  }
}

module.exports = {
  geocodeAddress,
  geocodeSalonWithAddress,
  geocodeSalons,
  reverseGeocode,
};
