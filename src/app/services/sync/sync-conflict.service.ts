import logger from '../logger.service';
import { Expense } from '../../models/expense.model';
import { Category } from '../../models/category.model';
import { ConflictResolution, SyncConflict } from '../../models/sync.model';
import mongoose from 'mongoose';

export interface ConflictResolutionRequest {
  conflictId?: string;
  entityId: string;
  entityType: string;
  resolution: 'local' | 'server' | 'merge';
  mergedData?: any;
}

export class SyncConflictService {
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
          {
            _id: conflict._id,
            user: userObjectId,
            resolvedAt: { $exists: false },
          },
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
        {
          $set: { resolutionState: 'resolving', claimedResolution: resolution },
        },
        { returnDocument: 'after' }
      ).lean();
      if (!claimed)
        throw new Error('Conflict already claimed with a different choice');
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
        String((entity as any)._resolutionConflictId || '') ===
          String(conflict._id) &&
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
                {
                  _id: entityId,
                  user: userObjectId,
                  _version: expectedVersion,
                },
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
        {
          _id: conflict._id,
          user: userObjectId,
          resolvedAt: { $exists: false },
        },
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
}
