import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import { User } from '../models/user.model';
import { Expense } from '../models/expense.model';
import { Category } from '../models/category.model';
import {
  SyncConflict,
  ConflictResolution,
  SyncOperation,
} from '../models/sync.model';
import {
  AdminAnalyticsService,
  analyticsPeriod,
  compareMetric,
} from '../services/admin-analytics.service';
import adminRoutes from '../routes/admin.route';
import { planService } from '../services/plan.service';
import { PlanSlug } from '../types/plan.types';

const service = new AdminAnalyticsService();
const now = new Date('2026-10-27T12:34:00Z');
const current = new Date('2026-10-25T11:00:00Z');
const prior = new Date('2026-10-18T11:00:00Z');

async function consumer(email: string, createdAt = current, extra = {}) {
  const user = await User.create({
    email,
    password: 'unused-in-this-test',
    ...extra,
  });
  await User.collection.updateOne({ _id: user._id }, { $set: { createdAt } });
  return user;
}
async function expense(user: any, createdAt = current, extra = {}) {
  const category = await Category.create({
    user: user._id,
    title: 'Food',
    icon: 'food',
    color: '#123456',
  });
  const record = await Expense.create({
    user: user._id,
    category: category._id,
    description: 'Test record',
    amount: 12,
    date: new Date('2020-01-01'),
    ...extra,
  });
  await Expense.collection.updateOne(
    { _id: record._id },
    { $set: { createdAt } }
  );
  return record;
}

describe('Admin analytics data contract', () => {
  it('uses complete UTC days and equal previous windows, independent of local DST', () => {
    expect(analyticsPeriod(7, now)).toEqual({
      start: new Date('2026-10-20T00:00:00Z'),
      end: new Date('2026-10-27T00:00:00Z'),
      previousStart: new Date('2026-10-13T00:00:00Z'),
    });
    expect(compareMetric(3, 0).changePercent).toBeNull();
    expect(compareMetric(0, 0).changePercent).toBeNull();
    expect(compareMetric(6, 4).changePercent).toBe(50);
  });

  it('zero fills sparse periods without inventing comparisons or status', async () => {
    for (const days of [7, 30, 90] as const) {
      const result = await service.overview(days, now);
      expect(result.series).toHaveLength(days);
      expect(result.metrics.expenses).toEqual({
        current: 0,
        previous: 0,
        changePercent: null,
      });
      expect(result.categories).toEqual([]);
      expect(result.operations.openConflicts.count).toBe(0);
      expect(result.series.every((row) => row.current.expenses === 0)).toBe(
        true
      );
    }
  });

  it('counts distinct retained consumers by stored creation time; excludes staff, deleted and orphaned records', async () => {
    const a = await consumer('a@example.test');
    const b = await consumer('b@example.test', prior, { isActive: false });
    const staff = await consumer('staff@example.test', current, {
      role: 'admin',
    });
    const deleted = await consumer('deleted@example.test', current, {
      _isDeleted: true,
    });
    await expense(a);
    await expense(a);
    await expense(a, prior);
    await expense(b);
    await expense(a, current, { _isDeleted: true });
    await expense(staff);
    await expense(deleted);
    await expense({ _id: new Types.ObjectId() });
    await expense(a, new Date('2026-10-27T00:00:00Z'));
    const result = await service.overview(7, now);
    expect(result.totalUsers).toBe(2);
    expect(result.metrics.newUsers).toEqual({
      current: 1,
      previous: 1,
      changePercent: 0,
    });
    expect(result.metrics.expenses).toEqual({
      current: 3,
      previous: 1,
      changePercent: 200,
    });
    expect(result.metrics.recordingUsers).toEqual({
      current: 2,
      previous: 1,
      changePercent: 100,
    });
    expect(result.categories).toEqual([
      { title: 'Food', count: 3, share: 100 },
    ]);
    const rows = await service.records('expenses', 7, '2026-10-25', 1, now);
    expect(rows.total).toBe(
      result.series.find((row) => row.date === '2026-10-25')!.current.expenses
    );
    expect(rows.rows).toHaveLength(3);
    const users = await service.records('recordingUsers', 7, undefined, 1, now);
    expect(users.total).toBe(2);
    expect(users.rows.map((row: any) => row.recordCount).sort()).toEqual([
      1, 2,
    ]);
  });

  it('deduplicates recording users across days and paginates records without returning account credentials', async () => {
    const a = await consumer('pagination@example.test');
    for (let index = 0; index < 12; index++)
      await expense(
        a,
        new Date(`2026-10-${index % 2 ? '24' : '25'}T11:00:00Z`)
      );
    const result = await service.overview(7, now);
    expect(result.metrics.recordingUsers.current).toBe(1);
    expect(
      result.series.reduce((sum, row) => sum + row.current.recordingUsers, 0)
    ).toBe(2);
    const first = await service.records('expenses', 7, undefined, 1, now);
    const second = await service.records('expenses', 7, undefined, 2, now);
    expect(first.total).toBe(12);
    expect(first.rows).toHaveLength(10);
    expect(second.rows).toHaveLength(2);
    expect(
      new Set([...first.rows, ...second.rows].map((row) => row._id.toString()))
        .size
    ).toBe(12);
    const accounts = await service.records('newUsers', 7, undefined, 1, now);
    expect(accounts.rows[0].password).toBeUndefined();
    expect(accounts.rows[0].sessions).toBeUndefined();
  });

  it('counts all unresolved conflicts, never resolution history or a four-item sample', async () => {
    const a = await consumer('sync@example.test');
    for (let i = 0; i < 6; i++)
      await SyncConflict.create({
        dedupeKey: `open-${i}`,
        user: a._id,
        entityId: `${i}`,
        entityType: 'expense',
        localData: {},
        serverData: {},
        detectedAt: prior,
      });
    await SyncConflict.create({
      dedupeKey: 'resolved',
      user: a._id,
      entityId: 'done',
      entityType: 'expense',
      localData: {},
      serverData: {},
      resolvedAt: current,
    });
    await ConflictResolution.create({
      user: a._id,
      entityId: 'old',
      entityType: 'expense',
      localData: {},
      serverData: {},
      resolution: 'server',
    });
    await SyncOperation.create({
      id: 'error',
      user: a._id,
      type: 'CREATE',
      entityType: 'expense',
      entityId: '1',
      data: {},
      status: 'error',
    });
    const result = await service.overview(7, now);
    expect(result.operations.openConflicts).toEqual({
      count: 6,
      affectedUsers: 1,
      oldestAt: prior,
    });
    expect(result.operations.failedOperations).toEqual({
      count: 1,
      affectedUsers: 1,
    });
  });

  it('rejects impossible, out-of-period and current-day drill-down dates', async () => {
    for (const day of ['2026-10-27', '2026-10-19', '2026-02-30', 'invalid']) {
      await expect(service.records('expenses', 7, day, 1, now)).rejects.toThrow(
        RangeError
      );
    }
  });

  it('keeps drill-downs anchored to the overview across UTC midnight', async () => {
    const a = await consumer(
      'midnight@example.test',
      new Date('2026-10-20T00:00:00Z')
    );
    await expense(a, new Date('2026-10-20T00:00:00Z'));
    const result = await service.overview(7, now);
    const rows = await service.records(
      'expenses',
      7,
      undefined,
      1,
      new Date('2026-10-28T01:00:00Z'),
      '2026-10-27'
    );
    expect(rows.start).toBe(result.period.start);
    expect(rows.endExclusive).toBe(result.period.endExclusive);
    expect(rows.total).toBe(result.metrics.expenses.current);
    await expect(
      service.records('expenses', 7, undefined, 1, now, '2026-10-28')
    ).rejects.toThrow(RangeError);
    await expect(
      service.records('expenses', 7, undefined, 1, now, '2026-02-30')
    ).rejects.toThrow(RangeError);
  });

  it('keeps assigned-plan counts on the same retained-consumer scope', async () => {
    await consumer('free@example.test');
    await consumer('pro@example.test', current, {
      plan: 'pro',
      isActive: false,
    });
    await consumer('staff-plan@example.test', current, { role: 'admin' });
    await consumer('deleted-plan@example.test', current, { _isDeleted: true });
    const plans = await planService.getPlanDistribution();
    expect(plans.reduce((sum, plan) => sum + plan.count, 0)).toBe(2);
    expect(plans.find((plan) => plan.planSlug === 'pro')?.count).toBe(1);
  });
});

describe('Analytics segment scopes', () => {
  it('reconciles plan/type metrics and drill-downs while keeping live operations global', async () => {
    const free = await consumer('free-segment@example.test');
    const pro = await consumer('pro-segment@example.test', current, {
      plan: PlanSlug.Pro,
    });
    const olderPro = await consumer('older-pro@example.test', prior, {
      plan: PlanSlug.Pro,
    });
    await expense(free);
    const firstIncome = await expense(pro);
    const secondIncome = await expense(pro);
    const previousIncome = await expense(pro, prior);
    await Category.updateMany(
      {
        _id: {
          $in: [
            firstIncome.category,
            secondIncome.category,
            previousIncome.category,
          ],
        },
      },
      { $set: { type: 'income' } }
    );
    await expense(olderPro);
    await expense(olderPro, current, { category: new Types.ObjectId() });
    await SyncOperation.create({
      id: 'global-error',
      user: free._id,
      type: 'CREATE',
      entityType: 'expense',
      entityId: '1',
      data: {},
      status: 'error',
    });
    const filters = { plan: PlanSlug.Pro, type: 'income' as const };
    const data = await service.overview(7, now, filters);
    expect(data.filters).toEqual(filters);
    expect(data.metrics.expenses).toEqual({
      current: 2,
      previous: 1,
      changePercent: 100,
    });
    expect(data.metrics.recordingUsers.current).toBe(1);
    expect(data.metrics.newUsers.current).toBe(1);
    expect(data.totalUsers).toBe(2);
    expect(data.categories).toEqual([{ title: 'Food', count: 2, share: 100 }]);
    expect(data.operations.failedOperations.count).toBe(1);
    for (const kind of ['expenses', 'recordingUsers', 'newUsers'] as const) {
      const rows = await service.records(
        kind,
        7,
        undefined,
        1,
        now,
        '2026-10-27',
        filters
      );
      expect(rows.total).toBe(data.metrics[kind].current);
      expect(rows.rows.every((row: any) => row.subtitle === pro.email)).toBe(
        true
      );
    }
    const outcome = await service.overview(7, now, {
      plan: PlanSlug.Pro,
      type: 'outcome',
    });
    expect(outcome.metrics.expenses.current).toBe(1);
    expect(outcome.metrics.newUsers.current).toBe(1);
    expect(
      (await service.overview(7, now, { plan: PlanSlug.Pro })).metrics.expenses
        .current
    ).toBe(4);
  });

  it('returns truthful empty segments with zero-filled time series', async () => {
    await expense(await consumer('only-free@example.test'));
    const data = await service.overview(7, now, {
      plan: PlanSlug.Premium,
      type: 'income',
    });
    expect(data.totalUsers).toBe(0);
    expect(data.metrics.expenses.current).toBe(0);
    expect(data.series.every((row) => row.current.expenses === 0)).toBe(true);
    expect(data.categories).toEqual([]);
  });
});

describe('Admin analytics HTTP boundary', () => {
  const app = express();
  app.use('/v1/admin', adminRoutes);
  it('requires an authenticated staff session', async () => {
    expect((await request(app).get('/v1/admin/analytics')).status).toBe(401);
    const user = await consumer('regular@example.test');
    await user.createSession();
    const token = await (await User.findById(
      user._id
    ))!.generateAccessAuthToken();
    expect(
      (
        await request(app)
          .get('/v1/admin/analytics')
          .auth(token, { type: 'bearer' })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/v1/admin/analytics/records?kind=newUsers')
          .auth(token, { type: 'bearer' })
      ).status
    ).toBe(403);
  });
  it('validates filters and uses the standard response envelope for moderator+', async () => {
    const user = await consumer('moderator@example.test', current, {
      role: 'moderator',
    });
    await user.createSession();
    const token = await (await User.findById(
      user._id
    ))!.generateAccessAuthToken();
    const get = (url: string) =>
      request(app).get(url).auth(token, { type: 'bearer' });
    const response = await get('/v1/admin/analytics?days=7');
    expect(response.status).toBe(200);
    expect(response.body.data.series).toHaveLength(7);
    for (const query of ['days=8', 'days=7&days=30', 'days[$gt]=1'])
      expect((await get(`/v1/admin/analytics?${query}`)).status).toBe(400);
    for (const query of [
      'kind=invalid',
      'kind=expenses&page=0',
      'kind=expenses&page=1.5',
      'kind=expenses&day=2026-02-30',
    ])
      expect((await get(`/v1/admin/analytics/records?${query}`)).status).toBe(
        400
      );
    expect(
      (await get('/v1/admin/analytics/records?kind=newUsers')).body.data.rows
    ).toEqual([]);
  });
  it('keeps assigned-plan filtering behind the existing Admin role boundary', async () => {
    const appGet = async (role: string, path: string) => {
      const user = await consumer(role + '-plan-filter@example.test', current, {
        role,
      });
      await user.createSession();
      const token = await (await User.findById(
        user._id
      ))!.generateAccessAuthToken();
      return request(app).get(path).auth(token, { type: 'bearer' });
    };
    expect(
      (await appGet('moderator', '/v1/admin/analytics?days=7&plan=pro')).status
    ).toBe(403);
    const moderator = await User.findOne({
      email: 'moderator-plan-filter@example.test',
    });
    const token = await moderator!.generateAccessAuthToken();
    expect(
      (
        await request(app)
          .get('/v1/admin/analytics/records?kind=expenses&plan=pro')
          .auth(token, { type: 'bearer' })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/v1/admin/analytics?days=7&type=income')
          .auth(token, { type: 'bearer' })
      ).status
    ).toBe(200);
    const response = await appGet(
      'admin',
      '/v1/admin/analytics?days=7&plan=pro&type=income'
    );
    expect(response.status).toBe(200);
    expect(response.body.data.filters).toEqual({ plan: 'pro', type: 'income' });
    const admin = await User.findOne({
      email: 'admin-plan-filter@example.test',
    });
    const adminToken = await admin!.generateAccessAuthToken();
    for (const query of [
      'plan=unknown',
      'plan=pro&plan=free',
      'type=invalid',
      'type[$ne]=income',
    ]) {
      expect(
        (
          await request(app)
            .get('/v1/admin/analytics?' + query)
            .auth(adminToken, { type: 'bearer' })
        ).status
      ).toBe(400);
    }
  });
});
