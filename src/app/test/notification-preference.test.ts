import { NotificationPreference } from '../models/notification-preference.model';
import { NotificationPreferenceService } from '../services/notification-preference.service';
import { NotificationService } from '../services/notification.service';
import { notificationPreferencePatchSchema } from '../validations/notification-preference.validation';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_DEFINITIONS,
  NOTIFICATION_EVENTS,
  definitionForEvent,
} from '../notifications/notification-taxonomy';
import { UserNotification } from '../models/user-notification.model';
import { Types } from 'mongoose';

describe('notification preference foundation', () => {
  it('returns all-enabled defaults without creating a preference record', async () => {
    const userId = '507f1f77bcf86cd799439011';
    const result = await NotificationPreferenceService.getForUser(userId);
    expect(result.sync).toEqual({ inbox: true, realtime: true, push: true });
    expect(await NotificationPreference.countDocuments()).toBe(0);
  });

  it('updates only whitelisted channels for the owning user', async () => {
    const userId = '507f1f77bcf86cd799439011';
    const result = await NotificationPreferenceService.updateForUser(userId, {
      sync: { push: false },
    });
    expect(result.sync.push).toBe(false);
    expect(result.sync.inbox).toBe(true);
    expect(
      (
        await NotificationPreferenceService.getForUser(
          '507f1f77bcf86cd799439012'
        )
      ).sync.push
    ).toBe(true);
  });

  it('atomically preserves concurrent updates across categories', async () => {
    const userId = new Types.ObjectId().toString();

    const responses = await Promise.all([
      NotificationPreferenceService.updateForUser(userId, {
        sync: { push: false },
      }),
      NotificationPreferenceService.updateForUser(userId, {
        subscription: { push: false },
      }),
    ]);

    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(Object.keys(response)).toHaveLength(4);
      expect(Object.keys(response)).toEqual(
        expect.arrayContaining(['sync', 'subscription', 'security', 'general'])
      );
    }
    const result = await NotificationPreferenceService.getForUser(userId);
    expect(result.sync.push).toBe(false);
    expect(result.subscription.push).toBe(false);
    expect(result.sync.inbox).toBe(true);
    expect(result.sync.realtime).toBe(true);
    expect(result.subscription.inbox).toBe(true);
    expect(result.subscription.realtime).toBe(true);
    expect(result.security).toEqual({
      inbox: true,
      realtime: true,
      push: true,
    });
    expect(result.general).toEqual({ inbox: true, realtime: true, push: true });
    expect(await NotificationPreference.countDocuments({ userId })).toBe(1);
  });

  it('atomically preserves concurrent updates within one category', async () => {
    const userId = new Types.ObjectId().toString();

    const responses = await Promise.all([
      NotificationPreferenceService.updateForUser(userId, {
        sync: { push: false },
      }),
      NotificationPreferenceService.updateForUser(userId, {
        sync: { realtime: false },
      }),
    ]);

    expect(responses).toHaveLength(2);
    const result = await NotificationPreferenceService.getForUser(userId);
    expect(result.sync).toEqual({ inbox: true, realtime: false, push: false });
    expect(await NotificationPreference.countDocuments({ userId })).toBe(1);
  });

  it('preserves independent concurrent updates on an existing document', async () => {
    const userId = new Types.ObjectId().toString();
    await NotificationPreferenceService.updateForUser(userId, {
      security: { inbox: false },
    });

    await Promise.all([
      NotificationPreferenceService.updateForUser(userId, {
        sync: { push: false },
      }),
      NotificationPreferenceService.updateForUser(userId, {
        subscription: { push: false },
      }),
    ]);

    const persisted = await NotificationPreference.findOne({ userId }).lean();
    expect(persisted?.categories).toEqual({
      sync: { inbox: true, realtime: true, push: false },
      subscription: { inbox: true, realtime: true, push: false },
      security: { inbox: false, realtime: true, push: true },
      general: { inbox: true, realtime: true, push: true },
    });
  });

  it('preserves independent concurrent channel updates on an existing category', async () => {
    const userId = new Types.ObjectId().toString();
    await NotificationPreferenceService.updateForUser(userId, {
      sync: { inbox: false },
    });

    await Promise.all([
      NotificationPreferenceService.updateForUser(userId, {
        sync: { push: false },
      }),
      NotificationPreferenceService.updateForUser(userId, {
        sync: { realtime: false },
      }),
    ]);

    const persisted = await NotificationPreference.findOne({ userId }).lean();
    expect(persisted?.categories.sync).toEqual({
      inbox: false,
      realtime: false,
      push: false,
    });
  });

  it('applies multi-field patches while preserving existing custom state', async () => {
    const userId = new Types.ObjectId().toString();
    await NotificationPreferenceService.updateForUser(userId, {
      sync: { inbox: false, push: false },
      subscription: { realtime: false },
    });

    const result = await NotificationPreferenceService.updateForUser(userId, {
      sync: { realtime: false },
    });

    expect(result).toEqual({
      sync: { inbox: false, realtime: false, push: false },
      subscription: { inbox: true, realtime: false, push: true },
      security: { inbox: true, realtime: true, push: true },
      general: { inbox: true, realtime: true, push: true },
    });
  });

  it('creates complete defaults for a new user with a partial patch', async () => {
    const userId = new Types.ObjectId().toString();

    const result = await NotificationPreferenceService.updateForUser(userId, {
      sync: { push: false },
    });

    expect(result).toEqual({
      sync: { inbox: true, realtime: true, push: false },
      subscription: { inbox: true, realtime: true, push: true },
      security: { inbox: true, realtime: true, push: true },
      general: { inbox: true, realtime: true, push: true },
    });
    expect(await NotificationPreference.countDocuments({ userId })).toBe(1);
  });

  it('is idempotent and keeps one preference document per user', async () => {
    const userId = new Types.ObjectId().toString();
    const patch = { subscription: { push: false } };

    await NotificationPreferenceService.updateForUser(userId, patch);
    await NotificationPreferenceService.updateForUser(userId, patch);

    expect(
      (await NotificationPreferenceService.getForUser(userId)).subscription.push
    ).toBe(false);
    expect(await NotificationPreference.countDocuments({ userId })).toBe(1);
  });

  it('keeps account preference documents isolated', async () => {
    const userA = new Types.ObjectId().toString();
    const userB = new Types.ObjectId().toString();

    await NotificationPreferenceService.updateForUser(userA, {
      sync: { push: false },
    });

    expect(
      (await NotificationPreferenceService.getForUser(userB)).sync.push
    ).toBe(true);
    expect(
      (await NotificationPreferenceService.getForUser(userA)).sync.push
    ).toBe(false);
  });

  it('bypasses optional suppression for mandatory policy', async () => {
    const userId = '507f1f77bcf86cd799439011';
    await NotificationPreferenceService.updateForUser(userId, {
      security: { inbox: false, realtime: false, push: false },
    });
    expect(
      await NotificationService.resolveChannelsForUser(
        userId,
        'security',
        'optional'
      )
    ).toEqual([]);
    expect(
      await NotificationService.resolveChannelsForUser(
        userId,
        'security',
        'mandatory'
      )
    ).toEqual(['inbox', 'realtime', 'push']);
  });

  it('preserves unspecified categories and channels and returns canonical state', async () => {
    const userId = '507f1f77bcf86cd799439013';
    const result = await NotificationPreferenceService.updateForUser(userId, {
      sync: { push: false },
      general: { realtime: false },
    });
    expect(result.sync).toEqual({ inbox: true, realtime: true, push: false });
    expect(result.general).toEqual({
      inbox: true,
      realtime: false,
      push: true,
    });
    expect(result.subscription).toEqual({
      inbox: true,
      realtime: true,
      push: true,
    });
    expect(await NotificationPreferenceService.getForUser(userId)).toEqual(
      result
    );
  });

  it('rejects unknown categories, channels, fields, invalid values, and empty patches', () => {
    expect(
      notificationPreferencePatchSchema.safeParse({ unknown: { push: true } })
        .success
    ).toBe(false);
    expect(
      notificationPreferencePatchSchema.safeParse({ sync: { email: true } })
        .success
    ).toBe(false);
    expect(
      notificationPreferencePatchSchema.safeParse({ sync: { push: 'false' } })
        .success
    ).toBe(false);
    expect(notificationPreferencePatchSchema.safeParse({}).success).toBe(false);
  });

  it('defines exactly one explicit category and policy for every event and rejects unknown events', () => {
    expect(Object.keys(NOTIFICATION_EVENT_DEFINITIONS)).toHaveLength(
      NOTIFICATION_EVENTS.length
    );
    for (const event of NOTIFICATION_EVENTS) {
      const definition = definitionForEvent(event);
      expect(['sync', 'subscription', 'security', 'general']).toContain(
        definition.category
      );
      expect(['optional', 'mandatory']).toContain(definition.policy);
    }
    expect(() => definitionForEvent('future.unknown')).toThrow(
      'UNKNOWN_NOTIFICATION_EVENT'
    );
  });

  it('returns only canonical channels and resolves each optional channel independently', async () => {
    const userId = '507f1f77bcf86cd799439014';
    await NotificationPreferenceService.updateForUser(userId, {
      sync: { inbox: true, realtime: false, push: true },
    });
    expect(
      await NotificationService.resolveChannelsForUser(
        userId,
        'sync',
        'optional'
      )
    ).toEqual(['inbox', 'push']);
    expect(NOTIFICATION_CHANNELS).toEqual(['inbox', 'realtime', 'push']);
  });

  it('keeps one durable inbox row per user and notification across channel fan-out', async () => {
    const notificationId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    await UserNotification.create({ notificationId, userId });
    await expect(
      UserNotification.create({ notificationId, userId })
    ).rejects.toMatchObject({ code: 11000 });
    expect(
      await UserNotification.countDocuments({ notificationId, userId })
    ).toBe(1);
  });
});
