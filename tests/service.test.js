const request = require('supertest');
const express = require('express');
const serviceRoutes = require('../src/routes/serviceRoutes');
const { authenticateToken } = require('../src/middleware/auth');

// Mock dependencies
jest.mock('../src/config/database');
jest.mock('../src/middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/services', serviceRoutes);

describe('Service Controller Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/services', () => {
    beforeEach(() => {
      authenticateToken.mockImplementation((req, res, next) => {
        req.user = { id: 'owner-123' };
        next();
      });
    });

    it('should create a service successfully', async () => {
      const mockService = {
        id: 'service-123',
        salon_id: 'salon-123',
        name: 'Haircut',
        price: 50,
        duration: 60,
        is_active: true
      };

      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({ data: [mockService], error: null })
        })
      });

      const response = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer valid-token')
        .send({
          salon_id: 'salon-123',
          name: 'Haircut',
          price: 50,
          duration: 60
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    });

    it('should reject service with missing required fields', async () => {
      const response = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer valid-token')
        .send({
          name: 'Haircut'
          // Missing price, duration
        });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/services', () => {
    beforeEach(() => {
      authenticateToken.mockImplementation((req, res, next) => {
        req.user = { id: 'owner-123' };
        next();
      });
    });

    it('should get salon services', async () => {
      const mockServices = [
        {
          id: 'service-1',
          name: 'Haircut',
          price: 50,
          duration: 60
        },
        {
          id: 'service-2',
          name: 'Hair Color',
          price: 100,
          duration: 120
        }
      ];

      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: mockServices, error: null })
          })
        })
      });

      const response = await request(app)
        .get('/api/services?salon_id=salon-123')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    });
  });

  describe('PUT /api/services/:id', () => {
    beforeEach(() => {
      authenticateToken.mockImplementation((req, res, next) => {
        req.user = { id: 'owner-123' };
        next();
      });
    });

    it('should update a service', async () => {
      const mockService = {
        id: 'service-123',
        name: 'Updated Haircut',
        price: 60,
        duration: 60
      };

      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue({ data: [mockService], error: null })
          })
        })
      });

      const response = await request(app)
        .put('/api/services/service-123')
        .set('Authorization', 'Bearer valid-token')
        .send({
          price: 60
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('DELETE /api/services/:id', () => {
    beforeEach(() => {
      authenticateToken.mockImplementation((req, res, next) => {
        req.user = { id: 'owner-123' };
        next();
      });
    });

    it('should delete a service', async () => {
      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        delete: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ data: null, error: null })
        })
      });

      const response = await request(app)
        .delete('/api/services/service-123')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});

