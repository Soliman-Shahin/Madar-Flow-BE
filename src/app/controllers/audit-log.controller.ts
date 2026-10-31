import { Request, Response } from 'express';
import { auditLogService } from '../services/audit-log.service';
import { AuditAction, AuditSeverity } from '../models/audit-log.model';
import { sendSuccess, sendError } from '../shared/helper';
import logger from '../services/logger.service';

/**
 * Audit Log Controller
 *
 * Handles HTTP requests for audit log queries and statistics
 */
class AuditLogController {
  /**
   * Get audit logs with filters
   * GET /api/v1/audit-logs
   */
  async getLogs(req: Request, res: Response): Promise<void> {
    try {
      const {
        actorId,
        targetUserId,
        action,
        severity,
        success,
        startDate,
        endDate,
        limit,
        skip,
        sortBy,
        sortOrder,
      } = req.query;

      const filters: any = {};

      if (actorId) filters.actorId = actorId as string;
      if (targetUserId) filters.targetUserId = targetUserId as string;
      if (action) {
        filters.action = Array.isArray(action)
          ? (action as AuditAction[])
          : (action as AuditAction);
      }
      if (severity) {
        filters.severity = Array.isArray(severity)
          ? (severity as AuditSeverity[])
          : (severity as AuditSeverity);
      }
      if (success !== undefined) filters.success = success === 'true';
      if (startDate) filters.startDate = new Date(startDate as string);
      if (endDate) filters.endDate = new Date(endDate as string);
      if (limit) filters.limit = parseInt(limit as string, 10);
      if (skip) filters.skip = parseInt(skip as string, 10);
      if (sortBy) filters.sortBy = sortBy as string;
      if (sortOrder) filters.sortOrder = sortOrder as 'asc' | 'desc';

      const result = await auditLogService.query(filters);

      sendSuccess(res, result, 'Audit logs retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting audit logs:', error.message);
      sendError(res, 'Failed to retrieve audit logs', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get audit logs for a specific user
   * GET /api/v1/audit-logs/user/:userId
   */
  async getUserLogs(req: Request, res: Response): Promise<void> {
    try {
      const rawUserId = req.params.userId;
      const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
      const { limit, skip } = req.query;

      const options = {
        limit: limit ? parseInt(limit as string, 10) : undefined,
        skip: skip ? parseInt(skip as string, 10) : undefined,
      };

      const result = await auditLogService.getUserLogs(userId, options);

      sendSuccess(res, result, 'User audit logs retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting user audit logs:', error.message);
      sendError(
        res,
        'Failed to retrieve user audit logs',
        500,
        'INTERNAL_ERROR'
      );
    }
  }

  /**
   * Get recent security events
   * GET /api/v1/audit-logs/security/recent
   */
  async getRecentSecurityEvents(req: Request, res: Response): Promise<void> {
    try {
      const { limit } = req.query;
      const limitNum = limit ? parseInt(limit as string, 10) : 100;

      const logs = await auditLogService.getRecentSecurityEvents(limitNum);

      sendSuccess(
        res,
        { logs },
        'Recent security events retrieved successfully'
      );
    } catch (error: any) {
      logger.error('Error getting recent security events:', error.message);
      sendError(
        res,
        'Failed to retrieve recent security events',
        500,
        'INTERNAL_ERROR'
      );
    }
  }

  /**
   * Get audit log statistics
   * GET /api/v1/audit-logs/stats
   */
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = req.query;

      if (!startDate || !endDate) {
        return sendError(
          res,
          'startDate and endDate are required',
          400,
          'VALIDATION_ERROR'
        );
      }

      const start = new Date(startDate as string);
      const end = new Date(endDate as string);

      const stats = await auditLogService.getStats(start, end);

      sendSuccess(res, stats, 'Audit log statistics retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting audit log stats:', error.message);
      sendError(
        res,
        'Failed to retrieve audit log statistics',
        500,
        'INTERNAL_ERROR'
      );
    }
  }

  /**
   * Delete old audit logs (cleanup)
   * DELETE /api/v1/audit-logs/cleanup
   */
  async cleanup(req: Request, res: Response): Promise<void> {
    try {
      const { olderThanDays } = req.query;

      if (!olderThanDays) {
        return sendError(
          res,
          'olderThanDays parameter is required',
          400,
          'VALIDATION_ERROR'
        );
      }

      const days = parseInt(olderThanDays as string, 10);
      if (isNaN(days) || days < 1) {
        return sendError(
          res,
          'olderThanDays must be a positive number',
          400,
          'VALIDATION_ERROR'
        );
      }

      const deletedCount = await auditLogService.deleteOldLogs(days);

      sendSuccess(
        res,
        {
          deletedCount,
          olderThanDays: days,
        },
        `Deleted ${deletedCount} old audit logs`
      );
    } catch (error: any) {
      logger.error('Error cleaning up audit logs:', error.message);
      sendError(res, 'Failed to cleanup audit logs', 500, 'INTERNAL_ERROR');
    }
  }
}

export const auditLogController = new AuditLogController();
