import { Request } from 'express';
import { AuditAction } from '../models/audit-log.model';
import { UserRole } from '../models';
import { auditLogService } from './audit-log.service';
import { getSocketService } from './socket.service';
import logger from './logger.service';

export interface AuditNotifyParams {
  req?: Request;
  actorId?: string;
  actorEmail?: string;
  actorRole?: UserRole;
  action: AuditAction;
  notification: {
    title: string;
    message: string;
    type: 'info' | 'success' | 'warn' | 'error';
  };
  changes?: Record<string, any>;
  targetUserId?: string;
  targetResourceType?: string;
  targetResourceId?: string;
}

/**
 * Records an audit-log entry and pushes the same event to staff dashboards in realtime.
 *
 * The single place for this behaviour: audit events must reach staff rooms only (never every
 * connected socket, see D-032), and a failure in either step must never fail the business
 * operation that triggered it.
 */
export async function auditAndNotifyStaff(params: AuditNotifyParams): Promise<void> {
  let auditLogId: string | undefined;

  try {
    const auditLog = await auditLogService.log({
      req: params.req,
      actorId: params.actorId,
      actorEmail: params.actorEmail,
      actorRole: params.actorRole,
      action: params.action,
      targetUserId: params.targetUserId,
      targetResourceType: params.targetResourceType,
      targetResourceId: params.targetResourceId,
      changes: params.changes,
    });
    auditLogId = auditLog._id.toString();
  } catch (err) {
    logger.error('Failed to log audit event in auditAndNotifyStaff', err as Error);
  }

  try {
    getSocketService().broadcastToStaff({
      title: params.notification.title,
      message: params.notification.message,
      type: params.notification.type,
      action: params.action,
      actor: { id: params.actorId, email: params.actorEmail, role: params.actorRole },
      resource: {
        type: params.targetResourceType,
        id: params.targetResourceId,
        name: params.targetResourceType,
      },
      changes: params.changes,
      auditLogId,
    });
  } catch (err) {
    logger.error('Failed to broadcast socket notification in auditAndNotifyStaff', err as Error);
  }
}
