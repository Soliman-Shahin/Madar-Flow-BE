import { AppError } from '../shared/errors';
import { Request, Response } from 'express';
import { temporaryPermissionService } from '../services/temporary-permission.service';
import { Permission } from '../types/permissions.types';
import { sendSuccess, sendError } from '../shared/helper';
import { AuthenticatedRequest } from '../middleware/access.middleware';
import logger from '../services/logger.service';

/**
 * Temporary Permission Controller
 * 
 * Handles HTTP requests for temporary permission management
 */
class TemporaryPermissionController {
  /**
   * Grant a temporary permission
   * POST /api/v1/temporary-permissions
   */
  async grantPermission(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const grantedBy = authReq.user_id;

      if (!grantedBy) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      const { userId, permission, startDate, endDate, reason, metadata } = req.body;

      // Validation
      if (!userId || !permission || !startDate || !endDate) {
        return sendError(
          res,
          'Missing required fields: userId, permission, startDate, endDate',
          400,
          'VALIDATION_ERROR'
        );
      }

      if (!Object.values(Permission).includes(permission)) {
        return sendError(res, 'Invalid permission', 400, 'VALIDATION_ERROR');
      }

      const tempPermission = await temporaryPermissionService.grantPermission({
        userId,
        permission,
        grantedBy,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        reason,
        metadata,
      });

      sendSuccess(
        res,
        tempPermission,
        'Temporary permission granted successfully',
        201
      );
    } catch (error: any) {
      logger.error('Error granting temporary permission:', error.message);
      if (error instanceof AppError) {
        return sendError(res, error.message, error.statusCode, error.code);
      }
      sendError(res, error.message, 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Revoke a temporary permission
   * DELETE /api/v1/temporary-permissions/:id
   */
  async revokePermission(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const revokedBy = authReq.user_id;

      if (!revokedBy) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      const rawId = req.params.id;
      const tempPermissionId = Array.isArray(rawId) ? rawId[0] : rawId;
      const { reason } = req.body;

      const tempPermission = await temporaryPermissionService.revokePermission(
        tempPermissionId,
        revokedBy,
        reason
      );

      sendSuccess(res, tempPermission, 'Temporary permission revoked successfully');
    } catch (error: any) {
      logger.error('Error revoking temporary permission:', error.message);
      if (error instanceof AppError) {
        return sendError(res, error.message, error.statusCode, error.code);
      }
      sendError(res, error.message, 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Extend a temporary permission
   * PATCH /api/v1/temporary-permissions/:id/extend
   */
  async extendPermission(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const extendedBy = authReq.user_id;

      if (!extendedBy) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      const rawId = req.params.id;
      const tempPermissionId = Array.isArray(rawId) ? rawId[0] : rawId;
      const { newEndDate, reason } = req.body;

      if (!newEndDate) {
        return sendError(
          res,
          'Missing required field: newEndDate',
          400,
          'VALIDATION_ERROR'
        );
      }

      const tempPermission = await temporaryPermissionService.extendPermission(
        tempPermissionId,
        new Date(newEndDate),
        extendedBy,
        reason
      );

      sendSuccess(res, tempPermission, 'Temporary permission extended successfully');
    } catch (error: any) {
      logger.error('Error extending temporary permission:', error.message);
      if (error instanceof AppError) {
        return sendError(res, error.message, error.statusCode, error.code);
      }
      sendError(res, error.message, 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get active temporary permissions for a user
   * GET /api/v1/temporary-permissions/user/:userId
   */
  async getUserPermissions(req: Request, res: Response): Promise<void> {
    try {
      const rawUserId = req.params.userId;
      const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;

      const permissions = await temporaryPermissionService.getUserPermissions(userId);

      sendSuccess(
        res,
        permissions,
        'User temporary permissions retrieved successfully'
      );
    } catch (error: any) {
      logger.error('Error getting user temporary permissions:', error.message);
      sendError(res, 'Failed to retrieve permissions', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get active temporary permissions for current user
   * GET /api/v1/temporary-permissions/me
   */
  async getMyPermissions(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user_id;

      if (!userId) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      const permissions = await temporaryPermissionService.getActivePermissions(userId);

      sendSuccess(
        res,
        permissions,
        'Your temporary permissions retrieved successfully'
      );
    } catch (error: any) {
      logger.error('Error getting my temporary permissions:', error.message);
      sendError(res, 'Failed to retrieve permissions', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get permissions expiring soon
   * GET /api/v1/temporary-permissions/expiring-soon
   */
  async getExpiringSoon(req: Request, res: Response): Promise<void> {
    try {
      const hours = req.query.hours ? parseInt(req.query.hours as string, 10) : 24;

      const permissions = await temporaryPermissionService.getExpiringSoon(hours);

      sendSuccess(
        res,
        {
          permissions,
          count: permissions.length,
          hoursFromNow: hours,
        },
        'Expiring permissions retrieved successfully'
      );
    } catch (error: any) {
      logger.error('Error getting expiring permissions:', error.message);
      sendError(res, 'Failed to retrieve permissions', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get temporary permission statistics
   * GET /api/v1/temporary-permissions/stats
   */
  async getStatistics(req: Request, res: Response): Promise<void> {
    try {
      const stats = await temporaryPermissionService.getStatistics();

      sendSuccess(res, stats, 'Statistics retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting temporary permission statistics:', error.message);
      sendError(res, 'Failed to retrieve statistics', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Process expired permissions (manual trigger)
   * POST /api/v1/temporary-permissions/process-expired
   */
  async processExpired(req: Request, res: Response): Promise<void> {
    try {
      const processedCount = await temporaryPermissionService.processExpiredPermissions();

      sendSuccess(
        res,
        { processedCount },
        `Processed ${processedCount} expired permissions`
      );
    } catch (error: any) {
      logger.error('Error processing expired permissions:', error.message);
      sendError(res, 'Failed to process expired permissions', 500, 'INTERNAL_ERROR');
    }
  }
}

export const temporaryPermissionController = new TemporaryPermissionController();
