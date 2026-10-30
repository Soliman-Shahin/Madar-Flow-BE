import { Schema, model, Document, Types } from 'mongoose';

/**
 * One row per billing event that was accepted for processing.
 *
 * The unique (provider, eventId) index is what makes event handling idempotent:
 * payment providers deliver the same notification more than once, and a replay
 * must never extend or downgrade a plan twice.
 */
export const BILLING_PROVIDERS = [
  'revenuecat',
  'google_play',
  'manual',
] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export const BILLING_EVENT_TYPES = [
  'purchased',
  'renewed',
  'cancelled',
  'expired',
  'refunded',
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

export interface IBillingEventLog extends Document {
  provider: BillingProvider;
  eventId: string;
  user: Types.ObjectId;
  type: BillingEventType;
  /** When the provider says it happened (used to ignore out-of-order events). */
  occurredAt: Date;
  receivedAt: Date;
}

const BillingEventLogSchema = new Schema<IBillingEventLog>(
  {
    provider: { type: String, enum: BILLING_PROVIDERS, required: true },
    eventId: { type: String, required: true, maxlength: 200 },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: BILLING_EVENT_TYPES, required: true },
    occurredAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false }
);

BillingEventLogSchema.index({ provider: 1, eventId: 1 }, { unique: true });
BillingEventLogSchema.index({ user: 1, occurredAt: -1 });

export const BillingEventLog = model<IBillingEventLog>(
  'BillingEventLog',
  BillingEventLogSchema
);
