import { errorCode } from '../shared/errors';
import { Types } from 'mongoose';
import {
  Notification,
  NotificationAudience,
  NotificationType,
} from '../models/notification.model';
import { UserNotification } from '../models/user-notification.model';
import { User, UserRole } from '../models/user.model';
import logger from './logger.service';
import { DevicePushToken } from '../models/device-push-token.model';
import { PushDeliveryService } from './push-delivery.service';
import { getSocketService } from './socket.service';
import { NotificationPreferenceService } from './notification-preference.service';
import {
  channelsForPolicy,
  NotificationCategory,
  NotificationChannel,
  NotificationPolicy,
  definitionForEvent,
  NotificationEvent,
} from '../notifications/notification-taxonomy';

export interface BroadcastTarget {
  roles?: string[];
  plans?: string[];
  platforms?: Array<'android' | 'ios' | 'web'>;
  planExpiringInDays?: number;
  joinedWithinDays?: number;
  userIds?: string[];
}

interface BroadcastInput {
  title: string;
  message: string;
  type: NotificationType;
  audience: NotificationAudience;
  target?: BroadcastTarget;
  channels?: { push?: boolean; realtime?: boolean };
  createdBy: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class NotificationService {
  static async dispatchUserEvent(input: {
    userId: string;
    event: NotificationEvent;
    dedupeKey: string;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) {
    const definition = definitionForEvent(input.event);
    const channels = await this.resolveChannelsForUser(
      input.userId,
      definition.category,
      definition.policy
    );
    let notification;
    try {
      notification = await Notification.create({
        title: input.title,
        message: input.message,
        type: 'warn',
        audience: 'all',
        createdBy: new Types.ObjectId(input.userId),
        routeKey: 'notification-detail',
        event: input.event,
        category: definition.category,
        dedupeKey: input.dedupeKey,
        metadata: input.metadata,
      });
    } catch (error: unknown) {
      if (errorCode(error) === 11000) return { created: false, channels };
      throw error;
    }
    const userObjectId = new Types.ObjectId(input.userId);
    if (channels.includes('inbox')) {
      await UserNotification.updateOne(
        { notificationId: notification._id, userId: userObjectId },
        {
          $setOnInsert: {
            notificationId: notification._id,
            userId: userObjectId,
          },
        },
        { upsert: true }
      );
    }
    const payload = {
      id: notification._id.toString(),
      title: input.title,
      message: input.message,
      type: 'warn' as const,
      event: input.event,
      category: definition.category,
      metadata: input.metadata,
      createdAt: notification.createdAt,
    };
    if (channels.includes('realtime')) {
      getSocketService().sendNotificationToUser(input.userId, payload);
    }
    if (channels.includes('push')) {
      await PushDeliveryService.sendToUsers({
        userIds: [userObjectId],
        notificationId: notification._id.toString(),
        title: input.title,
        message: input.message,
        type: 'warn',
        routeKey: 'notification-detail',
      });
    }
    return {
      created: true,
      channels,
      notificationId: notification._id.toString(),
    };
  }
  static async resolveChannelsForUser(
    userId: string,
    category: NotificationCategory,
    policy: NotificationPolicy = 'optional'
  ): Promise<NotificationChannel[]> {
    const preferences = await NotificationPreferenceService.getForUser(userId);
    return channelsForPolicy(category, policy, preferences);
  }

  static async listForUser(userId: string, limit = 50, offset = 0) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);
    const userObjectId = new Types.ObjectId(userId);
    const [result] = await UserNotification.aggregate([
      { $match: { userId: userObjectId, archivedAt: { $exists: false } } },
      {
        $lookup: {
          from: 'notifications',
          localField: 'notificationId',
          foreignField: '_id',
          as: 'notification',
        },
      },
      { $unwind: '$notification' },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          data: [
            { $skip: safeOffset },
            { $limit: safeLimit },
            {
              $project: {
                readAt: 1,
                notification: {
                  _id: 1,
                  title: 1,
                  message: 1,
                  type: 1,
                  routeKey: 1,
                  event: 1,
                  category: 1,
                  metadata: 1,
                  createdAt: 1,
                },
              },
            },
          ],
          totals: [{ $count: 'count' }],
          unread: [
            { $match: { readAt: { $exists: false } } },
            { $count: 'count' },
          ],
        },
      },
    ]);
    const rows = result?.data ?? [];
    const total = result?.totals?.[0]?.count ?? 0;
    const unreadCount = result?.unread?.[0]?.count ?? 0;
    return {
      data: rows.map((row: any) => ({
        id: row.notification._id.toString(),
        title: row.notification.title,
        message: row.notification.message,
        type: row.notification.type,
        routeKey: row.notification.routeKey,
        event: row.notification.event,
        category: row.notification.category,
        metadata: row.notification.metadata,
        isRead: !!row.readAt,
        createdAt: row.notification.createdAt,
      })),
      total,
      unreadCount,
      hasMore: safeOffset + rows.length < total,
    };
  }

  /** Builds the user query for an audience / custom target. */
  static async resolveRecipientIds(
    audience: NotificationAudience,
    target: BroadcastTarget = {}
  ): Promise<Types.ObjectId[]> {
    const filter: Record<string, unknown> = {
      isActive: { $ne: false },
      _isDeleted: { $ne: true },
    };
    if (audience === 'admins') {
      filter.role = { $in: [UserRole.Admin, UserRole.SuperAdmin] };
    } else if (audience === 'moderators') {
      filter.role = UserRole.Moderator;
    } else if (audience === 'custom') {
      if (target.userIds?.length) {
        filter._id = { $in: target.userIds.map((id) => new Types.ObjectId(id)) };
      } else {
        if (target.roles?.length) filter.role = { $in: target.roles };
        if (target.plans?.length) filter.plan = { $in: target.plans };
        if (target.planExpiringInDays) {
          const now = Date.now();
          filter.planExpiresAt = {
            $gte: new Date(now),
            $lte: new Date(now + target.planExpiringInDays * DAY_MS),
          };
        }
        if (target.joinedWithinDays) {
          filter.createdAt = {
            $gte: new Date(Date.now() - target.joinedWithinDays * DAY_MS),
          };
        }
        if (target.platforms?.length) {
          const ids = await DevicePushToken.distinct('userId', {
            active: true,
            platform: { $in: target.platforms },
          });
          filter._id = { $in: ids };
        }
      }
    }
    const rows = await User.find(filter).select('_id').lean();
    return rows.map((row) => row._id as Types.ObjectId);
  }

  static async previewBroadcast(
    audience: NotificationAudience,
    target: BroadcastTarget = {}
  ) {
    const ids = await this.resolveRecipientIds(audience, target);
    const [sample, pushDevices] = await Promise.all([
      User.find({ _id: { $in: ids.slice(0, 5) } })
        .select('email username role plan')
        .lean(),
      ids.length
        ? DevicePushToken.countDocuments({
            userId: { $in: ids },
            active: true,
          })
        : Promise.resolve(0),
    ]);
    return {
      recipientCount: ids.length,
      pushDevices,
      sample: sample.map((user: any) => ({
        id: String(user._id),
        email: user.email,
        name: user.username,
        role: user.role,
        plan: user.plan,
      })),
    };
  }

  static async listBroadcasts(limit = 20, offset = 0) {
    const query = { event: { $exists: false } };
    const [rows, total] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Notification.countDocuments(query),
    ]);
    const reads = await UserNotification.aggregate([
      { $match: { notificationId: { $in: rows.map((row) => row._id) } } },
      {
        $group: {
          _id: '$notificationId',
          read: { $sum: { $cond: [{ $ifNull: ['$readAt', false] }, 1, 0] } },
        },
      },
    ]);
    const readMap = new Map(reads.map((r: any) => [String(r._id), r.read]));
    return {
      data: rows.map((row) => ({
        id: String(row._id),
        title: row.title,
        message: row.message,
        type: row.type,
        audience: row.audience,
        targeting: row.targeting,
        channels: row.channels,
        status: row.status,
        recipientCount: row.recipientCount,
        readCount: readMap.get(String(row._id)) ?? 0,
        pushSummary: row.pushSummary,
        createdAt: row.createdAt,
      })),
      total,
      hasMore: offset + rows.length < total,
    };
  }

  static async broadcast(input: BroadcastInput) {
    const useRealtime = input.channels?.realtime !== false;
    const usePush = input.channels?.push !== false;
    const notification = await Notification.create({
      title: input.title,
      message: input.message,
      type: input.type,
      audience: input.audience,
      targeting:
        input.audience === 'custom'
          ? { ...input.target }
          : undefined,
      channels: { push: usePush, realtime: useRealtime },
      createdBy: new Types.ObjectId(input.createdBy),
      routeKey: 'notification-detail',
    });

    const userIds = await this.resolveRecipientIds(input.audience, input.target);

    if (userIds.length > 0) {
      await UserNotification.insertMany(
        userIds.map((userId) => ({
          notificationId: notification._id,
          userId,
        })),
        { ordered: false }
      );
    }

    notification.recipientCount = userIds.length;
    await notification.save();

    const socketNotification = {
      id: notification._id.toString(),
      title: notification.title,
      message: notification.message,
      type: notification.type,
      createdAt: notification.createdAt,
      isRead: false,
    };

    if (useRealtime) {
      const socketService = getSocketService();
      if (input.audience === 'custom') {
        for (const userId of userIds) {
          socketService.sendNotificationToUser(
            userId.toString(),
            socketNotification
          );
        }
      } else if (input.audience === 'admins') {
        socketService.broadcastNotification(socketNotification, 'admin');
        socketService.broadcastNotification(socketNotification, 'superadmin');
      } else if (input.audience === 'moderators') {
        socketService.broadcastNotification(socketNotification, 'moderator');
      } else {
        socketService.broadcastNotification(socketNotification);
      }
    }

    if (!usePush) {
      notification.status = 'dispatched';
      await notification.save();
      return notification;
    }

    try {
      const pushSummary = await PushDeliveryService.sendToUsers({
        userIds,
        notificationId: notification._id.toString(),
        title: notification.title,
        message: notification.message,
        type: notification.type,
        routeKey: notification.routeKey,
      });

      notification.pushSummary = pushSummary;
      notification.status =
        pushSummary.failed > 0
          ? pushSummary.succeeded > 0
            ? 'partial'
            : 'failed'
          : 'dispatched';
      await notification.save();
    } catch {
      notification.status = 'failed';
      await notification.save();
      logger.warn(
        '[Notification] Persisted notification push delivery failed',
        {
          notificationId: notification._id.toString(),
        }
      );
    }

    return notification;
  }

  static async getForUser(userId: string, notificationId: string) {
    if (!Types.ObjectId.isValid(notificationId)) return null;

    const userNotification = await UserNotification.findOne({
      userId: new Types.ObjectId(userId),
      notificationId: new Types.ObjectId(notificationId),
    }).lean();
    if (!userNotification) return null;

    const notification = await Notification.findById(notificationId).lean();
    if (!notification) return null;

    return {
      id: notification._id.toString(),
      title: notification.title,
      message: notification.message,
      type: notification.type,
      routeKey: notification.routeKey,
      event: notification.event,
      category: notification.category,
      metadata: notification.metadata,
      isRead: !!userNotification.readAt,
      createdAt: notification.createdAt,
    };
  }

  static async markRead(userId: string, notificationId: string) {
    if (!Types.ObjectId.isValid(notificationId)) return false;

    const result = await UserNotification.updateOne(
      {
        userId: new Types.ObjectId(userId),
        notificationId: new Types.ObjectId(notificationId),
        archivedAt: { $exists: false },
      },
      { $set: { readAt: new Date(), openedAt: new Date() } }
    );
    return result.matchedCount > 0;
  }

  static async markAllRead(userId: string) {
    const result = await UserNotification.updateMany(
      {
        userId: new Types.ObjectId(userId),
        archivedAt: { $exists: false },
        readAt: { $exists: false },
      },
      { $set: { readAt: new Date(), openedAt: new Date() } }
    );
    return { updatedCount: result.modifiedCount };
  }
}
