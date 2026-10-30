import { Types } from 'mongoose';
import { NotificationPreference } from '../models/notification-preference.model';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationCategory,
  NotificationChannel,
  NotificationPreferences,
} from '../notifications/notification-taxonomy';

function defaults(): NotificationPreferences {
  return JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_PREFERENCES));
}

export class NotificationPreferenceService {
  static async getForUser(userId: string) {
    const userObjectId = new Types.ObjectId(userId);
    const record = await NotificationPreference.findOne({
      userId: userObjectId,
    }).lean();
    return record?.categories ?? defaults();
  }

  static async updateForUser(
    userId: string,
    updates: Partial<
      Record<
        NotificationCategory,
        Partial<Record<NotificationChannel, boolean>>
      >
    >
  ) {
    const categoryUpdates: Record<string, boolean> = {};
    for (const [category, channels] of Object.entries(updates)) {
      if (!channels) continue;
      for (const [channel, value] of Object.entries(channels)) {
        categoryUpdates[`categories.${category}.${channel}`] = value;
      }
    }

    const defaultsOnInsert: Record<string, boolean | Types.ObjectId> = {
      userId: new Types.ObjectId(userId),
    };
    for (const [category, channels] of Object.entries(
      DEFAULT_NOTIFICATION_PREFERENCES
    )) {
      for (const [channel, value] of Object.entries(channels)) {
        const path = `categories.${category}.${channel}`;
        if (!(path in categoryUpdates)) defaultsOnInsert[path] = value;
      }
    }

    const filter = { userId: new Types.ObjectId(userId) };
    const update = {
      $set: categoryUpdates,
      $setOnInsert: defaultsOnInsert,
    };
    const options = { upsert: true, returnDocument: 'after' as const, setDefaultsOnInsert: true };

    let record;
    try {
      record = await NotificationPreference.findOneAndUpdate(
        filter,
        update,
        options
      ).lean();
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      if (code !== 11000) throw error;

      // Another concurrent first update inserted this user's document. Retry
      // the same field-level update against the now-existing document.
      record = await NotificationPreference.findOneAndUpdate(
        filter,
        update,
        options
      ).lean();
    }

    return record?.categories ?? defaults();
  }
}
