import { Types } from 'mongoose';
import { Category, Expense } from '../models';
import { MAX_SEARCH_LENGTH, safeSearchPattern } from '../shared/search';

describe('safeSearchPattern', () => {
  it('escapes regex metacharacters, trims, and caps length', () => {
    expect(safeSearchPattern('  a.b*(c) ')).toBe('a\\.b\\*\\(c\\)');
    expect(safeSearchPattern('x'.repeat(500))).toHaveLength(MAX_SEARCH_LENGTH);
  });

  it('ignores empty and non-string input', () => {
    expect(safeSearchPattern('   ')).toBeNull();
    expect(safeSearchPattern(undefined)).toBeNull();
    expect(safeSearchPattern(['a', 'b'])).toBeNull();
    expect(safeSearchPattern({ $ne: null })).toBeNull();
  });

  it('matches input literally in MongoDB and neutralizes catastrophic patterns', async () => {
    const user = new Types.ObjectId();
    const category = await Category.create({
      user,
      title: 'Food',
      icon: 'fast-food',
      color: '#FF0000',
      type: 'outcome',
    } as any);
    const base = { user, category: category._id, amount: 1, date: new Date() };
    await Expense.create([
      { ...base, _clientId: 'c1', description: 'a.b' },
      { ...base, _clientId: 'c2', description: 'axb' },
      { ...base, _clientId: 'c3', description: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' },
    ] as any);

    const literal = await Expense.find({
      description: { $regex: safeSearchPattern('A.B')!, $options: 'i' },
    }).lean();
    expect(literal.map((e) => e.description)).toEqual(['a.b']);

    // Unescaped, this is a classic ReDoS pattern; escaped it is plain text.
    const evil = await Expense.find({
      description: { $regex: safeSearchPattern('(a+)+$')!, $options: 'i' },
    }).lean();
    expect(evil).toHaveLength(0);
  });
});
