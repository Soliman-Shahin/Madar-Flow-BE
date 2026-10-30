import { z } from 'zod';

export const registerPushDeviceSchema = z
  .object({
    deviceId: z.string().trim().min(1).max(128),
    token: z.string().trim().min(20).max(4096),
    platform: z.enum(['android', 'ios', 'web']),
    appVersion: z.string().trim().max(64).optional(),
  })
  .strict();

export const pushDeviceIdSchema = z.string().trim().min(1).max(128);
