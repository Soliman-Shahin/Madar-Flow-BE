import express from 'express';
import request from 'supertest';
import { rateLimitSync } from '../middleware/sync.middleware';
import { configureExpressApp } from '../app';
import { Category, Expense, User } from '../models';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { planService } from '../services/plan.service';

/**
 * End-to-end critical paths through the real Express app (full middleware
 * stack: encryption, CSRF, rate limits, auth, plan guards) against an
 * in-memory MongoDB. These are the journeys a launch must not break:
 * sign up, sign in, record spending, sync between devices, stay isolated from
 * other accounts, and respect plan limits.
 */
const app = configureExpressApp();

const PASSWORD = 'Testing-Password-42!';
const consent = {
  termsAccepted: true,
  privacyAccepted: true,
  termsVersion: CONSENT_VERSIONS.terms,
  privacyVersion: CONSENT_VERSIONS.privacy,
};

let ipCounter = 0;
// A distinct client IP per call keeps the in-memory brute-force/rate-limit state isolated.
const freshIp = () => `10.20.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

const encrypted = (body: Record<string, unknown>) => ({ data: encryptCryptoJS(body) });

async function signUp(email: string) {
  const res = await request(app)
    .post('/v1/user/signup')
    .set('X-Forwarded-For', freshIp())
    .send(encrypted({ email, password: PASSWORD, ...consent }));
  expect(res.status).toBe(200);
  return { token: res.body.data.accessToken as string, id: res.body.data.user._id as string };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (path: string, token: string) => request(app).get(path).set(auth(token));
const post = (path: string, token: string, body: object) =>
  request(app).post(path).set(auth(token)).send(body);
const put = (path: string, token: string, body: object) =>
  request(app).put(path).set(auth(token)).send(body);

beforeEach(async () => {
  await planService.seedDefaultPlans();
});

describe('E2E: account and sign-in', () => {
  it('signs up, signs in again, and rejects a wrong password', async () => {
    const { token, id } = await signUp('first-day@example.test');

    const me = await get('/v1/plans/me', token);
    expect(me.status).toBe(200);
    expect(me.body.data.context.planSlug).toBe('free');
    expect(await Category.countDocuments({ user: id, isDefault: true })).toBe(1);

    const login = await request(app)
      .post('/v1/user/login')
      .set('X-Forwarded-For', freshIp())
      .send(encrypted({ email: 'first-day@example.test', password: PASSWORD }));
    expect(login.status).toBe(200);
    expect(login.body.data.accessToken).toBeTruthy();

    const wrong = await request(app)
      .post('/v1/user/login')
      .set('X-Forwarded-For', freshIp())
      .send(encrypted({ email: 'first-day@example.test', password: 'Wrong-Password-1!' }));
    expect(wrong.status).toBe(401);
    expect(wrong.body.data?.accessToken).toBeUndefined();
  });

  it('refuses duplicate sign-ups and sign-ups without consent', async () => {
    await signUp('dup@example.test');
    const again = await request(app)
      .post('/v1/user/signup')
      .set('X-Forwarded-For', freshIp())
      .send(encrypted({ email: 'dup@example.test', password: PASSWORD, ...consent }));
    expect(again.status).toBe(409);
    expect(await User.countDocuments({ email: 'dup@example.test' })).toBe(1);

    const noConsent = await request(app)
      .post('/v1/user/signup')
      .set('X-Forwarded-For', freshIp())
      .send(encrypted({ email: 'nc@example.test', password: PASSWORD }));
    expect(noConsent.status).toBeGreaterThanOrEqual(400);
    expect(await User.countDocuments({ email: 'nc@example.test' })).toBe(0);
  });

  it('protects data routes: no token is 401, and state changes without a bearer token hit CSRF', async () => {
    expect((await request(app).get('/v1/expenses')).status).toBe(401);
    expect((await request(app).get('/v1/plans/me')).status).toBe(401);
    expect((await request(app).post('/v1/expenses').send({})).status).toBe(403);
    expect((await get('/v1/expenses', 'not-a-real-token')).status).toBe(401);
  });
});

describe('E2E: recording spending over REST', () => {
  it('creates a category and an expense and lists them back', async () => {
    const { token, id } = await signUp('spender@example.test');

    const cat = await post('/v1/categories/create', token, {
      title: 'Coffee',
      icon: 'cafe-outline',
      color: '#7C6BFF',
      type: 'outcome',
    });
    expect(cat.status).toBeLessThan(300);
    const categoryId = cat.body.data._id ?? cat.body.data.category?._id;
    expect(categoryId).toBeTruthy();

    const exp = await post('/v1/expenses', token, {
      description: 'Latte',
      amount: 65,
      category: categoryId,
      date: new Date().toISOString(),
    });
    expect(exp.status).toBeLessThan(300);

    const list = await get('/v1/expenses', token);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('Latte');
    expect(await Expense.countDocuments({ user: id })).toBe(1);
  });

  it('rejects an invalid expense without storing anything', async () => {
    const { token, id } = await signUp('invalid@example.test');
    const res = await post('/v1/expenses', token, {
      description: 'Negative',
      amount: -5,
      category: 'x',
      date: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
    expect(await Expense.countDocuments({ user: id })).toBe(0);
  });
});

describe('E2E: offline-first sync between two devices', () => {
  it('pushes offline records, maps ids, and a second device pulls them; edits and deletes propagate', async () => {
    const { token } = await signUp('sync@example.test');
    const catLocal = 'offline_category_e2e';
    const expLocal = 'offline_expense_e2e';

    const push = await post('/v1/sync/push', token, {
      entities: [
        {
          _id: catLocal,
          _clientId: catLocal,
          _entityType: 'category',
          title: 'Travel',
          icon: 'car-outline',
          color: '#2FB67C',
          type: 'outcome',
          order: 1,
        },
        {
          _id: expLocal,
          _clientId: expLocal,
          _entityType: 'expense',
          description: 'Taxi',
          amount: 120,
          category: catLocal,
          date: new Date().toISOString(),
        },
      ],
    });
    expect(push.status).toBe(200);
    expect(push.body.data.errors).toHaveLength(0);
    const serverExpenseId = push.body.data.idMap[expLocal];
    expect(serverExpenseId).toBeTruthy();
    expect(push.body.data.idMap[catLocal]).toBeTruthy();

    // Device B (same account) starts from scratch and sees both records.
    const pullB = await get('/v1/sync/pull', token);
    expect(pullB.status).toBe(200);
    const types = pullB.body.data.entities.map((e: { _entityType: string }) => e._entityType);
    expect(types).toEqual(expect.arrayContaining(['category', 'expense']));
    const taxi = pullB.body.data.entities.find(
      (e: { description?: string }) => e.description === 'Taxi'
    );
    expect(taxi._id).toBe(serverExpenseId);

    // Device A edits the expense; B sees the new amount on the next pull.
    const checkpoint = new Date(Date.now() - 1000).toISOString();
    const edit = await post('/v1/sync/push', token, {
      entities: [
        {
          _id: serverExpenseId,
          _entityType: 'expense',
          _baseVersion: taxi._version,
          description: 'Taxi',
          amount: 150,
          category: taxi.category,
          date: taxi.date,
          _operationId: 'e2e-edit-1',
        },
      ],
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data.errors).toHaveLength(0);
    const after = await get(`/v1/sync/pull?lastSyncTime=${encodeURIComponent(checkpoint)}`, token);
    const updated = after.body.data.entities.find((e: { _id: string }) => e._id === serverExpenseId);
    expect(updated.amount).toBe(150);

    // Deleting on A is reported to B as a deletion, and the row is soft-deleted.
    const current = await Expense.findById(serverExpenseId);
    const del = await post('/v1/sync/push', token, {
      entities: [
        {
          _id: serverExpenseId,
          _entityType: 'expense',
          _baseVersion: current!._version,
          _isDeleted: true,
          _operationId: 'e2e-delete-1',
        },
      ],
    });
    expect(del.status).toBe(200);
    expect((await Expense.findById(serverExpenseId))!._isDeleted).toBe(true);
  });

  it('does not silently overwrite a record that changed on another device', async () => {
    const { token } = await signUp('conflict@example.test');
    const catLocal = 'offline_category_conflict';
    const expLocal = 'offline_expense_conflict';
    const created = await post('/v1/sync/push', token, {
      entities: [
        { _id: catLocal, _clientId: catLocal, _entityType: 'category', title: 'C', icon: 'tag-outline', color: '#3366ff', type: 'outcome', order: 0 },
        { _id: expLocal, _clientId: expLocal, _entityType: 'expense', description: 'Original', amount: 10, category: catLocal, date: new Date().toISOString() },
      ],
    });
    const id = created.body.data.idMap[expLocal];
    const base = (await Expense.findById(id))!._version;

    // Device A saves first.
    await post('/v1/sync/push', token, {
      entities: [{ _id: id, _entityType: 'expense', _baseVersion: base, description: 'From A', amount: 20, category: (await Expense.findById(id))!.category, date: new Date().toISOString(), _operationId: 'conflict-a' }],
    });
    // Device B still holds the old version and saves a different value.
    const stale = await post('/v1/sync/push', token, {
      entities: [{ _id: id, _entityType: 'expense', _baseVersion: base, description: 'From B', amount: 30, category: (await Expense.findById(id))!.category, date: new Date().toISOString(), _operationId: 'conflict-b' }],
    });
    expect(stale.status).toBe(200);
    const saved = await Expense.findById(id);
    expect(saved!.description).not.toBe('From B');
    const reported = (stale.body.data.conflicts ?? []).length + (stale.body.data.errors ?? []).length;
    expect(reported).toBeGreaterThan(0);
  });
});

describe('E2E: account isolation', () => {
  it("another user cannot read, pull, or change someone else's expense", async () => {
    const a = await signUp('owner@example.test');
    const b = await signUp('stranger@example.test');

    const cat = await post('/v1/categories/create', a.token, {
      title: 'Private', icon: 'lock-closed-outline', color: '#E5484D', type: 'outcome',
    });
    const categoryId = cat.body.data._id ?? cat.body.data.category?._id;
    const exp = await post('/v1/expenses', a.token, {
      description: 'Secret purchase', amount: 999, category: categoryId, date: new Date().toISOString(),
    });
    const expenseId = exp.body.data._id ?? exp.body.data.expense?._id;
    expect(expenseId).toBeTruthy();

    expect(JSON.stringify((await get('/v1/expenses', b.token)).body)).not.toContain('Secret purchase');
    expect(JSON.stringify((await get('/v1/sync/pull', b.token)).body)).not.toContain('Secret purchase');

    const tamper = await put(`/v1/expenses/${expenseId}`, b.token, {
      description: 'Hacked', amount: 1, category: categoryId, date: new Date().toISOString(),
    });
    expect(tamper.status).toBeGreaterThanOrEqual(400);
    expect((await Expense.findById(expenseId))!.description).toBe('Secret purchase');

    const del = await request(app).delete(`/v1/expenses/${expenseId}`).set(auth(b.token));
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect(await Expense.exists({ _id: expenseId, _isDeleted: { $ne: true } })).toBeTruthy();
  });
});

describe('E2E: plan limits', () => {
  it('stops a free account at its category limit and leaves the data unchanged', async () => {
    const { token, id } = await signUp('limit@example.test');
    const free = await get('/v1/plans/me', token);
    const max = free.body.data.context.limits.maxCategories as number;
    expect(max).toBeGreaterThan(0);

    let blocked: number | null = null;
    for (let i = 0; i < max + 2; i++) {
      const res = await post('/v1/categories/create', token, {
        title: `Cat ${i}`, icon: 'tag-outline', color: '#3366ff', type: 'outcome',
      });
      if (res.status >= 400) {
        blocked = res.status;
        break;
      }
    }
    expect(blocked).toBe(403);
    expect(await Category.countDocuments({ user: id, _isDeleted: { $ne: true } })).toBe(max);
  });
  it('reports real usage and stops a free account at its monthly transaction limit', async () => {
    const { token, id } = await signUp('tx-limit@example.test');
    const plan = await get('/v1/plans/me', token);
    const max = plan.body.data.context.limits.maxTransactionsPerMonth as number;
    const categoryId = (await Category.findOne({ user: id }))!._id.toString();
    expect(max).toBeGreaterThan(0);

    let blocked: number | null = null;
    for (let i = 0; i < max + 2; i++) {
      const res = await post('/v1/expenses', token, {
        description: 'Item ' + i, amount: 1, category: categoryId, date: new Date().toISOString(),
      });
      if (res.status >= 400) {
        blocked = res.status;
        break;
      }
    }
    expect(blocked).toBe(403);
    expect(await Expense.countDocuments({ user: id })).toBe(max);

    const usage = (await get('/v1/plans/me', token)).body.data.usage;
    expect(usage.transactionsThisMonth.used).toBe(max);
    expect(usage.transactionsThisMonth.percentage).toBe(100);
    expect(usage.categories.used).toBe(1);
  });
});

describe('E2E: sync rate limit is per user', () => {
  it('one busy user hitting the limit does not block other users', async () => {
    const limited = express();
    limited.use((req, _res, next) => {
      (req as unknown as { user_id: string }).user_id = String(req.headers['x-user']);
      next();
    });
    limited.use('/v1/sync', rateLimitSync(2, 60_000), (_req, res) => res.json({ ok: true }));

    const hit = (user: string) => request(limited).get('/v1/sync/pull').set('x-user', user);
    expect((await hit('busy')).status).toBe(200);
    expect((await hit('busy')).status).toBe(200);
    expect((await hit('busy')).status).toBe(429);
    expect((await hit('quiet')).status).toBe(200);
  });
});
