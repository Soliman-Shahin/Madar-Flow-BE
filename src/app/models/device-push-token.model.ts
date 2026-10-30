import { Document, Schema, Types, model } from 'mongoose';

export type PushPlatform = 'android' | 'ios' | 'web';

export interface DevicePushTokenDocument extends Document {
  userId: Types.ObjectId;
  deviceId: string;
  token: string;
  platform: PushPlatform;
  appVersion?: string;
  active: boolean;
  lastRegisteredAt: Date;
  lastSeenAt: Date;
  invalidatedAt?: Date;
  invalidReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DevicePushTokenSchema = new Schema<DevicePushTokenDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, trim: true, maxlength: 128 },
    token: { type: String, required: true, select: false },
    platform: {
      type: String,
      enum: ['android', 'ios', 'web'],
      required: true,
    },
    appVersion: { type: String, trim: true, maxlength: 64 },
    active: { type: Boolean, default: true, index: true },
    lastRegisteredAt: { type: Date, required: true, default: Date.now },
    lastSeenAt: { type: Date, required: true, default: Date.now },
    invalidatedAt: Date,
    invalidReason: { type: String, maxlength: 128 },
  },
  { timestamps: true }
);

DevicePushTokenSchema.index({ token: 1 }, { unique: true });
DevicePushTokenSchema.index(
  { userId: 1, deviceId: 1, platform: 1 },
  { unique: true }
);
DevicePushTokenSchema.index({ userId: 1, active: 1 });

export const DevicePushToken = model<DevicePushTokenDocument>(
  'DevicePushToken',
  DevicePushTokenSchema
);
