import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import { User } from '../models/user.model';
import { Category } from '../models/category.model';
import { Expense } from '../models/expense.model';
import { Subscription } from '../models/subscription.model';
import { EngagementAnalyticsService } from '../services/engagement-analytics.service';
import { SubscriptionAnalyticsService } from '../services/subscription-analytics.service';
import { ExpenseService } from '../services/expense.service';
import { SyncService } from '../services/sync.service';
import { NotificationPreferenceService } from '../services/notification-preference.service';
import adminRoutes from '../routes/admin.route';

const now = new Date('2026-10-29T12:00:00Z');
const engagement = new EngagementAnalyticsService();
const subscriptions = new SubscriptionAnalyticsService();
let sequence = 0;
async function account(createdAt = '2026-10-01T10:00:00Z', extra = {}) {
  const user = await User.create({
    email: `insight-${++sequence}@example.test`,
    password: 'unused-test-password',
    ...extra,
  });
  await User.collection.updateOne(
    { _id: user._id },
    { $set: { createdAt: new Date(createdAt) } }
  );
  return user;
}
async function record(user: any, observedAt: string | null, extra = {}) {
  const category = await Category.create({
    user: user._id,
    title: 'Test',
    icon: 'food',
    color: '#123456',
    type: 'outcome',
  });
  const record = await Expense.create({
    user: user._id,
    category: category._id,
    description: 'Test record',
    amount: 10,
    date: new Date('2001-01-01'),
    ...extra,
  });
  await Expense.collection.updateOne(
    { _id: record._id },
    observedAt
      ? { $set: { _serverRecordedAt: new Date(observedAt) } }
      : { $unset: { _serverRecordedAt: 1 } }
  );
  return record;
}
async function history(user: any, extra = {}) {
  return Subscription.create({
    user: user._id,
    plan: new Types.ObjectId(),
    startDate: new Date('2026-10-23T00:00:00Z'),
    ...extra,
  });
}

describe('Server-observed financial recording contract', () => {
  it('observes a synced CREATE once across retries and keeps pull payloads unchanged', async () => {
    const user = await account();
    await NotificationPreferenceService.updateForUser(String(user._id), {
      sync: { realtime: false, push: false },
    });
    const category = await Category.create({
      user: user._id,
      title: 'Sync',
      icon: 'food',
      color: '#123456',
    });
    const sync = new SyncService();
    const entity = {
      _operationId: 'observe-once',
      _operationType: 'CREATE',
      _id: 'offline_observation',
      _clientId: 'offline_observation',
      _entityType: 'expense',
      description: 'Offline new record',
      category: String(category._id),
      amount: 8,
      date: '2000-01-01',
      createdAt: '2000-01-01',
      _serverRecordedAt: '2000-01-01',
    };
    const before = Date.now();
    const first = await sync.pushData(String(user._id), [entity]);
    expect(first.errors).toHaveLength(0);
    const id = first.idMap.offline_observation;
    const stored = await Expense.collection.findOne({
      _id: new Types.ObjectId(id),
    });
    expect(stored!._serverRecordedAt!.getTime()).toBeGreaterThanOrEqual(before);
    const retry = await sync.pushData(String(user._id), [entity]);
    expect(retry.errors).toHaveLength(0);
    expect(await Expense.countDocuments({ user: user._id })).toBe(1);
    expect(
      (await Expense.collection.findOne({ _id: stored!._id }))!
        ._serverRecordedAt
    ).toEqual(stored!._serverRecordedAt);
    const pull = await sync.pullData(String(user._id), {
      entityType: 'expense',
    });
    expect(pull.entities).toHaveLength(1);
    expect(pull.entities[0]).not.toHaveProperty('_serverRecordedAt');
  });
  it('stamps server time on creation, hides it from payloads and cannot backfill legacy records on edits', async () => {
    const user = await account();
    const legacy = await record(user, null);
    const before = Date.now();
    const created = await Expense.create({
      user: user._id,
      category: legacy.category,
      description: 'New',
      amount: 1,
      date: now,
      createdAt: new Date('2000-01-01'),
      _serverRecordedAt: new Date('2000-01-01'),
    });
    const stored = await Expense.collection.findOne({ _id: created._id });
    expect(stored!._serverRecordedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored!._serverRecordedAt!.getTime()).toBeLessThanOrEqual(
      Date.now()
    );
    expect(created.toJSON()).not.toHaveProperty('_serverRecordedAt');
    expect(created.toObject()).not.toHaveProperty('_serverRecordedAt');
    expect(await Expense.findById(created._id).lean()).not.toHaveProperty(
      '_serverRecordedAt'
    );
    const explicit = await Expense.findById(created._id).select(
      '+_serverRecordedAt'
    );
    explicit!.set('_serverRecordedAt', new Date('1999-01-01'));
    explicit!.description = 'Changed';
    await explicit!.save();
    await Expense.findByIdAndUpdate(created._id, {
      $set: { _serverRecordedAt: now, amount: 2 },
    });
    expect(
      (await Expense.collection.findOne({ _id: created._id }))!
        ._serverRecordedAt
    ).toEqual(stored!._serverRecordedAt);
    legacy.description = 'Legacy edited';
    await legacy.save();
    expect(
      await Expense.collection.findOne({ _id: legacy._id })
    ).not.toHaveProperty('_serverRecordedAt');
    const typed = await ExpenseService.getExpenses(String(user._id), {
      type: 'outcome',
    });
    expect(typed.data).toHaveLength(2);
    expect(typed.data.every((row: any) => !('_serverRecordedAt' in row))).toBe(
      true
    );
  });

  it('uses null for unobserved days, excludes the first partial day and zero-fills covered days', async () => {
    const empty = await engagement.overview(7, now);
    expect(empty.coverage.currentDays).toBe(0);
    expect(empty.metrics.records).toEqual({ current: null, previous: null });
    expect(
      empty.series.every((row) => row.current === null && row.previous === null)
    ).toBe(true);
    const user = await account();
    await record(user, '2026-10-25T15:00:00Z');
    await record(user, null, { createdAt: new Date('2026-10-27') });
    const result = await engagement.overview(7, now);
    expect(result.coverage).toMatchObject({
      firstObservedAt: '2026-10-25T15:00:00.000Z',
      completeFrom: '2026-10-26T00:00:00.000Z',
      observedRecords: 1,
      currentDays: 3,
      previousDays: 0,
    });
    expect(result.metrics.records).toEqual({ current: 0, previous: null });
    expect(
      result.series.find((row) => row.date === '2026-10-25')!.current
    ).toBeNull();
    expect(
      result.series.find((row) => row.date === '2026-10-26')!.current
    ).toMatchObject({ records: 0, users: 0 });
  });

  it('counts distinct retained people by server observation, independently from client creation dates', async () => {
    const a = await account();
    const b = await account(undefined, { isActive: false });
    const staff = await account(undefined, { role: 'admin' });
    const deleted = await account(undefined, { _isDeleted: true });
    await record(a, '2026-10-10T12:00:00Z');
    await record(a, '2026-10-16T00:00:00Z');
    await record(a, '2026-10-22T00:00:00Z');
    await record(a, '2026-10-22T23:59:59.999Z');
    await record(a, '2026-10-23T00:00:00Z');
    await record(b, '2026-10-23T12:00:00Z');
    for (const owner of [staff, deleted, { _id: new Types.ObjectId() }])
      await record(owner, '2026-10-23T12:00:00Z');
    await record(a, '2026-10-23T12:00:00Z', { _isDeleted: true });
    await record(a, '2026-10-29T00:00:00Z');
    const result = await engagement.overview(7, now);
    expect(result.coverage).toMatchObject({ currentDays: 7, previousDays: 7 });
    expect(result.metrics).toEqual({
      recordingUsers: { current: 2, previous: 1 },
      records: { current: 4, previous: 1 },
    });
    expect(result.series[0].current).toMatchObject({ users: 1, records: 2 });
    expect(result.series[1].current).toMatchObject({ users: 2, records: 2 });
  });

  it('measures exact D1/D7/D30 calendar-day returns only after the complete target day', async () => {
    const anchor = await account('2026-08-01');
    await record(anchor, '2026-08-01T12:00:00Z');
    const a = await account('2026-09-28T23:59:59Z');
    const b = await account('2026-09-28T00:00:00Z', { isActive: false });
    await record(a, '2026-09-29T00:00:00Z');
    await record(a, '2026-09-29T23:59:59.999Z');
    await record(a, '2026-10-05T15:00:00Z');
    await record(a, '2026-10-28T23:59:59.999Z');
    await record(b, '2026-09-30T00:00:00Z'); // D2 is not D1.
    await record(b, '2026-09-29T10:00:00Z', { _isDeleted: true });
    await account('2026-09-28', { role: 'moderator' });
    await account('2026-09-28', { _isDeleted: true });
    const recent = await account('2026-10-28T00:01:00Z');
    await record(recent, '2026-10-29T01:00:00Z'); // Today is not complete.
    await account('2026-09-29'); // D30 ends tomorrow.
    const result = await engagement.overview(90, now);
    const cohort = result.cohorts.find((row) => row.date === '2026-09-28')!;
    expect(cohort.size).toBe(2);
    for (const offset of ['d1', 'd7', 'd30'] as const)
      expect(cohort[offset]).toEqual({ eligible: 2, returned: 1, rate: 50 });
    expect(result.cohorts.find((row) => row.date === '2026-10-28')!.d1).toEqual(
      { eligible: 0, returned: 0, rate: null }
    );
    expect(
      result.cohorts.find((row) => row.date === '2026-09-29')!.d30.rate
    ).toBeNull();
    expect(
      result.cohorts.find((row) => row.date === '2026-08-01')
    ).toBeUndefined(); // First partial observation day.
  });
});

describe('Subscription assignment and history contract', () => {
  it('separates expiry, missing expiry and free assignments; includes disabled accounts but excludes staff/deleted', async () => {
    await account(undefined, { plan: 'pro', planExpiresAt: now }); // Inclusive expired boundary.
    await account(undefined, {
      plan: 'premium',
      planExpiresAt: new Date('2026-10-20'),
    });
    await account(undefined, { plan: 'pro', planExpiresAt: null });
    await account(undefined, { plan: 'pro' });
    const soon = await account(undefined, {
      plan: 'premium',
      planExpiresAt: new Date('2026-11-05T12:00:00Z'),
      isActive: false,
    });
    await account(undefined, {
      plan: 'pro',
      planExpiresAt: new Date('2026-11-05T12:00:00.001Z'),
    });
    await account(undefined, {
      plan: 'free',
      planExpiresAt: new Date('2026-10-30'),
    });
    await account(undefined, {
      plan: 'pro',
      role: 'admin',
      planExpiresAt: new Date('2026-10-30'),
    });
    await account(undefined, {
      plan: 'pro',
      _isDeleted: true,
      planExpiresAt: new Date('2026-10-30'),
    });
    const result = await subscriptions.overview(7, 7, 1, now);
    expect(result.metrics).toEqual({
      retainedAccounts: 7,
      paidTierAssignments: 6,
      expiredAssignments: 2,
      unexpiredAssignments: 4,
      noExpiry: 2,
      disabledAssignments: 1,
      missingHistory: 6,
      mismatchedHistory: 0,
      duplicateCurrentHistory: 0,
    });
    expect(result.expiring.total).toBe(1);
    expect(String(result.expiring.rows[0]._id)).toBe(String(soon._id));
    expect(result.expiring.rows[0].isActive).toBe(false);
    expect(Object.keys(result.expiring.rows[0]).sort()).toEqual(
      ['_id', 'title', 'email', 'plan', 'planExpiresAt', 'isActive'].sort()
    );
    expect((await subscriptions.overview(30, 30, 1, now)).expiring.total).toBe(
      2
    );
  });

  it('flags overlap and missing/mismatched history without treating starts as payments or renewals', async () => {
    const a = await account(undefined, { plan: 'pro' });
    const b = await account(undefined, { plan: 'premium' });
    await account(undefined, { plan: 'pro' });
    const free = await account();
    const freePlan = new Types.ObjectId();
    const premiumPlan = new Types.ObjectId();
    await User.db.collection('plans').insertMany([
      { _id: freePlan, slug: 'free' },
      { _id: premiumPlan, slug: 'premium' },
    ]);
    await history(a, { plan: freePlan }); // Current latest history differs.
    await history(a, {
      plan: freePlan,
      startDate: new Date('2026-10-22'),
      status: 'trial',
      trialEndsAt: new Date('2026-11-01'),
    });
    await history(a, {
      startDate: new Date('2026-10-21'),
      status: 'trial',
      trialEndsAt: now,
    }); // Trial ended, not duplicate.
    await history(b, { plan: premiumPlan, status: 'cancelled' });
    await history(b, { plan: freePlan, startDate: new Date('2026-10-24') });
    await history(b, { plan: premiumPlan, startDate: new Date('2026-10-30') }); // A matching future record cannot hide a current mismatch.
    await history(free, {
      plan: freePlan,
      paymentMethod: 'manual',
      adminNote: 'No payment',
    });
    const staff = await account(undefined, { role: 'admin' });
    const deleted = await account(undefined, { _isDeleted: true });
    for (const owner of [staff, deleted, { _id: new Types.ObjectId() }])
      await history(owner);
    const result = await subscriptions.overview(7, 7, 1, now);
    expect(result.metrics).toMatchObject({
      missingHistory: 1,
      mismatchedHistory: 2,
      duplicateCurrentHistory: 1,
    });
    expect(result.history).toHaveLength(7);
    expect(result.history.reduce((sum, row) => sum + row.records, 0)).toBe(5); // Includes manual/free and cancelled starts, excludes future starts.
    expect(
      result.history.find((row) => row.date === '2026-10-25')!.records
    ).toBe(0);
  });

  it('orders and paginates upcoming expirations without duplicates', async () => {
    for (let i = 0; i < 12; i++)
      await account(undefined, {
        plan: 'pro',
        planExpiresAt: new Date('2026-10-30T00:00:00Z'),
      });
    const first = await subscriptions.overview(7, 7, 1, now);
    const second = await subscriptions.overview(7, 7, 2, now);
    expect(first.expiring.total).toBe(12);
    expect(first.expiring.rows).toHaveLength(10);
    expect(second.expiring.rows).toHaveLength(2);
    expect(
      new Set(
        [...first.expiring.rows, ...second.expiring.rows].map((row) =>
          String(row._id)
        )
      ).size
    ).toBe(12);
    expect((await subscriptions.overview(7, 7, 3, now)).expiring.rows).toEqual(
      []
    );
  });
});

describe('Insights HTTP permissions and validation', () => {
  const app = express();
  app.use('/v1/admin', adminRoutes);
  async function token(role: string) {
    const user = await account(undefined, { role });
    await user.createSession();
    return (await User.findById(user._id))!.generateAccessAuthToken();
  }
  it('enforces authenticated Moderator+ for recording and Admin+ for subscription insights', async () => {
    const paths = [
      '/v1/admin/analytics/engagement',
      '/v1/admin/analytics/subscriptions',
    ];
    for (const path of paths)
      expect((await request(app).get(path)).status).toBe(401);
    for (const role of ['user', 'moderator', 'admin', 'superadmin']) {
      const auth = await token(role);
      for (const path of paths) {
        const response = await request(app)
          .get(path + '?days=7')
          .auth(auth, { type: 'bearer' });
        expect(response.status).toBe(
          role === 'user' ||
            (role === 'moderator' && path.endsWith('subscriptions'))
            ? 403
            : 200
        );
        if (response.status === 200)
          expect(response.body.data.period.days).toBe(7);
      }
    }
  });
  it('rejects invalid/unknown/structured inputs and defaults safely', async () => {
    const auth = await token('admin');
    const get = (path: string) =>
      request(app)
        .get('/v1/admin/analytics/' + path)
        .auth(auth, { type: 'bearer' });
    for (const path of [
      'engagement?days=8',
      'engagement?plan=pro',
      'engagement?days=7&days=30',
      'engagement?days[$gt]=1',
      'subscriptions?horizon=90',
      'subscriptions?page=0',
      'subscriptions?page=1.5',
      'subscriptions?page=10000',
      'subscriptions?plan=pro',
    ])
      expect((await get(path)).status).toBe(400);
    expect((await get('subscriptions')).body.data).toMatchObject({
      horizon: 7,
      expiring: { page: 1, total: 0 },
      period: { days: 30 },
    });
  });
});
