import logger from '../services/logger.service';
import { Request, Response, NextFunction } from 'express';
import { SyncService } from '../services/sync.service';
import { sendError } from '../shared/helper';

export interface SyncRequest extends Request {
  syncService?: SyncService;
}

/**
 * Middleware to inject sync service into request
 */
export const injectSyncService = (syncService: SyncService) => {
  return (req: SyncRequest, res: Response, next: NextFunction) => {
    req.syncService = syncService;
    next();
  };
};

/**
 * Middleware to track sync operations
 */
export const trackSyncOperation = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();

  // Track the operation
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const userId = (req as any).user?._id;

    if (userId) {
      logger.info(
        `Sync operation: ${req.method} ${req.path} - User: ${userId} - Duration: ${duration}ms - Status: ${res.statusCode}`
      );

      // Update sync metadata if it's a sync endpoint
      if (
        (req.path.includes('/sync/') || req.originalUrl?.includes('/sync/')) &&
        res.statusCode < 400
      ) {
        // This would be handled by the sync service
        logger.info(
          `Sync operation completed successfully for user: ${userId}`
        );
      }
    }
  });

  next();
};

/**
 * Middleware to handle sync errors
 */
export const handleSyncError = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (req.path.includes('/sync/') || req.originalUrl?.includes('/sync/')) {
    logger.error('Sync error:', error);

    if (
      String(error?.message || '').includes('SYNC_CONFLICT_STALE_RESOLUTION')
    ) {
      sendError(
        res,
        'The conflict is no longer based on the current server version',
        409,
        'SYNC_CONFLICT_STALE_RESOLUTION'
      );
      return;
    }

    // Update sync metadata with error
    const userId = (req as any).user?._id;
    if (userId) {
      // This would be handled by the sync service
      logger.info(`Sync error recorded for user: ${userId}`);
    }

    const isDev = process.env.NODE_ENV === 'development';
    const message =
      isDev && error?.message ? String(error.message) : 'Sync operation failed';

    sendError(res, message, 500, 'SYNC_OPERATION_FAILED');
  } else {
    next(error);
  }
};

/**
 * Middleware to validate sync data
 */
export const validateSyncData = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const isSyncPush =
    req.path.includes('/sync/push') || req.originalUrl?.includes('/sync/push');
  const isSyncBulk =
    req.path.includes('/sync/bulk') || req.originalUrl?.includes('/sync/bulk');

  if (isSyncPush || isSyncBulk) {
    const { entities } = req.body;

    if (!entities || !Array.isArray(entities)) {
      return sendError(
        res,
        'Invalid sync data: entities must be an array',
        400,
        'SYNC_INVALID_DATA'
      );
    }

    // Validate each entity
    for (const entity of entities) {
      if (!entity._entityType || !entity._id) {
        return sendError(
          res,
          'Invalid sync data: each entity must have _entityType and _id',
          400,
          'SYNC_INVALID_DATA'
        );
      }

      if (!['expense', 'category', 'user'].includes(entity._entityType)) {
        return sendError(
          res,
          'Invalid sync data: _entityType must be expense, category, or user',
          400,
          'SYNC_INVALID_DATA'
        );
      }
    }
  }

  next();
};

/**
 * Middleware to rate limit sync operations
 */
export const rateLimitSync = (
  maxRequests: number = 100,
  windowMs: number = 15 * 60 * 1000
) => {
  const requests = new Map<string, { count: number; resetTime: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path.includes('/sync/') || req.originalUrl?.includes('/sync/')) {
      // Must run after authentication: without an identity every caller would
      // share one counter and a single busy hour would lock everyone out.
      const identity =
        (req as any).user?._id || (req as any).user_id || req.ip || 'unknown';
      const now = Date.now();
      const key = `sync_${String(identity)}`;

      const userRequests = requests.get(key);

      if (!userRequests || now > userRequests.resetTime) {
        requests.set(key, { count: 1, resetTime: now + windowMs });
      } else if (userRequests.count >= maxRequests) {
        const retryAfter = Math.ceil((userRequests.resetTime - now) / 1000);
        return sendError(
          res,
          'Too many sync requests. Please try again later.',
          429,
          'SYNC_RATE_LIMIT',
          { retryAfter }
        );
      } else {
        userRequests.count++;
      }
    }

    next();
  };
};

/**
 * Middleware to compress sync responses
 */
export const compressSyncResponse = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (req.path.includes('/sync/') || req.originalUrl?.includes('/sync/')) {
    // Set compression headers
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
  }

  next();
};

/**
 * Middleware to add sync headers
 */
export const addSyncHeaders = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (req.path.includes('/sync/') || req.originalUrl?.includes('/sync/')) {
    res.setHeader('X-Sync-Version', '1.0.0');
    res.setHeader('X-Sync-Timestamp', new Date().toISOString());
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
};
