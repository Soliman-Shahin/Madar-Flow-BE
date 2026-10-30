import { Router } from 'express';
import { billingController } from '../controllers/billing.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import { requireSuperAdmin } from '../middleware/admin.middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

/**
 * POST /v1/billing/revenuecat/webhook — RevenueCat → server (shared-secret header).
 * POST /v1/billing/sync               — signed-in user re-checks store purchases.
 *
 * The webhook is authenticated by its own secret, not a user token. RevenueCat
 * sends the configured header value, which must be in the form
 * `Bearer <secret>` so the global CSRF guard (Bearer requests) lets it through
 * without opening any new exemption.
 */
const webhookLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 300,
  message: 'Too many billing requests',
});

const syncLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many purchase checks, please try again later',
});

export const billingRoutes = Router();
billingRoutes.post(
  '/revenuecat/webhook',
  webhookLimiter,
  billingController.revenueCatWebhook.bind(billingController)
);
billingRoutes.post(
  '/sync',
  verifyAccessToken,
  syncLimiter,
  billingController.sync.bind(billingController)
);

/** POST /v1/admin/billing/test-event — rehearsal only; closed in production. */
export const billingAdminRoutes = Router();
billingAdminRoutes.use(verifyAccessToken, requireSuperAdmin);
billingAdminRoutes.post(
  '/test-event',
  billingController.testEvent.bind(billingController)
);
