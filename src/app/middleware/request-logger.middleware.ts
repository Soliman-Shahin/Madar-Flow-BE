import { Request, Response, NextFunction } from 'express';
import logger from '../services/logger.service';

/**
 * Request Logger Middleware
 *
 * Features:
 * - Log all incoming requests
 * - Track request duration
 * - Include request/response details
 * - Color-coded console output (development)
 */

interface RequestLogData {
  method: string;
  path: string;
  statusCode?: number;
  duration?: number;
  ip?: string;
  userAgent?: string;
  userId?: string;
  errorMessage?: string;
}

/**
 * Main request logger middleware
 */
export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();

  // Generate unique request ID
  const requestId = Math.random().toString(36).substr(2, 9);
  (req as any).id = requestId;
  res.setHeader('X-Request-ID', requestId);

  // Log request start
  const context = {
    requestId,
    userId: (req as any).user_id,
    ip: req.ip || req.socket.remoteAddress,
    method: req.method,
    path: req.path,
    userAgent: req.get('user-agent'),
  };
  logger.debug(`→ Incoming ${req.method} ${req.path}`, context);

  // Capture original end function
  const originalEnd = res.end;

  // Override end function to log response
  res.end = function (this: Response, ...endArgs: any[]): Response {
    // Calculate duration
    const duration = Date.now() - startTime;

    // Extract user ID if available
    const userId = (req as any).user_id;

    // Prepare log data
    const logData: RequestLogData = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      ip: req.ip || req.socket.remoteAddress,
      userAgent: req.get('user-agent'),
      userId,
    };

    // Log based on status code
    const level =
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    const message = `← ${req.method} ${req.path} ${res.statusCode} ${duration}ms`;

    if (level === 'error') {
      logger.error(message, undefined, context, logData);
    } else if (level === 'warn') {
      logger.warn(message, context, logData);
    } else {
      logger.info(message, context, logData);
    }

    // Call original end function
    return originalEnd.apply(this, endArgs as any);
  };

  next();
};

/**
 * Performance monitoring middleware
 * Warns if request takes too long
 */
export const performanceMonitor = (thresholdMs: number = 1000) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;

      if (duration > thresholdMs) {
        const context = {
          ip: req.ip || req.socket.remoteAddress,
          method: req.method,
          path: req.path,
        };
        logger.warn(
          `⏱️  Slow request detected: ${req.method} ${req.path}`,
          context,
          { duration, threshold: thresholdMs }
        );
      }
    });

    next();
  };
};

/**
 * Request size monitor
 * Logs large request bodies
 */
export const requestSizeMonitor = (thresholdBytes: number = 1024 * 100) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const size = parseInt(req.get('content-length') || '0', 10);

    if (size > thresholdBytes) {
      const context = {
        ip: req.ip || req.socket.remoteAddress,
        method: req.method,
        path: req.path,
      };
      logger.info(`📦 Large request body: ${req.method} ${req.path}`, context, {
        size,
        sizeKB: Math.round(size / 1024),
        threshold: thresholdBytes,
      });
    }

    next();
  };
};

/**
 * Response size monitor
 * Logs large responses
 */
export const responseSizeMonitor = (thresholdBytes: number = 1024 * 100) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);

    res.json = function (body: any): Response {
      const bodyString = JSON.stringify(body);
      const size = Buffer.byteLength(bodyString, 'utf8');

      if (size > thresholdBytes) {
        const context = {
          ip: req.ip || req.socket.remoteAddress,
          method: req.method,
          path: req.path,
        };
        logger.info(
          `📤 Large response body: ${req.method} ${req.path}`,
          context,
          {
            size,
            sizeKB: Math.round(size / 1024),
            threshold: thresholdBytes,
          }
        );
      }

      return originalJson(body);
    };

    next();
  };
};

/**
 * Create combined monitoring middleware
 */
export const createMonitoringMiddleware = (options?: {
  slowRequestThresholdMs?: number;
  largeRequestThresholdBytes?: number;
  largeResponseThresholdBytes?: number;
}) => {
  return [
    requestLogger,
    performanceMonitor(options?.slowRequestThresholdMs),
    requestSizeMonitor(options?.largeRequestThresholdBytes),
    responseSizeMonitor(options?.largeResponseThresholdBytes),
  ];
};

export default requestLogger;
