import logger from './logger.service';
import { SyncOperationLedger } from './sync/sync-ledger.service';
import { SyncConflictService } from './sync/sync-conflict.service';
import { assertOwnsCategory } from '../shared/ownership';
import { Expense } from '../models/expense.model';
import { Category } from '../models/category.model';
import { User } from '../models/user.model';
import {
  SyncOperation,
  ConflictResolution,
  SyncConflict,
  SyncMetadata,
} from '../models/sync.model';
import mongoose from 'mongoose';
import { CategoryService } from './category.service';
import { NotificationService } from './notification.service';
import { SyncFailure } from '../models/sync-failure.model';
import { SyncRegistration } from '../models/sync-registration.model';
import { createHash, randomUUID } from 'crypto';

const conflictDedupeKey = (userId: string, entity: any, server: any): string =>
  `${userId}:${String(entity._entityType || 'unknown')}:${String(entity._id || entity._clientId || 'unknown')}:${String(entity._version || entity._lastModified || 'unknown')}:${String(server?._version || server?._lastModified || 'unknown')}`;

export interface SyncRequest {
  lastSyncTime?: Date;
  entityType?: 'expense' | 'outcome' | 'category' | 'user';
  limit?: number;
  offset?: number;
}

export interface SyncResponse {
  entities: any[];
  conflicts: any[];
  lastSyncTime: Date;
  hasMore: boolean;
  totalCount: number;
}

/**
 * 🔄 Sync Service - Professional Backend Implementation
 *
 * المسؤوليات:
 * 1. معالجة طلبات المزامنة من العميل (Pull & Push)
 * 2. إدارة التعارضات
 * 3. تتبع metadata المزامنة
 */
export type { ConflictResolutionRequest } from './sync/sync-conflict.service';

export class SyncService {
  private readonly ledger = new SyncOperationLedger();
  private readonly conflictService = new SyncConflictService();

  constructor() {}

  resolveConflict(...args: Parameters<SyncConflictService['resolveConflict']>) {
    return this.conflictService.resolveConflict(...args);
  }

  getConflicts(...args: Parameters<SyncConflictService['getConflicts']>) {
    return this.conflictService.getConflicts(...args);
  }

  // ==================== PULL DATA FROM CLIENT ====================

  /**
   * 📥 Pull البيانات للعميل
   * يرجع كل البيانات المعدلة بعد lastSyncTime
   */
  async pullData(userId: string, request: SyncRequest): Promise<SyncResponse> {
    const { lastSyncTime, entityType, limit = 50, offset = 0 } = request;

    logger.info('📥 [SYNC] Pull request:', {
      userId,
      lastSyncTime,
      entityType,
      limit,
      offset,
    });

    try {
      if (!userId) {
        throw new Error('User ID is required');
      }

      // Convert userId to ObjectId
      const userObjectId = new mongoose.Types.ObjectId(userId);

      // Build query
      const query: any = {
        user: userObjectId,
        // لا نفلتر _isDeleted لأننا نحتاج إرسال العناصر المحذوفة للمزامنة
      };

      // Filter by lastSyncTime if provided
      if (lastSyncTime) {
        const syncDate = new Date(lastSyncTime);
        query.$or = [
          { _lastModified: { $gt: syncDate } },
          { updatedAt: { $gt: syncDate } },
          { createdAt: { $gt: syncDate } },
        ];
      }

      logger.info(`🔍 [SYNC] Query: ${JSON.stringify(query)}`);

      let entities: any[] = [];
      let totalCount = 0;

      // Fetch Expenses (or Outcomes)
      if (!entityType || entityType === 'expense' || entityType === 'outcome') {
        logger.info('💰 [SYNC] Fetching expenses...');

        const expenses = await Expense.find(query)
          .populate('category', 'title icon color type')
          .sort({ _lastModified: -1, updatedAt: -1 })
          .limit(limit)
          .skip(offset)
          .lean()
          .exec();

        logger.info(`✅ [SYNC] Found ${expenses.length} expenses`);

        entities = [
          ...entities,
          ...expenses.map((exp) => ({
            ...exp,
            _entityType: 'expense',
            _lastModified: exp._lastModified || exp.updatedAt || exp.createdAt,
          })),
        ];

        totalCount += await Expense.countDocuments(query);
      }

      // Fetch Categories
      if (!entityType || entityType === 'category') {
        logger.info('📁 [SYNC] Fetching categories...');

        const categories = await Category.find(query)
          .sort({ _lastModified: -1, updatedAt: -1 })
          .limit(limit)
          .skip(offset)
          .lean()
          .exec();

        logger.info(`✅ [SYNC] Found ${categories.length} categories`);

        entities = [
          ...entities,
          ...categories.map((cat) => ({
            ...cat,
            _entityType: 'category',
            _lastModified: cat._lastModified || cat.updatedAt || cat.createdAt,
          })),
        ];

        totalCount += await Category.countDocuments(query);
      }

      // Fetch conflicts
      logger.info('⚠️ [SYNC] Fetching conflicts...');
      const conflicts = await this.getConflicts(userId);
      logger.info(`✅ [SYNC] Found ${conflicts.length} conflicts`);

      // Update sync metadata
      try {
        await this.updateSyncMetadata(userId, {
          lastSyncTime: new Date(),
          totalEntities: totalCount,
          pendingCount: 0,
          conflictCount: conflicts.length,
        });
        logger.info('✅ [SYNC] Metadata updated');
      } catch (metadataError) {
        logger.warn(
          '⚠️ [SYNC] Failed to update metadata:',
          undefined,
          metadataError
        );
      }

      // Sort entities by modification date (newest first)
      entities.sort((a, b) => {
        const dateA = new Date(
          a._lastModified || a.updatedAt || a.createdAt
        ).getTime();
        const dateB = new Date(
          b._lastModified || b.updatedAt || b.createdAt
        ).getTime();
        return dateB - dateA;
      });

      const response: SyncResponse = {
        entities,
        conflicts,
        lastSyncTime: new Date(),
        hasMore: entities.length === limit,
        totalCount,
      };

      logger.info('✅ [SYNC] Pull completed:', {
        entitiesCount: entities.length,
        conflictsCount: conflicts.length,
        totalCount,
        hasMore: response.hasMore,
      });

      return response;
    } catch (error: any) {
      logger.error('❌ [SYNC] Pull error:', error);
      throw new Error(`Failed to pull sync data: ${error.message}`);
    }
  }

  // ==================== PUSH DATA FROM CLIENT ====================

  /**
   * 📤 استقبال البيانات من العميل
   * معالجة التغييرات وإرجاع النتيجة والتعارضات
   */
  async pushData(
    userId: string,
    entities: any[]
  ): Promise<{
    success: boolean;
    conflicts: any[];
    processed: number;
    idMap: Record<string, string>;
    errors: any[];
    receipts: Record<string, string>;
  }> {
    logger.info(
      `📤 [SYNC] Push request: ${entities.length} entities from user ${userId}`
    );

    const conflicts: any[] = [];
    let processed = 0;
    const errors: any[] = [];
    const idMap = new Map<string, string>();
    const receipts: Record<string, string> = {};

    try {
      for (const entity of entities) {
        let processingEntity = entity;
        try {
          const registration = await this.ledger.registerOperation(
            userId,
            entity
          );
          const requestedOperationType =
            entity._operationType ||
            (entity._isDeleted
              ? 'DELETE'
              : entity._baseVersion != null
                ? 'UPDATE'
                : 'CREATE');
          if (
            !registration &&
            ['UPDATE', 'DELETE'].includes(requestedOperationType)
          ) {
            const result = await this.processEntity(userId, entity, idMap);
            if (result.conflict) {
              conflicts.push(result.entity);
              const conflictId = await this.recordConflict(
                userId,
                result.entity
              );
              result.entity.conflictId = conflictId;
            } else {
              throw new Error('SYNC_REGISTRATION_REQUIRED');
            }
            continue;
          }
          processingEntity = registration
            ? { ...entity, _receiptId: registration.receiptId }
            : entity;
          if (registration)
            receipts[registration.clientOperationId] = registration.receiptId;
          const result = await this.processEntity(
            userId,
            processingEntity,
            idMap
          );

          if (result.conflict) {
            conflicts.push(result.entity);
            const conflictId = await this.recordConflict(userId, result.entity);
            result.entity.conflictId = conflictId;
            logger.info(
              `⚠️ [SYNC] Conflict detected for ${entity._entityType}:${entity._id}`
            );
          } else {
            await this.ledger.clearObservedFailure(userId, processingEntity);
            processed++;
          }
        } catch (error: any) {
          await this.ledger.recordObservedFailure(userId, processingEntity);
          logger.error(
            `❌ [SYNC] Error processing entity ${entity._id}:`,
            error
          );
          errors.push({
            operationId: entity._operationId,
            reason: error.message || 'SYNC_PROCESSING_FAILED',
          });
        }
      }

      logger.info(
        `✅ [SYNC] Push completed: ${processed} processed, ${conflicts.length} conflicts`
      );

      return {
        success: true,
        conflicts,
        processed,
        idMap: Object.fromEntries(idMap),
        errors,
        receipts,
      };
    } catch (error: any) {
      logger.error('❌ [SYNC] Push error:', error);
      throw new Error(`Failed to push sync data: ${error.message}`);
    }
  }

  private async recordConflict(userId: string, conflict: any): Promise<string> {
    const entityType = String(conflict._entityType || 'unknown');
    const entityId = String(conflict._id || conflict._clientId || 'unknown');
    const localVersion = String(
      conflict._version || conflict._lastModified || 'unknown'
    );
    const serverVersion = String(
      conflict._conflictData?._version ||
        conflict._conflictData?._lastModified ||
        'unknown'
    );
    const dedupeKey = `${userId}:${entityType}:${entityId}:${localVersion}:${serverVersion}`;
    let record;
    try {
      record = await SyncConflict.findOneAndUpdate(
        { dedupeKey },
        {
          $setOnInsert: {
            dedupeKey,
            entityId,
            entityType,
            localData: conflict,
            serverData: conflict._conflictData,
            user: new mongoose.Types.ObjectId(userId),
            detectedAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'before' }
      ).lean();
    } catch (error: any) {
      if (error?.code === 11000) {
        const duplicate = await SyncConflict.findOne({ dedupeKey })
          .select('_id')
          .lean();
        return String(duplicate?._id || dedupeKey);
      }
      throw error;
    }
    if (record) return String(record._id);
    await NotificationService.dispatchUserEvent({
      userId,
      event: 'sync.conflict',
      dedupeKey,
      title: 'Sync conflict detected / تم اكتشاف تعارض في المزامنة',
      message:
        'Review the affected item to choose a version. / راجع العنصر المتأثر لاختيار نسخة.',
      metadata: { conflictId: dedupeKey, entityType },
    });
    const persisted = await SyncConflict.findOne({ dedupeKey })
      .select('_id')
      .lean();
    return String(persisted?._id || dedupeKey);
  }

  /**
   * معالجة entity واحدة
   */
  private async processEntity(
    userId: string,
    entity: any,
    idMap: Map<string, string>
  ): Promise<{ conflict: boolean; entity: any }> {
    const {
      _entityType,
      _id,
      _version,
      _baseVersion,
      _lastModified,
      _isDeleted,
      _syncError,
      _operationId,
      _operationType,
      _receiptId,
      ...entityData
    } = entity;

    logger.info(`🔄 [SYNC] Processing ${_entityType}:${_id}...`);

    try {
      // Map offline IDs to new MongoDB IDs if they were created in this batch
      if (
        entityData.category &&
        typeof entityData.category === 'string' &&
        entityData.category.startsWith('offline_')
      ) {
        if (idMap.has(entityData.category)) {
          entityData.category = idMap.get(entityData.category);
        }
      }

      // Never trust ownership/identity fields from the client: `user` would let a caller
      // move an entity into another account, and a foreign `category` leaks it via populate.
      for (const protectedField of ['user', '_id', '__v'])
        delete entityData[protectedField];
      if (_entityType !== 'category') {
        await assertOwnsCategory(entityData.category, userId);
      }
      const userObjectId = new mongoose.Types.ObjectId(userId);
      let Model: any;

      // Determine model
      switch (_entityType) {
        case 'expense':
        case 'outcome':
          Model = Expense;
          break;
        case 'category':
          Model = Category;
          break;
        default:
          throw new Error(`Unknown entity type: ${_entityType}`);
      }

      // Find existing entity
      const correlationId =
        typeof entityData._clientId === 'string' &&
        entityData._clientId.startsWith('offline_')
          ? entityData._clientId
          : typeof _id === 'string' && _id.startsWith('offline_')
            ? _id
            : undefined;
      let existingEntity = null;
      let targetId = _id;

      if (mongoose.Types.ObjectId.isValid(_id)) {
        existingEntity = await Model.findOne({ _id, user: userObjectId });
      } else if (correlationId) {
        // It's an offline ID, search by _clientId
        existingEntity = await Model.findOne({
          _clientId: correlationId,
          user: userObjectId,
        });
        if (existingEntity) {
          targetId = existingEntity._id.toString();
        }
      }

      // Check for conflicts
      if (existingEntity && this.hasConflict(existingEntity, _baseVersion)) {
        logger.info(`⚠️ [SYNC] Conflict for ${_entityType}:${_id}`);
        return {
          conflict: true,
          entity: {
            ...entity,
            conflictId: conflictDedupeKey(userId, entity, existingEntity),
            _conflictData: existingEntity.toObject(),
          },
        };
      }

      if (existingEntity && correlationId) {
        idMap.set(correlationId, existingEntity._id.toString());
      }

      // Process based on operation
      if (_isDeleted) {
        const deleted = await this.handleDelete(
          Model,
          targetId,
          userId,
          _baseVersion
        );
        if (!deleted) {
          const current = await Model.findOne({
            _id: targetId,
            user: userObjectId,
          });
          return {
            conflict: true,
            entity: {
              ...entity,
              conflictId: conflictDedupeKey(userId, entity, current),
              _conflictData: current?.toObject(),
            },
          };
        }
        logger.info(`🗑️ [SYNC] Deleted ${_entityType}:${targetId}`);
      } else if (existingEntity) {
        const updated = await this.handleUpdate(
          Model,
          targetId,
          userId,
          entityData,
          _baseVersion
        );
        if (!updated) {
          const current = await Model.findOne({
            _id: targetId,
            user: userObjectId,
          });
          return {
            conflict: true,
            entity: {
              ...entity,
              conflictId: conflictDedupeKey(userId, entity, current),
              _conflictData: current?.toObject(),
            },
          };
        }
        logger.info(`✏️ [SYNC] Updated ${_entityType}:${targetId}`);
      } else {
        await this.handleCreate(
          Model,
          entityData,
          userId,
          targetId,
          idMap,
          _operationId
        );
        logger.info(`🆕 [SYNC] Created ${_entityType}:${targetId}`);
      }

      // Clear cache if entity type is category
      if (_entityType === 'category') {
        CategoryService.clearUserCategoryCache(userId);
      }

      return { conflict: false, entity };
    } catch (error: any) {
      logger.error(`❌ [SYNC] Error processing ${_entityType}:${_id}:`, error);
      throw error;
    }
  }

  /**
   * التحقق من وجود تعارض
   */
  private hasConflict(existing: any, baseVersion?: number): boolean {
    return (
      !Number.isInteger(baseVersion) || (existing._version || 0) !== baseVersion
    );
  }

  /**
   * إنشاء entity جديدة
   */
  private async handleCreate(
    Model: any,
    data: any,
    userId: string,
    entityId: string | undefined,
    idMap: Map<string, string>,
    operationId?: string
  ): Promise<void> {
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const entityData: any = {
      ...data,
      user: userObjectId,
      _syncStatus: 'synced',
      _lastModified: new Date(),
      _version: 1,
    };

    // Use provided ID if available and valid
    if (entityId) {
      if (mongoose.Types.ObjectId.isValid(entityId)) {
        entityData._id = entityId;
      } else {
        // It's an offline ID, map it to _clientId so frontend can track it
        entityData._clientId = entityId;
      }
    }

    try {
      const entity = new Model(entityData);
      await entity.save();

      const correlationId =
        typeof data._clientId === 'string' &&
        data._clientId.startsWith('offline_')
          ? data._clientId
          : typeof entityId === 'string' && entityId.startsWith('offline_')
            ? entityId
            : undefined;
      if (correlationId) idMap.set(correlationId, entity._id.toString());
    } catch (error: any) {
      // A concurrent retry may win the unique owner/clientId insert. Treat that
      // duplicate as the already-created logical entity.
      if (error?.code !== 11000) throw error;
      const correlationId =
        typeof data._clientId === 'string' &&
        data._clientId.startsWith('offline_')
          ? data._clientId
          : typeof entityId === 'string' && entityId.startsWith('offline_')
            ? entityId
            : undefined;
      if (!correlationId) throw error;
      const existing = await Model.findOne({
        user: userObjectId,
        _clientId: correlationId,
      });
      if (!existing) throw error;
      idMap.set(correlationId, existing._id.toString());
    }
  }

  /**
   * تحديث entity موجودة
   */
  private async handleUpdate(
    Model: any,
    id: string,
    userId: string,
    data: any,
    version?: number
  ): Promise<boolean> {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    if (!Number.isInteger(version)) return false;
    const expectedVersion = version as number;
    const result = await Model.updateOne(
      { _id: id, user: userObjectId, _version: expectedVersion },
      {
        $set: {
          ...data,
          _syncStatus: 'synced',
          _lastModified: new Date(),
          _version: expectedVersion + 1,
        },
      }
    );
    return result.modifiedCount === 1;
  }

  /**
   * حذف entity (soft delete)
   */
  private async handleDelete(
    Model: any,
    id: string,
    userId: string,
    version?: number
  ): Promise<boolean> {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    if (!Number.isInteger(version)) return false;
    const expectedVersion = version as number;
    const result = await Model.updateOne(
      { _id: id, user: userObjectId, _version: expectedVersion },
      {
        $set: {
          _isDeleted: true,
          _syncStatus: 'synced',
          _lastModified: new Date(),
          _version: expectedVersion + 1,
        },
      }
    );
    return result.modifiedCount === 1;
  }

  // ==================== CONFLICT RESOLUTION ====================

  // ==================== SYNC METADATA ====================

  async getSyncMetadata(userId: string): Promise<any> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      let metadata = await SyncMetadata.findOne({ user: userObjectId });

      if (!metadata) {
        metadata = await SyncMetadata.create({
          user: userObjectId,
          lastSyncTime: new Date(),
          totalEntities: 0,
          pendingCount: 0,
          conflictCount: 0,
          errorCount: 0,
          isOnline: true,
          isSyncing: false,
        });
      }

      return metadata.toObject();
    } catch (error: any) {
      logger.error('❌ [SYNC] Get metadata error:', error);
      throw new Error(`Failed to get sync metadata: ${error.message}`);
    }
  }

  async updateSyncMetadata(
    userId: string,
    updates: Partial<any>
  ): Promise<void> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);

      await SyncMetadata.updateOne(
        { user: userObjectId },
        {
          $set: {
            ...updates,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (error: any) {
      logger.error('❌ [SYNC] Update metadata error:', error);
      throw new Error(`Failed to update sync metadata: ${error.message}`);
    }
  }

  // ==================== BULK OPERATIONS ====================

  async bulkSync(
    userId: string,
    entities: any[]
  ): Promise<{ success: boolean; results: any[] }> {
    logger.info(`📦 [SYNC] Bulk sync: ${entities.length} entities`);

    const results: any[] = [];

    try {
      const idMap = new Map<string, string>();
      for (const entity of entities) {
        try {
          const result = await this.processEntity(userId, entity, idMap);
          results.push({
            success: true,
            entity: result.entity,
            conflict: result.conflict,
          });
        } catch (error: any) {
          results.push({
            success: false,
            entity,
            error: error.message,
          });
        }
      }

      return { success: true, results };
    } catch (error: any) {
      logger.error('❌ [SYNC] Bulk sync error:', error);
      throw new Error(`Failed to perform bulk sync: ${error.message}`);
    }
  }

  // ==================== CLEANUP ====================

  async cleanupOldSyncData(
    userId: string,
    olderThanDays: number = 30
  ): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      // Clean up old sync operations
      await SyncOperation.deleteMany({
        user: userId,
        timestamp: { $lt: cutoffDate },
        status: 'synced',
      });

      // Clean up old conflict resolutions
      await ConflictResolution.deleteMany({
        user: userId,
        timestamp: { $lt: cutoffDate },
      });

      logger.info(`🧹 [SYNC] Cleaned up data older than ${olderThanDays} days`);
    } catch (error: any) {
      logger.error('❌ [SYNC] Cleanup error:', error);
      throw new Error(`Failed to cleanup sync data: ${error.message}`);
    }
  }
}
