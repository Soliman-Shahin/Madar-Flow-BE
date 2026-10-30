import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendError } from '../shared/helper';
import { AuthenticatedRequest } from '../middleware/access.middleware';
import {
  billingTestModeEnabled,
  revenueCatSecretKey,
  revenueCatWebhookAuth,
} from '../config/billing.config';
import { BILLING_EVENT_TYPES } from '../models/billing-event-log.model';
import { billingService } from '../services/billing.service';
import { revenueCatService } from '../services/revenuecat.service';
import { PlanSlug } from '../types/plan.types';
import { User } from '../models/user.model';
import { NotFoundError } from '../shared/errors';
import logger from '../services/logger.service';

/** Compare secrets without leaking their length or content through timing. */
function sameSecret(a: string, b: string): boolean {
  const ha = Buffer.from(createHash('sha256').update(a).digest('hex'));
  const hb = Buffer.from(createHash('sha256').update(b).digest('hex'));
  return timingSafeEqual(new Uint8Array(ha), new Uint8Array(hb));
}

export class BillingController {
  /**
   * POST /v1/billing/revenuecat/webhook
   * Called by RevenueCat only. Authenticated by the shared `Authorization`
   * header value; with no secret configured the endpoint is closed.
   */
  async revenueCatWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      const expected = revenueCatWebhookAuth();
      if (!expected) {
        sendError(
          res,
          'Billing webhook is not configured',
          503,
          'BILLING_NOT_CONFIGURED'
        );
        return;
      }
      const given = req.headers.authorization ?? '';
      if (!given || !sameSecret(given, expected)) {
        sendError(res, 'Unauthorized', 401, 'UNAUTHORIZED');
        return;
      }

      const outcome = await revenueCatService.handleEvent(
        req.body?.event ?? {}
      );
      if (!outcome.handled) {
        logger.info('Billing: webhook event ignored', {
          reason: outcome.reason,
        });
      }
      // 2xx tells RevenueCat the event was received; errors above (thrown) are 5xx so it retries.
      sendSuccess(res, outcome, 'Event received');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /v1/billing/sync
   * Signed-in user asks the server to re-check their store purchases
   * ("restore purchases"). Only ever grants; never downgrades.
   */
  async sync(req: Request, res: Response, next: NextFunction) {
    try {
      if (!revenueCatSecretKey()) {
        sendError(
          res,
          'Billing is not available yet',
          503,
          'BILLING_NOT_CONFIGURED'
        );
        return;
      }
      const userId = (req as AuthenticatedRequest).user_id!;
      const result = await revenueCatService.syncUser(userId);
      sendSuccess(res, result, 'Purchases checked');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /v1/admin/billing/test-event   (super admin, non-production only)
   * Simulates a purchase lifecycle step for one user without any store, so the
   * whole flow can be rehearsed. Uses the `manual` provider, so it can only
   * change plans it created itself.
   * Body: { userId, planSlug, type, days? }
   */
  async testEvent(req: Request, res: Response, next: NextFunction) {
    try {
      if (!billingTestModeEnabled()) {
        sendError(
          res,
          'Billing test mode is off',
          403,
          'BILLING_TEST_MODE_OFF'
        );
        return;
      }
      const { userId, planSlug, type, days } = req.body ?? {};
      if (
        typeof userId !== 'string' ||
        !Object.values(PlanSlug).includes(planSlug) ||
        !(BILLING_EVENT_TYPES as readonly string[]).includes(type)
      ) {
        sendError(
          res,
          'userId, planSlug and type are required',
          400,
          'VALIDATION_ERROR'
        );
        return;
      }
      if (!(await User.exists({ _id: userId }))) {
        throw new NotFoundError('User', userId);
      }
      const length =
        Number.isFinite(days) && days > 0 && days <= 400 ? Number(days) : 30;
      const now = new Date();
      const result = await billingService.applyEvent(
        {
          provider: 'manual',
          eventId: `test:${userId}:${now.getTime()}:${type}`,
          userId,
          planSlug,
          type,
          occurredAt: now,
          periodEnd: new Date(now.getTime() + length * 24 * 60 * 60 * 1000),
        },
        now
      );
      sendSuccess(res, result, 'Test event applied');
    } catch (error) {
      next(error);
    }
  }
}

export const billingController = new BillingController();
