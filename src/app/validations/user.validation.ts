import { z } from 'zod';

export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  username: z.string().trim().min(2).max(50).optional(),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  termsVersion: z.string(),
  privacyVersion: z.string(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});
