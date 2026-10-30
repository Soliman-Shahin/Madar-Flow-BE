import { Router } from 'express';
import { telemetryController } from '../controllers/telemetry.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import { requireModerator } from '../middleware/admin.middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

/**
 * POST   /v1/telemetry/events  — opted-in app reports a small batch (signed in).
 * DELETE /v1/telemetry/events  — erase everything stored for one install id.
 *
 * Rate-limited per account: 30 requests per 15 minutes is far above normal use
 * (the app batches) and low enough to make flooding pointless.
 */
const telemetryLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  message: 'Too many telemetry requests, please try again later',
});

export const telemetryRoutes = Router();
telemetryRoutes.use(verifyAccessToken, telemetryLimiter);
telemetryRoutes.post(
  '/events',
  telemetryController.record.bind(telemetryController)
);
telemetryRoutes.delete(
  '/events',
  telemetryController.erase.bind(telemetryController)
);

/** GET /v1/admin/telemetry/summary — dashboard read (Moderator and above). */
export const telemetryAdminRoutes = Router();
telemetryAdminRoutes.use(verifyAccessToken);
telemetryAdminRoutes.get(
  '/summary',
  requireModerator,
  telemetryController.summary.bind(telemetryController)
);
