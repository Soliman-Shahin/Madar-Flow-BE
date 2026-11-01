import { Document, Schema, Types, model } from 'mongoose';

export type NotificationType = 'info' | 'success' | 'warn' | 'error';
export type NotificationAudience =
  | 'all'
  | 'admins'
  | 'moderators'
  | 'custom';

export interface NotificationDocument extends Document {
  title: string;
  message: string;
  type: NotificationType;
  audience: NotificationAudience;
  routeKey: 'notification-detail';
  event?: string;
  category?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
  targeting?: Record<string, unknown>;
  channels?: { push: boolean; realtime: boolean };
  createdBy: Types.ObjectId;
  status: 'created' | 'dispatched' | 'partial' | 'failed';
  recipientCount: number;
  pushSummary: {
    attempted: number;
    succeeded: number;
    failed: number;
    invalidTokens: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<NotificationDocument>(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    type: {
      type: String,
      enum: ['info', 'success', 'warn', 'error'],
      default: 'info',
    },
    audience: {
      type: String,
      enum: ['all', 'admins', 'moderators', 'custom'],
      default: 'all',
    },
    routeKey: {
      type: String,
      enum: ['notification-detail'],
      default: 'notification-detail',
    },
    event: { type: String },
    category: { type: String },
    dedupeKey: { type: String },
    metadata: { type: Schema.Types.Mixed },
    targeting: { type: Schema.Types.Mixed },
    channels: {
      push: { type: Boolean, default: true },
      realtime: { type: Boolean, default: true },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['created', 'dispatched', 'partial', 'failed'],
      default: 'created',
    },
    recipientCount: { type: Number, default: 0, min: 0 },
    pushSummary: {
      attempted: { type: Number, default: 0, min: 0 },
      succeeded: { type: Number, default: 0, min: 0 },
      failed: { type: Number, default: 0, min: 0 },
      invalidTokens: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true }
);

NotificationSchema.index({ createdAt: -1 });
NotificationSchema.index({ audience: 1, createdAt: -1 });
NotificationSchema.index(
  { event: 1, dedupeKey: 1 },
  { unique: true, sparse: true }
);

export const Notification = model<NotificationDocument>(
  'Notification',
  NotificationSchema
);
