import { RequestHandler, Router } from 'express';
import {
  basicHealthCheck,
  detailedHealthCheck,
  diagnosticsHealthCheck,
  readinessCheck,
  livenessCheck,
} from '../controllers/health.controller';

import { verifyAccessToken } from '../middleware/access.middleware';
import { requireRole } from '../middleware/admin.middleware';
import { UserRole } from '../models/user.model';

const router = Router();

/**
 * Health Check Routes
 * These endpoints are typically used by monitoring systems and orchestrators
 */

// Basic health check - lightweight
router.get('/', basicHealthCheck);

// Public status summary (status + timestamp only). The Mobile app polls this URL to detect
// backend reachability, so it must stay reachable without a token.
router.get('/detailed', detailedHealthCheck);

// Full diagnostics - exposes version, environment and resource details, so it requires an
// authenticated caller with a staff role (moderator or above).
router.get(
  '/diagnostics',
  verifyAccessToken as unknown as RequestHandler,
  requireRole(UserRole.Moderator, UserRole.Admin, UserRole.SuperAdmin),
  diagnosticsHealthCheck
);

// Readiness check - for Kubernetes
router.get('/ready', readinessCheck);

// Liveness check - for Kubernetes
router.get('/live', livenessCheck);

export default router;
