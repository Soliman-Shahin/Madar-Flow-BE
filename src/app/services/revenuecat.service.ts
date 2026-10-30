import { Types } from 'mongoose';
import { Plan } from '../models/plan.model';
import { User } from '../models/user.model';
import { BillingEventType } from '../models/billing-event-log.model';
import { PlanSlug, PLAN_WEIGHTS } from '../types/plan.types';
import { ExternalServiceError } from '../shared/errors';
import {
  acceptSandboxPurchases,
  revenueCatSecretKey,
} from '../config/billing.config';
import { billingService, BillingEvent, BillingResult } from './billing.service';
import logger from './logger.service';

/** The parts of a RevenueCat webhook event this backend reads. */
export interface RevenueCatEvent {
  id?: string;
  type?: string;
  app_user_id?: string;
  product_id?: string;
  new_product_id?: string;
  expiration_at_ms?: number | null;
  event_timestamp_ms?: number;
  environment?: 'SANDBOX' | 'PRODUCTION' | string;
  cancel_reason?: string;
}

export type WebhookOutcome =
  | { handled: true; result: BillingResult }
  | { handled: false; reason: string };

/** Google Play product ids may carry a base plan suffix: `pro_monthly:monthly`. */
function baseProductId(productId: string): string {
  return productId.split(':')[0];
}

export class RevenueCatService {
  /** Plan that a store product grants, or null when the product is unknown. */
  async planForProduct(productId: string): Promise<PlanSlug | null> {
    const wanted = [productId, baseProductId(productId)];
    const plan = await Plan.findOne({ productIds: { $in: wanted } }).lean();
    return plan ? (plan.slug as PlanSlug) : null;
  }

  /**
   * Turn a RevenueCat webhook event into plan state. Authentication of the
   * request is the caller's job (the controller). Events that do not change
   * access (test pings, billing retries, unknown products, anonymous users) are
   * acknowledged without effect so RevenueCat does not retry them forever.
   */
  async handleEvent(
    raw: RevenueCatEvent,
    now = new Date()
  ): Promise<WebhookOutcome> {
    if (!raw.id || !raw.type) return { handled: false, reason: 'malformed' };

    if (raw.environment === 'SANDBOX' && !acceptSandboxPurchases()) {
      return { handled: false, reason: 'sandbox_rejected' };
    }

    const type = this.mapType(raw);
    if (!type) return { handled: false, reason: 'ignored_type' };

    const userId = raw.app_user_id ?? '';
    if (
      !Types.ObjectId.isValid(userId) ||
      String(new Types.ObjectId(userId)) !== userId
    ) {
      return { handled: false, reason: 'unknown_user' };
    }
    if (!(await User.exists({ _id: userId }))) {
      return { handled: false, reason: 'unknown_user' };
    }

    // On a product change the event describes the old product; use the new one.
    const productId =
      raw.type === 'PRODUCT_CHANGE' && raw.new_product_id
        ? raw.new_product_id
        : raw.product_id;
    if (!productId) return { handled: false, reason: 'no_product' };
    const planSlug = await this.planForProduct(productId);
    if (!planSlug) {
      logger.warn('Billing: store product is not mapped to a plan', {
        productId,
      });
      return { handled: false, reason: 'unknown_product' };
    }

    const grants = type === 'purchased' || type === 'renewed';
    const periodEnd = raw.expiration_at_ms
      ? new Date(raw.expiration_at_ms)
      : null;
    if (grants && (!periodEnd || periodEnd.getTime() <= now.getTime())) {
      // A replayed old renewal; nothing to grant.
      return { handled: false, reason: 'no_future_period' };
    }

    const event: BillingEvent = {
      provider: 'revenuecat',
      eventId: raw.id,
      userId,
      planSlug,
      type,
      occurredAt: new Date(raw.event_timestamp_ms ?? now.getTime()),
      periodEnd,
    };
    return {
      handled: true,
      result: await billingService.applyEvent(event, now),
    };
  }

  private mapType(raw: RevenueCatEvent): BillingEventType | null {
    switch (raw.type) {
      case 'INITIAL_PURCHASE':
      case 'PRODUCT_CHANGE':
        return 'purchased';
      case 'RENEWAL':
      case 'UNCANCELLATION':
      case 'SUBSCRIPTION_EXTENDED':
      case 'REFUND_REVERSED':
        return 'renewed';
      case 'CANCELLATION':
        // RevenueCat reports refunds as a cancellation made by support.
        return raw.cancel_reason === 'CUSTOMER_SUPPORT'
          ? 'refunded'
          : 'cancelled';
      case 'EXPIRATION':
        return 'expired';
      default:
        // TEST, BILLING_ISSUE, TRANSFER, SUBSCRIPTION_PAUSED, INVOICE_ISSUANCE ...
        return null;
    }
  }

  /**
   * "Restore purchases" on the server: ask RevenueCat what this user currently
   * holds and grant the best active plan. It only ever grants; ending access is
   * left to verified webhook events, so a lookup glitch cannot downgrade anyone.
   */
  async syncUser(
    userId: string,
    fetchImpl: typeof fetch = fetch,
    now = new Date()
  ): Promise<{ plan: PlanSlug | null; applied: boolean }> {
    const key = revenueCatSecretKey();
    if (!key) throw new ExternalServiceError('RevenueCat', 'Not configured');

    const response = await fetchImpl(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!response.ok) {
      throw new ExternalServiceError('RevenueCat', `HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      subscriber?: {
        subscriptions?: Record<
          string,
          {
            expires_date?: string | null;
            purchase_date?: string | null;
            is_sandbox?: boolean;
            refunded_at?: string | null;
          }
        >;
      };
    };

    let best: {
      slug: PlanSlug;
      end: Date;
      productId: string;
      boughtAt: Date;
    } | null = null;
    for (const [productId, sub] of Object.entries(
      body.subscriber?.subscriptions ?? {}
    )) {
      if (sub.refunded_at) continue;
      if (sub.is_sandbox && !acceptSandboxPurchases()) continue;
      const end = sub.expires_date ? new Date(sub.expires_date) : null;
      if (!end || Number.isNaN(end.getTime()) || end.getTime() <= now.getTime())
        continue;
      const slug = await this.planForProduct(productId);
      if (!slug) continue;
      if (!best || PLAN_WEIGHTS[slug] > PLAN_WEIGHTS[best.slug]) {
        // Dated at the purchase itself so a later cancel/expiry/refund webhook
        // is never mistaken for an older event and dropped.
        const bought = sub.purchase_date ? new Date(sub.purchase_date) : now;
        best = {
          slug,
          end,
          productId,
          boughtAt: Number.isNaN(bought.getTime()) ? now : bought,
        };
      }
    }
    if (!best) return { plan: null, applied: false };

    const result = await billingService.applyEvent(
      {
        provider: 'revenuecat',
        eventId: `sync:${userId}:${best.productId}:${best.end.getTime()}`,
        userId,
        planSlug: best.slug,
        type: 'renewed',
        occurredAt: best.boughtAt,
        periodEnd: best.end,
      },
      now
    );
    return { plan: best.slug, applied: result.applied };
  }
}

export const revenueCatService = new RevenueCatService();
