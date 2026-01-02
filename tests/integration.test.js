const request = require('supertest');
const express = require('express');
const app = require('../src/app');

describe('API Integration Tests', () => {
  describe('Health Check', () => {
    it('should return API information', async () => {
      const response = await request(app)
        .get('/');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Welcome to SalonTime API');
    });
  });

  describe('Authentication Flow', () => {
    it('should handle complete OAuth flow', async () => {
      // Step 1: Generate OAuth URL
      const generateResponse = await request(app)
        .post('/api/auth/oauth/generate-url')
        .send({
          provider: 'google',
          user_type: 'client'
        });

      expect(generateResponse.status).toBe(200);
      expect(generateResponse.body.data.oauth_url).toBeDefined();

      // Step 2: Handle callback (would need valid token in real test)
      // This would require mocking Supabase auth
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent routes', async () => {
      const response = await request(app)
        .get('/api/non-existent');

      expect(response.status).toBe(404);
    });

    it('should return 401 for protected routes without token', async () => {
      const response = await request(app)
        .get('/api/bookings/my-bookings');

      expect(response.status).toBe(401);
    });
  });
});

