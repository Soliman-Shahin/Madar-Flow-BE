import { Router } from 'express';
import { cacheController } from '../controllers/cache.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import {
  requireAdmin,
  requireSuperAdmin,
} from '../middleware/admin.middleware';

const router = Router();

// All cache routes require authentication
router.use(verifyAccessToken);

// ==================== CACHE STATISTICS (Admin+) ====================

/**
 * Get cache statistics
 */
router.get(
  '/stats',
  requireAdmin,
  cacheController.getStats.bind(cacheController)
);

/**
 * Check if user's permissions are cached
 */
router.get(
  '/user/:userId/status',
  requireAdmin,
  cacheController.checkUserCache.bind(cacheController)
);

// ==================== CACHE INVALIDATION (Admin+) ====================

/**
 * Invalidate cache for a specific user
 */
router.delete(
  '/user/:userId',
  requireAdmin,
  cacheController.invalidateUser.bind(cacheController)
);

/**
 * Invalidate cache for multiple users
 * Body: { userIds: string[] }
 */
router.post(
  '/invalidate-users',
  requireAdmin,
  cacheController.invalidateUsers.bind(cacheController)
);

/**
 * Invalidate cache for all users on a specific plan
 */
router.delete(
  '/plan/:planSlug',
  requireAdmin,
  cacheController.invalidatePlan.bind(cacheController)
);

// ==================== CACHE MANAGEMENT (SuperAdmin Only) ====================

/**
 * Flush entire cache
 */
router.delete(
  '/flush',
  requireSuperAdmin,
  cacheController.flush.bind(cacheController)
);

/**
 * Warm up cache for multiple users
 * Body: { userIds: string[] }
 */
router.post(
  '/warmup',
  requireSuperAdmin,
  cacheController.warmUp.bind(cacheController)
);

export default router;
