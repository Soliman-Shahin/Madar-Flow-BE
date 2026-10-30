import { Types } from 'mongoose';
import { User } from '../models/user.model';
import { Subscription } from '../models/subscription.model';
import {
  BillingEventLog,
  BillingEventType,
  BillingProvider,
} from '../models/billing-event-log.model';
import { PlanSlug } from '../types/plan.types';
import { ConflictError, NotFoundError } from '../shared/errors';
import { planService } from './plan.service';
import { permissionCacheService } from './permission-cache.service';
import logger from './logger.service';

/**
 * A payment-provider notification, already authenticated and normalized by the
 * provider adapter (for example a Google Play notification handler). This
 * service never talks to a provider and never trusts an unauthenticated caller:
 * it only turns a verified event into plan state, safely and exactly once.
 */
export interface BillingEvent {
  provider: BillingProvider;
  /** The provider's unique id for this notification (idempotency key). */
  eventId: string;
  userId: string;
  planSlug: PlanSlug;
  type: BillingEventType;
  /** When the provider says it happened. */
  occurredAt: Date;
  /** End of the paid period; required for `purchased` and `renewed`. */
  periodEnd?: Date | null;
}

export type BillingResult =
  | { applied: true }
  | { applied: false; reason: 'duplicate' | 'stale' | 'not_managed' };

const DUPLICATE_KEY = 11000;

export class BillingService {
  async applyEvent(
    event: BillingEvent,
    now: Date = new Date()
  ): Promise<BillingResult> {
    const grants = event.type === 'purchased' || event.type === 'renewed';
    if (grants) {
      if (event.planSlug === PlanSlug.Free) {
        throw new ConflictError('A purchase must be for a paid plan');
      }
      if (!event.periodEnd || event.periodEnd.getTime() <= now.getTime()) {
        throw new ConflictError('A purchase needs a future period end');
      }
    }

    const user = await User.findById(event.userId);
    if (!user) throw new NotFoundError('User', event.userId);

    // Providers can deliver out of order: ignore anything older than what we
    // already processed for this user and provider.
    const newer = await BillingEventLog.exists({
      user: user._id,
      provider: event.provider,
      occurredAt: { $gt: event.occurredAt },
    });
    if (newer) return { applied: false, reason: 'stale' };

    // Record first: the unique (provider, eventId) index makes replays harmless.
    try {
      await BillingEventLog.create({
        provider: event.provider,
        eventId: event.eventId,
        user: user._id,
        type: event.type,
        occurredAt: event.occurredAt,
        receivedAt: now,
      });
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) {
        return { applied: false, reason: 'duplicate' };
      }
      throw error;
    }

    try {
      const result = grants
        ? await this.grant(event, user._id, now)
        : await this.revokeOrCancel(event, user._id);
      permissionCacheService.invalidateUser(String(user._id));
      return result;
    } catch (error) {
      // Let the provider's retry be processed instead of swallowing the event.
      await BillingEventLog.deleteOne({
        provider: event.provider,
        eventId: event.eventId,
      });
      throw error;
    }
  }

  /** purchased / renewed: set the plan and its paid-until date. */
  private async grant(
    event: BillingEvent,
    userId: Types.ObjectId,
    now: Date
  ): Promise<BillingResult> {
    const plan = await planService.getPlanBySlug(event.planSlug);
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User', String(userId));

    const planChanged = user.plan !== event.planSlug;
    user.plan = event.planSlug;
    user.planExpiresAt = event.periodEnd!;
    if (planChanged || !user.planStartedAt) user.planStartedAt = now;
    await user.save();

    const active = await Subscription.findOne({
      user: userId,
      status: 'active',
      plan: plan._id,
      paymentMethod: event.provider,
    });
    if (active) {
      // Renewal of the same subscription: extend it.
      active.endDate = event.periodEnd!;
      active.paymentRef = event.eventId;
      await active.save();
    } else {
      await Subscription.updateMany(
        { user: userId, status: 'active' },
        { $set: { status: 'expired', endDate: now } }
      );
      await Subscription.create({
        user: userId,
        plan: plan._id,
        status: 'active',
        startDate: now,
        endDate: event.periodEnd!,
        paymentMethod: event.provider,
        paymentRef: event.eventId,
      });
    }
    logger.info('Billing: plan granted', {
      plan: event.planSlug,
      type: event.type,
      provider: event.provider,
    });
    return { applied: true };
  }

  /**
   * cancelled: access continues until the paid period ends.
   * expired / refunded: access ends now.
   * Only subscriptions that this provider created are touched, so an admin's
   * manual grant is never downgraded by a provider notification.
   */
  private async revokeOrCancel(
    event: BillingEvent,
    userId: Types.ObjectId
  ): Promise<BillingResult> {
    // A cancelled subscription is still in its paid period, so it can still
    // expire or be refunded later; a plain cancel only applies to an active one.
    const active = await Subscription.findOne({
      user: userId,
      status:
        event.type === 'cancelled' ? 'active' : { $in: ['active', 'cancelled'] },
      paymentMethod: event.provider,
    }).sort({ startDate: -1 });
    if (!active) return { applied: false, reason: 'not_managed' };

    if (event.type === 'cancelled') {
      active.status = 'cancelled';
      active.cancelledAt = event.occurredAt;
      await active.save();
      logger.info('Billing: subscription cancelled (access until period end)', {
        provider: event.provider,
      });
      return { applied: true };
    }

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User', String(userId));
    user.plan = PlanSlug.Free;
    user.planExpiresAt = null;
    await user.save();

    active.status = event.type === 'refunded' ? 'cancelled' : 'expired';
    active.endDate = event.occurredAt;
    if (event.type === 'refunded') active.cancelledAt = event.occurredAt;
    await active.save();
    logger.info('Billing: plan revoked', {
      type: event.type,
      provider: event.provider,
    });
    return { applied: true };
  }
}

export const billingService = new BillingService();
