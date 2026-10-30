import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../shared/helper';
import { ValidationError } from '../shared/errors';
import { telemetryService } from '../services/telemetry.service';
import {
  telemetryBatchSchema,
  telemetryDeleteSchema,
  telemetrySummaryQuerySchema,
} from '../validations/telemetry.validation';

/** Field paths and messages only: never echo submitted content back. */
function fail(error: {
  issues: { path: PropertyKey[]; message: string }[];
}): never {
  throw new ValidationError(
    'Validation failed',
    error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }))
  );
}

/**
 * Telemetry controller.
 * The write endpoints require a signed-in session (so abuse is limited to real
 * accounts and the Bearer scheme keeps them outside CSRF scope) but the account
 * is deliberately NOT stored with the events; see the event model.
 */
export class TelemetryController {
  async record(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = telemetryBatchSchema.safeParse(req.body);
      if (!parsed.success) fail(parsed.error);
      const accepted = await telemetryService.record(parsed.data!);
      res.set('Cache-Control', 'no-store');
      sendSuccess(res, { accepted }, 'Events accepted', 202);
    } catch (error) {
      next(error);
    }
  }

  async erase(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = telemetryDeleteSchema.safeParse(req.body);
      if (!parsed.success) fail(parsed.error);
      const deleted = await telemetryService.deleteInstall(
        parsed.data!.installId
      );
      res.set('Cache-Control', 'no-store');
      sendSuccess(res, { deleted }, 'Events deleted');
    } catch (error) {
      next(error);
    }
  }

  async summary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = telemetrySummaryQuerySchema.safeParse(req.query);
      if (!parsed.success) fail(parsed.error);
      res.set('Cache-Control', 'no-store');
      sendSuccess(
        res,
        await telemetryService.summary(parsed.data!.days),
        'Usage summary retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }
}

export const telemetryController = new TelemetryController();
