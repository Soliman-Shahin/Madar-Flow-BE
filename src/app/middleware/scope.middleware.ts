import { errorMessage, asError } from '../shared/errors';
import { Request, Response, NextFunction } from 'express';
import { sendError } from '../shared/helper';
import { PlanRequest } from './permission.middleware';
import {
  PermissionScope,
  hasScope,
  hasAnyScope,
  hasAllScopes,
} from '../types/permission-scopes.types';
import { errorMessageService } from '../services/error-message.service';
import logger from '../services/logger.service';

/**
 * Scope Middleware
 *
 * Higher-level permission checks using scopes instead of individual permissions.
 * Scopes group related permissions for easier management.
 */

/**
 * requireScope
 *
 * Middleware factory that checks if the user has a specific permission scope.
 * A scope is a logical grouping of related permissions.
 *
 * IMPORTANT: Must be used AFTER `verifyAccessToken` AND `attachPlanContext`.
 *
 * @param scope - The required permission scope
 * @returns Express middleware
 *
 * @example
 * router.post('/export', verifyAccessToken, attachPlanContext, requireScope(PermissionScope.EXPENSES_FULL), handler)
 */
export const requireScope = (scope: PermissionScope) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const planReq = req as PlanRequest;

      if (!planReq.planContext) {
        logger.warn(
          'requireScope called without planContext. Ensure attachPlanContext runs first.'
        );
        return sendError(
          res,
          'Plan context not initialized',
          500,
          'INTERNAL_ERROR'
        );
      }

      const { permissions, planSlug, isExpired } = planReq.planContext;

      // Reject if plan is expired
      if (isExpired) {
        logger.warn(
          `Scope denied (expired plan): user=${planReq.user_id} scope=${scope}`
        );
        return sendError(
          res,
          'Your subscription has expired. Please renew to access this feature.',
          403,
          'PLAN_EXPIRED'
        );
      }

      // Check if the user has the required scope
      if (!hasScope(permissions, scope)) {
        logger.warn(
          `Scope denied: user=${planReq.user_id} plan=${planSlug} missing=${scope}`
        );

        const errorDetails = errorMessageService.getScopeDeniedMessage({
          scope,
          currentPlan: planSlug,
        });

        return sendError(res, errorDetails.message, 403, 'SCOPE_DENIED', {
          scope,
          currentPlan: planSlug,
          requiredPlan: errorDetails.requiredPlan,
          suggestion: errorDetails.suggestion,
          upgradeUrl: errorDetails.upgradeUrl,
        });
      }

      logger.debug(`Scope granted: user=${planReq.user_id} scope=${scope}`);
      next();
    } catch (error: unknown) {
      logger.error('Error in requireScope middleware:', asError(error));
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
 * requireAnyScope
 *
 * Grants access if the user has AT LEAST ONE of the listed scopes.
 * Useful for resources that can be accessed by multiple feature sets.
 *
 * @param scopes - Array of acceptable scopes (OR logic)
 */
export const requireAnyScope = (scopes: PermissionScope[]) => {
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

      const { permissions, isExpired } = planReq.planContext;

      if (isExpired) {
        return sendError(
          res,
          'Your subscription has expired.',
          403,
          'PLAN_EXPIRED'
        );
      }

      if (!hasAnyScope(permissions, scopes)) {
        return sendError(
          res,
          'You do not have the required feature access to perform this action.',
          403,
          'SCOPE_DENIED',
          {
            requiredAnyOf: scopes,
            currentPlan: planReq.planContext.planSlug,
          }
        );
      }

      next();
    } catch (error: unknown) {
      logger.error('Error in requireAnyScope middleware:', asError(error));
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
 * requireAllScopes
 *
 * Grants access only if the user has ALL of the listed scopes.
 * Useful for operations that require multiple feature sets.
 *
 * @param scopes - Array of required scopes (AND logic)
 */
export const requireAllScopes = (scopes: PermissionScope[]) => {
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

      const { permissions, isExpired } = planReq.planContext;

      if (isExpired) {
        return sendError(
          res,
          'Your subscription has expired.',
          403,
          'PLAN_EXPIRED'
        );
      }

      if (!hasAllScopes(permissions, scopes)) {
        return sendError(
          res,
          'You do not have all the required feature access to perform this action.',
          403,
          'SCOPE_DENIED',
          {
            requiredAll: scopes,
            currentPlan: planReq.planContext.planSlug,
          }
        );
      }

      next();
    } catch (error: unknown) {
      logger.error('Error in requireAllScopes middleware:', asError(error));
      return sendError(
        res,
        'Authorization check failed',
        500,
        'INTERNAL_ERROR'
      );
    }
  };
};
