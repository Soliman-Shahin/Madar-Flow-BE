import { errorCode } from '../../shared/errors';
import logger from '../logger.service';
import { Expense } from '../../models/expense.model';
import { Category } from '../../models/category.model';
import mongoose from 'mongoose';
import { NotificationService } from '../notification.service';
import { SyncFailure } from '../../models/sync-failure.model';
import { SyncRegistration } from '../../models/sync-registration.model';
import { createHash, randomUUID } from 'crypto';

const REPEATED_FAILURE_THRESHOLD = 3;
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{6,63}$/i;

const stableCanonicalize = (value: any): any => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result: Record<string, unknown>, key) => {
        result[key] = stableCanonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
};

const mutationFingerprint = (entity: any): string => {
  const data = Object.keys(entity)
    .filter(
      (key) =>
        ![
          '_operationId',
          '_operationType',
          '_receiptId',
          '_retryCount',
          '_maxRetries',
          '_syncError',
        ].includes(key)
    )
    .sort()
    .reduce((result: Record<string, unknown>, key) => {
      result[key] = entity[key];
      return result;
    }, {});
  return createHash('sha256')
    .update(JSON.stringify(stableCanonicalize(data)))
    .digest('hex');
};

/** Idempotency receipts and repeated-failure tracking for pushed sync operations. */
export class SyncOperationLedger {
  async registerOperation(userId: string, entity: any) {
    const operationId =
      typeof entity._operationId === 'string' ? entity._operationId.trim() : '';
    const operationType =
      entity._operationType ||
      (entity._isDeleted
        ? 'DELETE'
        : entity._baseVersion != null
          ? 'UPDATE'
          : 'CREATE');
    const entityType = String(entity._entityType || '');
    const entityId = String(entity._id || '');
    if (
      !OPERATION_ID_PATTERN.test(operationId) ||
      !['CREATE', 'UPDATE', 'DELETE'].includes(operationType) ||
      !['expense', 'outcome', 'category'].includes(entityType) ||
      !entityId ||
      entityId.length > 200
    )
      return null;
    const fingerprint = mutationFingerprint(entity);
    const userObjectId = new mongoose.Types.ObjectId(userId);
    if (entity._receiptId) {
      const receipt = await SyncRegistration.findOne({
        receiptId: entity._receiptId,
      }).lean();
      if (!receipt || String(receipt.user) !== String(userObjectId))
        throw new Error('SYNC_RECEIPT_MISMATCH');
      if (
        receipt.clientOperationId !== operationId ||
        receipt.entityType !== entityType ||
        receipt.entityId !== entityId ||
        receipt.operationType !== operationType ||
        receipt.fingerprint !== fingerprint
      )
        throw new Error('SYNC_RECEIPT_MISMATCH');
    }
    const existing = await SyncRegistration.findOne({
      user: userObjectId,
      clientOperationId: operationId,
    }).lean();
    if (existing) {
      if (
        (entity._receiptId && entity._receiptId !== existing.receiptId) ||
        existing.entityType !== entityType ||
        existing.entityId !== entityId ||
        existing.operationType !== operationType ||
        existing.fingerprint !== fingerprint
      )
        throw new Error('SYNC_RECEIPT_MISMATCH');
      return existing;
    }
    if (operationType !== 'CREATE') {
      const Model: any = entityType === 'category' ? Category : Expense;
      const owned = await Model.findOne({ _id: entityId, user: userObjectId })
        .select('_version')
        .lean();
      if (!owned) throw new Error('SYNC_REGISTRATION_REQUIRED');
      if (entity._baseVersion != null && owned._version !== entity._baseVersion)
        return null;
    }
    try {
      return await SyncRegistration.findOneAndUpdate(
        { user: userObjectId, clientOperationId: operationId },
        {
          $setOnInsert: {
            receiptId: randomUUID(),
            user: userObjectId,
            clientOperationId: operationId,
            operationType,
            entityType,
            entityId,
            baseVersion: entity._baseVersion,
            fingerprint,
            state: 'registered',
          },
        },
        { upsert: true, returnDocument: 'after' }
      ).lean();
    } catch (error: unknown) {
      if (errorCode(error) === 11000) {
        const winner = await SyncRegistration.findOne({
          user: userObjectId,
          clientOperationId: operationId,
        }).lean();
        if (
          !winner ||
          winner.operationType !== operationType ||
          winner.entityType !== entityType ||
          winner.entityId !== entityId ||
          winner.baseVersion !== entity._baseVersion ||
          winner.fingerprint !== fingerprint
        )
          throw new Error('SYNC_RECEIPT_MISMATCH');
        return winner;
      }
      throw error;
    }
  }

  async recordObservedFailure(userId: string, entity: any): Promise<void> {
    const receiptId =
      typeof entity._receiptId === 'string' ? entity._receiptId : '';
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
      if (
        !registration ||
        registration.entityType !== entityType ||
        registration.entityId !== entityId
      )
        return;
      const identityFilter = {
        user: new mongoose.Types.ObjectId(userId),
        registrationId: registration.receiptId,
      };
      let existing = await SyncFailure.findOne(identityFilter).lean();
      let reclaimed = false;
      if (
        existing?.terminal &&
        existing.dispatchState === 'dispatching' &&
        existing.updatedAt &&
        Date.now() - new Date(existing.updatedAt).getTime() > 5 * 60 * 1000
      ) {
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
      } catch (error: unknown) {
        if (errorCode(error) === 11000) {
          failure = await SyncFailure.findOneAndUpdate(
            { ...identityFilter, terminal: false },
            { $inc: { attemptCount: 1 } },
            { returnDocument: 'after' }
          ).lean();
        } else {
          throw error;
        }
      }

      if (
        !failure ||
        failure.terminal ||
        failure.attemptCount < REPEATED_FAILURE_THRESHOLD
      )
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

  async clearObservedFailure(userId: string, entity: any): Promise<void> {
    const entityType = String(entity._entityType || 'unknown');
    const entityId = String(entity._id || entity._clientId || 'unknown');
    if (!['expense', 'outcome', 'category'].includes(entityType) || !entityId)
      return;
    if (typeof entity._receiptId === 'string') {
      await SyncRegistration.updateOne(
        {
          user: new mongoose.Types.ObjectId(userId),
          receiptId: entity._receiptId,
        },
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

  async dispatchRepeatedFailure(userId: string, failure: any): Promise<void> {
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
        message:
          'A change could not be synchronized after several attempts. / تعذر مزامنة تغيير بعد عدة محاولات.',
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
}
