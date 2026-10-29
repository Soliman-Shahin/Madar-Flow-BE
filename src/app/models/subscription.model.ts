import { Schema, model, Document, Types } from 'mongoose';
import { SubscriptionStatus } from '../types/plan.types';

/**
 * Subscription Model
 *
 * Records the history of a user's plan subscriptions.
 * A user can have multiple subscription records (history), but only one
 * active subscription at a time (status = 'active').
 *
 * The user's active plan is also denormalized into `user.plan` for fast
 * access without a join. Both must be kept in sync by PlanService.
 */
export interface ISubscription extends Document {
  /** Reference to the subscribed user */
  user: Types.ObjectId;
  /** Reference to the Plan document */
  plan: Types.ObjectId;
  /** Current status of this subscription */
  status: SubscriptionStatus;
  /** When this subscription period started */
  startDate: Date;
  /** When this subscription period ends (null = never / lifetime) */
  endDate: Date | null;
  /** When the user cancelled (if cancelled) */
  cancelledAt?: Date | null;
  /** When the trial period ends (if applicable) */
  trialEndsAt?: Date | null;
  /** Payment method label (e.g., 'stripe', 'manual', 'promo') */
  paymentMethod?: string;
  /** External payment reference (e.g., Stripe charge ID) */
  paymentRef?: string;
  /** Admin note (e.g., "Granted manually by admin X") */
  adminNote?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    plan: {
      type: Schema.Types.ObjectId,
      ref: 'Plan',
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'cancelled', 'trial'] as SubscriptionStatus[],
      default: 'active',
      required: true,
    },
    startDate: { type: Date, required: true, default: Date.now },
    endDate: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null },
    paymentMethod: { type: String, trim: true },
    paymentRef: { type: String, trim: true },
    adminNote: { type: String, trim: true },
  },
  { timestamps: true }
);

// Efficiently find a user's active subscription
SubscriptionSchema.index({ user: 1, status: 1 });
// Scheduled job: find all subscriptions expiring soon
SubscriptionSchema.index({ endDate: 1, status: 1 });
// Audit history: list all subscriptions for a user ordered by start date
SubscriptionSchema.index({ user: 1, startDate: -1 });
// Bounded daily history analytics across retained consumer accounts.
SubscriptionSchema.index({ startDate: -1, user: 1 });

const Subscription = model<ISubscription>('Subscription', SubscriptionSchema);
export { Subscription };
