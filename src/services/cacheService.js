/**
 * Redis Cache Service
 * Provides caching layer for frequently accessed data
 */

const config = require('../config');

class CacheService {
  constructor() {
    this.client = null;
    this.enabled = false;
    this.initialize();
  }

  async initialize() {
    // Only initialize Redis if REDIS_URL is provided
    if (config.cache.redis_url && config.cache.redis_url !== 'redis://localhost:6379') {
      try {
        const redis = require('redis');
        this.client = redis.createClient({
          url: config.cache.redis_url,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                console.error('❌ Redis: Max reconnection attempts reached');
                return new Error('Max reconnection attempts reached');
              }
              return Math.min(retries * 100, 3000);
            }
          }
        });

        this.client.on('error', (err) => {
          console.error('❌ Redis Client Error:', err);
          this.enabled = false;
        });

        this.client.on('connect', () => {
          console.log('✅ Redis connected');
          this.enabled = true;
        });

        await this.client.connect();
      } catch (error) {
        console.warn('⚠️ Redis not available, using in-memory fallback:', error.message);
        this.enabled = false;
        // Fallback to in-memory cache
        this.memoryCache = new Map();
      }
    } else {
      console.log('ℹ️ Redis URL not configured, using in-memory cache');
      this.memoryCache = new Map();
    }
  }

  /**
   * Get value from cache
   */
  async get(key) {
    try {
      if (this.enabled && this.client) {
        const value = await this.client.get(key);
        return value ? JSON.parse(value) : null;
      } else if (this.memoryCache) {
        const cached = this.memoryCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.value;
        }
        this.memoryCache.delete(key);
        return null;
      }
      return null;
    } catch (error) {
      console.error('❌ Cache get error:', error);
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set(key, value, ttlSeconds = null) {
    try {
      const ttl = ttlSeconds || config.cache.ttl_seconds;
      
      if (this.enabled && this.client) {
        await this.client.setEx(key, ttl, JSON.stringify(value));
      } else if (this.memoryCache) {
        this.memoryCache.set(key, {
          value,
          expiresAt: Date.now() + (ttl * 1000)
        });
      }
    } catch (error) {
      console.error('❌ Cache set error:', error);
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key) {
    try {
      if (this.enabled && this.client) {
        await this.client.del(key);
      } else if (this.memoryCache) {
        this.memoryCache.delete(key);
      }
    } catch (error) {
      console.error('❌ Cache delete error:', error);
    }
  }

  /**
   * Delete multiple keys matching a pattern
   */
  async deletePattern(pattern) {
    try {
      if (this.enabled && this.client) {
        const keys = await this.client.keys(pattern);
        if (keys.length > 0) {
          await this.client.del(keys);
        }
      } else if (this.memoryCache) {
        // For in-memory, iterate and delete matching keys
        for (const key of this.memoryCache.keys()) {
          if (this._matchPattern(key, pattern)) {
            this.memoryCache.delete(key);
          }
        }
      }
    } catch (error) {
      console.error('❌ Cache delete pattern error:', error);
    }
  }

  /**
   * Simple pattern matching for in-memory cache
   */
  _matchPattern(key, pattern) {
    const regex = new RegExp(pattern.replace('*', '.*'));
    return regex.test(key);
  }

  /**
   * Clear all cache
   */
  async clear() {
    try {
      if (this.enabled && this.client) {
        await this.client.flushDb();
      } else if (this.memoryCache) {
        this.memoryCache.clear();
      }
    } catch (error) {
      console.error('❌ Cache clear error:', error);
    }
  }

  /**
   * Generate cache key for salon search
   */
  static getSalonSearchKey(params) {
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${key}:${params[key]}`)
      .join('|');
    return `salon:search:${sortedParams}`;
  }

  /**
   * Generate cache key for salon by ID
   */
  static getSalonKey(salonId) {
    return `salon:${salonId}`;
  }

  /**
   * Generate cache key for user bookings
   */
  static getUserBookingsKey(userId, params = {}) {
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${key}:${params[key]}`)
      .join('|');
    return `bookings:user:${userId}${sortedParams ? `:${sortedParams}` : ''}`;
  }

  /**
   * Generate cache key for services
   */
  static getServicesKey(salonId) {
    return `services:salon:${salonId}`;
  }

  /**
   * Generate cache key for favorites
   */
  static getFavoritesKey(userId) {
    return `favorites:user:${userId}`;
  }

  /**
   * Invalidate salon-related cache
   */
  async invalidateSalon(salonId) {
    await this.delete(this.constructor.getSalonKey(salonId));
    await this.deletePattern('salon:search:*');
  }

  /**
   * Invalidate user-related cache
   */
  async invalidateUser(userId) {
    await this.deletePattern(`bookings:user:${userId}*`);
    await this.delete(this.constructor.getFavoritesKey(userId));
  }
}

// Export singleton instance
module.exports = new CacheService();
