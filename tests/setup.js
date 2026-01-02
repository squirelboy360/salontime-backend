// Test setup file
// This runs before all tests

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://REMOVED_SECRET.supabase.co';
process.env.SUPABASE_ANON_KEY = 'REMOVED_SECRET';
process.env.SUPABASE_SERVICE_KEY = 'REMOVED_SECRET';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.FRONTEND_URL = 'http://localhost:3000';

// Suppress console logs during tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

