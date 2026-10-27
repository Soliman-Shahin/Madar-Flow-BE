import { Types } from 'mongoose';
import { Category, Expense } from '../models';
import { CLIENT_ID_INDEX_NAME } from '../models/client-id-index';


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

beforeAll(async () => {
  await Expense.init();
  await Category.init();
});

describe('_clientId uniqueness (partial index)', () => {
  it('declares a unique partial index on both collections', async () => {
    for (const model of [Expense, Category]) {
      const index = (await model.collection.indexes()).find((i) => i.name === CLIENT_ID_INDEX_NAME);
      expect(index?.unique).toBe(true);
      expect(index?.partialFilterExpression).toEqual({ _clientId: { $type: 'string' } });
      expect(index?.sparse).toBeFalsy();
    }
  });

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
