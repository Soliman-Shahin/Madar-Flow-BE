import { Router } from 'express';
import { auditLogController } from '../controllers/audit-log.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import {
  requireAdmin,
  requireSuperAdmin,
} from '../middleware/admin.middleware';

const router = Router();

// All audit log routes require authentication
router.use(verifyAccessToken);

// ==================== AUDIT LOG QUERIES (Admin+) ====================

/**
 * Get audit logs with filters
 * Query params: actorId, targetUserId, action, severity, success, startDate, endDate, limit, skip, sortBy, sortOrder
 */
router.get(
  '/',
  requireAdmin,
  auditLogController.getLogs.bind(auditLogController)
);

/**
 * Get audit logs for a specific user
 */
router.get(
  '/user/:userId',
  requireAdmin,
  auditLogController.getUserLogs.bind(auditLogController)
);

/**
 * Get recent security events
 * Query params: limit (default: 100)
 */
router.get(
  '/security/recent',
  requireAdmin,
  auditLogController.getRecentSecurityEvents.bind(auditLogController)
);

/**
 * Get audit log statistics
 * Query params: startDate, endDate (required)
 */
router.get(
  '/stats',
  requireAdmin,
  auditLogController.getStats.bind(auditLogController)
);

// ==================== AUDIT LOG MANAGEMENT (SuperAdmin Only) ====================

/**
 * Delete old audit logs (cleanup)
 * Query params: olderThanDays (required)
 */
router.delete(
  '/cleanup',
  requireSuperAdmin,
  auditLogController.cleanup.bind(auditLogController)
);

export default router;
