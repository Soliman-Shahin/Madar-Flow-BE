import { Types } from 'mongoose';
import { Category } from '../models/category.model';

/**
 * Categories every new account starts with, whatever way it was created
 * (e-mail signup, Google on the web, Google on a phone).
 *
 * - "Uncategorized" is the isDefault fallback: when a category is deleted its
 *   transactions move here, so there must be exactly one per user.
 * - "Income" lets a new user record income straight away.
 * Both are flagged isStarter, so they never count toward the plan's category
 * limit: the limit set in the dashboard applies to the user's own categories.
 */
export async function createStarterCategories(
  userId: Types.ObjectId | string
): Promise<void> {
  await Category.create({
    title: 'Uncategorized',
    icon: 'help-circle-outline',
    color: '#9E9E9E',
    type: 'outcome',
    user: userId,
    isDefault: true,
    isStarter: true,
  });
  await Category.create({
    title: 'Income',
    icon: 'cash-outline',
    color: '#2E7D32',
    type: 'income',
    user: userId,
    isDefault: false,
    isStarter: true,
  });
}
