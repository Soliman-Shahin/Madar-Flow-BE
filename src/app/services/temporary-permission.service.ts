import { BadRequestError, ConflictError, NotFoundError } from '../shared/errors';
import mongoose from 'mongoose';
import { TemporaryPermission, ITemporaryPermission } from '../models/temporary-permission.model';
import { Permission } from '../types/permissions.types';
import { auditLogService } from './audit-log.service';
import { permissionCacheService } from './permission-cache.service';
import { AuditAction, AuditSeverity } from '../models/audit-log.model';
import { UserRole } from '../models/user.model';
import logger from './logger.service';

/**
 * Temporary Permission Service
 * 
 * Manages time-limited permissions for users.
 */
class TemporaryPermissionService {
  /**
   * Grant a temporary permission to a user
   */
  async grantPermission(params: {
    userId: string;
    permission: Permission;
    grantedBy: string;
    startDate: Date;
    endDate: Date;
    reason?: string;
    metadata?: Record<string, any>;
  }): Promise<ITemporaryPermission> {
    try {
      const {
        userId,
        permission,
        grantedBy,
        startDate,
        endDate,
        reason,
        metadata,
      } = params;

      // Validate dates
      if (endDate <= startDate) {
        throw new BadRequestError('End date must be after start date');
      }

      if (endDate <= new Date()) {
        throw new BadRequestError('End date must be in the future');
      }

      // Create temporary permission
      const tempPermission = new TemporaryPermission({
        userId: new mongoose.Types.ObjectId(userId),
        permission,
        grantedBy: new mongoose.Types.ObjectId(grantedBy),
        startDate,
        endDate,
        reason,
        metadata,
        isActive: true,
      });

      await tempPermission.save();

      // Invalidate user's permission cache
      await permissionCacheService.invalidateUser(userId);

      // Log the action
      await auditLogService.log({
        action: AuditAction.PERMISSION_GRANT_TEMPORARY,
        actorId: grantedBy,
        targetUserId: userId,
        severity: AuditSeverity.INFO,
        metadata: {
          permission,
          startDate,
          endDate,
          reason,
          tempPermissionId: tempPermission._id,
        },
      });

      logger.info(
        `Temporary permission granted: ${permission} to user ${userId} until ${endDate}`
      );

      return tempPermission;
    } catch (error: any) {
      logger.error('Error granting temporary permission:', error.message);
      throw error;
    }
  }

  /**
   * Revoke a temporary permission
   */
  async revokePermission(
    tempPermissionId: string,
    revokedBy: string,
    reason?: string
  ): Promise<ITemporaryPermission> {
    try {
      const tempPermission = await TemporaryPermission.findById(tempPermissionId);

      if (!tempPermission) {
        throw new NotFoundError('Temporary permission');
      }

      if (!tempPermission.isActive) {
        throw new ConflictError('Permission is already revoked');
      }

      // Revoke the permission
      tempPermission.revoke(new mongoose.Types.ObjectId(revokedBy), reason);
      await tempPermission.save();

      // Invalidate user's permission cache
      await permissionCacheService.invalidateUser(tempPermission.userId.toString());

      // Log the action
      await auditLogService.log({
        action: AuditAction.PERMISSION_REVOKE_TEMPORARY,
        actorId: revokedBy,
        targetUserId: tempPermission.userId.toString(),
        severity: AuditSeverity.WARNING,
        metadata: {
          permission: tempPermission.permission,
          reason,
          tempPermissionId: tempPermission._id,
        },
      });

      logger.info(
        `Temporary permission revoked: ${tempPermission.permission} for user ${tempPermission.userId}`
      );

      return tempPermission;
    } catch (error: any) {
      logger.error('Error revoking temporary permission:', error.message);
      throw error;
    }
  }

  /**
   * Get active temporary permissions for a user
   */
  async getActivePermissions(userId: string): Promise<ITemporaryPermission[]> {
    try {
      return await TemporaryPermission.findActiveForUser(userId);
    } catch (error: any) {
      logger.error('Error getting active permissions:', error.message);
      return [];
    }
  }

  /**
   * Get all temporary permissions for a user (active and inactive)
   */
  async getUserPermissions(userId: string): Promise<ITemporaryPermission[]> {
    try {
      return await TemporaryPermission.find({ userId }).sort({ createdAt: -1 });
    } catch (error: any) {
      logger.error('Error getting user permissions:', error.message);
      return [];
    }
  }

  /**
   * Check if user has a specific temporary permission
   */
  async hasPermission(userId: string, permission: Permission): Promise<boolean> {
    try {
      const now = new Date();
      const count = await TemporaryPermission.countDocuments({
        userId,
        permission,
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
      });

      return count > 0;
    } catch (error: any) {
      logger.error('Error checking temporary permission:', error.message);
      return false;
    }
  }

  /**
   * Get all active temporary permissions (for a user) as Permission array
   */
  async getActivePermissionsList(userId: string): Promise<Permission[]> {
    try {
      const tempPermissions = await this.getActivePermissions(userId);
      return tempPermissions.map((tp) => tp.permission);
    } catch (error: any) {
      logger.error('Error getting active permissions list:', error.message);
      return [];
    }
  }

  /**
   * Process expired permissions (deactivate them)
   * Should be called by a cron job
   */
  async processExpiredPermissions(): Promise<number> {
    try {
      const expiredPermissions = await TemporaryPermission.findExpired();
      let processedCount = 0;

      for (const tempPermission of expiredPermissions) {
        tempPermission.isActive = false;
        await tempPermission.save();

        // Invalidate user's permission cache
        await permissionCacheService.invalidateUser(
          tempPermission.userId.toString()
        );

        // Log the expiration
        await auditLogService.log({
          action: AuditAction.PERMISSION_EXPIRE_TEMPORARY,
          targetUserId: tempPermission.userId.toString(),
          severity: AuditSeverity.INFO,
          metadata: {
            permission: tempPermission.permission,
            tempPermissionId: tempPermission._id,
          },
        });

        processedCount++;
      }

      if (processedCount > 0) {
        logger.info(`Processed ${processedCount} expired temporary permissions`);
      }

      return processedCount;
    } catch (error: any) {
      logger.error('Error processing expired permissions:', error.message);
      throw error;
    }
  }

  /**
   * Get permissions expiring soon
   */
  async getExpiringSoon(hoursFromNow: number = 24): Promise<ITemporaryPermission[]> {
    try {
      return await TemporaryPermission.findExpiringSoon(hoursFromNow);
    } catch (error: any) {
      logger.error('Error getting expiring permissions:', error.message);
      return [];
    }
  }

  /**
   * Extend a temporary permission
   */
  async extendPermission(
    tempPermissionId: string,
    newEndDate: Date,
    extendedBy: string,
    reason?: string
  ): Promise<ITemporaryPermission> {
    try {
      const tempPermission = await TemporaryPermission.findById(tempPermissionId);

      if (!tempPermission) {
        throw new NotFoundError('Temporary permission');
      }

      if (!tempPermission.isActive) {
        throw new ConflictError('Cannot extend inactive permission');
      }

      if (newEndDate <= tempPermission.endDate) {
        throw new BadRequestError('New end date must be after current end date');
      }

      const oldEndDate = tempPermission.endDate;
      tempPermission.endDate = newEndDate;
      
      if (!tempPermission.metadata) {
        tempPermission.metadata = {};
      }
      tempPermission.metadata.extended = true;
      tempPermission.metadata.extendedBy = extendedBy;
      tempPermission.metadata.extendedAt = new Date();
      tempPermission.metadata.extensionReason = reason;

      await tempPermission.save();

      // Invalidate user's permission cache
      await permissionCacheService.invalidateUser(tempPermission.userId.toString());

      // Log the action
      await auditLogService.log({
        action: AuditAction.PERMISSION_EXTEND_TEMPORARY,
        actorId: extendedBy,
        targetUserId: tempPermission.userId.toString(),
        severity: AuditSeverity.INFO,
        metadata: {
          permission: tempPermission.permission,
          oldEndDate,
          newEndDate,
          reason,
          tempPermissionId: tempPermission._id,
        },
      });

      logger.info(
        `Temporary permission extended: ${tempPermission.permission} for user ${tempPermission.userId} until ${newEndDate}`
      );

      return tempPermission;
    } catch (error: any) {
      logger.error('Error extending temporary permission:', error.message);
      throw error;
    }
  }

  /**
   * Get statistics about temporary permissions
   */
  async getStatistics(): Promise<{
    total: number;
    active: number;
    expired: number;
    revoked: number;
    expiringSoon: number;
  }> {
    try {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const [total, active, expired, revoked, expiringSoon] = await Promise.all([
        TemporaryPermission.countDocuments(),
        TemporaryPermission.countDocuments({
          isActive: true,
          startDate: { $lte: now },
          endDate: { $gte: now },
        }),
        TemporaryPermission.countDocuments({
          isActive: true,
          endDate: { $lt: now },
        }),
        TemporaryPermission.countDocuments({
          isActive: false,
          revokedAt: { $exists: true },
        }),
        TemporaryPermission.countDocuments({
          isActive: true,
          startDate: { $lte: now },
          endDate: { $gte: now, $lte: tomorrow },
        }),
      ]);

      return {
        total,
        active,
        expired,
        revoked,
        expiringSoon,
      };
    } catch (error: any) {
      logger.error('Error getting temporary permission statistics:', error.message);
      throw error;
    }
  }
}

export const temporaryPermissionService = new TemporaryPermissionService();
