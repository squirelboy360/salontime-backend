/**
 * Cache Middleware
 * Provides response caching for GET requests
 */

const cacheService = require('../services/cacheService');

/**
 * Cache middleware factory
 * @param {number} ttlSeconds - Time to live in seconds
 * @param {Function} keyGenerator - Optional function to generate cache key from request
 */
const cache = (ttlSeconds = null, keyGenerator = null) => {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Generate cache key
    const cacheKey = keyGenerator 
      ? keyGenerator(req)
      : `cache:${req.originalUrl}:${JSON.stringify(req.query)}`;

    try {
      // Try to get from cache
      const cached = await cacheService.get(cacheKey);
      
      if (cached) {
        // Set cache headers
        res.set('X-Cache', 'HIT');
        return res.status(200).json(cached);
      }

      // Cache miss - store original json method
      const originalJson = res.json.bind(res);
      
      // Override json method to cache response
      res.json = function(data) {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cacheService.set(cacheKey, data, ttlSeconds).catch(err => {
            console.error('Cache set error:', err);
          });
        }
        res.set('X-Cache', 'MISS');
        return originalJson(data);
      };

      next();
    } catch (error) {
      console.error('Cache middleware error:', error);
      next();
    }
  };
};

/**
 * Invalidate cache for a specific pattern
 */
const invalidateCache = async (pattern) => {
  await cacheService.deletePattern(pattern);
};

module.exports = {
  cache,
  invalidateCache
};
