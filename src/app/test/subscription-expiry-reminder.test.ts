import { Types } from 'mongoose';
import { createServer } from 'http';
import { Notification } from '../models/notification.model';
import { Plan } from '../models/plan.model';
import { User } from '../models/user.model';
import { NotificationPreferenceService } from '../services/notification-preference.service';
import { NotificationService } from '../services/notification.service';
import { PushDeliveryService } from '../services/push-delivery.service';
import { initializeSocketService } from '../services/socket.service';
import {
  SubscriptionExpiryReminderService,
  SUBSCRIPTION_EXPIRY_REMINDER_WINDOW,
} from '../services/subscription-expiry-reminder.service';
import { PlanSlug } from '../types/plan.types';

const DAY_MS = 24 * 60 * 60 * 1000;

async function plan(slug: PlanSlug = PlanSlug.Pro) {
  return Plan.create({
    name: slug,
    slug,
    description: `${slug} plan`,
    price: 4.99,
    currency: 'USD',
    billingCycle: 'monthly',
    limits: {
      maxCategories: 20,
      maxTransactionsPerMonth: 500,
      maxBackupFiles: 10,
      maxDevices: 3,
    },
    features: [],
    isActive: true,
    isPopular: false,
    order: 1,
  });
}

async function user(email: string, expiry: Date | null, overrides = {}) {
  return User.create({
    email,
    password: 'hashed-password',
    plan: PlanSlug.Pro,
    planExpiresAt: expiry,
    ...overrides,
  });
}

describe('subscription expiry reminder processor', () => {
  const reference = new Date('2026-01-01T00:00:00.000Z');
  let dispatch: jest.SpiedFunction<
    typeof NotificationService.dispatchUserEvent
  >;

  beforeEach(async () => {
    await plan();
    dispatch = jest
      .spyOn(NotificationService, 'dispatchUserEvent')
      .mockResolvedValue({
        created: true,
        channels: ['inbox', 'realtime', 'push'],
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['window start', 7 * DAY_MS, true],
    ['one millisecond before window start', 7 * DAY_MS - 1, false],
    [
      'one millisecond before window end',
      7 * DAY_MS + 60 * 60 * 1000 - 1,
      true,
    ],
    ['window end', 7 * DAY_MS + 60 * 60 * 1000, false],
    ['already expired before reference', -1, false],
  ])(
    'applies the UTC instant half-open boundary for %s',
    async (_label, offset, included) => {
      const expiry = new Date(reference.getTime() + Number(offset));
      await user(`${String(_label).replace(/ /g, '-')}@example.test`, expiry);

      const result =
        await SubscriptionExpiryReminderService.processExpiringSubscriptions(
          reference
        );

      expect(result.eligible).toBe(included ? 1 : 0);
      expect(dispatch).toHaveBeenCalledTimes(included ? 1 : 0);
    }
  );

  it('emits one reminder inside the seven-day window with approved metadata only', async () => {
    const expiry = new Date(reference.getTime() + 7 * DAY_MS + 30 * 60 * 1000);
    const account = await user('inside-window@example.test', expiry);

    const result =
      await SubscriptionExpiryReminderService.processExpiringSubscriptions(
        reference
      );

    expect(result.created).toBe(1);
    expect(dispatch).toHaveBeenCalledWith({
      userId: account._id.toString(),
      event: 'subscription.expiring',
      dedupeKey: `subscription.expiring:${account._id}:${expiry.getTime()}:${SUBSCRIPTION_EXPIRY_REMINDER_WINDOW}`,
      title: 'Subscription expiring soon',
      message: 'Your subscription expires in 7 days.',
      metadata: { expiresAt: expiry.toISOString() },
    });
    expect(Object.keys(dispatch.mock.calls[0][0].metadata || {})).toEqual([
      'expiresAt',
    ]);
    expect(JSON.stringify(dispatch.mock.calls[0][0].metadata)).not.toMatch(
      /userId|subscription|payment|provider|dedupe|token|password|ip|user-agent/i
    );
  });

  it('repeated execution uses the same canonical identity', async () => {
    const expiry = new Date(reference.getTime() + 7 * DAY_MS + 15 * 60 * 1000);
    await user('repeat@example.test', expiry);
    dispatch.mockResolvedValue({ created: false, channels: [] });

    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      reference
    );
    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      reference
    );

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0].dedupeKey).toBe(
      dispatch.mock.calls[1][0].dedupeKey
    );
    expect(dispatch.mock.calls[0][0].metadata?.expiresAt).toBe(
      expiry.toISOString()
    );
  });

  it('keeps consecutive hourly windows contiguous without overlap', async () => {
    const firstWindowEndExpiry = new Date(
      reference.getTime() + 7 * DAY_MS + 60 * 60 * 1000
    );
    await user('next-hour-window@example.test', firstWindowEndExpiry);

    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      reference
    );
    expect(dispatch).not.toHaveBeenCalled();

    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      new Date(reference.getTime() + 60 * 60 * 1000)
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('concurrent processors resolve to one canonical notification through the unique index', async () => {
    const expiry = new Date(reference.getTime() + 7 * DAY_MS + 10 * 60 * 1000);
    const account = await user('concurrent@example.test', expiry);
    jest
      .spyOn(NotificationService, 'dispatchUserEvent')
      .mockImplementation(async (input) => {
        const created = await Notification.create({
          title: input.title,
          message: input.message,
          type: 'warn',
          audience: 'all',
          routeKey: 'notification-detail',
          event: input.event,
          category: 'subscription',
          dedupeKey: input.dedupeKey,
          createdBy: new Types.ObjectId(input.userId),
          metadata: input.metadata,
        })
          .then(() => true)
          .catch((error: any) => {
            if (error?.code === 11000) return false;
            throw error;
          });
        return { created, channels: [] };
      });

    await Promise.all([
      SubscriptionExpiryReminderService.processExpiringSubscriptions(reference),
      SubscriptionExpiryReminderService.processExpiringSubscriptions(reference),
    ]);

    expect(
      await Notification.countDocuments({ event: 'subscription.expiring' })
    ).toBe(1);
    expect((await User.findById(account._id))!.planExpiresAt).toEqual(expiry);
  });

  it.each([
    ['free with null expiry', { plan: PlanSlug.Free, planExpiresAt: null }],
    [
      'free with stale non-null expiry',
      {
        plan: PlanSlug.Free,
        planExpiresAt: new Date(reference.getTime() + 7 * DAY_MS),
      },
    ],
    ['already expired', { planExpiresAt: new Date(reference.getTime() - 1) }],
    ['inactive', { isActive: false }],
    ['deleted', { _isDeleted: true }],
  ])('excludes %s users', async (_label, overrides) => {
    await user(
      `${String(_label).replace(/ /g, '-')}@example.test`,
      new Date(reference.getTime() + 7 * DAY_MS + 1),
      overrides
    );

    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      reference
    );

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips a user whose referenced plan is missing', async () => {
    await user(
      'missing-plan@example.test',
      new Date(reference.getTime() + 7 * DAY_MS + 1),
      { plan: PlanSlug.Premium }
    );

    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      reference
    );

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('resolves the recipient from the selected user and not another account', async () => {
    const expiry = new Date(reference.getTime() + 7 * DAY_MS + 1);
    const first = await user('recipient-a@example.test', expiry);
    await user(
      'recipient-b@example.test',
      new Date(reference.getTime() + 9 * DAY_MS)
    );

    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      reference
    );

    expect(dispatch.mock.calls[0][0].userId).toBe(first._id.toString());
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves optional subscription preference channel resolution', async () => {
    const expiry = new Date(reference.getTime() + 7 * DAY_MS + 1);
    const account = await user('preferences@example.test', expiry);
    const channels = ['inbox'];
    jest
      .spyOn(NotificationService, 'resolveChannelsForUser')
      .mockResolvedValue(channels as any);

    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      reference
    );

    expect(
      await NotificationService.resolveChannelsForUser(
        account._id.toString(),
        'subscription',
        'optional'
      )
    ).toEqual(channels);
    expect(dispatch.mock.calls[0][0].event).toBe('subscription.expiring');
  });

  it('uses a new expiry epoch after renewal but not after a plan-only change', async () => {
    dispatch.mockRestore();
    const httpServer = createServer();
    initializeSocketService(httpServer);
    const push = jest
      .spyOn(PushDeliveryService, 'sendToUsers')
      .mockResolvedValue({
        attempted: 0,
        succeeded: 0,
        failed: 0,
        invalidTokens: 0,
      });

    await plan(PlanSlug.Premium);
    const firstExpiry = new Date(reference.getTime() + 7 * DAY_MS + 1);
    const account = await user('renewal@example.test', firstExpiry);

    try {
      await SubscriptionExpiryReminderService.processExpiringSubscriptions(
        reference
      );

      const renewedExpiry = new Date(reference.getTime() + 8 * DAY_MS + 1);
      await User.updateOne(
        { _id: account._id },
        { $set: { planExpiresAt: renewedExpiry } }
      );
      const renewedReference = new Date(
        renewedExpiry.getTime() - 7 * DAY_MS - 1
      );
      await SubscriptionExpiryReminderService.processExpiringSubscriptions(
        renewedReference
      );

      await User.updateOne(
        { _id: account._id },
        { $set: { plan: PlanSlug.Premium } }
      );
      await SubscriptionExpiryReminderService.processExpiringSubscriptions(
        renewedReference
      );

      const reminders = await Notification.find({
        event: 'subscription.expiring',
      })
        .sort({ createdAt: 1 })
        .lean();
      expect(reminders).toHaveLength(2);
      expect(reminders[0].dedupeKey).not.toBe(reminders[1].dedupeKey);
      expect(reminders[0].metadata?.expiresAt).toBe(firstExpiry.toISOString());
      expect(reminders[1].metadata?.expiresAt).toBe(
        renewedExpiry.toISOString()
      );
    } finally {
      httpServer.close();
      push.mockRestore();
    }
  });

  it('keeps the canonical reminder after a channel failure and does not recreate it', async () => {
    dispatch.mockRestore();
    const httpServer = createServer();
    initializeSocketService(httpServer);
    const push = jest
      .spyOn(PushDeliveryService, 'sendToUsers')
      .mockRejectedValueOnce(new Error('push unavailable'));
    const expiry = new Date(reference.getTime() + 7 * DAY_MS + 1);
    await user('partial-delivery@example.test', expiry);

    try {
      const first =
        await SubscriptionExpiryReminderService.processExpiringSubscriptions(
          reference
        );
      const second =
        await SubscriptionExpiryReminderService.processExpiringSubscriptions(
          reference
        );

      expect(first.failures).toBe(1);
      expect(second.created).toBe(0);
      expect(
        await Notification.countDocuments({ event: 'subscription.expiring' })
      ).toBe(1);
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      httpServer.close();
      push.mockRestore();
    }
  });

  it('uses the explicit reference time and continues after one dispatch failure', async () => {
    const expiry = new Date(reference.getTime() + 7 * DAY_MS + 1);
    const failed = await user('failed@example.test', expiry);
    const succeeded = await user('succeeded@example.test', expiry);
    dispatch
      .mockRejectedValueOnce(new Error('delivery unavailable'))
      .mockResolvedValueOnce({ created: true, channels: ['inbox'] });

    const result =
      await SubscriptionExpiryReminderService.processExpiringSubscriptions(
        reference
      );

    expect(result.failures).toBe(1);
    expect(result.created).toBe(1);
    expect(dispatch.mock.calls.map(([input]) => input.userId)).toEqual([
      failed._id.toString(),
      succeeded._id.toString(),
    ]);
  });

  it('does not depend on Subscription history or mutate the user expiry', async () => {
    const expiry = new Date(reference.getTime() + 7 * DAY_MS + 1);
    const account = await user('no-history@example.test', expiry);

    await SubscriptionExpiryReminderService.processExpiringSubscriptions(
      reference
    );

    expect((await User.findById(account._id))!.planExpiresAt).toEqual(expiry);
  });
});
