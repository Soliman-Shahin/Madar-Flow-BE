import mongoose from 'mongoose';
import { Category } from '../models/category.model';
import { BadRequestError } from './errors';

/**
 * An expense may only reference a category owned by the same user: `populate('category')` would
 * otherwise return another account's category (D-029). Clients echo back the populated object they
 * pulled, so a `{ _id }` object is resolved to its id first.
 */
export async function userOwnsCategory(
  ref: unknown,
  userId: string
): Promise<boolean> {
  const id =
    typeof ref === 'object' && ref !== null
      ? (ref as { _id?: unknown })._id
      : ref;
  if (!mongoose.Types.ObjectId.isValid(id as string)) return false;
  return !!(await Category.exists({ _id: id as string, user: userId }));
}

/** No-op for a missing reference; throws a 400 when the category is not the caller's. */
export async function assertOwnsCategory(
  ref: unknown,
  userId: string
): Promise<void> {
  if (ref === undefined || ref === null) return;
  if (!(await userOwnsCategory(ref, userId)))
    throw new BadRequestError('Category not found');
}
