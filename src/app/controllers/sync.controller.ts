import logger from '../services/logger.service';
import { Request, Response, NextFunction } from 'express';
import {
  SyncService,
  SyncRequest,
  SyncResponse,
  ConflictResolutionRequest,
} from '../services/sync.service';
import { sendError, sendSuccess } from '../shared/helper';

export class SyncController {
  private syncService: SyncService;

  constructor() {
    this.syncService = new SyncService();
  }

  // ==================== SYNC DATA PULL ====================

  async pullData(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      logger.info('Pull data controller called');
      const userId = (req as any).user?._id || req.user_id;
      logger.info('User ID:', userId);

      if (!userId) {
        logger.error('No userId found');
        sendError(res, 'User ID is required', 400, 'SYNC_USER_ID_REQUIRED');
        return;
      }

      const { lastSyncTime, entityType, limit, offset } = req.query;

      const request: SyncRequest = {
        lastSyncTime: lastSyncTime
          ? new Date(lastSyncTime as string)
          : undefined,
        entityType: entityType as 'expense' | 'category' | 'user',
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      };

      logger.info('📞 Calling syncService.pullData...');
      const result = await this.syncService.pullData(userId, request);
      logger.info('✅ Got result from syncService:', {
        entitiesCount: result.entities.length,
        conflictsCount: result.conflicts.length,
        totalCount: result.totalCount,
      });

      logger.info('📤 Sending response...');
      sendSuccess(res, result, 'Sync data pulled successfully');
      logger.info('✅ Response sent successfully');
    } catch (error) {
      logger.error('❌ Error in pullData controller:', error as Error);
      next(error);
    }
  }

  // ==================== SYNC DATA PUSH ====================

  async pushData(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;
      const { entities } = req.body;

      if (!entities || !Array.isArray(entities)) {
        sendError(
          res,
          'Entities array is required',
          400,
          'SYNC_ENTITIES_REQUIRED'
        );
        return;
      }

      const result = await this.syncService.pushData(userId, entities);
      sendSuccess(res, result, 'Sync data pushed successfully');
    } catch (error) {
      next(error);
    }
  }

  // ==================== BULK SYNC ====================

  async bulkSync(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;
      const { entities } = req.body;

      if (!entities || !Array.isArray(entities)) {
        sendError(
          res,
          'Entities array is required',
          400,
          'SYNC_ENTITIES_REQUIRED'
        );
        return;
      }

      const result = await this.syncService.bulkSync(userId, entities);
      sendSuccess(res, result, 'Bulk sync completed');
    } catch (error) {
      next(error);
    }
  }

  // ==================== CONFLICTS ====================

  async getConflicts(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;
      const conflicts = await this.syncService.getConflicts(userId);
      sendSuccess(res, conflicts, 'Conflicts retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async resolveConflict(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;
      const conflictData: ConflictResolutionRequest = req.body;

      if (
        !conflictData.entityId ||
        !conflictData.entityType ||
        !conflictData.resolution
      ) {
        sendError(
          res,
          'Entity ID, entity type, and resolution are required',
          400,
          'SYNC_CONFLICT_INVALID_INPUT'
        );
        return;
      }

      const result = await this.syncService.resolveConflict(
        userId,
        conflictData
      );
      sendSuccess(res, result, 'Conflict resolved successfully');
    } catch (error) {
      next(error);
    }
  }

  // ==================== SYNC METADATA ====================

  async getSyncMetadata(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;
      const metadata = await this.syncService.getSyncMetadata(userId);
      sendSuccess(res, metadata, 'Sync metadata retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  async updateSyncMetadata(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;
      const updates = req.body;

      await this.syncService.updateSyncMetadata(userId, updates);
      sendSuccess(res, { success: true }, 'Sync metadata updated successfully');
    } catch (error) {
      next(error);
    }
  }

  // ==================== CLEANUP ====================

  async cleanupSyncData(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;
      const { olderThanDays } = req.query;
      const days = olderThanDays ? parseInt(olderThanDays as string) : 30;

      await this.syncService.cleanupOldSyncData(userId, days);
      sendSuccess(res, { success: true }, 'Sync data cleaned up successfully');
    } catch (error) {
      next(error);
    }
  }

  // ==================== FORCE SYNC ====================

  async forceSync(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;

      // Update metadata to indicate syncing
      await this.syncService.updateSyncMetadata(userId, { isSyncing: true });

      // Perform full sync
      const pullResult = await this.syncService.pullData(userId, {});

      // Update metadata to indicate sync complete
      await this.syncService.updateSyncMetadata(userId, {
        isSyncing: false,
        lastSyncTime: new Date(),
        totalEntities: pullResult.totalCount,
      });

      sendSuccess(
        res,
        {
          success: true,
          message: `Sync completed. ${pullResult.entities.length} entities synced.`,
          entities: pullResult.entities.length,
          totalCount: pullResult.totalCount,
        },
        'Force sync completed'
      );
    } catch (error) {
      // Update metadata to indicate sync error
      const userId = (req as any).user?._id || req.user_id;
      if (userId) {
        await this.syncService.updateSyncMetadata(userId, { isSyncing: false });
      }
      next(error);
    }
  }

  // ==================== SYNC STATUS ====================

  async getSyncStatus(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).user?._id || req.user_id;
      const metadata = await this.syncService.getSyncMetadata(userId);
      const conflicts = await this.syncService.getConflicts(userId);

      const status = {
        metadata,
        isOnline: true, // This would be determined by network status
        lastSyncTime: metadata.lastSyncTime,
        pendingCount: metadata.pendingCount,
        conflictCount: conflicts.length,
        errorCount: metadata.errorCount,
      };

      sendSuccess(res, status, 'Sync status retrieved successfully');
    } catch (error) {
      next(error);
    }
  }
}

export const syncController = new SyncController();
