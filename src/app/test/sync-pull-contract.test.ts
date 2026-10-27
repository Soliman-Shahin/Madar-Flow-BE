import request from 'supertest';
import { Types } from 'mongoose';
import { configureExpressApp } from '../app';
import { Category, Expense, User } from '../models';

const app = configureExpressApp();
const OLD = new Date('2026-01-01T00:00:00.000Z');
const NEW = new Date('2026-06-01T00:00:00.000Z');
const CUTOFF = '2026-03-01T00:00:00.000Z';

async function signedInUser(label: string) {
  const user = await User.create({
    email: `pull-${label}-${new Types.ObjectId()}@example.test`,
    password: 'not-used',
  });
  await user.createSession();
  const token = await (await User.findById(user._id))!.generateAccessAuthToken();
  return { user, token };
}

async function seed(userId: Types.ObjectId, label: string) {
  const category = await Category.create({
    user: userId,
    _clientId: `cat-${label}`,
    title: `Cat ${label}`,
    icon: 'folder',
    color: '#123456',
    _lastModified: OLD,
  } as any);
  const base = { user: userId, category: category._id, amount: 10, date: OLD };
  await Expense.create([
    { ...base, _clientId: `old-${label}`, description: `old ${label}`, _lastModified: OLD },
    { ...base, _clientId: `new-${label}`, description: `new ${label}`, _lastModified: NEW },
    {
      ...base,
      _clientId: `deleted-${label}`,
      description: `deleted ${label}`,
      _isDeleted: true,
      _lastModified: NEW,
    },
  ] as any);
  // Pin timestamps so the createdAt/updatedAt branches of the filter are deterministic.
  await Expense.collection.updateMany(
    { user: userId, _lastModified: OLD },
    { $set: { createdAt: OLD, updatedAt: OLD } }
  );
  await Expense.collection.updateMany(
    { user: userId, _lastModified: NEW },
    { $set: { createdAt: NEW, updatedAt: NEW } }
  );
  await Category.collection.updateMany({ user: userId }, { $set: { createdAt: OLD, updatedAt: OLD } });
}

const pull = (token: string, query = '') =>
  request(app).get(`/v1/sync/pull${query}`).set('Authorization', `Bearer ${token}`);

describe('sync pull contract', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/v1/sync/pull');
    expect(res.status).toBe(401);
  });

  it('returns only the caller\'s own entities, tagged with their type', async () => {
    const a = await signedInUser('a');
    const b = await signedInUser('b');
    await seed(a.user._id as Types.ObjectId, 'a');
    await seed(b.user._id as Types.ObjectId, 'b');

    const res = await pull(a.token);
    expect(res.status).toBe(200);
    const entities = res.body.data.entities as any[];
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.every((e) => String(e.user?._id ?? e.user) === a.user._id.toString())).toBe(true);
    expect(entities.some((e) => /\bb$/.test(e.description ?? e.title ?? ''))).toBe(false);
    expect(new Set(entities.map((e) => e._entityType))).toEqual(new Set(['expense', 'category']));
  });

  it('applies lastSyncTime and still includes deletions as tombstones', async () => {
    const a = await signedInUser('a');
    await seed(a.user._id as Types.ObjectId, 'a');

    const res = await pull(a.token, `?lastSyncTime=${encodeURIComponent(CUTOFF)}`);
    expect(res.status).toBe(200);
    const descriptions = (res.body.data.entities as any[]).map((e) => e.description ?? e.title);
    expect(descriptions).toEqual(expect.arrayContaining(['new a', 'deleted a']));
    expect(descriptions).not.toContain('old a');
    expect(descriptions).not.toContain('Cat a');
    const tombstone = (res.body.data.entities as any[]).find((e) => e.description === 'deleted a');
    expect(tombstone._isDeleted).toBe(true);
  });

  it('filters by entityType', async () => {
    const a = await signedInUser('a');
    await seed(a.user._id as Types.ObjectId, 'a');

    const res = await pull(a.token, '?entityType=category');
    expect(res.status).toBe(200);
    const types = new Set((res.body.data.entities as any[]).map((e) => e._entityType));
    expect(types).toEqual(new Set(['category']));
  });

  it('rejects malformed query parameters', async () => {
    const a = await signedInUser('a');
    expect((await pull(a.token, '?lastSyncTime=yesterday')).status).toBe(400);
    expect((await pull(a.token, '?entityType=salary')).status).toBe(400);
    expect((await pull(a.token, '?limit=1000')).status).toBe(400);
  });
});
