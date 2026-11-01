import { z } from 'zod';
import { UserRole } from '../models/user.model';
import { PlanSlug } from '../types/plan.types';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const broadcastTargetSchema = z
  .object({
    roles: z.array(z.nativeEnum(UserRole)).max(4).optional(),
    plans: z.array(z.nativeEnum(PlanSlug)).max(3).optional(),
    platforms: z.array(z.enum(['android', 'ios', 'web'])).max(3).optional(),
    /** Paid plan expires within the next N days. */
    planExpiringInDays: z.number().int().min(1).max(90).optional(),
    /** Account created within the last N days. */
    joinedWithinDays: z.number().int().min(1).max(3650).optional(),
    /** Explicit recipients. When present every other filter is ignored. */
    userIds: z.array(objectId).min(1).max(500).optional(),
  })
  .strict();

export const broadcastChannelsSchema = z
  .object({
    push: z.boolean().default(true),
    realtime: z.boolean().default(true),
  })
  .strict();

export const broadcastNotificationSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(1000),
    type: z.enum(['info', 'success', 'warn', 'error']).default('info'),
    audience: z.enum(['all', 'admins', 'moderators', 'custom']).default('all'),
    target: broadcastTargetSchema.optional(),
    channels: broadcastChannelsSchema.optional(),
  })
  .strict();

export const broadcastPreviewSchema = z
  .object({
    audience: z.enum(['all', 'admins', 'moderators', 'custom']).default('all'),
    target: broadcastTargetSchema.optional(),
  })
  .strict();
