import express from 'express';
import request from 'supertest';
import { Plan } from '../models/plan.model';
import { User, UserRole } from '../models/user.model';
import { Subscription } from '../models/subscription.model';
import { BillingEventLog } from '../models/billing-event-log.model';
import planRoutes from '../routes/plan.route';
import { billingService, BillingEvent } from '../services/billing.service';
import { PlanSlug } from '../types/plan.types';
import { enhancedErrorHandler } from '../middleware/error-handler-enhanced';

const app = express();
app.use(express.json());
app.use('/v1/plans', planRoutes);
app.use(enhancedErrorHandler);

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-30T12:00:00Z');

async function seedPlans() {
  for (const [slug, order] of [
    [PlanSlug.Free, 0],
    [PlanSlug.Pro, 1],
    [PlanSlug.Premium, 2],
  ] as const) {
    await Plan.create({
      name: slug,
      slug,
      description: `${slug} plan`,
      price: slug === PlanSlug.Free ? 0 : 4.99,
      currency: 'USD',
      billingCycle: slug === PlanSlug.Free ? 'lifetime' : 'monthly',
      limits: {
        maxCategories: 20,
        maxTransactionsPerMonth: 500,
        maxBackupFiles: 10,
        maxDevices: 3,
      },
      features: [],
      isActive: true,
      isPopular: false,
      order,
    });
  }
}

async function newUser(email: string, role = UserRole.User) {
  const user = await User.create({ email, password: 'unused-in-this-test', role });
  await user.createSession();
  const fresh = (await User.findById(user._id))!;
  return { id: String(user._id), token: await fresh.generateAccessAuthToken() };
}

const event = (over: Partial<BillingEvent> & { userId: string }): BillingEvent => ({
  provider: 'google_play',
  eventId: 'evt-1',
  planSlug: PlanSlug.Pro,
  type: 'purchased',
  occurredAt: T0,
  periodEnd: new Date(T0.getTime() + 30 * DAY),
  ...over,
});

describe('Self-service upgrades are closed by default', () => {
  const OLD = process.env.ALLOW_SELF_SERVICE_UPGRADE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.ALLOW_SELF_SERVICE_UPGRADE;
    else process.env.ALLOW_SELF_SERVICE_UPGRADE = OLD;
  });

  it('refuses to grant a paid plan without payment and changes nothing', async () => {
    delete process.env.ALLOW_SELF_SERVICE_UPGRADE;
    await seedPlans();
    const { id, token } = await newUser('free-rider@example.test');

    const res = await request(app)
      .post('/v1/plans/upgrade')
      .auth(token, { type: 'bearer' })
      .send({ planSlug: 'pro' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UPGRADE_NOT_AVAILABLE');
    const user = await User.findById(id);
    expect(user!.plan).toBe(PlanSlug.Free);
    expect(await Subscription.countDocuments({ user: id })).toBe(0);
  });

  it('stays closed for any value other than the exact string "true"', async () => {
    await seedPlans();
    const { token } = await newUser('flag@example.test');
    for (const v of ['', '1', 'TRUE', 'yes', 'false']) {
      process.env.ALLOW_SELF_SERVICE_UPGRADE = v;
      const res = await request(app)
        .post('/v1/plans/upgrade')
        .auth(token, { type: 'bearer' })
        .send({ planSlug: 'pro' });
      expect(res.status).toBe(403);
    }
  });

  it('works only when explicitly enabled (development / staging)', async () => {
    process.env.ALLOW_SELF_SERVICE_UPGRADE = 'true';
    await seedPlans();
    const { id, token } = await newUser('enabled@example.test');
    const res = await request(app)
      .post('/v1/plans/upgrade')
      .auth(token, { type: 'bearer' })
      .send({ planSlug: 'pro' });
    expect(res.status).toBe(200);
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Pro);
  });

  it('tells the app whether upgrading is available', async () => {
    await seedPlans();
    const { token } = await newUser('me@example.test');
    delete process.env.ALLOW_SELF_SERVICE_UPGRADE;
    const off = await request(app).get('/v1/plans/me').auth(token, { type: 'bearer' });
    expect(off.status).toBe(200);
    expect(off.body.data.upgradeAvailable).toBe(false);
    process.env.ALLOW_SELF_SERVICE_UPGRADE = 'true';
    const on = await request(app).get('/v1/plans/me').auth(token, { type: 'bearer' });
    expect(on.body.data.upgradeAvailable).toBe(true);
  });
});

describe('BillingService (verified provider events -> plan state)', () => {
  beforeEach(seedPlans);

  it('a purchase sets the plan and paid-until date and records one active subscription', async () => {
    const { id } = await newUser('buyer@example.test');
    const res = await billingService.applyEvent(event({ userId: id }), T0);
    expect(res).toEqual({ applied: true });

    const user = await User.findById(id);
    expect(user!.plan).toBe(PlanSlug.Pro);
    expect(user!.planExpiresAt!.getTime()).toBe(T0.getTime() + 30 * DAY);
    const subs = await Subscription.find({ user: id });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'active', paymentMethod: 'google_play', paymentRef: 'evt-1' });
  });

  it('replays are harmless (same event twice applies once)', async () => {
    const { id } = await newUser('replay@example.test');
    await billingService.applyEvent(event({ userId: id }), T0);
    const again = await billingService.applyEvent(event({ userId: id }), T0);
    expect(again).toEqual({ applied: false, reason: 'duplicate' });
    expect(await Subscription.countDocuments({ user: id })).toBe(1);
    expect(await BillingEventLog.countDocuments({ user: id })).toBe(1);
  });

  it('a renewal extends the same subscription instead of stacking new ones', async () => {
    const { id } = await newUser('renew@example.test');
    await billingService.applyEvent(event({ userId: id }), T0);
    const later = new Date(T0.getTime() + 30 * DAY);
    await billingService.applyEvent(
      event({
        userId: id,
        eventId: 'evt-2',
        type: 'renewed',
        occurredAt: later,
        periodEnd: new Date(later.getTime() + 30 * DAY),
      }),
      later
    );
    const subs = await Subscription.find({ user: id });
    expect(subs).toHaveLength(1);
    expect(subs[0].endDate!.getTime()).toBe(later.getTime() + 30 * DAY);
    expect((await User.findById(id))!.planExpiresAt!.getTime()).toBe(later.getTime() + 30 * DAY);
  });

  it('cancelling keeps access until the paid period ends, then expiry downgrades', async () => {
    const { id } = await newUser('cancel@example.test');
    await billingService.applyEvent(event({ userId: id }), T0);

    const t1 = new Date(T0.getTime() + 5 * DAY);
    await billingService.applyEvent(event({ userId: id, eventId: 'evt-c', type: 'cancelled', occurredAt: t1, periodEnd: null }), t1);
    let user = await User.findById(id);
    expect(user!.plan).toBe(PlanSlug.Pro); // still paid up
    expect((await Subscription.findOne({ user: id }))!.status).toBe('cancelled');

    const t2 = new Date(T0.getTime() + 31 * DAY);
    const res = await billingService.applyEvent(event({ userId: id, eventId: 'evt-e', type: 'expired', occurredAt: t2, periodEnd: null }), t2);
    expect(res).toEqual({ applied: true });
    user = await User.findById(id);
    expect(user!.plan).toBe(PlanSlug.Free);
    expect(user!.planExpiresAt).toBeNull();
    expect((await Subscription.findOne({ user: id }))!.status).toBe('expired');
  });

  it('a refund ends access immediately', async () => {
    const { id } = await newUser('refund@example.test');
    await billingService.applyEvent(event({ userId: id }), T0);
    const t1 = new Date(T0.getTime() + DAY);
    await billingService.applyEvent(event({ userId: id, eventId: 'evt-r', type: 'refunded', occurredAt: t1, periodEnd: null }), t1);
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);
    expect((await Subscription.findOne({ user: id }))!.status).toBe('cancelled');
  });

  it('ignores an older event that arrives after a newer one', async () => {
    const { id } = await newUser('order@example.test');
    const t2 = new Date(T0.getTime() + 31 * DAY);
    await billingService.applyEvent(event({ userId: id }), T0);
    await billingService.applyEvent(event({ userId: id, eventId: 'evt-e', type: 'expired', occurredAt: t2, periodEnd: null }), t2);
    // A delayed "renewed" from before the expiry must not resurrect the plan.
    const stale = await billingService.applyEvent(
      event({ userId: id, eventId: 'evt-old', type: 'renewed', occurredAt: new Date(T0.getTime() + 10 * DAY), periodEnd: new Date(t2.getTime() + 30 * DAY) }),
      t2
    );
    expect(stale).toEqual({ applied: false, reason: 'stale' });
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);
  });

  it('never downgrades a plan that an admin granted (not managed by the provider)', async () => {
    const { id } = await newUser('manual@example.test');
    await User.updateOne({ _id: id }, { $set: { plan: PlanSlug.Pro } });
    const res = await billingService.applyEvent(event({ userId: id, eventId: 'evt-x', type: 'expired', periodEnd: null }), T0);
    expect(res).toEqual({ applied: false, reason: 'not_managed' });
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Pro);
  });

  it('rejects purchases that make no sense', async () => {
    const { id } = await newUser('bad@example.test');
    await expect(
      billingService.applyEvent(event({ userId: id, planSlug: PlanSlug.Free }), T0)
    ).rejects.toThrow();
    await expect(
      billingService.applyEvent(event({ userId: id, eventId: 'p', periodEnd: new Date(T0.getTime() - DAY) }), T0)
    ).rejects.toThrow();
    await expect(
      billingService.applyEvent(event({ userId: id, eventId: 'q', periodEnd: null }), T0)
    ).rejects.toThrow();
    expect(await BillingEventLog.countDocuments()).toBe(0);
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);
  });

  it('does not leave an event recorded when applying it fails (so a retry can succeed)', async () => {
    const { id } = await newUser('retry@example.test');
    await Plan.deleteOne({ slug: PlanSlug.Pro }); // makes the grant fail
    await expect(billingService.applyEvent(event({ userId: id }), T0)).rejects.toThrow();
    expect(await BillingEventLog.countDocuments()).toBe(0);
    await seedPlansOnly(PlanSlug.Pro);
    expect(await billingService.applyEvent(event({ userId: id }), T0)).toEqual({ applied: true });
  });
});

async function seedPlansOnly(slug: PlanSlug) {
  await Plan.create({
    name: slug,
    slug,
    description: `${slug} plan`,
    price: 4.99,
    currency: 'USD',
    billingCycle: 'monthly',
    limits: { maxCategories: 20, maxTransactionsPerMonth: 500, maxBackupFiles: 10, maxDevices: 3 },
    features: [],
    isActive: true,
    isPopular: false,
    order: 1,
  });
}
