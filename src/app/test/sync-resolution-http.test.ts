import request from 'supertest';
import { configureExpressApp } from '../app';
import {
  Category,
  Expense,
  User,
  SyncConflict,
  ConflictResolution,
} from '../models';

const app = configureExpressApp();

async function createFixture() {
  const user = await User.create({
    email: `sync-http-${Date.now()}@example.test`,
    password: 'not-used',
  });
  // Access tokens are bound to a persisted session (sid), so create one first.
  await user.createSession();
  const token = await (await User.findById(user._id))!.generateAccessAuthToken();
  const category = await Category.create({
    user: user._id,
    _clientId: `sync-http-category-${Date.now()}`,
    title: 'QA',
    icon: 'folder',
    color: '#123456',
    _version: 1,
  });
  const expense = await Expense.create({
    user: user._id,
    _clientId: `sync-http-expense-${Date.now()}`,
    category: category._id,
    description: 'QA expense',
    amount: 100,
    date: new Date(),
    _version: 1,
  });
  return { user, token, expense, category };
}

async function push(token: string, entity: Record<string, unknown>) {
  return request(app)
    .post('/v1/sync/push')
    .set('Authorization', `Bearer ${token}`)
    .send({ entities: [entity] });
}

describe('sync conflict resolution HTTP boundary', () => {
  it('creates a real conflict then resolves Keep Mine without immutable-field failure', async () => {
    const { token, expense } = await createFixture();
    const base = {
      _entityType: 'expense',
      _id: expense._id.toString(),
      _baseVersion: 1,
      _version: 1,
      description: 'QA expense',
      amount: 300,
      category: expense.category.toString(),
      date: expense.date.toISOString(),
    };
    expect((await push(token, base)).status).toBe(200);
    expect((await push(token, { ...base, amount: 200 })).status).toBe(200);
    const listed = await request(app)
      .get('/v1/sync/conflicts')
      .set('Authorization', `Bearer ${token}`);
    const conflict = listed.body.data[0];
    const resolved = await request(app)
      .post('/v1/sync/conflicts/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conflictId: conflict.conflictId,
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution: 'local',
      });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.entity.amount).toBe(200);
    expect(resolved.body.data.entity._version).toBe(3);
    expect(await ConflictResolution.countDocuments({ conflictId: conflict.conflictId })).toBe(1);
  });

  it('creates a real conflict then resolves Use Server without advancing revision', async () => {
    const { token, expense } = await createFixture();
    const base = {
      _entityType: 'expense',
      _id: expense._id.toString(),
      _baseVersion: 1,
      _version: 1,
      description: 'QA expense',
      amount: 300,
      category: expense.category.toString(),
      date: expense.date.toISOString(),
    };
    expect((await push(token, base)).status).toBe(200);

    const stale = { ...base, amount: 200, _baseVersion: 1, _version: 1 };
    const conflictPush = await push(token, stale);
    expect(conflictPush.status).toBe(200);
    const listed = await request(app)
      .get('/v1/sync/conflicts')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    const conflict = listed.body.data[0];
    expect(conflict.conflictId).toMatch(/^[a-f0-9]{24}$/);

    const resolved = await request(app)
      .post('/v1/sync/conflicts/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conflictId: conflict.conflictId,
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution: 'server',
      });

    expect(resolved.status).toBe(200);
    expect(resolved.body.data.entity.amount).toBe(300);
    expect(resolved.body.data.entity._version).toBe(2);
    expect(
      await SyncConflict.countDocuments({ resolvedAt: { $exists: true } })
    ).toBe(1);
    expect(
      await ConflictResolution.countDocuments({
        entityId: expense._id.toString(),
      })
    ).toBe(1);

    const retry = await request(app)
      .post('/v1/sync/conflicts/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conflictId: conflict.conflictId,
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution: 'server',
      });
    expect(retry.status).toBe(200);
    expect(retry.body.data.entity.amount).toBe(300);
    expect(retry.body.data.entity._version).toBe(2);
    expect(
      await ConflictResolution.countDocuments({
        entityId: expense._id.toString(),
      })
    ).toBe(1);
  });

  it('returns a stable non-500 stale result and preserves the newer entity', async () => {
    const { token, expense } = await createFixture();
    const base = {
      _entityType: 'expense',
      _id: expense._id.toString(),
      _baseVersion: 1,
      _version: 1,
      description: 'QA expense',
      amount: 300,
      category: expense.category.toString(),
      date: expense.date.toISOString(),
    };
    await push(token, base);
    const conflictPush = await push(token, { ...base, amount: 200 });
    const listed = await request(app)
      .get('/v1/sync/conflicts')
      .set('Authorization', `Bearer ${token}`);
    const conflict = listed.body.data[0];
    await Expense.updateOne(
      { _id: expense._id, user: expense.user },
      { $set: { amount: 400, _version: 3 } }
    );

    const response = await request(app)
      .post('/v1/sync/conflicts/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conflictId: conflict.conflictId,
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution: 'server',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SYNC_CONFLICT_STALE_RESOLUTION');
    expect((await Expense.findById(expense._id))?.amount).toBe(400);
    expect(
      (await SyncConflict.findOne({ entityId: expense._id.toString() }))
        ?.resolvedAt
    ).toBeUndefined();
    expect(
      await ConflictResolution.countDocuments({
        entityId: expense._id.toString(),
      })
    ).toBe(0);
  });
});
