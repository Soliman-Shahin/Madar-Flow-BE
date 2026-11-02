import { User } from '../models/user.model';
import { Plan } from '../models/plan.model';
import { Notification } from '../models/notification.model';
import { UserNotification } from '../models/user-notification.model';
import { UserService } from '../services/user.service';
import { planService } from '../services/plan.service';
import { PlanSlug } from '../types/plan.types';

/**
 * The plan's "devices" number limits how many sessions are signed in at once.
 * A new sign-in is never refused: the least recently active OLDER sessions
 * are ended instead, and the new one always survives.
 */
let n = 0;
async function account(plan: string = 'free') {
  return User.create({
    email: `device-limit-${++n}@example.test`,
    password: 'x'.repeat(20),
    plan,
  } as any);
}
const sessionDevices = async (id: any) =>
  ((await User.findById(id).select('sessions').lean())?.sessions || []).map(
    (s: any) => s.device
  );

beforeEach(async () => {
  await planService.seedDefaultPlans();
  await Plan.updateOne({ slug: PlanSlug.Free }, { 'limits.maxDevices': 1 });
  await Plan.updateOne({ slug: PlanSlug.Pro }, { 'limits.maxDevices': 3 });
  await Plan.updateOne({ slug: PlanSlug.Premium }, { 'limits.maxDevices': null });
});

describe('plan device limit', () => {
  it('ends the previous session when a free account (1 device) signs in elsewhere', async () => {
    const user = await account('free');
    const first = await UserService.createAuthenticatedSession(
      user, 'password', 'web', 'Laptop'
    );
    const second = await UserService.createAuthenticatedSession(
      user, 'password', 'android', 'Phone'
    );
    expect(await sessionDevices(user._id)).toEqual(['Phone']);
    // The new device keeps working; the old one can no longer refresh.
    expect(await UserService.rotateRefreshToken(second.refreshToken)).not.toBeNull();
    expect(await UserService.rotateRefreshToken(first.refreshToken)).toBeNull();
  });

  it('tells the user in the inbox which device was signed out and why', async () => {
    const user = await account('free');
    await UserService.createAuthenticatedSession(
      user, 'password', 'web', 'Laptop'
    );
    await UserService.createAuthenticatedSession(
      user, 'password', 'android', 'Phone'
    );
    const note = await Notification.findOne({
      createdBy: user._id,
      event: 'security.session_limit',
    });
    expect(note).toBeTruthy();
    expect(note!.category).toBe('security');
    expect(note!.message).toContain('Laptop');
    expect(note!.message).toContain('1 device');
    expect((note!.metadata as any).endedDevices).toEqual(['Laptop']);
    expect(
      await UserNotification.countDocuments({
        notificationId: note!._id,
        userId: user._id,
      })
    ).toBe(1);
  });

  it('sends no notice when nothing was signed out', async () => {
    const user = await account('premium');
    await UserService.createAuthenticatedSession(user, 'password', 'web', 'A');
    await UserService.createAuthenticatedSession(user, 'password', 'web', 'B');
    expect(
      await Notification.countDocuments({
        createdBy: user._id,
        event: 'security.session_limit',
      })
    ).toBe(0);
  });

  it('keeps the newest N sessions and drops the least recently active', async () => {
    const user = await account('pro');
    for (const device of ['A', 'B', 'C']) {
      await UserService.createAuthenticatedSession(user, 'password', 'web', device);
    }
    // Make B the most stale one.
    await User.updateOne(
      { _id: user._id, 'sessions.device': 'B' },
      { $set: { 'sessions.$.lastAuthenticatedAt': new Date(Date.now() - 3_600_000) } }
    );
    await UserService.createAuthenticatedSession(user, 'password', 'web', 'D');
    const devices = (await sessionDevices(user._id)).sort();
    expect(devices).toEqual(['A', 'C', 'D']);
  });

  it('does not limit a plan with no device cap', async () => {
    const user = await account('premium');
    for (const device of ['A', 'B', 'C', 'D', 'E']) {
      await UserService.createAuthenticatedSession(user, 'password', 'web', device);
    }
    expect(await sessionDevices(user._id)).toHaveLength(5);
  });

  it('never blocks a sign-in when the plan cannot be read', async () => {
    const user = await account('free');
    await Plan.deleteOne({ slug: PlanSlug.Free });
    const tokens = await UserService.createAuthenticatedSession(
      user, 'password', 'web', 'Laptop'
    );
    expect(tokens.accessToken).toBeTruthy();
    expect(await sessionDevices(user._id)).toEqual(['Laptop']);
  });
});
