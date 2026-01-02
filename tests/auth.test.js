const request = require('supertest');
const express = require('express');
const authRoutes = require('../src/routes/auth');
const { authenticateToken } = require('../src/middleware/auth');

// Mock dependencies
jest.mock('../src/config/database');
jest.mock('../src/services/supabaseService');
jest.mock('../src/middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

describe('Auth Controller Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/auth/oauth/generate-url', () => {
    it('should generate OAuth URL for Google', async () => {
      const mockOAuthUrl = 'https://supabase.co/auth/v1/authorize?...';
      const supabaseService = require('../src/services/supabaseService');
      supabaseService.generateOAuthUrl = jest.fn().mockResolvedValue(mockOAuthUrl);

      const response = await request(app)
        .post('/api/auth/oauth/generate-url')
        .send({
          provider: 'google',
          user_type: 'client'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.oauth_url).toBe(mockOAuthUrl);
      expect(response.body.data.provider).toBe('google');
    });

    it('should generate OAuth URL for Facebook', async () => {
      const mockOAuthUrl = 'https://supabase.co/auth/v1/authorize?...';
      const supabaseService = require('../src/services/supabaseService');
      supabaseService.generateOAuthUrl = jest.fn().mockResolvedValue(mockOAuthUrl);

      const response = await request(app)
        .post('/api/auth/oauth/generate-url')
        .send({
          provider: 'facebook',
          user_type: 'salon_owner'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.provider).toBe('facebook');
    });

    it('should reject unsupported provider', async () => {
      const response = await request(app)
        .post('/api/auth/oauth/generate-url')
        .send({
          provider: 'twitter',
          user_type: 'client'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should reject invalid user type', async () => {
      const response = await request(app)
        .post('/api/auth/oauth/generate-url')
        .send({
          provider: 'google',
          user_type: 'invalid'
        });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/auth/oauth/callback', () => {
    it('should handle OAuth callback successfully', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        user_metadata: {
          first_name: 'John',
          last_name: 'Doe'
        }
      };

      const mockProfile = {
        id: 'user-123',
        email: 'test@example.com',
        user_type: 'client',
        first_name: 'John',
        last_name: 'Doe'
      };

      const { supabase } = require('../src/config/database');
      supabase.auth.getUser = jest.fn().mockResolvedValue({
        data: { user: mockUser },
        error: null
      });

      const supabaseService = require('../src/services/supabaseService');
      supabaseService.getUserProfile = jest.fn().mockResolvedValue(mockProfile);
      supabaseService.generateTokens = jest.fn().mockResolvedValue({
        access_token: 'access-token-123',
        refresh_token: 'refresh-token-123'
      });

      const response = await request(app)
        .post('/api/auth/oauth/callback')
        .send({
          access_token: 'valid-token',
          user_type: 'client'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user).toBeDefined();
      expect(response.body.data.tokens).toBeDefined();
    });

    it('should reject callback without access token', async () => {
      const response = await request(app)
        .post('/api/auth/oauth/callback')
        .send({
          user_type: 'client'
        });

      expect(response.status).toBe(400);
    });

    it('should reject callback with invalid token', async () => {
      const { supabase } = require('../src/config/database');
      supabase.auth.getUser = jest.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid token' }
      });

      const response = await request(app)
        .post('/api/auth/oauth/callback')
        .send({
          access_token: 'invalid-token',
          user_type: 'client'
        });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/auth/profile', () => {
    it('should get user profile when authenticated', async () => {
      const mockProfile = {
        id: 'user-123',
        email: 'test@example.com',
        user_type: 'client'
      };

      authenticateToken.mockImplementation((req, res, next) => {
        req.user = { id: 'user-123' };
        next();
      });

      const supabaseService = require('../src/services/supabaseService');
      supabaseService.getUserProfile = jest.fn().mockResolvedValue(mockProfile);

      const response = await request(app)
        .get('/api/auth/profile')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    });
  });
});

