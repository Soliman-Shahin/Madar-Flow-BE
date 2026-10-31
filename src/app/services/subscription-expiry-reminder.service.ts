import { errorMessage } from '../shared/errors';
import { Plan } from '../models/plan.model';
import { User } from '../models/user.model';
import { PlanSlug } from '../types/plan.types';
import { NotificationService } from './notification.service';
import logger from './logger.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOURLY_WINDOW_MS = 60 * 60 * 1000;
const REMINDER_OFFSET_MS = 7 * DAY_MS;

export const SUBSCRIPTION_EXPIRY_REMINDER_WINDOW = '7d';

export interface SubscriptionExpiryReminderResult {
  scanned: number;
  eligible: number;
  created: number;
  skipped: number;
  failures: number;
}

/**
 * Finds current paid entitlements whose authoritative User.planExpiresAt is
 * seven days away and emits an idempotent subscription.expiring event.
 *
 * The one-hour half-open range is intentionally aligned with the future
 * hourly scheduler: [reference + 7d, reference + 7d + 1h). No client input
 * participates in selection, recipient resolution, or deduplication.
 */
export class SubscriptionExpiryReminderService {
  static async processExpiringSubscriptions(
    referenceTime: Date
  ): Promise<SubscriptionExpiryReminderResult> {
    const referenceMs = referenceTime.getTime();
    if (!Number.isFinite(referenceMs)) {
      throw new Error('INVALID_REFERENCE_TIME');
    }

    const windowStart = new Date(referenceMs + REMINDER_OFFSET_MS);
    const windowEnd = new Date(
      referenceMs + REMINDER_OFFSET_MS + HOURLY_WINDOW_MS
    );

    const users = await User.find({
      isActive: { $ne: false },
      _isDeleted: { $ne: true },
      plan: { $ne: PlanSlug.Free },
      planExpiresAt: { $gte: windowStart, $lt: windowEnd },
    })
      .select('_id plan planExpiresAt')
      .lean();

    const plans = await Plan.find({
      slug: { $in: users.map((user) => user.plan) },
    })
      .select('slug')
      .lean();
    const validPlans = new Set(plans.map((plan) => plan.slug));

    const result: SubscriptionExpiryReminderResult = {
      scanned: users.length,
      eligible: 0,
      created: 0,
      skipped: 0,
      failures: 0,
    };

    for (const user of users) {
      const expiry = user.planExpiresAt;
      if (
        !expiry ||
        expiry.getTime() <= referenceMs ||
        !validPlans.has(user.plan)
      ) {
        result.skipped += 1;
        continue;
      }

      result.eligible += 1;
      const expiryEpoch = expiry.getTime();
      const dedupeKey = `subscription.expiring:${String(
        user._id
      )}:${expiryEpoch}:${SUBSCRIPTION_EXPIRY_REMINDER_WINDOW}`;

      try {
        const dispatch = await NotificationService.dispatchUserEvent({
          userId: String(user._id),
          event: 'subscription.expiring',
          dedupeKey,
          title: 'Subscription expiring soon',
          message: 'Your subscription expires in 7 days.',
          metadata: { expiresAt: expiry.toISOString() },
        });
        if (dispatch.created) result.created += 1;
      } catch (error: unknown) {
        result.failures += 1;
        logger.warn('[SubscriptionExpiryReminder] Reminder dispatch failed', {
          userId: String(user._id),
          error: errorMessage(error) || 'unknown error',
        });
      }
    }

    return result;
  }
}

export const subscriptionExpiryReminderService =
  SubscriptionExpiryReminderService;
