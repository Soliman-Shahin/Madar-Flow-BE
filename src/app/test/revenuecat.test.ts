import express from 'express';
import request from 'supertest';
import { Plan } from '../models/plan.model';
import { User, UserRole } from '../models/user.model';
import { Subscription } from '../models/subscription.model';
import { BillingEventLog } from '../models/billing-event-log.model';
import planRoutes from '../routes/plan.route';
import { billingRoutes, billingAdminRoutes } from '../routes/billing.route';
import { revenueCatService } from '../services/revenuecat.service';
import { PlanSlug } from '../types/plan.types';
import { enhancedErrorHandler } from '../middleware/error-handler-enhanced';

const app = express();
app.use(express.json());
app.use('/v1/plans', planRoutes);
app.use('/v1/billing', billingRoutes);
app.use('/v1/admin/billing', billingAdminRoutes);
app.use(enhancedErrorHandler);

const DAY = 24 * 60 * 60 * 1000;
const AUTH = 'Bearer test-webhook-secret';

const ENV_KEYS = [
  'REVENUECAT_WEBHOOK_AUTH',
  'REVENUECAT_SECRET_API_KEY',
  'REVENUECAT_ANDROID_PUBLIC_KEY',
  'REVENUECAT_ACCEPT_SANDBOX',
  'BILLING_TEST_MODE',
  'NODE_ENV',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.REVENUECAT_WEBHOOK_AUTH = AUTH;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function seedPlans() {
  const defs: [PlanSlug, string[], number][] = [
    [PlanSlug.Free, [], 0],
    [PlanSlug.Pro, ['pro_monthly', 'pro_yearly'], 1],
    [PlanSlug.Premium, ['premium_monthly'], 2],
  ];
  for (const [slug, productIds, order] of defs) {
    await Plan.create({
      name: slug,
      slug,
      description: `${slug} plan`,
      price: 0,
      currency: 'USD',
      productIds,
      isActive: true,
      order,
    });
  }
}

async function newUser(email: string, role = UserRole.User) {
  const user = await User.create({
    email,
    password: 'unused-in-this-test',
    role,
  });
  await user.createSession();
  const fresh = (await User.findById(user._id))!;
  return { id: String(user._id), token: await fresh.generateAccessAuthToken() };
}

let seq = 0;
const rc = (userId: string, over: Record<string, unknown> = {}) => ({
  api_version: '1.0',
  event: {
    id: `evt-${++seq}`,
    type: 'INITIAL_PURCHASE',
    app_user_id: userId,
    product_id: 'pro_monthly:monthly',
    environment: 'PRODUCTION',
    event_timestamp_ms: Date.now(),
    expiration_at_ms: Date.now() + 30 * DAY,
    ...over,
  },
});

const post = (body: unknown, auth: string | null = AUTH) => {
  const r = request(app).post('/v1/billing/revenuecat/webhook');
  return (auth === null ? r : r.set('Authorization', auth)).send(
    body as object
  );
};

describe('RevenueCat webhook: authentication', () => {
  it('is closed when no secret is configured', async () => {
    delete process.env.REVENUECAT_WEBHOOK_AUTH;
    await seedPlans();
    const { id } = await newUser('a@example.test');
    const res = await post(rc(id));
    expect(res.status).toBe(503);
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);
  });

  it('rejects a missing or wrong Authorization header and changes nothing', async () => {
    await seedPlans();
    const { id } = await newUser('b@example.test');
    for (const auth of [
      null,
      'Bearer wrong',
      'test-webhook-secret',
      AUTH + 'x',
    ]) {
      expect((await post(rc(id), auth)).status).toBe(401);
    }
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);
    expect(await BillingEventLog.countDocuments()).toBe(0);
  });
});

describe('RevenueCat webhook: lifecycle', () => {
  it('purchase grants the plan mapped to the store product', async () => {
    await seedPlans();
    const { id } = await newUser('buy@example.test');
    const res = await post(rc(id));
    expect(res.status).toBe(200);
    const user = (await User.findById(id))!;
    expect(user.plan).toBe(PlanSlug.Pro);
    expect(user.planExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(
      await Subscription.countDocuments({ user: id, status: 'active' })
    ).toBe(1);
  });

  it('maps the yearly product and a product without base-plan suffix', async () => {
    await seedPlans();
    const a = await newUser('yearly@example.test');
    await post(rc(a.id, { product_id: 'pro_yearly' }));
    expect((await User.findById(a.id))!.plan).toBe(PlanSlug.Pro);
    const b = await newUser('prem@example.test');
    await post(rc(b.id, { product_id: 'premium_monthly:base' }));
    expect((await User.findById(b.id))!.plan).toBe(PlanSlug.Premium);
  });

  it('a replayed delivery is applied once', async () => {
    await seedPlans();
    const { id } = await newUser('replay@example.test');
    const body = rc(id);
    await post(body);
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(again.body.data.result.reason).toBe('duplicate');
    expect(await Subscription.countDocuments({ user: id })).toBe(1);
  });

  it('cancel keeps access, expiration and refund end it', async () => {
    await seedPlans();
    const { id } = await newUser('life@example.test');
    const t = Date.now();
    await post(rc(id, { event_timestamp_ms: t }));

    await post(
      rc(id, {
        type: 'CANCELLATION',
        cancel_reason: 'UNSUBSCRIBE',
        event_timestamp_ms: t + 1000,
      })
    );
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Pro);

    await post(rc(id, { type: 'EXPIRATION', event_timestamp_ms: t + 2000 }));
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);

    const r = await newUser('refund@example.test');
    await post(rc(r.id, { event_timestamp_ms: t }));
    await post(
      rc(r.id, {
        type: 'CANCELLATION',
        cancel_reason: 'CUSTOMER_SUPPORT',
        event_timestamp_ms: t + 1000,
      })
    );
    expect((await User.findById(r.id))!.plan).toBe(PlanSlug.Free);
  });

  it('renewal extends and a product change switches plan', async () => {
    await seedPlans();
    const { id } = await newUser('renew@example.test');
    const t = Date.now();
    await post(rc(id, { event_timestamp_ms: t }));
    const newEnd = t + 60 * DAY;
    await post(
      rc(id, {
        type: 'RENEWAL',
        expiration_at_ms: newEnd,
        event_timestamp_ms: t + 1000,
      })
    );
    expect((await User.findById(id))!.planExpiresAt!.getTime()).toBe(newEnd);

    await post(
      rc(id, {
        type: 'PRODUCT_CHANGE',
        product_id: 'pro_monthly',
        new_product_id: 'premium_monthly',
        event_timestamp_ms: t + 2000,
      })
    );
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Premium);
  });

  it('acknowledges but ignores noise: test pings, unknown product/user, anonymous ids, past renewals', async () => {
    await seedPlans();
    const { id } = await newUser('noise@example.test');
    const cases = [
      rc(id, { type: 'TEST' }),
      rc(id, { type: 'BILLING_ISSUE' }),
      rc(id, { product_id: 'something_else' }),
      rc('64b0f0f0f0f0f0f0f0f0f0f0'),
      rc('$RCAnonymousID:abc'),
      rc(id, { type: 'RENEWAL', expiration_at_ms: Date.now() - DAY }),
      { event: {} },
    ];
    for (const body of cases) expect((await post(body)).status).toBe(200);
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);
    expect(await BillingEventLog.countDocuments()).toBe(0);
  });

  it('never touches a plan an admin granted', async () => {
    await seedPlans();
    const { id } = await newUser('admin-granted@example.test');
    await User.updateOne(
      { _id: id },
      { plan: PlanSlug.Premium, planExpiresAt: new Date(Date.now() + 90 * DAY) }
    );
    await post(rc(id, { type: 'EXPIRATION', product_id: 'pro_monthly' }));
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Premium);
  });
});

describe('Sandbox purchases', () => {
  it('are rejected in production unless explicitly accepted', async () => {
    await seedPlans();
    const { id } = await newUser('sandbox@example.test');
    process.env.NODE_ENV = 'production';
    delete process.env.REVENUECAT_ACCEPT_SANDBOX;
    await post(rc(id, { environment: 'SANDBOX' }));
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);

    process.env.REVENUECAT_ACCEPT_SANDBOX = 'true';
    await post(rc(id, { environment: 'SANDBOX' }));
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Pro);
  });

  it('real production purchases are always accepted', async () => {
    await seedPlans();
    const { id } = await newUser('prod@example.test');
    process.env.NODE_ENV = 'production';
    await post(rc(id));
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Pro);
  });
});

describe('Restore purchases (server sync)', () => {
  const reply = (subscriptions: Record<string, unknown>) =>
    (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ subscriber: { subscriptions } }),
      }) as Response) as unknown as typeof fetch;

  it('grants the best active plan found at RevenueCat', async () => {
    process.env.REVENUECAT_SECRET_API_KEY = 'sk_test_dummy';
    await seedPlans();
    const { id } = await newUser('sync@example.test');
    const future = new Date(Date.now() + 20 * DAY).toISOString();
    const result = await revenueCatService.syncUser(
      id,
      reply({
        'pro_monthly:monthly': {
          expires_date: future,
          purchase_date: new Date().toISOString(),
        },
        premium_monthly: {
          expires_date: future,
          purchase_date: new Date().toISOString(),
        },
        old_one: { expires_date: new Date(Date.now() - DAY).toISOString() },
      })
    );
    expect(result).toEqual({ plan: PlanSlug.Premium, applied: true });
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Premium);
  });

  it('ignores refunded and expired subscriptions and never downgrades', async () => {
    process.env.REVENUECAT_SECRET_API_KEY = 'sk_test_dummy';
    await seedPlans();
    const { id } = await newUser('sync2@example.test');
    const future = new Date(Date.now() + 20 * DAY).toISOString();
    const result = await revenueCatService.syncUser(
      id,
      reply({
        pro_monthly: {
          expires_date: future,
          refunded_at: new Date().toISOString(),
        },
      })
    );
    expect(result).toEqual({ plan: null, applied: false });
    expect((await User.findById(id))!.plan).toBe(PlanSlug.Free);
  });

  it('endpoint is unavailable without a secret key and requires sign-in', async () => {
    await seedPlans();
    const { token } = await newUser('sync3@example.test');
    delete process.env.REVENUECAT_SECRET_API_KEY;
    expect((await request(app).post('/v1/billing/sync')).status).toBe(401);
    const res = await request(app)
      .post('/v1/billing/sync')
      .auth(token, { type: 'bearer' });
    expect(res.status).toBe(503);
  });
});

describe('Plan catalog and availability', () => {
  it('/plans/me reports purchases available only when fully configured, and exposes the public key', async () => {
    await seedPlans();
    const { token } = await newUser('me@example.test');
    const get = () =>
      request(app).get('/v1/plans/me').auth(token, { type: 'bearer' });

    let res = await get();
    expect(res.body.data.upgradeAvailable).toBe(false);
    expect(res.body.data.billing).toBeNull();

    process.env.REVENUECAT_ANDROID_PUBLIC_KEY = 'goog_public_dummy';
    res = await get();
    expect(res.body.data.upgradeAvailable).toBe(true);
    expect(res.body.data.billing).toEqual({
      provider: 'revenuecat',
      androidPublicKey: 'goog_public_dummy',
    });
    expect(JSON.stringify(res.body)).not.toContain('test-webhook-secret');
  });

  it('public plan list carries product ids and per-currency prices', async () => {
    await seedPlans();
    await Plan.updateOne(
      { slug: PlanSlug.Pro },
      {
        prices: [
          { currency: 'usd', amount: 1 },
          { currency: 'EGP', amount: 50 },
        ],
      }
    );
    const res = await request(app).get('/v1/plans');
    const pro = res.body.data.find((p: { slug: string }) => p.slug === 'pro');
    expect(pro.productIds).toEqual(['pro_monthly', 'pro_yearly']);
    expect(pro.prices).toEqual([
      { currency: 'USD', amount: 1 },
      { currency: 'EGP', amount: 50 },
    ]);
  });
});

describe('Admin test events (rehearsal without a store)', () => {
  it('is off by default, super admin only, and never in production', async () => {
    await seedPlans();
    const admin = await newUser('super@example.test', UserRole.SuperAdmin);
    const user = await newUser('plain@example.test');
    const send = (token: string) =>
      request(app)
        .post('/v1/admin/billing/test-event')
        .auth(token, { type: 'bearer' })
        .send({ userId: user.id, planSlug: 'pro', type: 'purchased' });

    expect((await send(admin.token)).status).toBe(403); // flag off

    process.env.BILLING_TEST_MODE = 'true';
    expect((await send(user.token)).status).toBe(403); // not a super admin
    expect((await send(admin.token)).status).toBe(200);
    expect((await User.findById(user.id))!.plan).toBe(PlanSlug.Pro);

    process.env.NODE_ENV = 'production';
    expect((await send(admin.token)).status).toBe(403);
  });
});
