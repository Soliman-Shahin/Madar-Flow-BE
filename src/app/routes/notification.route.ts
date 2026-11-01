import { Router } from 'express';
import {
  broadcastNotification,
  previewBroadcast,
  listBroadcasts,
  listNotificationsForCurrentUser,
  getNotificationForCurrentUser,
  markNotificationRead,
  markAllNotificationsRead,
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../controllers/notification.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import { requireRole } from '../middleware/admin.middleware';
import { UserRole } from '../models/user.model';
import { validateRequestWithZod } from '../middleware/validation.middleware';
import {
  broadcastNotificationSchema,
  broadcastPreviewSchema,
} from '../validations/notification.validation';
import { sendError } from '../shared/helper';
import { notificationPreferencePatchSchema } from '../validations/notification-preference.validation';

const router = Router();

/**
 * @route  POST /v1/notifications/broadcast
 * @desc   Broadcast a real-time notification to all connected clients
 * @access Admin, SuperAdmin
 */
router.post(
  '/broadcast',
  verifyAccessToken,
  requireRole(UserRole.Admin), // requireRole uses weights, so SuperAdmin is also allowed
  validateRequestWithZod(broadcastNotificationSchema),
  broadcastNotification
);

router.post(
  '/broadcast/preview',
  verifyAccessToken,
  requireRole(UserRole.Admin),
  validateRequestWithZod(broadcastPreviewSchema),
  previewBroadcast
);
router.get(
  '/broadcast/history',
  verifyAccessToken,
  requireRole(UserRole.Admin),
  listBroadcasts
);

router.get('/list', verifyAccessToken, listNotificationsForCurrentUser);
router.patch('/all/read', verifyAccessToken, markAllNotificationsRead);
router.get('/preferences', verifyAccessToken, getNotificationPreferences);
router.patch(
  '/preferences',
  verifyAccessToken,
  validateRequestWithZod(notificationPreferencePatchSchema),
  updateNotificationPreferences
);

router.get(
  '/:notificationId',
  verifyAccessToken,
  (req, res, next) => {
    if (!/^[a-f\d]{24}$/i.test(String(req.params.notificationId))) {
      sendError(res, 'Invalid notification ID', 400, 'VALIDATION_ERROR');
      return;
    }
    next();
  },
  getNotificationForCurrentUser
);

router.patch(
  '/:notificationId/read',
  verifyAccessToken,
  (req, res, next) => {
    if (!/^[a-f\d]{24}$/i.test(String(req.params.notificationId))) {
      sendError(res, 'Invalid notification ID', 400, 'VALIDATION_ERROR');
      return;
    }
    next();
  },
  markNotificationRead
);

export default router;
