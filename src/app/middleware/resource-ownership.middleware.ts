import { errorMessage, asError } from '../shared/errors';
import { Request, Response, NextFunction } from 'express';
import { sendError } from '../shared/helper';
import { AuthenticatedRequest } from './access.middleware';
import { UserRole, ROLE_WEIGHTS } from '../models/user.model';
import { Expense } from '../models/expense.model';
import { Category } from '../models/category.model';
import { errorMessageService } from '../services/error-message.service';
import logger from '../services/logger.service';
import { auditLogService } from '../services/audit-log.service';
import { AuditAction } from '../models/audit-log.model';

/**
 * Resource Ownership Middleware
 *
 * Ensures users can only access/modify their own resources.
 * Admins can bypass ownership checks.
 */

export type ResourceType = 'expense' | 'category';

/**
 * Check if user owns the resource or has admin privileges
 */
export const requireOwnership = (resourceType: ResourceType) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const resourceId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      const userId = authReq.user_id;
      const userRole = authReq.user?.role;

      if (!userId) {
        logger.warn('requireOwnership: no user_id on request');
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      if (!resourceId) {
        logger.warn('requireOwnership: no resource id in params');
        return sendError(
          res,
          'Resource ID is required',
          400,
          'VALIDATION_ERROR'
        );
      }

      // Admins bypass ownership check
      if (userRole && ROLE_WEIGHTS[userRole] >= ROLE_WEIGHTS[UserRole.Admin]) {
        logger.debug(
          `Ownership check bypassed for ${userRole}: ${resourceType}/${resourceId}`
        );
        return next();
      }

      // Check ownership based on resource type
      const resource = await getResource(resourceType, resourceId);

      if (!resource) {
        logger.warn(
          `Resource not found: ${resourceType}/${resourceId} by user ${userId}`
        );

        // Log access denial
        await auditLogService.logAccessDenied({
          actorId: userId,
          actorRole: userRole,
          targetResourceType: resourceType,
          targetResourceId: resourceId,
          reason: 'Resource not found',
          req,
        });

        return sendError(
          res,
          `${capitalize(resourceType)} not found`,
          404,
          'RESOURCE_NOT_FOUND'
        );
      }

      // Check if user owns the resource
      const ownerId = resource.user?.toString();
      if (ownerId !== userId) {
        logger.warn(
          `Ownership denied: user ${userId} attempted to access ${resourceType}/${resourceId} owned by ${ownerId}`
        );

        // Log access denial
        await auditLogService.logAccessDenied({
          actorId: userId,
          actorRole: userRole,
          targetResourceType: resourceType,
          targetResourceId: resourceId,
          reason: 'User does not own this resource',
          req,
        });

        const errorDetails = errorMessageService.getAccessDeniedMessage({
          resourceType,
          resourceId,
          reason: 'You do not own this resource',
        });

        return sendError(res, errorDetails.message, 403, 'RESOURCE_NOT_OWNED', {
          resourceType,
          resourceId,
          suggestion: errorDetails.suggestion,
          helpUrl: errorDetails.helpUrl,
        });
      }

      logger.debug(
        `Ownership verified: user ${userId} owns ${resourceType}/${resourceId}`
      );

      // Attach resource to request for downstream use (optional optimization)
      (req as any).resource = resource;

      next();
    } catch (error: unknown) {
      logger.error('Error in requireOwnership middleware:', asError(error));
      return sendError(
        res,
        'Failed to verify resource ownership',
        500,
        'INTERNAL_ERROR'
      );
    }
  };
};

/**
 * Check if user can access resource (read-only check)
 * More lenient than requireOwnership - allows shared resources in the future
 */
export const canAccessResource = (resourceType: ResourceType) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const resourceId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      const userId = authReq.user_id;
      const userRole = authReq.user?.role;

      if (!userId) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      if (!resourceId) {
        return sendError(
          res,
          'Resource ID is required',
          400,
          'VALIDATION_ERROR'
        );
      }

      // Admins can access any resource
      if (userRole && ROLE_WEIGHTS[userRole] >= ROLE_WEIGHTS[UserRole.Admin]) {
        return next();
      }

      const resource = await getResource(resourceType, resourceId);

      if (!resource) {
        await auditLogService.logAccessDenied({
          actorId: userId,
          actorRole: userRole,
          targetResourceType: resourceType,
          targetResourceId: resourceId,
          reason: 'Resource not found',
          req,
        });

        return sendError(
          res,
          `${capitalize(resourceType)} not found`,
          404,
          'RESOURCE_NOT_FOUND'
        );
      }

      const ownerId = resource.user?.toString();

      // For now, only owner can access
      // In the future, this can be extended to check shared resources
      if (ownerId !== userId) {
        await auditLogService.logAccessDenied({
          actorId: userId,
          actorRole: userRole,
          targetResourceType: resourceType,
          targetResourceId: resourceId,
          reason: 'Access denied - not owner',
          req,
        });

        return sendError(
          res,
          'You do not have permission to access this resource',
          403,
          'ACCESS_DENIED'
        );
      }

      (req as any).resource = resource;
      next();
    } catch (error: unknown) {
      logger.error('Error in canAccessResource middleware:', asError(error));
      return sendError(
        res,
        'Failed to verify resource access',
        500,
        'INTERNAL_ERROR'
      );
    }
  };
};

/**
 * Bulk ownership check for multiple resources
 * Used in batch operations (e.g., delete multiple expenses)
 */
export const requireBulkOwnership = (resourceType: ResourceType) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user_id;
      const userRole = authReq.user?.role;
      const { ids } = req.body;

      if (!userId) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      if (!Array.isArray(ids) || ids.length === 0) {
        return sendError(
          res,
          'ids must be a non-empty array',
          400,
          'VALIDATION_ERROR'
        );
      }

      // Admins bypass ownership check
      if (userRole && ROLE_WEIGHTS[userRole] >= ROLE_WEIGHTS[UserRole.Admin]) {
        return next();
      }

      // Check ownership for all resources
      const resources = await getResources(resourceType, ids);

      if (resources.length !== ids.length) {
        const foundIds = resources.map((r: any) => r._id.toString());
        const missingIds = ids.filter((id: string) => !foundIds.includes(id));

        logger.warn(
          `Bulk ownership check: ${missingIds.length} resources not found`
        );

        return sendError(
          res,
          `Some ${resourceType}s not found`,
          404,
          'RESOURCES_NOT_FOUND',
          { missingIds }
        );
      }

      // Check if user owns all resources
      const notOwnedResources = resources.filter(
        (r: any) => r.user?.toString() !== userId
      );

      if (notOwnedResources.length > 0) {
        const notOwnedIds = notOwnedResources.map((r: any) => r._id.toString());

        logger.warn(
          `Bulk ownership denied: user ${userId} does not own ${notOwnedIds.length} resources`
        );

        await auditLogService.logAccessDenied({
          actorId: userId,
          actorRole: userRole,
          targetResourceType: resourceType,
          reason: `Attempted to access ${notOwnedIds.length} resources not owned by user`,
          req,
        });

        return sendError(
          res,
          'You do not have permission to access some of these resources',
          403,
          'BULK_OWNERSHIP_DENIED',
          { notOwnedIds }
        );
      }

      logger.debug(
        `Bulk ownership verified: user ${userId} owns all ${ids.length} ${resourceType}s`
      );

      (req as any).resources = resources;
      next();
    } catch (error: unknown) {
      logger.error('Error in requireBulkOwnership middleware:', asError(error));
      return sendError(
        res,
        'Failed to verify bulk resource ownership',
        500,
        'INTERNAL_ERROR'
      );
    }
  };
};

/**
 * Helper: Get a single resource by ID
 */
async function getResource(
  resourceType: ResourceType,
  resourceId: string
): Promise<any | null> {
  try {
    switch (resourceType) {
      case 'expense':
        return await Expense.findById(resourceId).select('user').lean();
      case 'category':
        return await Category.findById(resourceId).select('user').lean();
      default:
        throw new Error(`Unknown resource type: ${resourceType}`);
    }
  } catch (error: unknown) {
    logger.error(`Error fetching ${resourceType}:`, asError(error));
    return null;
  }
}

/**
 * Helper: Get multiple resources by IDs
 */
async function getResources(
  resourceType: ResourceType,
  resourceIds: string[]
): Promise<any[]> {
  try {
    switch (resourceType) {
      case 'expense':
        return await Expense.find({ _id: { $in: resourceIds } })
          .select('user')
          .lean();
      case 'category':
        return await Category.find({ _id: { $in: resourceIds } })
          .select('user')
          .lean();
      default:
        throw new Error(`Unknown resource type: ${resourceType}`);
    }
  } catch (error: unknown) {
    logger.error(`Error fetching ${resourceType}s:`, asError(error));
    return [];
  }
}

/**
 * Helper: Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
