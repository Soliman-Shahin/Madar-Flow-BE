import { errorMessage, asError } from '../shared/errors';
import { Request, Response, NextFunction } from 'express';
import { auditLogService } from '../services/audit-log.service';
import { AuditAction } from '../models/audit-log.model';
import { AuthenticatedRequest } from './access.middleware';
import logger from '../services/logger.service';

/**
 * Audit Middleware
 *
 * Automatically logs requests to sensitive endpoints
 */

/**
 * Log the current request to audit log
 */
export const auditRequest = (action: AuditAction) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    try {
      // Capture the original res.json to log after response
      const originalJson = res.json.bind(res);

      res.json = function (body: any) {
        const success = res.statusCode >= 200 && res.statusCode < 400;

        // Log asynchronously to not block the response
        setImmediate(() => {
          auditLogService
            .log({
              actorId: authReq.user_id,
              actorRole: authReq.user?.role,
              actorEmail: authReq.user?.email,
              action,
              success,
              errorMessage: success ? undefined : body?.message,
              req,
            })
            .catch((err: any) => {
              logger.error('Failed to log audit entry:', err.message);
            });
        });

        return originalJson(body);
      };

      next();
    } catch (error: unknown) {
      logger.error('Error in audit middleware:', asError(error));
      next();
    }
  };
};

/**
 * Log resource creation
 */
export const auditResourceCreation = (
  resourceType: string,
  action: AuditAction
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      const success = res.statusCode >= 200 && res.statusCode < 400;
      const resourceId = body?.data?._id || body?.data?.id;

      setImmediate(() => {
        auditLogService
          .log({
            actorId: authReq.user_id,
            actorRole: authReq.user?.role,
            actorEmail: authReq.user?.email,
            action,
            targetResourceType: resourceType,
            targetResourceId: resourceId,
            success,
            metadata: {
              resourceData: body?.data,
            },
            req,
          })
          .catch((err: any) => {
            logger.error('Failed to log resource creation:', err.message);
          });
      });

      return originalJson(body);
    };

    next();
  };
};

/**
 * Log resource update with changes
 */
export const auditResourceUpdate = (
  resourceType: string,
  action: AuditAction,
  getOriginalData?: (req: Request) => Promise<any>
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    const resourceId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;

    let originalData: any = null;
    if (getOriginalData) {
      try {
        originalData = await getOriginalData(req);
      } catch (error: unknown) {
        logger.warn('Failed to fetch original data for audit:', asError(error));
      }
    }

    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      const success = res.statusCode >= 200 && res.statusCode < 400;

      setImmediate(() => {
        const changes: Record<string, any> = {};
        if (originalData && body?.data) {
          Object.keys(req.body).forEach((key) => {
            if (originalData[key] !== req.body[key]) {
              changes[key] = {
                before: originalData[key],
                after: req.body[key],
              };
            }
          });
        }

        auditLogService
          .log({
            actorId: authReq.user_id,
            actorRole: authReq.user?.role,
            actorEmail: authReq.user?.email,
            action,
            targetResourceType: resourceType,
            targetResourceId: resourceId,
            changes: Object.keys(changes).length > 0 ? changes : undefined,
            success,
            req,
          })
          .catch((err: any) => {
            logger.error('Failed to log resource update:', err.message);
          });
      });

      return originalJson(body);
    };

    next();
  };
};

/**
 * Log resource deletion
 */
export const auditResourceDeletion = (
  resourceType: string,
  action: AuditAction
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    const resourceId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;

    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      const success = res.statusCode >= 200 && res.statusCode < 400;

      setImmediate(() => {
        auditLogService
          .log({
            actorId: authReq.user_id,
            actorRole: authReq.user?.role,
            actorEmail: authReq.user?.email,
            action,
            targetResourceType: resourceType,
            targetResourceId: resourceId,
            success,
            req,
          })
          .catch((err: any) => {
            logger.error('Failed to log resource deletion:', err.message);
          });
      });

      return originalJson(body);
    };

    next();
  };
};

/**
 * Log user management actions
 */
export const auditUserManagement = (action: AuditAction) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    const rawId = req.params.id || req.params.userId;
    const targetUserId = Array.isArray(rawId) ? rawId[0] : rawId;

    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      const success = res.statusCode >= 200 && res.statusCode < 400;

      setImmediate(() => {
        auditLogService
          .log({
            actorId: authReq.user_id,
            actorRole: authReq.user?.role,
            actorEmail: authReq.user?.email,
            action,
            targetUserId,
            targetRole: body?.data?.role,
            changes: req.body,
            success,
            req,
          })
          .catch((err: any) => {
            logger.error('Failed to log user management action:', err.message);
          });
      });

      return originalJson(body);
    };

    next();
  };
};

/**
 * Log authentication events
 */
export const auditAuth = (action: AuditAction) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      const success = res.statusCode >= 200 && res.statusCode < 400;
      const userId = body?.data?.user?._id || body?.data?.userId;

      setImmediate(() => {
        auditLogService
          .log({
            actorId: userId,
            actorEmail: req.body.email,
            action,
            success,
            errorMessage: success ? undefined : body?.message,
            metadata: {
              email: req.body.email,
              loginMethod: req.body.loginMethod || 'email',
            },
            req,
          })
          .catch((err: any) => {
            logger.error('Failed to log auth event:', err.message);
          });
      });

      return originalJson(body);
    };

    next();
  };
};
