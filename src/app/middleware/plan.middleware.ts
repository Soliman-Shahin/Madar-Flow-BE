import { Request, Response, NextFunction } from 'express';
import { sendError } from '../shared/helper';
import { planService } from '../services/plan.service';
import { permissionCacheService } from '../services/permission-cache.service';
import { temporaryPermissionService } from '../services/temporary-permission.service';
import { errorMessageService } from '../services/error-message.service';
import { UserPlanContext, PlanLimits } from '../types/plan.types';
import { AuthenticatedRequest } from './access.middleware';
import { PlanRequest } from './permission.middleware';
import logger from '../services/logger.service';

// ─────────────────────────────────────────────────────────────────────────────
// attachPlanContext
// ─────────────────────────────────────────────────────────────────────────────

/**
 * attachPlanContext
 *
 * Fetches the authenticated user's plan context (permissions + limits)
 * and attaches it to `req.planContext` for downstream middleware/controllers.
 *
 * This middleware is designed to be lightweight: the plan document is cached
 * in memory (via the Plan model) and only the user's plan slug is stored on
 * the user document, keeping the DB query minimal.
 *
 * IMPORTANT: Must be used AFTER `verifyAccessToken`.
 *
 * @example
 * router.use(verifyAccessToken, attachPlanContext);
 */
export const attachPlanContext = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user_id;

    if (!userId) {
      logger.warn('attachPlanContext: no user_id on request');
      sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      return;
    }

    // Use cache for better performance. The cache does not clone
    // (useClones: false), so copy before adding request-scoped temporary
    // permissions; mutating the cached object would keep them alive after
    // they expire.
    const cachedContext =
      await permissionCacheService.getUserPlanContext(userId);
    const planContext = {
      ...cachedContext,
      permissions: [...cachedContext.permissions],
    };

    logger.debug('[SUBSCRIPTION-BE-TRACE][PLAN-CONTEXT]', {
      plan: planContext.planSlug,
      cached: permissionCacheService.isCached(userId),
      expired: planContext.isExpired,
    });

    // Add temporary permissions to the context
    const tempPermissions =
      await temporaryPermissionService.getActivePermissionsList(userId);
    if (tempPermissions.length > 0) {
      // Merge temporary permissions with plan permissions (avoid duplicates)
      const allPermissions = [
        ...new Set([...planContext.permissions, ...tempPermissions]),
      ];
      planContext.permissions = allPermissions;

      logger.debug(
        `Added ${tempPermissions.length} temporary permissions for user ${userId}`
      );
    }

    (req as PlanRequest).planContext = planContext;

    logger.debug(
      `Plan context attached (cached=${permissionCacheService.isCached(userId)}): user=${userId} plan=${planContext.planSlug} expired=${planContext.isExpired} permissions=${planContext.permissions.length}`
    );

    next();
  } catch (error: any) {
    logger.error('Error in attachPlanContext:', error.message);
    sendError(res, 'Failed to load plan context', 500, 'INTERNAL_ERROR');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// checkPlanLimit
// ─────────────────────────────────────────────────────────────────────────────

type LimitType = 'categories' | 'transactions';

/**
 * checkPlanLimit
 *
 * Middleware factory that checks if the user has reached a specific plan
 * usage limit before allowing a create operation.
 *
 * IMPORTANT: Must be used AFTER `verifyAccessToken` AND `attachPlanContext`.
 *
 * @param limitType - Which limit to check ('categories' | 'transactions')
 * @returns Express middleware that blocks with 403 if the limit is reached
 *
 * @example
 * router.post('/create', verifyAccessToken, attachPlanContext, checkPlanLimit('categories'), createCategory)
 */
export const checkPlanLimit = (limitType: LimitType) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const planReq = req as PlanRequest;
      const userId = (req as AuthenticatedRequest).user_id;

      if (!userId) {
        sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
        return;
      }

      if (!planReq.planContext) {
        logger.warn(
          'checkPlanLimit: planContext missing, ensure attachPlanContext runs first'
        );
        sendError(res, 'Plan context not initialized', 500, 'INTERNAL_ERROR');
        return;
      }

      switch (limitType) {
        case 'categories':
          await planService.checkCategoryLimit(userId, planReq.planContext);
          break;
        case 'transactions':
          await planService.checkTransactionLimit(userId, planReq.planContext);
          break;
        default:
          logger.error(`checkPlanLimit: unknown limitType "${limitType}"`);
          sendError(res, 'Internal configuration error', 500, 'INTERNAL_ERROR');
          return;
      }

      next();
    } catch (error: any) {
      // PlanLimitError has statusCode 403 and code 'PLAN_LIMIT_EXCEEDED'
      if (error.code === 'PLAN_LIMIT_EXCEEDED') {
        sendError(
          res,
          error.message,
          403,
          'PLAN_LIMIT_EXCEEDED',
          error.details
        );
        return;
      }
      logger.error('Error in checkPlanLimit middleware:', error.message);
      sendError(res, 'Failed to check plan limits', 500, 'INTERNAL_ERROR');
    }
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// rejectExpiredPlan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * rejectExpiredPlan
 *
 * Middleware that blocks access if the user's paid plan has expired.
 * Typically used on routes that require a paid plan feature.
 *
 * Users on the free plan (which never expires) are not affected.
 */
export const rejectExpiredPlan = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const planReq = req as PlanRequest;

  if (!planReq.planContext) {
    sendError(res, 'Plan context not initialized', 500, 'INTERNAL_ERROR');
    return;
  }

  if (planReq.planContext.isExpired) {
    const errorDetails = errorMessageService.getPlanExpiredMessage({
      plan: planReq.planContext.planSlug,
      expiredAt: planReq.planContext.planExpiresAt!,
    });

    sendError(res, errorDetails.message, 403, 'PLAN_EXPIRED', {
      expiredAt: planReq.planContext.planExpiresAt,
      daysExpired: errorDetails.daysExpired,
      suggestion: errorDetails.suggestion,
      renewUrl: errorDetails.renewUrl,
    });
    return;
  }

  next();
};
