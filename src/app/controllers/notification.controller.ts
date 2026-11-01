import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/access.middleware';
import { sendError, sendSuccess } from '../shared/helper';
import { NotificationService } from '../services/notification.service';
import { NotificationPreferenceService } from '../services/notification-preference.service';

export const broadcastNotification = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user_id;
    if (!userId) {
      return res
        .status(401)
        .json({ success: false, message: 'Authentication required' });
    }

    const notification = await NotificationService.broadcast({
      ...req.body,
      createdBy: userId,
    });

    return res.status(200).json({
      success: true,
      message: 'Notification broadcasted successfully',
      notification: {
        id: notification._id.toString(),
        title: notification.title,
        message: notification.message,
        type: notification.type,
        audience: notification.audience,
        recipientCount: notification.recipientCount,
        status: notification.status,
        createdAt: notification.createdAt,
        isRead: false,
      },
    });
  } catch {
    return res
      .status(500)
      .json({ success: false, message: 'Failed to broadcast notification' });
  }
};

export const getNotificationForCurrentUser = async (
  req: Request,
  res: Response
) => {
  const userId = (req as AuthenticatedRequest).user_id;
  if (!userId) return sendError(res, 'Authentication required', 401);

  const notificationId = Array.isArray(req.params.notificationId)
    ? req.params.notificationId[0]
    : req.params.notificationId;
  const notification = await NotificationService.getForUser(
    userId,
    notificationId
  );
  if (!notification) return sendError(res, 'Notification not found', 404);

  return sendSuccess(res, notification);
};

export const listNotificationsForCurrentUser = async (
  req: Request,
  res: Response
) => {
  const userId = (req as AuthenticatedRequest).user_id;
  if (!userId) return sendError(res, 'Authentication required', 401);
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return sendError(res, 'Invalid pagination', 400, 'VALIDATION_ERROR');
  }
  return sendSuccess(
    res,
    await NotificationService.listForUser(userId, limit, offset)
  );
};

export const markNotificationRead = async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user_id;
  if (!userId) return sendError(res, 'Authentication required', 401);

  const notificationId = Array.isArray(req.params.notificationId)
    ? req.params.notificationId[0]
    : req.params.notificationId;
  const updated = await NotificationService.markRead(userId, notificationId);
  if (!updated) return sendError(res, 'Notification not found', 404);

  return sendSuccess(res, { id: notificationId, isRead: true });
};

export const markAllNotificationsRead = async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user_id;
  if (!userId) return sendError(res, 'Authentication required', 401);
  return sendSuccess(res, await NotificationService.markAllRead(userId));
};

export const getNotificationPreferences = async (
  req: Request,
  res: Response
) => {
  const userId = (req as AuthenticatedRequest).user_id;
  if (!userId) return sendError(res, 'Authentication required', 401);
  return sendSuccess(res, {
    categories: await NotificationPreferenceService.getForUser(userId),
  });
};

export const updateNotificationPreferences = async (
  req: Request,
  res: Response
) => {
  const userId = (req as AuthenticatedRequest).user_id;
  if (!userId) return sendError(res, 'Authentication required', 401);
  return sendSuccess(res, {
    categories: await NotificationPreferenceService.updateForUser(
      userId,
      req.body
    ),
  });
};

export const previewBroadcast = async (req: Request, res: Response) => {
  try {
    return sendSuccess(
      res,
      await NotificationService.previewBroadcast(
        req.body.audience,
        req.body.target
      )
    );
  } catch {
    return sendError(res, 'Failed to preview audience', 500);
  }
};

export const listBroadcasts = async (req: Request, res: Response) => {
  const limit = Number(req.query.limit || 20);
  const offset = Number(req.query.offset || 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return sendError(res, 'Invalid pagination', 400, 'VALIDATION_ERROR');
  }
  return sendSuccess(res, await NotificationService.listBroadcasts(limit, offset));
};
