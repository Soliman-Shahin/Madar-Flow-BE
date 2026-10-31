import mongoose from 'mongoose';
import { Category, User } from '../models';
import { assertOwnsCategory, userOwnsCategory } from '../shared/ownership';

async function seed() {
  const a = await User.create({
    email: 'own-a@example.test',
    password: 'not-used',
  });
  const b = await User.create({
    email: 'own-b@example.test',
    password: 'not-used',
  });
  const cat = await Category.create({
    user: a._id,
    _clientId: `own-${Date.now()}`,
    title: 'A',
    icon: 'x',
    color: '#000000',
  });
  return { a: String(a._id), b: String(b._id), cat };
}

describe('category ownership helper', () => {
  it('accepts the owner, by id string or by populated object', async () => {
    const { a, cat } = await seed();
    expect(await userOwnsCategory(String(cat._id), a)).toBe(true);
    expect(
      await userOwnsCategory({ _id: String(cat._id), title: 'A' }, a)
    ).toBe(true);
  });

  it('rejects another account, unknown ids and junk', async () => {
    const { b, a, cat } = await seed();
    expect(await userOwnsCategory(String(cat._id), b)).toBe(false);
    expect(
      await userOwnsCategory(new mongoose.Types.ObjectId().toString(), a)
    ).toBe(false);
    for (const junk of ['x', 123, {}, [], true]) {
      expect(await userOwnsCategory(junk, a)).toBe(false);
    }
  });

  it('assert is a no-op for a missing reference and throws 400 for a foreign one', async () => {
    const { b, cat } = await seed();
    await expect(assertOwnsCategory(undefined, b)).resolves.toBeUndefined();
    await expect(assertOwnsCategory(null, b)).resolves.toBeUndefined();
    await expect(assertOwnsCategory(String(cat._id), b)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
