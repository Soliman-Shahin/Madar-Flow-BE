import request from 'supertest';
import mongoose from 'mongoose';
import { configureExpressApp } from '../app';
import { Category, Expense, User } from '../models';

const app = configureExpressApp();

async function actor(tag: string) {
  const user = await User.create({ email: `sync-own-${tag}-${Date.now()}@example.test`, password: 'not-used' });
  await user.createSession();
  const token = await (await User.findById(user._id))!.generateAccessAuthToken();
  const category = await Category.create({
    user: user._id, _clientId: `sync-own-cat-${tag}-${Date.now()}`, title: `${tag} category`,
    icon: 'folder', color: '#123456', _version: 1,
  });
  const expense = await Expense.create({
    user: user._id, _clientId: `sync-own-exp-${tag}-${Date.now()}`, category: category._id,
    description: `${tag} expense`, amount: 10, date: new Date(), _version: 1,
  });
  return { user, token, category, expense };
}
const push = (token: string, entity: Record<string, unknown>) =>
  request(app).post('/v1/sync/push').set('Authorization', `Bearer ${token}`).send({ entities: [entity] });

describe('sync push ownership', () => {
  it("does not let a pushed expense reference another user's category (D-029, sync path)", async () => {
    const a = await actor('a');
    const b = await actor('b');
    const id = new mongoose.Types.ObjectId().toString();
    await push(b.token, {
      _id: id, _entityType: 'expense', description: 'cross ref', amount: 5,
      category: a.category._id.toString(), date: new Date().toISOString(), _operationId: 'op-cross-ref-1',
    });
    const stored = await Expense.findOne({ _id: id });
    expect(stored?.category?.toString() ?? null).not.toBe(a.category._id.toString());
  });

  it('cannot move an owned entity to another user through a pushed `user` field', async () => {
    const a = await actor('a2');
    const b = await actor('b2');
    await push(b.token, {
      _id: b.expense._id.toString(), _entityType: 'expense', _baseVersion: 1,
      description: 'moved', amount: 11, category: b.category._id.toString(),
      date: new Date().toISOString(), user: a.user._id.toString(), _operationId: 'op-move-owner-1',
    });
    const after = await Expense.findById(b.expense._id);
    expect(after?.user.toString()).toBe(b.user._id.toString());
  });

  it("cannot update or delete another user's entity by id", async () => {
    const a = await actor('a3');
    const b = await actor('b3');
    await push(b.token, {
      _id: a.expense._id.toString(), _entityType: 'expense', _baseVersion: 1,
      description: 'hijack', amount: 99, category: b.category._id.toString(),
      date: new Date().toISOString(), _operationId: 'op-hijack-1',
    });
    await push(b.token, { _id: a.expense._id.toString(), _entityType: 'expense', _baseVersion: 1, _isDeleted: true, _operationId: 'op-hijack-2' });
    const after = await Expense.findById(a.expense._id);
    expect(after?.description).toBe('a3 expense');
    expect(after?._isDeleted).toBeFalsy();
    expect(after?.user.toString()).toBe(a.user._id.toString());
  });
});
