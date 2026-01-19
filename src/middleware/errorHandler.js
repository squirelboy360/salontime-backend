// Check if we're in production (Vercel)
const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

// Simple logger without Winston (to avoid file system access issues on Vercel)
const logger = {
  error: (data) => {
    if (typeof data === 'object') {
      console.error(JSON.stringify({
        level: 'error',
        timestamp: new Date().toISOString(),
        service: 'salontime-backend',
        ...data
      }));
    } else {
      console.error(data);
    }
  },
  info: (data) => {
    if (typeof data === 'object') {
      console.log(JSON.stringify({
        level: 'info',
        timestamp: new Date().toISOString(),
        service: 'salontime-backend',
        ...data
      }));
    } else {
      console.log(data);
    }
  },
  warn: (data) => {
    if (typeof data === 'object') {
      console.warn(JSON.stringify({
        level: 'warn',
        timestamp: new Date().toISOString(),
        service: 'salontime-backend',
        ...data
      }));
    } else {
      console.warn(data);
    }
  }
}

// Custom error class
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

// Global error handler middleware
const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error
  logger.error({
    message: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Supabase errors
  if (err.code && err.code.startsWith('PGRST')) {
    error = new AppError('Database error', 400, 'DATABASE_ERROR');
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map(val => val.message).join(', ');
    error = new AppError(message, 400, 'VALIDATION_ERROR');
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error = new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  if (err.name === 'TokenExpiredError') {
    error = new AppError('Token expired', 401, 'TOKEN_EXPIRED');
  }

  // Multer errors (file upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    error = new AppError('File too large', 400, 'FILE_TOO_LARGE');
  }

  // Default error response
  const statusCode = error.statusCode || 500;
  const response = {
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || 'Internal server error'
    }
  };

  // Add stack trace and details in development
  if (!isProduction) {
    response.error.stack = error.stack;
    if (error.originalError) {
      response.error.originalError = error.originalError;
    }
    if (error.errorName) {
      response.error.errorName = error.errorName;
    }
    if (error.errorCode) {
      response.error.errorCode = error.errorCode;
    }
  }

  res.status(statusCode).json(response);
};

// Async error wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// 404 Not Found middleware
const notFound = (req, res, next) => {
  const error = new AppError(`Not Found - ${req.originalUrl}`, 404, 'NOT_FOUND');
  next(error);
};

module.exports = {
  errorHandler,
  asyncHandler,
  AppError,
  logger,
  notFound
};

