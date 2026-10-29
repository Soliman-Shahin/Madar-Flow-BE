import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendError, sendSuccess } from '../shared/helper';
import { PlanSlug } from '../types/plan.types';
import { engagementAnalyticsService } from '../services/engagement-analytics.service';
import { subscriptionAnalyticsService } from '../services/subscription-analytics.service';
import {
  adminAnalyticsService,
  AnalyticsDays,
  AnalyticsPeriodSelection,
} from '../services/admin-analytics.service';

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodFields = {
    days: z.enum(['7', '30', '90']).optional(),
    start: dateParam.optional(),
    end: dateParam.optional(),
    compare: z.enum(['previous', 'yearAgo']).default('previous'),
    plan: z.enum(PlanSlug).optional(),
    type: z.enum(['income', 'outcome']).optional(),
  };
const validatePeriod = (
  value: { days?: string; start?: string; end?: string },
  context: z.RefinementCtx
) => {
  const custom = !!value.start || !!value.end;
  if ((custom && (!value.start || !value.end)) || (custom && !!value.days)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use either days or a complete start/end range.',
    });
  }
};
const periodQuery = z.object(periodFields).strict().superRefine(validatePeriod);
const recordsQuery = z.object({
  ...periodFields,
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  kind: z.enum(['newUsers', 'recordingUsers', 'expenses']),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .default('1'),
}).strict().superRefine(validatePeriod);

function periodSelection(value: {
  days?: string;
  start?: string;
  end?: string;
  compare?: 'previous' | 'yearAgo';
}): AnalyticsPeriodSelection {
  return value.start && value.end
    ? { start: value.start, end: value.end, comparison: value.compare }
    : (Number(value.days || 30) as AnalyticsDays);
}

export const adminAnalyticsController = {
  async engagement(req: Request, res: Response, next: NextFunction) {
    const query = periodQuery.safeParse(req.query);
    if (!query.success)
      return sendError(
        res,
        'Choose a preset period or a complete start/end range.',
        400,
        'INVALID_ANALYTICS_QUERY'
      );
    try {
      return sendSuccess(
        res,
        await engagementAnalyticsService.overview(
          periodSelection(query.data),
          undefined,
          { plan: query.data.plan, type: query.data.type }
        )
      );
    } catch (error) {
      if (error instanceof RangeError)
        return sendError(res, error.message, 400, 'INVALID_ANALYTICS_QUERY');
      return next(error);
    }
  },
  async subscriptions(req: Request, res: Response, next: NextFunction) {
    const query = z
      .object({
        ...periodFields,
        plan: z.enum(PlanSlug).optional(),
        type: z.never().optional(),
        horizon: z.enum(['7', '30']).default('7'),
        page: z
          .string()
          .regex(/^[1-9]\d{0,3}$/)
          .default('1'),
      }).strict().superRefine(validatePeriod)
      .safeParse(req.query);
    if (!query.success)
      return sendError(
        res,
        'Invalid subscription analytics filters.',
        400,
        'INVALID_ANALYTICS_QUERY'
      );
    try {
      return sendSuccess(
        res,
        await subscriptionAnalyticsService.overview(
          periodSelection(query.data),
          Number(query.data.horizon) as 7 | 30,
          Number(query.data.page),
          undefined,
          { plan: query.data.plan }
        )
      );
    } catch (error) {
      if (error instanceof RangeError)
        return sendError(res, error.message, 400, 'INVALID_ANALYTICS_QUERY');
      return next(error);
    }
  },
  async overview(req: Request, res: Response, next: NextFunction) {
    const query = periodQuery.safeParse(req.query);
    if (!query.success)
      return sendError(
        res,
        'Choose a preset period or a complete start/end range.',
        400,
        'INVALID_ANALYTICS_QUERY'
      );
    try {
      return sendSuccess(
        res,
        await adminAnalyticsService.overview(
          periodSelection(query.data),
          undefined,
          { plan: query.data.plan, type: query.data.type }
        ),
        'Analytics retrieved successfully'
      );
    } catch (error) {
      if (error instanceof RangeError)
        return sendError(res, error.message, 400, 'INVALID_ANALYTICS_QUERY');
      return next(error);
    }
  },
  async records(req: Request, res: Response, next: NextFunction) {
    const query = recordsQuery.safeParse(req.query);
    if (!query.success)
      return sendError(
        res,
        'Invalid analytics record filters.',
        400,
        'INVALID_ANALYTICS_QUERY'
      );
    try {
      const { kind, day, page, asOf, plan, type } = query.data;
      return sendSuccess(
        res,
        await adminAnalyticsService.records(
          kind,
          periodSelection(query.data),
          day,
          Number(page),
          undefined,
          asOf,
          { plan, type }
        ),
        'Analytics records retrieved successfully'
      );
    } catch (error) {
      if (error instanceof RangeError)
        return sendError(res, error.message, 400, 'INVALID_ANALYTICS_QUERY');
      return next(error);
    }
  },
};
