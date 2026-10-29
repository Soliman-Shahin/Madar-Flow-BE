import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../shared/helper';
import { ValidationError } from '../shared/errors';
import { appSettingsService } from '../services/app-settings.service';
import { appSettingsUpdateSchema } from '../validations/app-settings.validation';
import { auditLogService } from '../services/audit-log.service';
import { AuditAction } from '../models/audit-log.model';
import { AuthenticatedRequest } from '../middleware/access.middleware';

/**
 * App Settings Controller
 * - Public read (GET /v1/app-settings): what the consumer app displays.
 * - Admin read/update (/v1/admin/app-settings): managed from the dashboard.
 */
export class AppSettingsController {
  async getPublic(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const data = await appSettingsService.getPublic();
      // One minute: dashboard edits (e.g. a maintenance notice) must show up
      // quickly, and clients revalidate with the ETag after that.
      res.set('Cache-Control', 'public, max-age=60');
      sendSuccess(res, data, 'App settings retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async getForAdmin(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      res.set('Cache-Control', 'no-store');
      sendSuccess(
        res,
        await appSettingsService.getForAdmin(),
        'App settings retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const parsed = appSettingsUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        // Field paths and messages only: never echo submitted content back.
        throw new ValidationError(
          'Validation failed',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }))
        );
      }

      const { settings, changed } = await appSettingsService.update(
        parsed.data,
        authReq.user_id!
      );

      try {
        await auditLogService.log({
          req,
          actorId: authReq.user_id,
          actorRole: authReq.user?.role,
          actorEmail: authReq.user?.email,
          action: AuditAction.APP_SETTINGS_UPDATED,
          targetResourceType: 'app_settings',
          targetResourceId: 'app',
          // Section names and revisions only; legal text is not copied into logs.
          changes: {
            sections: changed,
            fromRevision: parsed.data.revision,
            toRevision: settings.revision,
          },
        });
      } catch {
        /* an audit failure must not undo a completed, validated save */
      }

      res.set('Cache-Control', 'no-store');
      sendSuccess(res, settings, 'App settings updated successfully');
    } catch (error) {
      next(error);
    }
  }
}

export const appSettingsController = new AppSettingsController();
