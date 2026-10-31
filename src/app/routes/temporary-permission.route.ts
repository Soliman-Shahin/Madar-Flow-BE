import { Router } from 'express';
import { temporaryPermissionController } from '../controllers/temporary-permission.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import {
  requireAdmin,
  requireSuperAdmin,
} from '../middleware/admin.middleware';

const router = Router();

// All routes require authentication
router.use(verifyAccessToken);

// ==================== USER ROUTES ====================

/**
 * Get current user's active temporary permissions
 */
router.get(
  '/me',
  temporaryPermissionController.getMyPermissions.bind(
    temporaryPermissionController
  )
);

// ==================== ADMIN ROUTES ====================

/**
 * Grant a temporary permission to a user
 * Body: { userId, permission, startDate, endDate, reason?, metadata? }
 */
router.post(
  '/',
  requireAdmin,
  temporaryPermissionController.grantPermission.bind(
    temporaryPermissionController
  )
);

/**
 * Revoke a temporary permission
 * Body: { reason? }
 */
router.delete(
  '/:id',
  requireAdmin,
  temporaryPermissionController.revokePermission.bind(
    temporaryPermissionController
  )
);

/**
 * Extend a temporary permission
 * Body: { newEndDate, reason? }
 */
router.patch(
  '/:id/extend',
  requireAdmin,
  temporaryPermissionController.extendPermission.bind(
    temporaryPermissionController
  )
);

/**
 * Get all temporary permissions for a specific user
 */
router.get(
  '/user/:userId',
  requireAdmin,
  temporaryPermissionController.getUserPermissions.bind(
    temporaryPermissionController
  )
);

/**
 * Get permissions expiring soon
 * Query: ?hours=24
 */
router.get(
  '/expiring-soon',
  requireAdmin,
  temporaryPermissionController.getExpiringSoon.bind(
    temporaryPermissionController
  )
);

/**
 * Get temporary permission statistics
 */
router.get(
  '/stats',
  requireAdmin,
  temporaryPermissionController.getStatistics.bind(
    temporaryPermissionController
  )
);

// ==================== SUPERADMIN ROUTES ====================

/**
 * Manually trigger processing of expired permissions
 */
router.post(
  '/process-expired',
  requireSuperAdmin,
  temporaryPermissionController.processExpired.bind(
    temporaryPermissionController
  )
);

export default router;
