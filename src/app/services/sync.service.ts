import logger from './logger.service';
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

const REPEATED_FAILURE_THRESHOLD = 3;
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{6,63}$/i;

const stableCanonicalize = (value: any): any => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result: Record<string, unknown>, key) => {
      result[key] = stableCanonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
};

const mutationFingerprint = (entity: any): string => {
  const data = Object.keys(entity)
    .filter((key) => !['_operationId', '_operationType', '_receiptId', '_retryCount', '_maxRetries', '_syncError'].includes(key))
    .sort()
    .reduce((result: Record<string, unknown>, key) => {
      result[key] = entity[key];
      return result;
    }, {});
  return createHash('sha256').update(JSON.stringify(stableCanonicalize(data))).digest('hex');
};

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

export interface ConflictResolutionRequest {
  conflictId?: string;
  entityId: string;
  entityType: string;
  resolution: 'local' | 'server' | 'merge';
  mergedData?: any;
}

/**
 * 🔄 Sync Service - Professional Backend Implementation
 *
 * المسؤوليات:
 * 1. معالجة طلبات المزامنة من العميل (Pull & Push)
 * 2. إدارة التعارضات
 * 3. تتبع metadata المزامنة
 */
export class SyncService {
  constructor() {}

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
          const registration = await this.registerOperation(userId, entity);
          const requestedOperationType = entity._operationType || (entity._isDeleted ? 'DELETE' : entity._baseVersion != null ? 'UPDATE' : 'CREATE');
          if (!registration && ['UPDATE', 'DELETE'].includes(requestedOperationType)) {
            const result = await this.processEntity(userId, entity, idMap);
            if (result.conflict) {
              conflicts.push(result.entity);
              const conflictId = await this.recordConflict(userId, result.entity);
              result.entity.conflictId = conflictId;
            } else {
              throw new Error('SYNC_REGISTRATION_REQUIRED');
            }
            continue;
          }
          processingEntity = registration
            ? { ...entity, _receiptId: registration.receiptId }
            : entity;
          if (registration) receipts[registration.clientOperationId] = registration.receiptId;
          const result = await this.processEntity(userId, processingEntity, idMap);

          if (result.conflict) {
            conflicts.push(result.entity);
            const conflictId = await this.recordConflict(userId, result.entity);
            result.entity.conflictId = conflictId;
            logger.info(
              `⚠️ [SYNC] Conflict detected for ${entity._entityType}:${entity._id}`
            );
          } else {
            await this.clearObservedFailure(userId, processingEntity);
            processed++;
          }
        } catch (error: any) {
          await this.recordObservedFailure(userId, processingEntity);
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

  private async recordObservedFailure(
    userId: string,
    entity: any
  ): Promise<void> {
    const receiptId = typeof entity._receiptId === 'string' ? entity._receiptId : '';
    const operationId =
      typeof entity._operationId === 'string' ? entity._operationId.trim() : '';
    const entityType = String(entity._entityType || 'unknown');
    const entityId = String(entity._id || entity._clientId || 'unknown');

    if (
      !receiptId ||
      !OPERATION_ID_PATTERN.test(operationId) ||
      !['expense', 'outcome', 'category'].includes(entityType) ||
      !entityId ||
      entityId.length > 200
    ) {
      return;
    }

    try {
      const registration = await SyncRegistration.findOne({
        user: new mongoose.Types.ObjectId(userId),
        receiptId,
        clientOperationId: operationId,
      }).lean();
      if (!registration || registration.entityType !== entityType || registration.entityId !== entityId) return;
      const identityFilter = {
        user: new mongoose.Types.ObjectId(userId),
        registrationId: registration.receiptId,
      };
      let existing = await SyncFailure.findOne(identityFilter).lean();
      let reclaimed = false;
      if (existing?.terminal && existing.dispatchState === 'dispatching' &&
        existing.updatedAt && Date.now() - new Date(existing.updatedAt).getTime() > 5 * 60 * 1000) {
        const reclaim = await SyncFailure.updateOne(
          { _id: existing._id, terminal: true, dispatchState: 'dispatching' },
          { $set: { terminal: false, dispatchState: 'pending' } }
        );
        reclaimed = reclaim.modifiedCount === 1;
        existing = await SyncFailure.findById(existing._id).lean();
        if (!reclaimed) return;
      }
      if (existing?.terminal && existing.dispatchState !== 'dispatching')
        return;
      if (reclaimed && existing) {
        await this.dispatchRepeatedFailure(userId, existing);
        return;
      }

      let failure;
      try {
        failure = await SyncFailure.findOneAndUpdate(
          { ...identityFilter, terminal: false },
          {
            $setOnInsert: {
              user: userId,
              registrationId: registration.receiptId,
              operationId,
              entityType,
              entityId,
              dispatchState: 'pending',
            },
            $inc: { attemptCount: 1 },
          },
          { upsert: true, returnDocument: 'after' }
        ).lean();
      } catch (error: any) {
        if (error?.code === 11000) {
          failure = await SyncFailure.findOneAndUpdate(
            { ...identityFilter, terminal: false },
            { $inc: { attemptCount: 1 } },
            { returnDocument: 'after' }
          ).lean();
        } else {
          throw error;
        }
      }

      if (!failure || failure.terminal || failure.attemptCount < REPEATED_FAILURE_THRESHOLD)
        return;

      const terminal = await SyncFailure.findOneAndUpdate(
        { _id: failure._id, terminal: false, dispatchState: 'pending' },
        { $set: { terminal: true, dispatchState: 'dispatching' } },
        { returnDocument: 'after' }
      ).lean();
      if (!terminal) return;

      await this.dispatchRepeatedFailure(userId, terminal);
    } catch (error) {
      logger.warn('[SYNC] Repeated-failure notification dispatch failed', {
        operationId,
        userId,
        error: error instanceof Error ? error.message : 'DISPATCH_FAILED',
      });
    }
  }

  private async dispatchRepeatedFailure(userId: string, failure: any): Promise<void> {
    const claimed = await SyncFailure.findOneAndUpdate(
      { _id: failure._id, terminal: false, dispatchState: 'pending' },
      { $set: { terminal: true, dispatchState: 'dispatching' } },
      { returnDocument: 'after' }
    ).lean();
    const dispatching = claimed || failure;
    try {
      await NotificationService.dispatchUserEvent({
        userId,
        event: 'sync.repeated_failure',
        dedupeKey: `${userId}:sync-repeated-failure:${dispatching.registrationId}`,
        title: 'Sync repeatedly failed / فشلت المزامنة عدة مرات',
        message: 'A change could not be synchronized after several attempts. / تعذر مزامنة تغيير بعد عدة محاولات.',
        metadata: {
          operationId: dispatching.operationId,
          registrationId: dispatching.registrationId,
          entityType: dispatching.entityType,
          entityId: dispatching.entityId,
          failureCount: dispatching.attemptCount,
        },
      });
      await SyncFailure.updateOne(
        { _id: dispatching._id, dispatchState: 'dispatching' },
        { $set: { dispatchState: 'dispatched' } }
      );
    } catch (dispatchError) {
      await SyncFailure.updateOne(
        { _id: dispatching._id, dispatchState: 'dispatching' },
        { $set: { terminal: false, dispatchState: 'pending' } }
      );
      throw dispatchError;
    }
  }

  private async registerOperation(userId: string, entity: any) {
    const operationId = typeof entity._operationId === 'string' ? entity._operationId.trim() : '';
    const operationType = entity._operationType || (entity._isDeleted ? 'DELETE' : entity._baseVersion != null ? 'UPDATE' : 'CREATE');
    const entityType = String(entity._entityType || '');
    const entityId = String(entity._id || '');
    if (!OPERATION_ID_PATTERN.test(operationId) || !['CREATE', 'UPDATE', 'DELETE'].includes(operationType) || !['expense', 'outcome', 'category'].includes(entityType) || !entityId || entityId.length > 200) return null;
    const fingerprint = mutationFingerprint(entity);
    const userObjectId = new mongoose.Types.ObjectId(userId);
    if (entity._receiptId) {
      const receipt = await SyncRegistration.findOne({ receiptId: entity._receiptId }).lean();
      if (!receipt || String(receipt.user) !== String(userObjectId)) throw new Error('SYNC_RECEIPT_MISMATCH');
      if (receipt.clientOperationId !== operationId || receipt.entityType !== entityType || receipt.entityId !== entityId || receipt.operationType !== operationType || receipt.fingerprint !== fingerprint) throw new Error('SYNC_RECEIPT_MISMATCH');
    }
    const existing = await SyncRegistration.findOne({ user: userObjectId, clientOperationId: operationId }).lean();
    if (existing) {
      if ((entity._receiptId && entity._receiptId !== existing.receiptId) || existing.entityType !== entityType || existing.entityId !== entityId || existing.operationType !== operationType || existing.fingerprint !== fingerprint) throw new Error('SYNC_RECEIPT_MISMATCH');
      return existing;
    }
    if (operationType !== 'CREATE') {
      const Model: any = entityType === 'category' ? Category : Expense;
      const owned = await Model.findOne({ _id: entityId, user: userObjectId }).select('_version').lean();
      if (!owned) throw new Error('SYNC_REGISTRATION_REQUIRED');
      if (entity._baseVersion != null && owned._version !== entity._baseVersion) return null;
    }
    try {
      return await SyncRegistration.findOneAndUpdate(
        { user: userObjectId, clientOperationId: operationId },
        { $setOnInsert: { receiptId: randomUUID(), user: userObjectId, clientOperationId: operationId, operationType, entityType, entityId, baseVersion: entity._baseVersion, fingerprint, state: 'registered' } },
        { upsert: true, returnDocument: 'after' }
      ).lean();
    } catch (error: any) {
      if (error?.code === 11000) {
        const winner = await SyncRegistration.findOne({ user: userObjectId, clientOperationId: operationId }).lean();
        if (!winner || winner.operationType !== operationType || winner.entityType !== entityType || winner.entityId !== entityId || winner.baseVersion !== entity._baseVersion || winner.fingerprint !== fingerprint) throw new Error('SYNC_RECEIPT_MISMATCH');
        return winner;
      }
      throw error;
    }
  }

  private async clearObservedFailure(userId: string, entity: any): Promise<void> {
    const entityType = String(entity._entityType || 'unknown');
    const entityId = String(entity._id || entity._clientId || 'unknown');
    if (!['expense', 'outcome', 'category'].includes(entityType) || !entityId) return;
    if (typeof entity._receiptId === 'string') {
      await SyncRegistration.updateOne(
        { user: new mongoose.Types.ObjectId(userId), receiptId: entity._receiptId },
        { $set: { state: 'completed' } }
      );
    }
    if (typeof entity._receiptId === 'string') {
      await SyncFailure.deleteOne({
        user: new mongoose.Types.ObjectId(userId),
        registrationId: entity._receiptId,
        terminal: false,
      });
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
      for (const protectedField of ['user', '_id', '__v']) delete entityData[protectedField];
      if (_entityType !== 'category' && entityData.category !== undefined && entityData.category !== null) {
        // Pulled expenses carry a populated category object; clients echo it back.
        const categoryRef =  typeof entityData.category === 'object' ? entityData.category._id : entityData.category;
        const owned =
          mongoose.Types.ObjectId.isValid(categoryRef) &&
          (await Category.exists({ _id: categoryRef, user: userId }));
        if (!owned) throw new Error('Category not found');
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

  async resolveConflict(
    userId: string,
    request: ConflictResolutionRequest
  ): Promise<any> {
    const { conflictId, entityId, entityType, resolution, mergedData } =
      request;
    logger.info(
      `🔧 [SYNC] Resolving conflict for ${entityType}:${entityId} with strategy: ${resolution}`
    );

    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      let Model: any;

      switch (entityType) {
        case 'expense':
        case 'outcome':
          Model = Expense;
          break;
        case 'category':
          Model = Category;
          break;
        default:
          throw new Error(`Unknown entity type: ${entityType}`);
      }

      const conflictQuery: any = conflictId
        ? {
            _id: conflictId,
            user: userObjectId,
          }
        : {
            entityId,
            entityType,
            user: userObjectId,
            resolvedAt: { $exists: false },
          };
      const conflict: any = await SyncConflict.findOne(conflictQuery).lean();
      if (!conflict) throw new Error('Conflict not found or already resolved');
      if (conflict.entityId !== entityId || conflict.entityType !== entityType)
        throw new Error('Conflict identity mismatch');

      const priorResolution: any = await ConflictResolution.findOne({
        conflictId: conflict._id,
        user: userObjectId,
      }).lean();
      if (conflict.resolvedAt || priorResolution) {
        if (!priorResolution || priorResolution.resolution !== resolution)
          throw new Error('Conflict already resolved with a different choice');
        await SyncConflict.updateOne(
          { _id: conflict._id, user: userObjectId, resolvedAt: { $exists: false } },
          { $set: { resolvedAt: new Date(), resolutionState: 'resolved' } }
        );
        const resolvedEntity = await Model.findOne({
          _id: entityId,
          user: userObjectId,
        }).lean();
        return {
          conflictId: String(conflict._id),
          entityType,
          entityId,
          entity: resolvedEntity,
          resolution: 'resolved',
        };
      }
      const claimed = await SyncConflict.findOneAndUpdate(
        {
          _id: conflict._id,
          user: userObjectId,
          resolvedAt: { $exists: false },
          $or: [
            { resolutionState: { $exists: false } },
            { resolutionState: 'resolving', claimedResolution: resolution },
          ],
        },
        { $set: { resolutionState: 'resolving', claimedResolution: resolution } },
        { returnDocument: 'after' }
      ).lean();
      if (!claimed) throw new Error('Conflict already claimed with a different choice');
      const entity = await Model.findOne({ _id: entityId, user: userObjectId });
      if (!entity) throw new Error('Entity not found');
      const expectedVersion = Number(conflict.serverData?._version);
      if (!Number.isInteger(expectedVersion))
        throw new Error('Conflict revision is invalid');

      let resolvedData: any;

      if (resolution === 'local') {
        resolvedData = conflict.localData;
      } else if (resolution === 'merge') {
        if (
          !mergedData ||
          typeof mergedData !== 'object' ||
          Array.isArray(mergedData)
        )
          throw new Error('Merged data is required');
        resolvedData = mergedData;
      }

      const {
        _id: ignoredId,
        user: ignoredUser,
        createdAt: ignoredCreatedAt,
        updatedAt: ignoredUpdatedAt,
        __v: ignoredVersionKey,
        _version: ignoredRevision,
        _syncStatus: ignoredSyncStatus,
        _lastModified: ignoredLastModified,
        _resolutionConflictId: ignoredResolutionMarker,
        _conflictData: ignoredConflictData,
        ...writableData
      } = resolvedData || {};

      // Use Server is a conditional no-op CAS: the authoritative server data
      // is already current, so resolution must not rewrite it or advance its
      // revision. Local and Merge intentionally mutate the entity and advance it.
      const entityAlreadyApplied =
        resolution !== 'server' &&
        String((entity as any)._resolutionConflictId || '') === String(conflict._id) &&
        Number(entity._version) === expectedVersion + 1;
      const updateResult =
        resolution === 'server'
          ? await Model.updateOne(
              { _id: entityId, user: userObjectId, _version: expectedVersion },
              { $set: { _version: expectedVersion } }
            )
          : entityAlreadyApplied
          ? { matchedCount: 1 }
          : await Model.updateOne(
              { _id: entityId, user: userObjectId, _version: expectedVersion },
              {
                $set: {
                  ...writableData,
                  _syncStatus: 'synced',
                  _lastModified: new Date(),
                  _version: expectedVersion + 1,
                  _resolutionConflictId: String(conflict._id),
                },
                $unset: { _conflictData: 1 },
              }
            );
      if (updateResult.matchedCount !== 1)
        throw new Error('SYNC_CONFLICT_STALE_RESOLUTION');
      await SyncConflict.updateOne(
        { _id: conflict._id, user: userObjectId, resolvedAt: { $exists: false } },
        {
          $set: {
            appliedRevision:
              resolution === 'server' ? expectedVersion : expectedVersion + 1,
          },
        }
      );
      const resolvedEntity = await Model.findOne({
        _id: entityId,
        user: userObjectId,
      }).lean();

      // Record resolution
      await ConflictResolution.create({
        conflictId: conflict._id,
        entityId,
        entityType,
        localData: entity.toObject(),
        serverData: conflict.serverData,
        resolution,
        mergedData,
        user: userObjectId,
      });
      await SyncConflict.updateOne(
        {
          _id: conflict._id,
          user: userObjectId,
          entityId,
          entityType,
          resolvedAt: { $exists: false },
        },
        { $set: { resolvedAt: new Date(), resolutionState: 'resolved' } }
      );

      logger.info(`✅ [SYNC] Conflict resolved for ${entityType}:${entityId}`);
      return {
        conflictId: String(conflict._id),
        entityType,
        entityId,
        entity: resolvedEntity,
        resolution: 'resolved',
      };
    } catch (error: any) {
      logger.error('❌ [SYNC] Conflict resolution error:', error);
      throw new Error(`Failed to resolve conflict: ${error.message}`);
    }
  }

  async getConflicts(userId: string): Promise<any[]> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const conflicts = await SyncConflict.find({
        user: userObjectId,
        resolvedAt: { $exists: false },
      })
        .sort({ detectedAt: -1 })
        .limit(50)
        .lean();

      return conflicts.map((conflict: any) => ({
        conflictId: String(conflict._id),
        entityId: conflict.entityId,
        entityType: conflict.entityType,
        localData: conflict.localData,
        serverData: conflict.serverData,
        timestamp: conflict.detectedAt,
      }));
    } catch (error) {
      logger.error('❌ [SYNC] Get conflicts error:', error as Error);
      return [];
    }
  }

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
