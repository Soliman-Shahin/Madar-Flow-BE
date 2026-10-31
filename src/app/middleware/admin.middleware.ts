import { errorMessage, asError } from '../shared/errors';
import { Request, Response, NextFunction } from 'express';
import { sendError } from '../shared/helper';
import logger from '../services/logger.service';
import { User, UserRole, ROLE_WEIGHTS } from '../models/user.model';
import { AuthenticatedRequest } from './access.middleware';

/**
 * requireRole
 *
 * Middleware factory that verifies the authenticated user has at least one of
 * the specified roles. Roles are checked against the database (not the JWT)
 * to reflect real-time changes (e.g., role revocation).
 *
 * The check uses role weights, so passing `UserRole.Admin` will also allow
 * `UserRole.SuperAdmin` (since superadmin > admin in privilege).
 *
 * IMPORTANT: Must be used AFTER `verifyAccessToken`.
 *
 * @param allowedRoles - One or more roles that are permitted
 * @returns Express middleware
 *
 * @example
 * // Allow admin AND superadmin
 * router.use(verifyAccessToken, requireRole(UserRole.Admin));
 *
 * // Allow only superadmin
 * router.use(verifyAccessToken, requireRole(UserRole.SuperAdmin));
 *
 * // Allow moderator, admin, and superadmin
 * router.use(verifyAccessToken, requireRole(UserRole.Moderator));
 */
export const requireRole = (...allowedRoles: UserRole[]) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user_id;

      if (!userId) {
        logger.warn(
          'requireRole: no user_id on request (verifyAccessToken missing?)'
        );
        sendError(res, 'Authentication required', 401, 'AUTH_NO_TOKEN');
        return;
      }

      const userRole = authReq.user?.role;

      if (!userRole) {
        logger.warn(
          'requireRole: user role not found on request (verifyAccessToken missing role?)'
        );
        sendError(res, 'Authentication required', 401, 'AUTH_NO_TOKEN');
        return;
      }

      const userWeight = ROLE_WEIGHTS[userRole] ?? 0;

      // The minimum weight required is the lowest weight among allowedRoles.
      // e.g., requireRole(Admin) => any role with weight >= Admin is accepted.
      const minRequiredWeight = Math.min(
        ...allowedRoles.map((r) => ROLE_WEIGHTS[r] ?? 0)
      );

      if (userWeight < minRequiredWeight) {
        logger.warn(
          `requireRole: access denied. user=${userId} role=${userRole} required=${allowedRoles.join('|')}`
        );
        sendError(
          res,
          `Insufficient permissions. Required role: ${allowedRoles.join(' or ')}.`,
          403,
          'AUTHZ_INSUFFICIENT_PERMISSIONS',
          { userRole, requiredRoles: allowedRoles }
        );
        return;
      }

      logger.debug(
        `requireRole: access granted. user=${userId} role=${userRole}`
      );
      next();
    } catch (error: unknown) {
      logger.error('Error in requireRole middleware:', asError(error));
      sendError(
        res,
        'Internal server error during authorization',
        500,
        'INTERNAL_ERROR'
      );
    }
  };
};

/**
 * requireAdmin
 *
 * Backward-compatible alias for `requireRole(UserRole.Admin)`.
 * Allows Admin AND SuperAdmin (since superadmin has a higher weight).
 *
 * @deprecated Prefer `requireRole(UserRole.Admin)` for explicitness.
 */
export const requireAdmin = requireRole(UserRole.Admin);

/**
 * requireSuperAdmin
 *
 * Allows only SuperAdmin users.
 */
export const requireSuperAdmin = requireRole(UserRole.SuperAdmin);

/**
 * requireModerator
 *
 * Allows Moderator, Admin, and SuperAdmin users.
 * Use for read-only admin panel sections.
 */
export const requireModerator = requireRole(UserRole.Moderator);
