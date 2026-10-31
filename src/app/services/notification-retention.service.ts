import { Types } from 'mongoose';
import { Notification } from '../models/notification.model';
import { UserNotification } from '../models/user-notification.model';
import { NOTIFICATION_ARCHIVE_AFTER_DAYS } from './notification-archival.service';

export const NOTIFICATION_DELETE_AFTER_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 500;

export interface NotificationRetentionResult {
  deletedUserNotifications: number;
  deletedNotifications: number;
}

export class NotificationRetentionService {
  static async deleteExpired(
    referenceTime: Date = new Date()
  ): Promise<NotificationRetentionResult> {
    const cutoff = new Date(
      referenceTime.getTime() - NOTIFICATION_DELETE_AFTER_DAYS * MS_PER_DAY
    );
    let deletedUserNotifications = 0;
    let deletedNotifications = 0;

    while (true) {
      const rows = await UserNotification.find({
        archivedAt: { $exists: true },
        createdAt: { $lte: cutoff },
      })
        .select('_id notificationId')
        .sort({ createdAt: 1, _id: 1 })
        .limit(RETENTION_BATCH_SIZE)
        .lean();
      if (!rows.length) break;

      const ids = rows.map((row) => row._id);
      const notificationIds = Array.from(
        new Set(rows.map((row) => row.notificationId.toString()))
      ).map((id) => new Types.ObjectId(id));
      const deleted = await UserNotification.deleteMany({ _id: { $in: ids } });
      deletedUserNotifications += deleted.deletedCount;

      deletedNotifications += await this.deleteUnreferencedNotifications(
        notificationIds,
        cutoff
      );
    }

    // Recover old canonical orphans left by a crash after association deletion.
    deletedNotifications += await this.cleanupHistoricalOrphans(cutoff);

    return { deletedUserNotifications, deletedNotifications };
  }

  private static async deleteUnreferencedNotifications(
    notificationIds: Types.ObjectId[],
    cutoff: Date
  ): Promise<number> {
    const referenced = await UserNotification.distinct('notificationId', {
      notificationId: { $in: notificationIds },
    });
    const referencedIds = new Set(referenced.map((id) => id.toString()));
    const orphanIds = notificationIds.filter(
      (id) => !referencedIds.has(id.toString())
    );
    if (!orphanIds.length) return 0;
    const result = await Notification.deleteMany({
      _id: { $in: orphanIds },
      createdAt: { $lte: cutoff },
    });
    return result.deletedCount;
  }

  private static async cleanupHistoricalOrphans(cutoff: Date): Promise<number> {
    let deleted = 0;
    let lastId: Types.ObjectId | undefined;
    while (true) {
      const filter: Record<string, unknown> = {
        createdAt: { $lte: cutoff },
      };
      if (lastId) filter._id = { $gt: lastId };
      const candidates = await Notification.find(filter)
        .select('_id')
        .sort({ _id: 1 })
        .limit(RETENTION_BATCH_SIZE)
        .lean();
      if (!candidates.length) break;
      lastId = candidates[candidates.length - 1]._id;

      const candidateIds = candidates.map((candidate) => candidate._id);
      const referenced = await UserNotification.distinct('notificationId', {
        notificationId: { $in: candidateIds },
      });
      const referencedIds = new Set(referenced.map((id) => id.toString()));
      const orphanIds = candidateIds.filter(
        (id) => !referencedIds.has(id.toString())
      );
      if (!orphanIds.length) continue;
      const result = await Notification.deleteMany({
        _id: { $in: orphanIds },
        createdAt: { $lte: cutoff },
      });
      deleted += result.deletedCount;
    }
    return deleted;
  }
}
