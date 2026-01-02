# Backend Test Suite

This directory contains all test files for the SalonTime backend API.

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm run test:watch
```

### Run tests with coverage
```bash
npm test -- --coverage
```

## Test Structure

### Unit Tests
- `auth.test.js` - Authentication controller tests
- `booking.test.js` - Booking controller tests
- `service.test.js` - Service controller tests

### Integration Tests
- `integration.test.js` - API endpoint integration tests

## Test Configuration

Tests are configured using Jest. See `jest.config.js` for configuration details.

## Mocking

Tests use mocks for:
- Database (Supabase)
- External services (Stripe, Email)
- Authentication middleware

## Test Coverage Goals

- Unit tests: 80%+ coverage
- Integration tests: 60%+ coverage
- Critical paths: 100% coverage

## Writing New Tests

1. Create test file in `tests/` directory
2. Follow naming convention: `*.test.js`
3. Use `describe()` to group related tests
4. Use `beforeEach()` for test setup
5. Mock external dependencies

## Example Test Structure

```javascript
const request = require('supertest');
const express = require('express');

describe('ControllerName Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/endpoint', () => {
    it('should do something', async () => {
      const response = await request(app)
        .post('/api/endpoint')
        .send({ data: 'test' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});
```

