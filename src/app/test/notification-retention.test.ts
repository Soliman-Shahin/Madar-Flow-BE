import { Types } from 'mongoose';
import { Notification } from '../models/notification.model';
import { UserNotification } from '../models/user-notification.model';
import { NotificationArchivalService } from '../services/notification-archival.service';
import { NotificationRetentionService } from '../services/notification-retention.service';
import { NotificationService } from '../services/notification.service';

describe('notification archival lifecycle', () => {
  const userId = new Types.ObjectId();
  const otherUserId = new Types.ObjectId();
  const referenceTime = new Date('2026-01-01T00:00:00.000Z');
  const days = (value: number) =>
    new Date(referenceTime.getTime() - value * 24 * 60 * 60 * 1000);

  async function createNotification(createdAt = referenceTime) {
    const notification = await Notification.create({
      title: 'Retention test',
      message: 'Notification lifecycle',
      createdBy: userId,
    });
    await Notification.collection.updateOne(
      { _id: notification._id },
      { $set: { createdAt, updatedAt: createdAt } }
    );
    return notification;
  }

  async function createAssociation(
    notificationId: Types.ObjectId,
    ownerId: Types.ObjectId,
    createdAt: Date,
    extra: Record<string, unknown> = {}
  ) {
    const row = await UserNotification.create({
      notificationId,
      userId: ownerId,
      ...extra,
    });
    await UserNotification.collection.updateOne(
      { _id: row._id },
      { $set: { createdAt, updatedAt: createdAt } }
    );
    return row;
  }

  it('keeps new associations active and excludes archived rows from pages and unread count', async () => {
    const active = await createNotification(days(10));
    const archived = await createNotification(days(100));
    await UserNotification.create({ notificationId: active._id, userId });
    await UserNotification.create({
      notificationId: archived._id,
      userId,
      archivedAt: days(5),
    });

    const page = await NotificationService.listForUser(
      userId.toString(),
      50,
      0
    );
    expect(page.data.map((item: { id: string }) => item.id)).toEqual([
      active._id.toString(),
    ]);
    expect(page.total).toBe(1);
    expect(page.unreadCount).toBe(1);
  });

  it('does not let archived rows consume pagination slots or corrupt hasMore', async () => {
    const archived = await createNotification(days(100));
    const active = await createNotification(days(10));
    await UserNotification.create({
      notificationId: archived._id,
      userId,
      archivedAt: days(1),
    });
    await UserNotification.create({ notificationId: active._id, userId });

    const page = await NotificationService.listForUser(userId.toString(), 1, 0);
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe(active._id.toString());
    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it('archives exactly eligible rows, preserves read state, and is idempotent', async () => {
    const exact = await createNotification(days(90));
    const newer = await createNotification(days(89));
    const older = await createNotification(days(120));
    const readAt = new Date('2025-12-01T00:00:00.000Z');
    await createAssociation(exact._id, userId, days(90), {
      readAt,
      openedAt: readAt,
    });
    await createAssociation(newer._id, userId, days(89));
    await createAssociation(older._id, userId, days(120));

    expect(
      await NotificationArchivalService.archiveEligible(referenceTime)
    ).toBe(2);
    const rows = await UserNotification.find({ userId }).lean();
    expect(
      rows.find((row) => row.notificationId.equals(exact._id))?.archivedAt
    ).toEqual(referenceTime);
    expect(
      rows.find((row) => row.notificationId.equals(exact._id))?.readAt
    ).toEqual(readAt);
    expect(
      rows.find((row) => row.notificationId.equals(exact._id))?.openedAt
    ).toEqual(readAt);
    expect(
      rows.find((row) => row.notificationId.equals(newer._id))?.archivedAt
    ).toBeUndefined();
    expect(
      await NotificationArchivalService.archiveEligible(referenceTime)
    ).toBe(0);
    expect(await Notification.countDocuments()).toBe(3);
  });

  it('excludes archived rows from read operations without unarchiving them', async () => {
    const active = await createNotification(days(10));
    const archived = await createNotification(days(100));
    await UserNotification.create({ notificationId: active._id, userId });
    await UserNotification.create({
      notificationId: archived._id,
      userId,
      archivedAt: days(1),
    });

    expect(
      await NotificationService.markRead(
        userId.toString(),
        archived._id.toString()
      )
    ).toBe(false);
    expect(
      (await NotificationService.markAllRead(userId.toString())).updatedCount
    ).toBe(1);
    const archivedRow = await UserNotification.findOne({
      notificationId: archived._id,
      userId,
    }).lean();
    expect(archivedRow?.readAt).toBeUndefined();
    expect(archivedRow?.archivedAt).toBeDefined();
  });

  it('keeps archived detail owner-authorized and account-isolated', async () => {
    const notification = await createNotification(days(100));
    await UserNotification.create({
      notificationId: notification._id,
      userId,
      archivedAt: days(1),
    });

    expect(
      await NotificationService.getForUser(
        userId.toString(),
        notification._id.toString()
      )
    ).not.toBeNull();
    expect(
      await NotificationService.getForUser(
        otherUserId.toString(),
        notification._id.toString()
      )
    ).toBeNull();
  });

  it('archives broadcast associations independently without changing the canonical record', async () => {
    const notification = await createNotification(days(100));
    await createAssociation(notification._id, userId, days(100));
    await createAssociation(notification._id, otherUserId, days(10));
    await NotificationArchivalService.archiveEligible(referenceTime);
    expect(
      await UserNotification.countDocuments({
        notificationId: notification._id,
        archivedAt: { $exists: true },
      })
    ).toBe(1);
    expect(
      await UserNotification.countDocuments({
        notificationId: notification._id,
        archivedAt: { $exists: false },
      })
    ).toBe(1);
    expect(await Notification.exists({ _id: notification._id })).not.toBeNull();
  });

  it('does not count missing canonical records or make pagination metadata lie', async () => {
    const active = await createNotification(days(10));
    await UserNotification.create({
      notificationId: new Types.ObjectId(),
      userId,
    });
    await UserNotification.create({ notificationId: active._id, userId });
    const page = await NotificationService.listForUser(
      userId.toString(),
      50,
      0
    );
    expect(page.data).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it('deletes archived associations at the exact 180-day boundary and removes the orphan canonical', async () => {
    const exact = await createNotification(days(180));
    const older = await createNotification(days(200));
    const younger = await createNotification(days(179));
    await createAssociation(exact._id, userId, days(180), {
      archivedAt: days(100),
    });
    await createAssociation(older._id, userId, days(200), {
      archivedAt: days(100),
    });
    await createAssociation(younger._id, userId, days(179), {
      archivedAt: days(100),
    });

    const result =
      await NotificationRetentionService.deleteExpired(referenceTime);
    expect(result.deletedUserNotifications).toBe(2);
    expect(result.deletedNotifications).toBe(2);
    expect(
      await UserNotification.exists({ notificationId: younger._id })
    ).not.toBeNull();
    expect(await Notification.exists({ _id: younger._id })).not.toBeNull();
  });

  it('does not delete an old active association or its canonical notification', async () => {
    const notification = await createNotification(days(200));
    await createAssociation(notification._id, userId, days(200));
    const result =
      await NotificationRetentionService.deleteExpired(referenceTime);
    expect(result.deletedUserNotifications).toBe(0);
    expect(
      await UserNotification.exists({ notificationId: notification._id })
    ).not.toBeNull();
    expect(await Notification.exists({ _id: notification._id })).not.toBeNull();
  });

  it('keeps a broadcast canonical while any active or younger archived association remains', async () => {
    const notification = await createNotification(days(200));
    await createAssociation(notification._id, userId, days(190), {
      archivedAt: days(100),
    });
    await createAssociation(notification._id, otherUserId, days(170), {
      archivedAt: days(10),
    });
    const result =
      await NotificationRetentionService.deleteExpired(referenceTime);
    expect(result.deletedUserNotifications).toBe(1);
    expect(result.deletedNotifications).toBe(0);
    expect(await Notification.exists({ _id: notification._id })).not.toBeNull();
    expect(
      await NotificationService.getForUser(
        otherUserId.toString(),
        notification._id.toString()
      )
    ).not.toBeNull();
  });

  it('keeps a canonical referenced by an active association', async () => {
    const notification = await createNotification(days(200));
    await createAssociation(notification._id, userId, days(190), {
      archivedAt: days(100),
    });
    await createAssociation(notification._id, otherUserId, days(10));
    const result =
      await NotificationRetentionService.deleteExpired(referenceTime);
    expect(result.deletedUserNotifications).toBe(1);
    expect(result.deletedNotifications).toBe(0);
    expect(await Notification.exists({ _id: notification._id })).not.toBeNull();
  });

  it('recovers old canonical orphans but preserves recent and referenced canonicals', async () => {
    const oldOrphan = await createNotification(days(200));
    const recentOrphan = await createNotification(days(10));
    const referenced = await createNotification(days(200));
    await createAssociation(referenced._id, userId, days(10));
    const result =
      await NotificationRetentionService.deleteExpired(referenceTime);
    expect(result.deletedNotifications).toBe(1);
    expect(await Notification.exists({ _id: oldOrphan._id })).toBeNull();
    expect(await Notification.exists({ _id: recentOrphan._id })).not.toBeNull();
    expect(await Notification.exists({ _id: referenced._id })).not.toBeNull();
  });

  it('archives then deletes a 200-day backlog row in one lifecycle sequence', async () => {
    const notification = await createNotification(days(200));
    await createAssociation(notification._id, userId, days(200));
    await NotificationArchivalService.archiveEligible(referenceTime);
    const result =
      await NotificationRetentionService.deleteExpired(referenceTime);
    expect(result.deletedUserNotifications).toBe(1);
    expect(result.deletedNotifications).toBe(1);
    expect(await Notification.exists({ _id: notification._id })).toBeNull();
  });

  it('deletes more than one association batch without skipping eligible rows', async () => {
    const notification = await createNotification(days(200));
    const associations = Array.from({ length: 1001 }, (_, index) => ({
      notificationId: notification._id,
      userId: new Types.ObjectId(),
      archivedAt: days(100),
      createdAt: days(200),
      updatedAt: days(200),
      _id: new Types.ObjectId(),
    }));
    await UserNotification.collection.insertMany(associations);

    const result =
      await NotificationRetentionService.deleteExpired(referenceTime);
    expect(result.deletedUserNotifications).toBe(1001);
    expect(
      await UserNotification.countDocuments({
        notificationId: notification._id,
      })
    ).toBe(0);
    expect(await Notification.exists({ _id: notification._id })).toBeNull();
  });

  it('traverses more than one orphan batch and advances past protected candidates', async () => {
    const candidates = Array.from({ length: 1001 }, () => ({
      title: 'Old orphan',
      message: 'Historical candidate',
      type: 'info' as const,
      audience: 'all' as const,
      routeKey: 'notification-detail' as const,
      createdBy: userId,
      createdAt: days(200),
      updatedAt: days(200),
      recipientCount: 0,
      pushSummary: { attempted: 0, succeeded: 0, failed: 0, invalidTokens: 0 },
      _id: new Types.ObjectId(),
    }));
    await Notification.collection.insertMany(candidates);
    const protectedIds = candidates
      .filter((_, index) => index % 100 === 0)
      .map((candidate) => candidate._id);
    await UserNotification.collection.insertMany(
      protectedIds.map((notificationId) => ({
        notificationId,
        userId,
        createdAt: days(10),
        updatedAt: days(10),
      }))
    );

    const result =
      await NotificationRetentionService.deleteExpired(referenceTime);
    expect(result.deletedNotifications).toBe(990);
    expect(
      await Notification.countDocuments({ _id: { $in: protectedIds } })
    ).toBe(11);
    expect(await Notification.countDocuments()).toBe(11);
  });
});
