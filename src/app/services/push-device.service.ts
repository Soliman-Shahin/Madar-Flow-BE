import { Types } from 'mongoose';
import { DevicePushToken, PushPlatform } from '../models/device-push-token.model';

interface RegisterDeviceInput {
  userId: string;
  deviceId: string;
  token: string;
  platform: PushPlatform;
  appVersion?: string;
}

export class PushDeviceService {
  static async register(input: RegisterDeviceInput) {
    const now = new Date();
    const userId = new Types.ObjectId(input.userId);

    const [tokenRecord, deviceRecord] = await Promise.all([
      DevicePushToken.findOne({ token: input.token }).select('+token'),
      DevicePushToken.findOne({
        userId,
        deviceId: input.deviceId,
        platform: input.platform,
      }).select('+token'),
    ]);

    if (
      tokenRecord &&
      deviceRecord &&
      tokenRecord._id.toString() !== deviceRecord._id.toString()
    ) {
      await DevicePushToken.deleteOne({ _id: tokenRecord._id });
    }

    const target = deviceRecord || tokenRecord;
    const update = {
      $set: {
        userId,
        deviceId: input.deviceId,
        token: input.token,
        platform: input.platform,
        appVersion: input.appVersion,
        active: true,
        lastRegisteredAt: now,
        lastSeenAt: now,
      },
      $unset: { invalidatedAt: 1, invalidReason: 1 },
    };

    const record = target
      ? await DevicePushToken.findByIdAndUpdate(target._id, update, {
          returnDocument: 'after',
          runValidators: true,
        })
      : await DevicePushToken.findOneAndUpdate(
          { userId, deviceId: input.deviceId, platform: input.platform },
          update,
          { returnDocument: 'after', upsert: true, runValidators: true }
        );

    if (!record) {
      throw new Error('Failed to register push device');
    }

    return {
      deviceId: record.deviceId,
      platform: record.platform,
      appVersion: record.appVersion,
      active: record.active,
      lastRegisteredAt: record.lastRegisteredAt,
    };
  }

  static async unregister(userId: string, deviceId: string) {
    const now = new Date();
    const result = await DevicePushToken.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), deviceId, active: true },
      {
        active: false,
        invalidatedAt: now,
        invalidReason: 'user_unregistered',
        lastSeenAt: now,
      },
      { returnDocument: 'after' }
    );

    return { deviceId, active: false, found: !!result };
  }
}
