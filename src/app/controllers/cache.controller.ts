import { Request, Response } from 'express';
import { permissionCacheService } from '../services/permission-cache.service';
import { sendSuccess, sendError } from '../shared/helper';
import logger from '../services/logger.service';

/**
 * Cache Controller
 *
 * Handles HTTP requests for cache management and statistics
 */
class CacheController {
  /**
   * Get cache statistics
   * GET /api/v1/cache/stats
   */
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = permissionCacheService.getStats();
      sendSuccess(res, stats, 'Cache statistics retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting cache stats:', error.message);
      sendError(
        res,
        'Failed to retrieve cache statistics',
        500,
        'INTERNAL_ERROR'
      );
    }
  }

  /**
   * Invalidate cache for a specific user
   * DELETE /api/v1/cache/user/:userId
   */
  async invalidateUser(req: Request, res: Response): Promise<void> {
    try {
      const rawUserId = req.params.userId;
      const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;

      permissionCacheService.invalidateUser(userId);

      sendSuccess(
        res,
        { userId, invalidated: true },
        `Cache invalidated for user ${userId}`
      );
    } catch (error: any) {
      logger.error('Error invalidating user cache:', error.message);
      sendError(res, 'Failed to invalidate user cache', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Invalidate cache for multiple users
   * POST /api/v1/cache/invalidate-users
   * Body: { userIds: string[] }
   */
  async invalidateUsers(req: Request, res: Response): Promise<void> {
    try {
      const { userIds } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return sendError(
          res,
          'userIds must be a non-empty array',
          400,
          'VALIDATION_ERROR'
        );
      }

      permissionCacheService.invalidateUsers(userIds);

      sendSuccess(
        res,
        { userIds, count: userIds.length, invalidated: true },
        `Cache invalidated for ${userIds.length} users`
      );
    } catch (error: any) {
      logger.error('Error invalidating users cache:', error.message);
      sendError(res, 'Failed to invalidate users cache', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Invalidate cache for all users on a specific plan
   * DELETE /api/v1/cache/plan/:planSlug
   */
  async invalidatePlan(req: Request, res: Response): Promise<void> {
    try {
      const rawPlanSlug = req.params.planSlug;
      const planSlug = Array.isArray(rawPlanSlug)
        ? rawPlanSlug[0]
        : rawPlanSlug;

      await permissionCacheService.invalidatePlan(planSlug);

      sendSuccess(
        res,
        { planSlug, invalidated: true },
        `Cache invalidated for plan ${planSlug}`
      );
    } catch (error: any) {
      logger.error('Error invalidating plan cache:', error.message);
      sendError(res, 'Failed to invalidate plan cache', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Flush entire cache
   * DELETE /api/v1/cache/flush
   */
  async flush(req: Request, res: Response): Promise<void> {
    try {
      permissionCacheService.flush();

      sendSuccess(res, { flushed: true }, 'Cache completely flushed');
    } catch (error: any) {
      logger.error('Error flushing cache:', error.message);
      sendError(res, 'Failed to flush cache', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Warm up cache for multiple users
   * POST /api/v1/cache/warmup
   * Body: { userIds: string[] }
   */
  async warmUp(req: Request, res: Response): Promise<void> {
    try {
      const { userIds } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return sendError(
          res,
          'userIds must be a non-empty array',
          400,
          'VALIDATION_ERROR'
        );
      }

      await permissionCacheService.warmUp(userIds);

      sendSuccess(
        res,
        { userIds, count: userIds.length, warmedUp: true },
        `Cache warmed up for ${userIds.length} users`
      );
    } catch (error: any) {
      logger.error('Error warming up cache:', error.message);
      sendError(res, 'Failed to warm up cache', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Check if user's permissions are cached
   * GET /api/v1/cache/user/:userId/status
   */
  async checkUserCache(req: Request, res: Response): Promise<void> {
    try {
      const rawUserId = req.params.userId;
      const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;

      const isCached = permissionCacheService.isCached(userId);
      const ttl = permissionCacheService.getTTL(userId);

      sendSuccess(
        res,
        {
          userId,
          isCached,
          ttl: ttl || null,
          expiresIn: ttl ? Math.floor((ttl - Date.now()) / 1000) : null,
        },
        'User cache status retrieved successfully'
      );
    } catch (error: any) {
      logger.error('Error checking user cache:', error.message);
      sendError(res, 'Failed to check user cache', 500, 'INTERNAL_ERROR');
    }
  }
}

export const cacheController = new CacheController();
