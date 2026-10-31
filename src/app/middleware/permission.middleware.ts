import { Request, Response, NextFunction } from 'express';
import { sendError } from '../shared/helper';
import { Permission } from '../types/permissions.types';
import { UserPlanContext } from '../types/plan.types';
import { AuthenticatedRequest } from './access.middleware';
import { errorMessageService } from '../services/error-message.service';
import logger from '../services/logger.service';

/**
 * Extended authenticated request that includes plan context.
 * Set by `attachPlanContext` middleware (see plan.middleware.ts).
 */
export interface PlanRequest extends AuthenticatedRequest {
  planContext?: UserPlanContext;
}

/**
 * requirePermission
 *
 * Middleware factory that checks whether the authenticated user's plan
 * context includes a specific permission.
 *
 * IMPORTANT: Must be used AFTER `verifyAccessToken` AND `attachPlanContext`.
 *
 * @param permission - The required permission string
 * @returns Express middleware
 *
 * @example
 * router.post('/export', verifyAccessToken, attachPlanContext, requirePermission(Permission.EXPENSE_EXPORT), handler)
 */
export const requirePermission = (permission: Permission) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const planReq = req as PlanRequest;

      if (!planReq.planContext) {
        logger.warn(
          'requirePermission called without planContext. Ensure attachPlanContext runs first.'
        );
        return sendError(
          res,
          'Plan context not initialized',
          500,
          'INTERNAL_ERROR'
        );
      }

      const { permissions, planSlug, isExpired } = planReq.planContext;

      // Reject if plan is expired (only affects paid features)
      if (isExpired && !permissions.includes(permission)) {
        logger.warn(
          `Permission denied (expired plan): user=${planReq.user_id} permission=${permission}`
        );
        return sendError(
          res,
          'Your subscription has expired. Please renew to access this feature.',
          403,
          'PLAN_EXPIRED'
        );
      }

      // Check if the permission is included
      if (!permissions.includes(permission)) {
        logger.warn(
          `Permission denied: user=${planReq.user_id} plan=${planSlug} missing=${permission}`
        );

        // Generate enhanced error message with upgrade suggestions
        const errorDetails = errorMessageService.getPermissionDeniedMessage({
          permission,
          currentPlan: planSlug,
        });

        return sendError(res, errorDetails.message, 403, 'PERMISSION_DENIED', {
          permission,
          currentPlan: planSlug,
          requiredPlan: errorDetails.requiredPlan,
          suggestion: errorDetails.suggestion,
          upgradeUrl: errorDetails.upgradeUrl,
          learnMoreUrl: errorDetails.learnMoreUrl,
        });
      }

      logger.debug(
        `Permission granted: user=${planReq.user_id} permission=${permission}`
      );
      next();
    } catch (error: any) {
      logger.error('Error in requirePermission middleware:', error.message);
      return sendError(
        res,
        'Authorization check failed',
        500,
        'INTERNAL_ERROR'
      );
    }
  };
};

/**
 * requireAnyPermission
 *
 * Grants access if the user has AT LEAST ONE of the listed permissions.
 * Useful for resources that can be accessed by multiple roles/plans.
 *
 * @param permissions - Array of acceptable permissions (OR logic)
 */
export const requireAnyPermission = (permissions: Permission[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const planReq = req as PlanRequest;

      if (!planReq.planContext) {
        return sendError(
          res,
          'Plan context not initialized',
          500,
          'INTERNAL_ERROR'
        );
      }

      const userPermissions = planReq.planContext.permissions;
      const hasAny = permissions.some((p) => userPermissions.includes(p));

      if (!hasAny) {
        return sendError(
          res,
          'You do not have the required permissions to perform this action.',
          403,
          'PERMISSION_DENIED',
          {
            requiredAnyOf: permissions,
            currentPlan: planReq.planContext.planSlug,
          }
        );
      }

      next();
    } catch (error: any) {
      logger.error('Error in requireAnyPermission middleware:', error.message);
      return sendError(
        res,
        'Authorization check failed',
        500,
        'INTERNAL_ERROR'
      );
    }
  };
};

/**
 * requireAllPermissions
 *
 * Grants access only if the user has ALL listed permissions (AND logic).
 *
 * @param permissions - All permissions must be present
 */
export const requireAllPermissions = (permissions: Permission[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const planReq = req as PlanRequest;

      if (!planReq.planContext) {
        return sendError(
          res,
          'Plan context not initialized',
          500,
          'INTERNAL_ERROR'
        );
      }

      const userPermissions = planReq.planContext.permissions;
      const missing = permissions.filter((p) => !userPermissions.includes(p));

      if (missing.length > 0) {
        return sendError(
          res,
          'You do not have all required permissions to perform this action.',
          403,
          'PERMISSION_DENIED',
          {
            missingPermissions: missing,
            currentPlan: planReq.planContext.planSlug,
          }
        );
      }

      next();
    } catch (error: any) {
      logger.error('Error in requireAllPermissions middleware:', error.message);
      return sendError(
        res,
        'Authorization check failed',
        500,
        'INTERNAL_ERROR'
      );
    }
  };
};
