import { NextFunction, Request, Response } from 'express';
import { sendError } from '../shared/helper';
import { AppError, toAppError } from '../shared/errors';
import logger from '../services/logger.service';

/**
 * Enhanced Error Handler Middleware
 *
 * Features:
 * - Centralized error handling
 * - Proper error logging with context
 * - Safe error responses (doesn't leak internals)
 * - Support for custom error types
 * - Production-safe error messages
 */

/**
 * Main error handler
 */
export const enhancedErrorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Convert to AppError if needed
  const appError = toAppError(err);

  // Extract request context for logging
  const ip = req.ip || req.socket.remoteAddress;
  const context = {
    requestId: req.id,
    ip,
    method: req.method,
    path: req.path,
  };

  // Log error based on type
  if (req.path.startsWith('/v1/user/')) {
    logger.warn('Authentication request failed', context, {
      code: appError.code,
      statusCode: appError.statusCode,
    });
  } else if (appError.isOperational) {
    // Operational errors (expected) - log as warning
    logger.warn(`Operational error: ${appError.message}`, context, {
      code: appError.code,
      statusCode: appError.statusCode,
      details: appError.details,
    });
  } else {
    // Programming or unknown errors - log as error
    logger.error(`Unexpected error: ${appError.message}`, err, context, {
      code: appError.code,
      statusCode: appError.statusCode,
    });
  }

  // Prepare response
  const isProduction = process.env.NODE_ENV === 'production';

  // For operational errors, send detailed message
  if (appError.isOperational) {
    return sendError(
      res,
      appError.message,
      appError.statusCode,
      appError.code,
      isProduction ? undefined : appError.details
    );
  }

  // For non-operational errors, send generic message in production
  const message = isProduction
    ? 'An unexpected error occurred. Please try again later.'
    : appError.message;

  const details = isProduction
    ? undefined
    : {
        stack: err.stack,
        ...appError.details,
      };

  return sendError(res, message, appError.statusCode, appError.code, details);
};

/**
 * Catch async errors wrapper
 * Wraps async route handlers to catch promise rejections
 */
export const catchAsync = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Handle 404 errors for unknown routes
 */
export const notFoundHandler = (
  req: Request & { originalUrl?: string },
  res: Response
) => {
  const message = `Route ${req.method} ${req.originalUrl || req.url} not found`;
  const context = {
    ip: req.ip || req.socket.remoteAddress,
    method: req.method,
    path: req.path,
  };
  logger.warn(message, context);

  return sendError(res, message, 404, 'ROUTE_NOT_FOUND');
};

/**
 * Handle unhandled promise rejections
 */
export const handleUnhandledRejection = () => {
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.fatal(
      'Unhandled Promise Rejection',
      reason,
      {},
      {
        promise: promise.toString(),
        reason: reason?.toString(),
      }
    );

    // In production, you might want to restart the process
    if (process.env.NODE_ENV === 'production') {
      logger.error('💀 Unhandled rejection. Shutting down gracefully...');
      process.exit(1);
    }
  });
};

/**
 * Handle uncaught exceptions
 */
export const handleUncaughtException = () => {
  process.on('uncaughtException', (error: Error) => {
    logger.fatal('Uncaught Exception', error);

    logger.error('💀 Uncaught exception. Shutting down...');
    process.exit(1);
  });
};

/**
 * Initialize error handlers
 */
export function initializeErrorHandlers() {
  handleUnhandledRejection();
  handleUncaughtException();
}

export default {
  enhancedErrorHandler,
  catchAsync,
  notFoundHandler,
  initializeErrorHandlers,
};
