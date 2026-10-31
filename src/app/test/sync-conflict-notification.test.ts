const mockSocketDelivery = jest.fn();
const mockPushDelivery = jest.fn().mockResolvedValue({
  attempted: 1,
  succeeded: 1,
  failed: 0,
  invalidTokens: 0,
});

jest.mock('../services/socket.service', () => ({
  getSocketService: () => ({ sendNotificationToUser: mockSocketDelivery }),
}));
jest.mock('../services/push-delivery.service', () => ({
  PushDeliveryService: { sendToUsers: mockPushDelivery },
}));

import { Notification } from '../models/notification.model';
import { NotificationPreferenceService } from '../services/notification-preference.service';
import { SyncConflict } from '../models/sync.model';
import { SyncFailure } from '../models/sync-failure.model';
import { Category } from '../models/category.model';
import { Expense } from '../models/expense.model';
import { UserNotification } from '../models/user-notification.model';
import { SyncService } from '../services/sync.service';

describe('sync.conflict notification producer', () => {
  const userId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    mockSocketDelivery.mockClear();
    mockPushDelivery.mockClear();
    await NotificationPreferenceService.updateForUser(userId, {
      sync: { realtime: false, push: false },
    });
    await NotificationPreferenceService.updateForUser(
      '507f1f77bcf86cd799439013',
      {
        sync: { realtime: false, push: false },
      }
    );
  });

  it('creates one owner-scoped notification for one unresolved conflict', async () => {
    const service = new SyncService();
    const conflict = {
      _id: '507f1f77bcf86cd799439012',
      _entityType: 'expense',
      _version: 4,
      _lastModified: '2026-01-01T00:00:00.000Z',
      _conflictData: { _version: 5, _lastModified: '2026-01-02T00:00:00.000Z' },
    };

    await (service as any).recordConflict(userId, conflict);
    await (service as any).recordConflict(userId, conflict);

    expect(
      await SyncConflict.countDocuments({
        user: userId,
        resolvedAt: { $exists: false },
      })
    ).toBe(1);
    expect(await Notification.countDocuments({ event: 'sync.conflict' })).toBe(
      1
    );
    expect(await SyncFailure.countDocuments({ user: userId })).toBe(0);
    expect(await UserNotification.countDocuments({ userId })).toBe(1);
    const notification = await Notification.findOne({
      event: 'sync.conflict',
    }).lean();
    expect(notification?.category).toBe('sync');
    expect(notification?.metadata).toEqual({
      conflictId: expect.any(String),
      entityType: 'expense',
    });
    expect(JSON.stringify(notification?.metadata)).not.toContain(
      '_conflictData'
    );
  });

  it('honors inbox, realtime, and push preference channels', async () => {
    const service = new SyncService();
    await NotificationPreferenceService.updateForUser(userId, {
      sync: { inbox: true, realtime: true, push: true },
    });
    await (service as any).recordConflict(userId, {
      _id: '507f1f77bcf86cd799439012',
      _entityType: 'expense',
      _version: 1,
      _conflictData: { _version: 2 },
    });
    expect(await UserNotification.countDocuments({ userId })).toBe(1);
    expect(mockSocketDelivery).toHaveBeenCalledTimes(1);
    expect(mockPushDelivery).toHaveBeenCalledTimes(1);

    await NotificationPreferenceService.updateForUser(userId, {
      sync: { inbox: false, realtime: false, push: false },
    });
    await (service as any).recordConflict(userId, {
      _id: '507f1f77bcf86cd799439014',
      _entityType: 'expense',
      _version: 1,
      _conflictData: { _version: 2 },
    });
    expect(await UserNotification.countDocuments({ userId })).toBe(1);
    expect(mockSocketDelivery).toHaveBeenCalledTimes(1);
    expect(mockPushDelivery).toHaveBeenCalledTimes(1);
  });

  it('creates separate notifications for distinct conflicts and isolates owners', async () => {
    const service = new SyncService();
    await (service as any).recordConflict(userId, {
      _id: '507f1f77bcf86cd799439012',
      _entityType: 'expense',
      _version: 1,
      _conflictData: { _version: 2 },
    });
    await (service as any).recordConflict('507f1f77bcf86cd799439013', {
      _id: '507f1f77bcf86cd799439012',
      _entityType: 'expense',
      _version: 1,
      _conflictData: { _version: 2 },
    });

    expect(await Notification.countDocuments({ event: 'sync.conflict' })).toBe(
      2
    );
    expect(await UserNotification.countDocuments({ userId })).toBe(1);
    expect(
      await UserNotification.countDocuments({
        userId: '507f1f77bcf86cd799439013',
      })
    ).toBe(1);
  });

  it('allows exactly one notification winner under concurrent duplicate detection', async () => {
    const service = new SyncService();
    const conflict = {
      _id: '507f1f77bcf86cd799439012',
      _entityType: 'expense',
      _version: 1,
      _conflictData: { _version: 2 },
    };
    await Promise.all([
      (service as any).recordConflict(userId, conflict),
      (service as any).recordConflict(userId, conflict),
    ]);
    expect(await Notification.countDocuments({ event: 'sync.conflict' })).toBe(
      1
    );
    expect(await UserNotification.countDocuments({ userId })).toBe(1);
  });

  it('permits a new conflict after the prior conflict is resolved', async () => {
    const service = new SyncService();
    const base = {
      _id: '507f1f77bcf86cd799439012',
      _entityType: 'expense',
      _version: 1,
      _conflictData: { _version: 2 },
    };
    await (service as any).recordConflict(userId, base);
    await SyncConflict.updateOne(
      { user: userId },
      { $set: { resolvedAt: new Date() } }
    );
    expect(await service.getConflicts(userId)).toHaveLength(0);
    await (service as any).recordConflict(userId, { ...base, _version: 2 });
    expect(await Notification.countDocuments({ event: 'sync.conflict' })).toBe(
      2
    );
  });

  it('returns only unresolved conflicts in the existing conflict-review shape', async () => {
    const service = new SyncService();
    await (service as any).recordConflict(userId, {
      _id: '507f1f77bcf86cd799439012',
      _entityType: 'expense',
      _version: 1,
      _conflictData: { _version: 2 },
    });
    const conflicts = await service.getConflicts(userId);
    expect(conflicts[0]).toEqual(
      expect.objectContaining({
        entityId: '507f1f77bcf86cd799439012',
        entityType: 'expense',
        timestamp: expect.any(Date),
      })
    );
    expect(conflicts[0]).not.toHaveProperty('dedupeKey');
  });

  it('counts backend-observed failures and dispatches exactly once at failure three', async () => {
    const service = new SyncService();
    const failedEntity = {
      _operationId: 'operation-1',
      _entityType: 'expense',
      _id: 'offline-failed-expense',
      description: 'Invalid expense',
      amount: 10,
      date: new Date().toISOString(),
    };

    for (const expected of [1, 2]) {
      const result = await service.pushData(userId, [failedEntity]);
      expect(result.errors).toHaveLength(1);
      expect(
        await Notification.countDocuments({ event: 'sync.repeated_failure' })
      ).toBe(0);
      expect((await SyncFailure.findOne({ user: userId }))?.attemptCount).toBe(
        expected
      );
    }
    const third = await service.pushData(userId, [failedEntity]);
    expect(third.errors).toHaveLength(1);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(1);
    const failure = await SyncFailure.findOne({ user: userId });
    expect(failure?.terminal).toBe(true);

    await service.pushData(userId, [failedEntity]);

    const repeatedNotifications = await Notification.find({
      event: 'sync.repeated_failure',
    }).lean();
    expect(repeatedNotifications).toHaveLength(1);
    expect(repeatedNotifications[0].dedupeKey).toMatch(
      `${userId}:sync-repeated-failure:`
    );
    const notification = await Notification.findOne({
      event: 'sync.repeated_failure',
    }).lean();
    expect(notification?.metadata).toEqual(
      expect.objectContaining({
        operationId: 'operation-1',
        registrationId: expect.any(String),
        entityType: 'expense',
        entityId: 'offline-failed-expense',
        failureCount: 3,
      })
    );
    expect(JSON.stringify(notification?.metadata)).not.toContain(
      'Invalid expense'
    );
  });

  it('does not trust forged retry metadata or client sync errors', async () => {
    const service = new SyncService();
    const categoryId = 'offline-safe-category';
    await service.pushData(userId, [
      {
        _operationId: 'operation-forged',
        _retryCount: 999999,
        _maxRetries: 1,
        _syncError: 'fabricated failure',
        _entityType: 'category',
        _id: categoryId,
        title: 'Safe category',
        icon: 'tag-outline',
        color: '#3366ff',
        type: 'outcome',
        order: 0,
      },
    ]);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(0);
    expect(await SyncFailure.countDocuments({ user: userId })).toBe(0);
  });

  it('does not create failure state for malformed or arbitrary operation identities', async () => {
    const service = new SyncService();
    const invalidEntity = {
      _entityType: 'expense',
      _id: 'offline-invalid-operation',
      description: 'Invalid expense',
      amount: 10,
      date: new Date().toISOString(),
    };
    for (const operationId of ['', 'x', 'bad id', 'a'.repeat(65)]) {
      await service.pushData(userId, [
        {
          ...invalidEntity,
          _operationId: operationId,
          _retryCount: -1,
          _maxRetries: 1,
        },
      ]);
    }
    expect(await SyncFailure.countDocuments({ user: userId })).toBe(0);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(0);
  });

  it('isolates the same durable operation id across authenticated users', async () => {
    const service = new SyncService();
    const failedEntity = {
      _operationId: 'shared-operation',
      _entityType: 'expense',
      _id: 'offline-shared-failure',
      description: 'Invalid expense',
      amount: 10,
      date: new Date().toISOString(),
    };
    const otherUser = '507f1f77bcf86cd799439013';
    for (let i = 0; i < 3; i++) {
      await service.pushData(userId, [failedEntity]);
      await service.pushData(otherUser, [failedEntity]);
    }
    expect(
      await SyncFailure.countDocuments({ operationId: 'shared-operation' })
    ).toBe(2);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(2);
  });

  it('isolates success, conflict, and ordinary failure in one push batch', async () => {
    const category = await Category.create({
      title: 'Mixed batch category',
      icon: 'folder',
      color: '#123456',
      user: userId,
      _version: 1,
    });
    const existingExpense = await Expense.create({
      description: 'Existing expense',
      amount: 100,
      category: category._id,
      date: new Date(),
      user: userId,
      _version: 2,
    });

    const result = await new SyncService().pushData(userId, [
      {
        _operationId: 'mixed-success',
        _entityType: 'category',
        _id: 'offline-mixed-category',
        title: 'Created category',
        icon: 'tag-outline',
        color: '#3366ff',
        type: 'outcome',
        order: 0,
      },
      {
        _operationId: 'mixed-conflict',
        _entityType: 'expense',
        _id: existingExpense._id.toString(),
        _version: 2,
        _baseVersion: 1,
        description: 'Stale update',
        amount: 200,
        category: category._id,
        date: new Date(),
      },
      {
        _operationId: 'mixed-failure',
        _entityType: 'expense',
        _id: 'offline-mixed-failure',
        description: 'Missing category',
        amount: 10,
        date: new Date().toISOString(),
      },
    ]);

    expect(result.processed).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(
      await SyncFailure.findOne({ user: userId, operationId: 'mixed-success' })
    ).toBeNull();
    expect(
      await SyncFailure.findOne({ user: userId, operationId: 'mixed-conflict' })
    ).toBeNull();
    expect(
      (
        await SyncFailure.findOne({
          user: userId,
          operationId: 'mixed-failure',
        })
      )?.attemptCount
    ).toBe(1);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(0);
  });
});
