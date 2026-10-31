import { z } from 'zod';

/** Fields a client may set when creating a category (extra sync fields are tolerated). */
export const categorySchema = z.object({
  title: z.string().trim().min(1).max(100),
  icon: z.string().trim().min(1).max(100),
  color: z.string().trim().min(1).max(32),
  type: z.enum(['income', 'outcome']).optional(),
});

/** Updates may send any subset, but a provided field must still be valid. */
export const categoryUpdateSchema = categorySchema.partial();
