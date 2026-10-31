import { Request } from 'express';
import { AuditLog, AuditAction, AuditSeverity, IAuditLog } from '../models/audit-log.model';
import { UserRole } from '../models/user.model';
import logger from './logger.service';
import { redactSensitive } from '../shared/redact';

/**
 * Audit Log Service
 * 
 * Centralized service for logging all security-sensitive operations
 */
class AuditLogService {
  /**
   * Log an audit event
   */
  async log(params: {
    actorId?: string;
    actorRole?: UserRole;
    actorEmail?: string;
    action: AuditAction;
    severity?: AuditSeverity;
    targetUserId?: string;
    targetRole?: UserRole;
    targetResourceType?: string;
    targetResourceId?: string;
    changes?: Record<string, any>;
    metadata?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
    requestPath?: string;
    requestMethod?: string;
    success?: boolean;
    errorMessage?: string;
    req?: Request;
  }): Promise<IAuditLog> {
    try {
      // Extract request metadata if provided
      let ipAddress = params.ipAddress;
      let userAgent = params.userAgent;
      let requestPath = params.requestPath;
      let requestMethod = params.requestMethod;

      if (params.req) {
        ipAddress = ipAddress || this.getClientIp(params.req);
        userAgent = userAgent || params.req.get('user-agent');
        requestPath = requestPath || params.req.originalUrl || params.req.url;
        requestMethod = requestMethod || params.req.method;
      }

      const auditLog = new AuditLog({
        actorId: params.actorId,
        actorRole: params.actorRole,
        actorEmail: params.actorEmail,
        action: params.action,
        severity: params.severity || this.determineSeverity(params.action, params.success),
        targetUserId: params.targetUserId,
        targetRole: params.targetRole,
        targetResourceType: params.targetResourceType,
        targetResourceId: params.targetResourceId,
        changes: redactSensitive(params.changes),
        metadata: redactSensitive(params.metadata),
        ipAddress,
        userAgent,
        requestPath,
        requestMethod,
        success: params.success !== false,
        errorMessage: params.errorMessage,
        timestamp: new Date(),
      });

      await auditLog.save();
      
      // Log to console for critical events
      if (params.severity === AuditSeverity.CRITICAL || params.severity === AuditSeverity.ERROR) {
        logger.warn(`[AUDIT] ${params.action} by ${params.actorEmail || params.actorId || 'system'}`, {
          action: params.action,
          severity: params.severity,
          success: params.success,
        });
      }

      return auditLog;
    } catch (error: any) {
      logger.error('Failed to create audit log:', error.message);
      throw error;
    }
  }

  /**
   * Log a user action (convenience method)
   */
  async logUserAction(params: {
    actorId: string;
    actorRole: UserRole;
    actorEmail?: string;
    action: AuditAction;
    targetUserId?: string;
    changes?: Record<string, any>;
    metadata?: Record<string, any>;
    req?: Request;
  }): Promise<IAuditLog> {
    return this.log({
      ...params,
      severity: AuditSeverity.INFO,
    });
  }

  /**
   * Log a security event (convenience method)
   */
  async logSecurityEvent(params: {
    actorId?: string;
    action: AuditAction;
    success: boolean;
    errorMessage?: string;
    metadata?: Record<string, any>;
    req?: Request;
  }): Promise<IAuditLog> {
    return this.log({
      ...params,
      severity: params.success ? AuditSeverity.WARNING : AuditSeverity.ERROR,
    });
  }

  /**
   * Log a permission denial
   */
  async logPermissionDenied(params: {
    actorId?: string;
    actorRole?: UserRole;
    action: string;
    requiredPermission: string;
    currentPlan?: string;
    req?: Request;
  }): Promise<IAuditLog> {
    return this.log({
      actorId: params.actorId,
      actorRole: params.actorRole,
      action: AuditAction.PERMISSION_DENIED,
      severity: AuditSeverity.WARNING,
      success: false,
      metadata: {
        attemptedAction: params.action,
        requiredPermission: params.requiredPermission,
        currentPlan: params.currentPlan,
      },
      req: params.req,
    });
  }

  /**
   * Log an access denial
   */
  async logAccessDenied(params: {
    actorId?: string;
    actorRole?: UserRole;
    targetResourceType: string;
    targetResourceId?: string;
    reason: string;
    req?: Request;
  }): Promise<IAuditLog> {
    return this.log({
      actorId: params.actorId,
      actorRole: params.actorRole,
      action: AuditAction.ACCESS_DENIED,
      severity: AuditSeverity.WARNING,
      targetResourceType: params.targetResourceType,
      targetResourceId: params.targetResourceId,
      success: false,
      errorMessage: params.reason,
      req: params.req,
    });
  }

  /**
   * Query audit logs with filters
   */
  async query(filters: {
    actorId?: string;
    targetUserId?: string;
    action?: AuditAction | AuditAction[];
    severity?: AuditSeverity | AuditSeverity[];
    success?: boolean;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    skip?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ logs: IAuditLog[]; total: number }> {
    try {
      const query: any = {};

      if (filters.actorId) query.actorId = filters.actorId;
      if (filters.targetUserId) query.targetUserId = filters.targetUserId;
      if (filters.action) {
        query.action = Array.isArray(filters.action) 
          ? { $in: filters.action } 
          : filters.action;
      }
      if (filters.severity) {
        query.severity = Array.isArray(filters.severity)
          ? { $in: filters.severity }
          : filters.severity;
      }
      if (filters.success !== undefined) query.success = filters.success;

      if (filters.startDate || filters.endDate) {
        query.timestamp = {};
        if (filters.startDate) query.timestamp.$gte = filters.startDate;
        if (filters.endDate) query.timestamp.$lte = filters.endDate;
      }

      const limit = filters.limit || 50;
      const skip = filters.skip || 0;
      const sortBy = filters.sortBy || 'timestamp';
      const sortOrder = filters.sortOrder === 'asc' ? 1 : -1;

      const [logs, total] = await Promise.all([
        AuditLog.find(query)
          .sort({ [sortBy]: sortOrder })
          .limit(limit)
          .skip(skip)
          .lean(),
        AuditLog.countDocuments(query),
      ]);

      return { logs: logs as IAuditLog[], total };
    } catch (error: any) {
      logger.error('Failed to query audit logs:', error.message);
      throw error;
    }
  }

  /**
   * Get audit logs for a specific user
   */
  async getUserLogs(
    userId: string,
    options?: { limit?: number; skip?: number }
  ): Promise<{ logs: IAuditLog[]; total: number }> {
    return this.query({
      actorId: userId,
      limit: options?.limit,
      skip: options?.skip,
    });
  }

  /**
   * Get recent security events
   */
  async getRecentSecurityEvents(
    limit: number = 100
  ): Promise<IAuditLog[]> {
    const securityActions = [
      AuditAction.USER_LOGIN_FAILED,
      AuditAction.ACCESS_DENIED,
      AuditAction.PERMISSION_DENIED,
      AuditAction.RATE_LIMIT_EXCEEDED,
      AuditAction.PASSWORD_CHANGED,
      AuditAction.TWO_FACTOR_ENABLED,
      AuditAction.TWO_FACTOR_DISABLED,
    ];

    const result = await this.query({
      action: securityActions,
      limit,
      sortBy: 'timestamp',
      sortOrder: 'desc',
    });

    return result.logs;
  }

  /**
   * Get statistics for a time period
   */
  async getStats(startDate: Date, endDate: Date): Promise<{
    totalLogs: number;
    byAction: Record<string, number>;
    bySeverity: Record<string, number>;
    successRate: number;
    topActors: Array<{ actorId: string; count: number }>;
  }> {
    try {
      const stats = await AuditLog.aggregate([
        {
          $match: {
            timestamp: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $facet: {
            total: [{ $count: 'count' }],
            byAction: [
              { $group: { _id: '$action', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            bySeverity: [
              { $group: { _id: '$severity', count: { $sum: 1 } } },
            ],
            successRate: [
              { $group: { _id: '$success', count: { $sum: 1 } } },
            ],
            topActors: [
              { $match: { actorId: { $exists: true } } },
              { $group: { _id: '$actorId', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 10 },
              { $project: { actorId: '$_id', count: 1, _id: 0 } },
            ],
          },
        },
      ]);

      const result = stats[0];
      const totalLogs = result.total[0]?.count || 0;
      const successCount = result.successRate.find((s: any) => s._id === true)?.count || 0;

      return {
        totalLogs,
        byAction: result.byAction.reduce((acc: any, item: any) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        bySeverity: result.bySeverity.reduce((acc: any, item: any) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        successRate: totalLogs > 0 ? (successCount / totalLogs) * 100 : 0,
        topActors: result.topActors,
      };
    } catch (error: any) {
      logger.error('Failed to get audit log stats:', error.message);
      throw error;
    }
  }

  /**
   * Delete old audit logs (cleanup)
   */
  async deleteOldLogs(olderThanDays: number): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const result = await AuditLog.deleteMany({
        timestamp: { $lt: cutoffDate },
      });

      logger.info(`Deleted ${result.deletedCount} audit logs older than ${olderThanDays} days`);
      return result.deletedCount || 0;
    } catch (error: any) {
      logger.error('Failed to delete old audit logs:', error.message);
      throw error;
    }
  }

  /**
   * Helper: Determine severity based on action and success
   */
  private determineSeverity(action: AuditAction, success?: boolean): AuditSeverity {
    // Failed actions are more severe
    if (success === false) {
      if (action.includes('login') || action.includes('access') || action.includes('permission')) {
        return AuditSeverity.WARNING;
      }
      return AuditSeverity.ERROR;
    }

    // Critical actions
    const criticalActions = [
      AuditAction.ROLE_CHANGED,
      AuditAction.USER_DELETED,
      AuditAction.PLAN_DELETED,
    ];
    if (criticalActions.includes(action)) {
      return AuditSeverity.CRITICAL;
    }

    // Warning actions
    const warningActions = [
      AuditAction.PERMISSION_GRANTED,
      AuditAction.PERMISSION_REVOKED,
      AuditAction.PASSWORD_CHANGED,
    ];
    if (warningActions.includes(action)) {
      return AuditSeverity.WARNING;
    }

    return AuditSeverity.INFO;
  }

  /**
   * Helper: Extract client IP from request
   */
  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }
}

export const auditLogService = new AuditLogService();
