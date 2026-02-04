// Load environment variables first
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');

// Validate required environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

// Create base Supabase client (without auth - will be set per request)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: true,
      persistSession: false, // Server-side doesn't need session persistence
      detectSessionInUrl: false // Server-side doesn't detect sessions from URL
    }
  }
);

// Function to get authenticated Supabase client for a specific user token
const getAuthenticatedClient = (accessToken) => {
  if (!accessToken) {
    return supabase; // Return base client if no token
  }
  
  // Create a new client instance with the user's token
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    }
  );
};

// Create admin client for server-side operations (avatars, cross-user profile reads).
// Must use SUPABASE_SERVICE_ROLE_KEY so RLS does not block reading other users' profiles (e.g. salon owner viewing employee avatars).
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️  SUPABASE_SERVICE_ROLE_KEY is not set; using anon key. RLS may block reading other users\' profiles (e.g. employee avatars).');
}

// Test connection
const testConnection = async () => {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('count')
      .limit(1);
    
    if (error && error.code !== 'PGRST116') { // PGRST116 is "relation does not exist"
      console.warn('⚠️  Supabase connection warning:', error.message);
    } else {
      console.log('✅ Supabase connection established');
    }
  } catch (err) {
    console.error('❌ Supabase connection failed:', err.message);
  }
};

// Test connection on startup
testConnection();

module.exports = {
  supabase,
  supabaseAdmin,
  getAuthenticatedClient
};

