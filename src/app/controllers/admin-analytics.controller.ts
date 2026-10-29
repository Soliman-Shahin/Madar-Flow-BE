import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendError, sendSuccess } from '../shared/helper';
import { PlanSlug } from '../types/plan.types';
import { engagementAnalyticsService } from '../services/engagement-analytics.service';
import { subscriptionAnalyticsService } from '../services/subscription-analytics.service';
import {
  adminAnalyticsService,
  AnalyticsDays,
} from '../services/admin-analytics.service';

const periodQuery = z
  .object({
    days: z.enum(['7', '30', '90']).default('30'),
    plan: z.enum(PlanSlug).optional(),
    type: z.enum(['income', 'outcome']).optional(),
  })
  .strict();
const recordsQuery = periodQuery.extend({
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
});

export const adminAnalyticsController = {
  async engagement(req: Request, res: Response, next: NextFunction) {
    const query = periodQuery.pick({ days: true }).safeParse(req.query);
    if (!query.success)
      return sendError(
        res,
        'Choose a 7, 30 or 90 day period.',
        400,
        'INVALID_ANALYTICS_QUERY'
      );
    try {
      return sendSuccess(
        res,
        await engagementAnalyticsService.overview(
          Number(query.data.days) as AnalyticsDays
        )
      );
    } catch (error) {
      return next(error);
    }
  },
  async subscriptions(req: Request, res: Response, next: NextFunction) {
    const query = periodQuery
      .pick({ days: true })
      .extend({
        horizon: z.enum(['7', '30']).default('7'),
        page: z
          .string()
          .regex(/^[1-9]\d{0,3}$/)
          .default('1'),
      })
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
          Number(query.data.days) as AnalyticsDays,
          Number(query.data.horizon) as 7 | 30,
          Number(query.data.page)
        )
      );
    } catch (error) {
      return next(error);
    }
  },
  async overview(req: Request, res: Response, next: NextFunction) {
    const query = periodQuery.safeParse(req.query);
    if (!query.success)
      return sendError(
        res,
        'Choose a 7, 30 or 90 day period.',
        400,
        'INVALID_ANALYTICS_QUERY'
      );
    try {
      return sendSuccess(
        res,
        await adminAnalyticsService.overview(
          Number(query.data.days) as AnalyticsDays,
          undefined,
          { plan: query.data.plan, type: query.data.type }
        ),
        'Analytics retrieved successfully'
      );
    } catch (error) {
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
      const { kind, days, day, page, asOf, plan, type } = query.data;
      return sendSuccess(
        res,
        await adminAnalyticsService.records(
          kind,
          Number(days) as AnalyticsDays,
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
