const request = require('supertest');
const express = require('express');
const bookingRoutes = require('../src/routes/bookingRoutes');
const { authenticateToken } = require('../src/middleware/auth');

// Mock dependencies
jest.mock('../src/config/database');
jest.mock('../src/services/supabaseService');
jest.mock('../src/services/emailService');
jest.mock('../src/middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/bookings', bookingRoutes);

describe('Booking Controller Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/bookings', () => {
    beforeEach(() => {
      authenticateToken.mockImplementation((req, res, next) => {
        req.user = { id: 'client-123' };
        next();
      });
    });

    it('should create a booking successfully', async () => {
      const mockService = {
        id: 'service-123',
        salon_id: 'salon-123',
        name: 'Haircut',
        price: 50,
        duration: 60
      };

      const mockSalon = {
        id: 'salon-123',
        business_name: 'Test Salon',
        email: 'salon@test.com'
      };

      const mockBooking = {
        id: 'booking-123',
        client_id: 'client-123',
        salon_id: 'salon-123',
        service_id: 'service-123',
        appointment_date: '2024-12-25',
        start_time: '10:00:00',
        end_time: '11:00:00',
        status: 'pending'
      };

      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: mockService, error: null })
          })
        })
      });

      // Mock salon lookup
      supabase.from = jest.fn()
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockService, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockSalon, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue({ data: [mockBooking], error: null })
          })
        });

      const response = await request(app)
        .post('/api/bookings')
        .set('Authorization', 'Bearer valid-token')
        .send({
          salon_id: 'salon-123',
          service_id: 'service-123',
          appointment_date: '2024-12-25',
          start_time: '10:00'
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    });

    it('should reject booking with missing required fields', async () => {
      const response = await request(app)
        .post('/api/bookings')
        .set('Authorization', 'Bearer valid-token')
        .send({
          salon_id: 'salon-123'
          // Missing service_id, appointment_date, start_time
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should reject booking for non-existent service', async () => {
      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } })
          })
        })
      });

      const response = await request(app)
        .post('/api/bookings')
        .set('Authorization', 'Bearer valid-token')
        .send({
          salon_id: 'salon-123',
          service_id: 'non-existent',
          appointment_date: '2024-12-25',
          start_time: '10:00'
        });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/bookings/my-bookings', () => {
    beforeEach(() => {
      authenticateToken.mockImplementation((req, res, next) => {
        req.user = { id: 'client-123' };
        next();
      });
    });

    it('should get user bookings', async () => {
      const mockBookings = [
        {
          id: 'booking-1',
          client_id: 'client-123',
          salon_id: 'salon-123',
          appointment_date: '2024-12-25',
          status: 'confirmed'
        }
      ];

      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: mockBookings, error: null })
          })
        })
      });

      const response = await request(app)
        .get('/api/bookings/my-bookings')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    });

    it('should filter bookings by status', async () => {
      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: [], error: null })
          })
        })
      });

      const response = await request(app)
        .get('/api/bookings/my-bookings?status=confirmed')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
    });
  });

  describe('PATCH /api/bookings/:id/status', () => {
    beforeEach(() => {
      authenticateToken.mockImplementation((req, res, next) => {
        req.user = { id: 'client-123' };
        next();
      });
    });

    it('should update booking status', async () => {
      const mockBooking = {
        id: 'booking-123',
        status: 'confirmed'
      };

      const { supabase } = require('../src/config/database');
      supabase.from = jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue({ data: [mockBooking], error: null })
          })
        })
      });

      const response = await request(app)
        .patch('/api/bookings/booking-123/status')
        .set('Authorization', 'Bearer valid-token')
        .send({
          status: 'confirmed'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});

