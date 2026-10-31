import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AuthenticationError } from '../shared/errors';
import { sendError, sendSuccess } from '../shared/helper';
import {
  AnalyticsReportScheduleInput,
  analyticsReportScheduleService,
  AnalyticsReportScheduleError,
} from '../services/analytics-report-schedule.service';
import { PlanSlug } from '../types/plan.types';

const scheduleInput = z
  .object({
    frequency: z.enum(['weekly', 'monthly']),
    weekday: z.number().int().min(1).max(7).optional(),
    monthDay: z.number().int().min(1).max(28).optional(),
    hour: z.number().int().min(0).max(23),
    timezone: z.string().trim().min(1).max(80),
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    comparison: z.enum(['previous', 'yearAgo']),
    plan: z.enum(PlanSlug).optional(),
    type: z.enum(['income', 'outcome']).optional(),
    language: z.enum(['en', 'ar']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.frequency === 'weekly' && (!value.weekday || value.monthDay))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekday'],
        message: 'Choose a weekday for weekly delivery.',
      });
    if (value.frequency === 'monthly' && (!value.monthDay || value.weekday))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['monthDay'],
        message: 'Choose a day of the month for monthly delivery.',
      });
  });

/** The access-token middleware sets user_id; fail closed if a route is ever mounted without it. */
const actorId = (req: Request): string => {
  if (!req.user_id) throw new AuthenticationError();
  return req.user_id;
};

const scheduleId = (req: Request) =>
  Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

function handleScheduleError(
  error: unknown,
  res: Response,
  next: NextFunction
) {
  if (error instanceof AnalyticsReportScheduleError)
    return sendError(res, error.message, error.statusCode, error.code);
  return next(error);
}

export const analyticsReportScheduleController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      return sendSuccess(
        res,
        await analyticsReportScheduleService.list(actorId(req)),
        'Analytics report schedules retrieved successfully'
      );
    } catch (error) {
      return next(error);
    }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    const parsed = scheduleInput.safeParse(req.body);
    if (!parsed.success)
      return sendError(
        res,
        'Invalid analytics report schedule.',
        400,
        'INVALID_REPORT_SCHEDULE',
        parsed.error.flatten()
      );
    try {
      return sendSuccess(
        res,
        await analyticsReportScheduleService.create(
          actorId(req),
          parsed.data as AnalyticsReportScheduleInput
        ),
        'Analytics report schedule created successfully'
      );
    } catch (error) {
      return handleScheduleError(error, res, next);
    }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    const parsed = scheduleInput.safeParse(req.body);
    if (!parsed.success)
      return sendError(
        res,
        'Invalid analytics report schedule.',
        400,
        'INVALID_REPORT_SCHEDULE',
        parsed.error.flatten()
      );
    try {
      return sendSuccess(
        res,
        await analyticsReportScheduleService.update(
          actorId(req),
          scheduleId(req),
          parsed.data as AnalyticsReportScheduleInput
        ),
        'Analytics report schedule updated successfully'
      );
    } catch (error) {
      return handleScheduleError(error, res, next);
    }
  },

  async setActive(req: Request, res: Response, next: NextFunction) {
    const parsed = z
      .object({ active: z.boolean() })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      return sendError(
        res,
        'Choose whether the report schedule should be active.',
        400,
        'INVALID_REPORT_SCHEDULE_STATUS'
      );
    try {
      return sendSuccess(
        res,
        await analyticsReportScheduleService.setActive(
          actorId(req),
          scheduleId(req),
          parsed.data.active
        ),
        parsed.data.active
          ? 'Analytics report schedule resumed successfully'
          : 'Analytics report schedule paused successfully'
      );
    } catch (error) {
      return handleScheduleError(error, res, next);
    }
  },

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const cancelled = await analyticsReportScheduleService.cancel(
        actorId(req),
        scheduleId(req)
      );
      if (!cancelled)
        return sendError(
          res,
          'Report schedule not found.',
          404,
          'REPORT_SCHEDULE_NOT_FOUND'
        );
      return sendSuccess(res, null, 'Analytics report schedule cancelled');
    } catch (error) {
      return next(error);
    }
  },
};
