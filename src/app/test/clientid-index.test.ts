import { Types } from 'mongoose';
import { Category, Expense } from '../models';
import { CLIENT_ID_INDEX_KEYS, CLIENT_ID_INDEX_NAME } from '../models/client-id-index';
import { migrateClientIdIndexes } from '../services/client-id-index-migration.service';

const LEGACY = 'user_1__clientId_1';

async function categoryFor(user: Types.ObjectId, clientId?: string) {
  return Category.create({
    user,
    title: 'Food',
    icon: 'fast-food',
    color: '#FF0000',
    type: 'outcome',
    ...(clientId ? { _clientId: clientId } : {}),
  } as any);
}

const expense = (user: Types.ObjectId, category: Types.ObjectId, clientId?: string) =>
  Expense.create({
    user,
    category,
    description: 'x',
    amount: 1,
    date: new Date(),
    ...(clientId ? { _clientId: clientId } : {}),
  } as any);

/** Put a collection back into the pre-migration state: legacy sparse index only. */
async function restoreLegacyState() {
  for (const model of [Expense, Category]) {
    const names = (await model.collection.indexes()).map((i) => i.name);
    if (names.includes(CLIENT_ID_INDEX_NAME)) await model.collection.dropIndex(CLIENT_ID_INDEX_NAME);
    if (!names.includes(LEGACY))
      await model.collection.createIndex(CLIENT_ID_INDEX_KEYS, { unique: true, sparse: true, name: LEGACY });
  }
}

const indexNames = async (model: typeof Expense | typeof Category) =>
  (await model.collection.indexes()).map((i) => i.name);

beforeAll(async () => {
  await Expense.init();
  await Category.init();
});

describe('_clientId uniqueness (partial index)', () => {
  it('allows several items without _clientId for the same user', async () => {
    const user = new Types.ObjectId();
    const c1 = await categoryFor(user);
    await categoryFor(user); // second category without _clientId used to fail with E11000
    await expense(user, c1._id as Types.ObjectId);
    await expense(user, c1._id as Types.ObjectId);
    expect(await Expense.countDocuments({ user })).toBe(2);
    expect(await Category.countDocuments({ user })).toBe(2);
  });

  it('still rejects a duplicate _clientId for the same user, but allows it across users', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    const cat = await categoryFor(a, 'cat-1');
    await expense(a, cat._id as Types.ObjectId, 'exp-1');
    await expect(expense(a, cat._id as Types.ObjectId, 'exp-1')).rejects.toMatchObject({ code: 11000 });
    await expect(categoryFor(a, 'cat-1')).rejects.toMatchObject({ code: 11000 });
    await expense(b, cat._id as Types.ObjectId, 'exp-1');
    await categoryFor(b, 'cat-1');
  });
});

describe('migrateClientIdIndexes', () => {
  afterEach(async () => {
    // Leave the database in the post-migration state for other tests.
    await migrateClientIdIndexes(true);
  });

  it('dry-run reports the planned change without touching indexes', async () => {
    await restoreLegacyState();
    const reports = await migrateClientIdIndexes(false);
    for (const r of reports) {
      expect(r.legacyIndex).toBe(LEGACY);
      expect(r.actions).toEqual([`create ${CLIENT_ID_INDEX_NAME}`, `drop ${LEGACY}`]);
    }
    expect(await indexNames(Expense)).toContain(LEGACY);
    expect(await indexNames(Expense)).not.toContain(CLIENT_ID_INDEX_NAME);
  });

  it('apply replaces the legacy index, keeps uniqueness, and is idempotent', async () => {
    await restoreLegacyState();
    const user = new Types.ObjectId();
    const cat = await categoryFor(user, 'keep');
    await expense(user, cat._id as Types.ObjectId, 'keep');

    const applied = await migrateClientIdIndexes(true);
    expect(applied.every((r) => !r.error && r.legacyIndex === null && r.partialIndexPresent)).toBe(true);
    for (const model of [Expense, Category]) {
      const names = await indexNames(model);
      expect(names).toContain(CLIENT_ID_INDEX_NAME);
      expect(names).not.toContain(LEGACY);
    }
    await expect(expense(user, cat._id as Types.ObjectId, 'keep')).rejects.toMatchObject({ code: 11000 });

    const again = await migrateClientIdIndexes(true);
    expect(again.every((r) => r.actions.length === 0 && !r.error)).toBe(true);
  });

  it('keeps the legacy index when the partial index already exists (app startup created it)', async () => {
    await restoreLegacyState();
    await Expense.collection.createIndex(CLIENT_ID_INDEX_KEYS, {
      name: CLIENT_ID_INDEX_NAME,
      unique: true,
      partialFilterExpression: { _clientId: { $type: 'string' } },
    });
    const [expenses] = await migrateClientIdIndexes(false);
    expect(expenses.actions).toEqual([`drop ${LEGACY}`]);
  });

  it('refuses to change anything when duplicate client ids exist', async () => {
    for (const model of [Expense]) {
      for (const name of await indexNames(model))
        if (name === LEGACY || name === CLIENT_ID_INDEX_NAME) await model.collection.dropIndex(name);
    }
    const user = new Types.ObjectId();
    const dup = { user, category: new Types.ObjectId(), description: 'x', amount: 1, date: new Date(), _clientId: 'twice' };
    await Expense.collection.insertMany([{ ...dup }, { ...dup }]);

    const [expenses] = await migrateClientIdIndexes(true);
    expect(expenses.duplicateClientIds).toBe(1);
    expect(expenses.error).toMatch(/duplicate/);
    expect(await indexNames(Expense)).not.toContain(CLIENT_ID_INDEX_NAME);

    await Expense.collection.deleteMany({ user });
  });
});
