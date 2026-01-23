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
    // Add small delay to respect rate limits (1 request per second for OpenStreetMap)
    if (geocodedSalons.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1100)); // 1.1 seconds between requests
    }
    const geocoded = await geocodeSalonWithAddress(salon);
    geocodedSalons.push(geocoded);
  }
  
  return geocodedSalons;
}

// Legacy functions for backward compatibility (city-based, Netherlands only)
const cityCoordinates = {
  'Amsterdam': { lat: 52.3676, lng: 4.9041 },
  'Rotterdam': { lat: 51.9244, lng: 4.4777 },
  'Utrecht': { lat: 52.0907, lng: 5.1214 },
  'The Hague': { lat: 52.0705, lng: 4.3007 },
  'Eindhoven': { lat: 51.4416, lng: 5.4697 },
  'Tilburg': { lat: 51.5555, lng: 5.0913 },
  'Groningen': { lat: 53.2194, lng: 6.5665 },
  'Almere': { lat: 52.3508, lng: 5.2647 },
  'Breda': { lat: 51.5719, lng: 4.7683 },
  'Nijmegen': { lat: 51.8426, lng: 5.8590 },
  'Apeldoorn': { lat: 52.2112, lng: 5.9699 },
  'Haarlem': { lat: 52.3874, lng: 4.6462 },
  'Arnhem': { lat: 51.9851, lng: 5.8987 },
  'Zaanstad': { lat: 52.4389, lng: 4.8258 },
  'Amersfoort': { lat: 52.1561, lng: 5.3878 },
  'Hoofddorp': { lat: 52.3030, lng: 4.6892 },
  'Maastricht': { lat: 50.8514, lng: 5.6910 },
  'Leiden': { lat: 52.1601, lng: 4.4970 },
  'Dordrecht': { lat: 51.8133, lng: 4.6900 },
  'Zoetermeer': { lat: 52.0575, lng: 4.4932 },
  'Capelle aan den IJssel': { lat: 51.9292, lng: 4.5778 },
  'Capelle': { lat: 51.9292, lng: 4.5778 }
};

function getCityCoordinates(city) {
  if (!city) return null;
  
  if (cityCoordinates[city]) {
    return cityCoordinates[city];
  }
  
  const cityKey = Object.keys(cityCoordinates).find(
    key => key.toLowerCase() === city.toLowerCase()
  );
  
  return cityKey ? cityCoordinates[cityKey] : null;
}

function addRandomOffset(lat, lng) {
  const latOffset = (Math.random() - 0.5) * 0.09;
  const lngOffset = (Math.random() - 0.5) * 0.09;
  
  return {
    latitude: parseFloat((lat + latOffset).toFixed(6)),
    longitude: parseFloat((lng + lngOffset).toFixed(6))
  };
}

function geocodeSalon(salon) {
  const coords = getCityCoordinates(salon.city);
  
  if (coords) {
    const { latitude, longitude } = addRandomOffset(coords.lat, coords.lng);
    return {
      ...salon,
      latitude,
      longitude
    };
  }
  
  return salon;
}

module.exports = {
  getCityCoordinates,
  addRandomOffset,
  geocodeSalon,
  geocodeSalons, // Now async and works globally
  geocodeAddress, // Now works globally
  geocodeSalonWithAddress // Now works globally
};
