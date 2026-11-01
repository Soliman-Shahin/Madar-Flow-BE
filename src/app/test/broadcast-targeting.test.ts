import { Types } from 'mongoose';
import { User, UserRole } from '../models/user.model';
import { DevicePushToken } from '../models/device-push-token.model';
import { UserNotification } from '../models/user-notification.model';
import { NotificationService } from '../services/notification.service';
import * as socketModule from '../services/socket.service';
import { PushDeliveryService } from '../services/push-delivery.service';
import { PlanSlug } from '../types/plan.types';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeUser(email: string, extra: Record<string, unknown> = {}) {
  return User.create({
    email,
    password: 'Password123!',
    role: UserRole.User,
    plan: PlanSlug.Free,
    ...extra,
  });
}

describe('custom broadcast targeting', () => {
  let free: any;
  let pro: any;
  let expiring: any;
  const sendToUser = jest.fn();

  beforeEach(async () => {
    free = await makeUser(`free-${Date.now()}@t.test`);
    pro = await makeUser(`pro-${Date.now()}@t.test`, { plan: PlanSlug.Pro });
    expiring = await makeUser(`exp-${Date.now()}@t.test`, {
      plan: PlanSlug.Pro,
      planExpiresAt: new Date(Date.now() + 3 * DAY_MS),
    });
    await DevicePushToken.create({
      userId: pro._id,
      deviceId: 'd1',
      token: `tok-${Date.now()}`,
      platform: 'android',
    });
    jest.spyOn(socketModule, 'getSocketService').mockReturnValue({
      broadcastNotification: jest.fn(),
      sendNotificationToUser: sendToUser,
    } as any);
    jest
      .spyOn(PushDeliveryService, 'sendToUsers')
      .mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0, invalidTokens: 0 });
  });

  afterEach(() => jest.restoreAllMocks());

  it('filters by plan and expiry window', async () => {
    const ids = await NotificationService.resolveRecipientIds('custom', {
      plans: ['pro'],
      planExpiringInDays: 7,
    });
    expect(ids.map(String)).toEqual([String(expiring._id)]);
  });

  it('filters by push platform and previews device count', async () => {
    const preview = await NotificationService.previewBroadcast('custom', {
      platforms: ['android'],
    });
    expect(preview.recipientCount).toBe(1);
    expect(preview.pushDevices).toBe(1);
    expect(preview.sample[0].email).toBe(pro.email);
  });

  it('explicit user ids override other filters and only those users receive it', async () => {
    const n = await NotificationService.broadcast({
      title: 't',
      message: 'm',
      type: 'info',
      audience: 'custom',
      target: { userIds: [String(free._id)], plans: ['premium'] },
      channels: { push: false },
      createdBy: String(new Types.ObjectId()),
    });
    expect(n.recipientCount).toBe(1);
    expect(await UserNotification.countDocuments({ notificationId: n._id, userId: free._id })).toBe(1);
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(PushDeliveryService.sendToUsers).not.toHaveBeenCalled();
  });
});
