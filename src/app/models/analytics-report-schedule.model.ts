import { Schema, model, type Document, type Types } from 'mongoose';
import { PlanSlug } from '../types/plan.types';

export type ReportFrequency = 'weekly' | 'monthly';
export type ReportComparison = 'previous' | 'yearAgo';
export type ReportLanguage = 'en' | 'ar';
export type ReportDeliveryStatus =
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'paused'
  | 'cancelled';

export interface IAnalyticsReportSchedule extends Document {
  owner: Types.ObjectId;
  frequency: ReportFrequency;
  weekday?: number;
  monthDay?: number;
  hour: number;
  timezone: string;
  days: 7 | 30 | 90;
  comparison: ReportComparison;
  plan?: PlanSlug;
  type?: 'income' | 'outcome';
  language: ReportLanguage;
  active: boolean;
  nextRunAt: Date;
  leaseUntil?: Date | null;
  retryAt?: Date | null;
  lastAttemptAt?: Date | null;
  lastSentAt?: Date | null;
  lastDeliveryStatus: ReportDeliveryStatus;
  lastErrorCode?: 'RECIPIENT_UNAVAILABLE' | 'DELIVERY_FAILED' | null;
  consecutiveFailures: number;
  cancelledAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const AnalyticsReportScheduleSchema = new Schema<IAnalyticsReportSchedule>(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    frequency: { type: String, enum: ['weekly', 'monthly'], required: true },
    weekday: { type: Number, min: 1, max: 7 },
    monthDay: { type: Number, min: 1, max: 28 },
    hour: { type: Number, min: 0, max: 23, required: true },
    timezone: { type: String, required: true, maxlength: 80 },
    days: { type: Number, enum: [7, 30, 90], required: true },
    comparison: {
      type: String,
      enum: ['previous', 'yearAgo'],
      default: 'previous',
      required: true,
    },
    plan: { type: String, enum: Object.values(PlanSlug) },
    type: { type: String, enum: ['income', 'outcome'] },
    language: { type: String, enum: ['en', 'ar'], default: 'en' },
    active: { type: Boolean, default: true, required: true },
    nextRunAt: { type: Date, required: true },
    leaseUntil: { type: Date, default: null },
    retryAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: null },
    lastDeliveryStatus: {
      type: String,
      enum: ['scheduled', 'sending', 'sent', 'failed', 'paused', 'cancelled'],
      default: 'scheduled',
      required: true,
    },
    lastErrorCode: {
      type: String,
      enum: ['RECIPIENT_UNAVAILABLE', 'DELIVERY_FAILED', null],
      default: null,
    },
    consecutiveFailures: { type: Number, default: 0, min: 0 },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

AnalyticsReportScheduleSchema.index({ active: 1, nextRunAt: 1, retryAt: 1 });
AnalyticsReportScheduleSchema.index({ owner: 1, active: 1, cancelledAt: 1 });

export const AnalyticsReportSchedule = model<IAnalyticsReportSchedule>(
  'AnalyticsReportSchedule',
  AnalyticsReportScheduleSchema
);
