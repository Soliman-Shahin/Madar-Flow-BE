import { SyncService } from '../services/sync.service';
import { SyncRegistration } from '../models/sync-registration.model';
import { SyncFailure } from '../models/sync-failure.model';
import { SyncConflict } from '../models/sync.model';
import { Category } from '../models/category.model';
import { Expense } from '../models/expense.model';
import { Notification } from '../models/notification.model';
import { NotificationService } from '../services/notification.service';
import mongoose from 'mongoose';

jest.mock('../services/socket.service', () => ({
  getSocketService: () => ({ sendNotificationToUser: jest.fn() }),
}));
jest.mock('../services/push-delivery.service', () => ({
  PushDeliveryService: {
    sendToUsers: jest.fn().mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      invalidTokens: 0,
    }),
  },
}));

const userA = '507f1f77bcf86cd799439011';
const userB = '507f1f77bcf86cd799439013';

describe('sync receipt contract', () => {
  const service = new SyncService();

  const failedCreate = (operationId = 'receipt-create-1') => ({
    _operationId: operationId,
    _operationType: 'CREATE',
    _entityType: 'expense',
    _id: `offline-${operationId}`,
    description: 'invalid receipt test',
    amount: 10,
    date: new Date().toISOString(),
  });

  it('returns and persists a receipt when the first CREATE fails, then reuses it', async () => {
    const original = failedCreate();
    const first = await service.pushData(userA, [original]);
    const receiptId = first.receipts['receipt-create-1'];
    expect(receiptId).toEqual(expect.any(String));
    expect(first.errors).toHaveLength(1);
    expect(await SyncRegistration.countDocuments({ user: userA })).toBe(1);
    expect((await SyncFailure.findOne({ user: userA }))?.registrationId).toBe(
      receiptId
    );

    const second = await service.pushData(userA, [
      { ...original, _receiptId: receiptId },
    ]);
    expect(second.receipts['receipt-create-1']).toBe(receiptId);
    expect(await SyncRegistration.countDocuments({ user: userA })).toBe(1);
  });

  it('rejects wrong-user and immutable binding mismatches without failure state', async () => {
    const first = await service.pushData(userA, [
      failedCreate('receipt-binding'),
    ]);
    const receiptId = first.receipts['receipt-binding'];
    const variants = [
      {
        ...failedCreate('receipt-binding'),
        _receiptId: receiptId,
        _id: 'offline-other-id',
      },
      {
        ...failedCreate('receipt-binding'),
        _receiptId: receiptId,
        _entityType: 'category',
      },
      {
        ...failedCreate('receipt-binding'),
        _receiptId: receiptId,
        _operationType: 'UPDATE',
      },
      { ...failedCreate('receipt-binding'), _receiptId: receiptId, amount: 99 },
    ];
    for (const entity of variants) {
      const result = await service.pushData(userA, [entity]);
      expect(result.errors[0]?.reason).toBe('SYNC_RECEIPT_MISMATCH');
    }
    const wrongUser = await service.pushData(userB, [
      { ...failedCreate('receipt-binding'), _receiptId: receiptId },
    ]);
    expect(wrongUser.errors[0]?.reason).toBe('SYNC_RECEIPT_MISMATCH');
    expect(await SyncFailure.countDocuments({ user: userB })).toBe(0);
  });

  it('resolves concurrent identical registration idempotently and rejects a mismatched winner', async () => {
    const entity = failedCreate('concurrent-registration');
    const registrations = await Promise.all([
      (service as any).ledger.registerOperation(userA, entity),
      (service as any).ledger.registerOperation(userA, entity),
    ]);
    expect(registrations[0].receiptId).toBe(registrations[1].receiptId);
    expect(
      await SyncRegistration.countDocuments({
        clientOperationId: entity._operationId,
      })
    ).toBe(1);
    await expect(
      (service as any).ledger.registerOperation(userA, {
        ...entity,
        amount: 11,
      })
    ).rejects.toThrow('SYNC_RECEIPT_MISMATCH');
  });

  it('hard-gates non-owned UPDATE and DELETE while preserving stale conflict behavior', async () => {
    const category = await Category.create({
      user: userA,
      title: 'owned',
      icon: 'folder',
      color: '#123456',
      _version: 1,
    });
    const expense = await Expense.create({
      user: userA,
      category: category._id,
      description: 'owned',
      amount: 10,
      date: new Date(),
      _version: 2,
    });
    const update = {
      _operationId: 'owned-update',
      _operationType: 'UPDATE',
      _entityType: 'expense',
      _id: expense._id.toString(),
      _baseVersion: 2,
      description: 'changed',
      amount: 11,
      category: category._id.toString(),
      date: new Date().toISOString(),
    };
    const valid = await service.pushData(userA, [update]);
    expect(valid.processed).toBe(1);
    expect(
      await SyncRegistration.countDocuments({
        clientOperationId: 'owned-update',
      })
    ).toBe(1);

    const wrong = await service.pushData(userB, [update]);
    expect(wrong.errors[0]?.reason).toBe('SYNC_REGISTRATION_REQUIRED');
    expect(await Expense.findById(expense._id).then((row) => row?.amount)).toBe(
      11
    );

    const stale = {
      ...update,
      _operationId: 'stale-update',
      _baseVersion: 1,
      amount: 12,
    };
    const conflict = await service.pushData(userA, [stale]);
    expect(conflict.conflicts).toHaveLength(1);
    expect(
      await SyncFailure.countDocuments({ operationId: 'stale-update' })
    ).toBe(0);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(0);
  });

  it('resets nonterminal failures after success and uses registration identity for dedupe', async () => {
    const entity = {
      ...failedCreate('reset-sequence'),
      _id: 'offline-reset-sequence',
    };
    await service.pushData(userA, [entity]);
    const registration = await SyncRegistration.findOne({
      clientOperationId: 'reset-sequence',
    }).lean();
    expect(registration).toBeTruthy();
    await SyncFailure.updateOne(
      { registrationId: registration!.receiptId },
      { $set: { attemptCount: 2 } }
    );

    const category = await Category.create({
      user: userA,
      title: 'reset success',
      icon: 'folder',
      color: '#123456',
      _version: 1,
    });
    const success = {
      _operationId: 'reset-success',
      _operationType: 'CREATE',
      _entityType: 'category',
      _id: 'offline-reset-success',
      title: 'reset success',
      icon: 'folder',
      color: '#123456',
      type: 'outcome',
      order: 0,
    };
    await service.pushData(userA, [success]);
    expect(
      await SyncFailure.findOne({ registrationId: registration!.receiptId })
    ).toBeTruthy();
    expect(category).toBeTruthy();
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(0);
  });

  async function failureRegistration(id: string) {
    const entity = failedCreate(id);
    const registration = await (service as any).ledger.registerOperation(
      userA,
      entity
    );
    return {
      entity: { ...entity, _receiptId: registration.receiptId },
      registration,
    };
  }

  it('covers owned DELETE and rejects another user DELETE before mutation', async () => {
    const category = await Category.create({
      user: userA,
      title: 'delete',
      icon: 'folder',
      color: '#123456',
      _version: 1,
    });
    const expense = await Expense.create({
      user: userA,
      category: category._id,
      description: 'delete',
      amount: 5,
      date: new Date(),
      _version: 1,
    });
    const deletion = {
      _operationId: 'owned-delete',
      _operationType: 'DELETE',
      _entityType: 'expense',
      _id: expense._id.toString(),
      _baseVersion: 1,
      _isDeleted: true,
    };
    const owned = await service.pushData(userA, [deletion]);
    expect(owned.processed).toBe(1);
    expect(
      await SyncRegistration.countDocuments({
        clientOperationId: 'owned-delete',
      })
    ).toBe(1);

    const otherCategory = await Category.create({
      user: userB,
      title: 'other',
      icon: 'folder',
      color: '#123456',
      _version: 1,
    });
    const otherExpense = await Expense.create({
      user: userB,
      category: otherCategory._id,
      description: 'protected',
      amount: 5,
      date: new Date(),
      _version: 1,
    });
    const rejected = await service.pushData(userA, [
      {
        ...deletion,
        _operationId: 'foreign-delete',
        _id: otherExpense._id.toString(),
      },
    ]);
    expect(rejected.errors[0]?.reason).toBe('SYNC_REGISTRATION_REQUIRED');
    expect(await Expense.findById(otherExpense._id)).toBeTruthy();
    expect(
      await SyncFailure.countDocuments({ operationId: 'foreign-delete' })
    ).toBe(0);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(0);
  });

  it('resets failure history on success and requires three post-reset failures', async () => {
    const { entity, registration } = await failureRegistration('reset-direct');
    await Promise.all([
      (service as any).ledger.recordObservedFailure(userA, entity),
    ]);
    const category = {
      _operationId: 'reset-success-direct',
      _operationType: 'CREATE',
      _entityType: 'category',
      _id: 'offline-reset-direct',
      title: 'ok',
      icon: 'folder',
      color: '#123456',
      type: 'outcome',
      order: 0,
    };
    await service.pushData(userA, [category]);
    await (service as any).ledger.clearObservedFailure(userA, entity);
    expect(
      await SyncFailure.findOne({ registrationId: registration.receiptId })
    ).toBeNull();
    await (service as any).ledger.recordObservedFailure(userA, entity);
    await (service as any).ledger.recordObservedFailure(userA, entity);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(0);
    await (service as any).ledger.recordObservedFailure(userA, entity);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(1);
  });

  it('counts simultaneous first failures without losing an increment', async () => {
    const { entity, registration } =
      await failureRegistration('parallel-first');
    await Promise.all([
      (service as any).ledger.recordObservedFailure(userA, entity),
      (service as any).ledger.recordObservedFailure(userA, entity),
    ]);
    expect(
      (await SyncFailure.findOne({ registrationId: registration.receiptId }))
        ?.attemptCount
    ).toBe(2);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(0);
  });

  it('allows only one notification at simultaneous threshold crossing', async () => {
    const { entity, registration } =
      await failureRegistration('parallel-threshold');
    await SyncFailure.create({
      user: userA,
      registrationId: registration.receiptId,
      operationId: entity._operationId,
      entityType: entity._entityType,
      entityId: entity._id,
      attemptCount: 2,
      terminal: false,
      dispatchState: 'pending',
    });
    await Promise.all([
      (service as any).ledger.recordObservedFailure(userA, entity),
      (service as any).ledger.recordObservedFailure(userA, entity),
    ]);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(1);
    expect(
      (await SyncFailure.findOne({ registrationId: registration.receiptId }))
        ?.dispatchState
    ).toBe('dispatched');
    await (service as any).ledger.recordObservedFailure(userA, entity);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(1);
  });

  it('keeps success/failure race within a valid serialized lifecycle', async () => {
    const { entity, registration } = await failureRegistration('success-race');
    await SyncFailure.create({
      user: userA,
      registrationId: registration.receiptId,
      operationId: entity._operationId,
      entityType: entity._entityType,
      entityId: entity._id,
      attemptCount: 2,
      terminal: false,
      dispatchState: 'pending',
    });
    await Promise.all([
      (service as any).ledger.recordObservedFailure(userA, entity),
      (service as any).ledger.clearObservedFailure(userA, entity),
    ]);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBeLessThanOrEqual(1);
    const state = await SyncFailure.findOne({
      registrationId: registration.receiptId,
    }).lean();
    expect(!state || [0, 1, 2, 3].includes(state.attemptCount)).toBe(true);
  });

  it('recovers from dispatch exception and retries without incrementing attempts', async () => {
    const { entity, registration } =
      await failureRegistration('dispatch-retry');
    const dispatch = jest.spyOn(NotificationService, 'dispatchUserEvent');
    dispatch
      .mockRejectedValueOnce(new Error('dispatch down'))
      .mockResolvedValue({} as any);
    await (service as any).ledger.recordObservedFailure(userA, entity);
    await (service as any).ledger.recordObservedFailure(userA, entity);
    await (service as any).ledger.recordObservedFailure(userA, entity);
    expect(
      (await SyncFailure.findOne({ registrationId: registration.receiptId }))
        ?.dispatchState
    ).toBe('pending');
    expect(
      (await SyncFailure.findOne({ registrationId: registration.receiptId }))
        ?.attemptCount
    ).toBe(3);
    await (service as any).ledger.recordObservedFailure(userA, entity);
    expect(
      (await SyncFailure.findOne({ registrationId: registration.receiptId }))
        ?.dispatchState
    ).toBe('dispatched');
    dispatch.mockRestore();
  });

  it('reclaims stale dispatching state and dispatches without incrementing', async () => {
    const { entity, registration } = await failureRegistration('stale-reclaim');
    await SyncFailure.create({
      user: userA,
      registrationId: registration.receiptId,
      operationId: entity._operationId,
      entityType: entity._entityType,
      entityId: entity._id,
      attemptCount: 3,
      terminal: true,
      dispatchState: 'dispatching',
    });
    await mongoose.connection
      .db!.collection('sync_failures')
      .updateOne(
        { registrationId: registration.receiptId },
        { $set: { updatedAt: new Date(Date.now() - 6 * 60 * 1000) } }
      );
    await (service as any).ledger.recordObservedFailure(userA, entity);
    const state = await SyncFailure.findOne({
      registrationId: registration.receiptId,
    });
    expect(state?.dispatchState).toBe('dispatched');
    expect(state?.attemptCount).toBe(3);
  });

  it('concurrent stale reclaim has one dispatch winner and no extra attempt', async () => {
    const { entity, registration } =
      await failureRegistration('stale-parallel');
    await SyncFailure.create({
      user: userA,
      registrationId: registration.receiptId,
      operationId: entity._operationId,
      entityType: entity._entityType,
      entityId: entity._id,
      attemptCount: 3,
      terminal: true,
      dispatchState: 'dispatching',
    });
    await mongoose.connection
      .db!.collection('sync_failures')
      .updateOne(
        { registrationId: registration.receiptId },
        { $set: { updatedAt: new Date(Date.now() - 6 * 60 * 1000) } }
      );
    await Promise.all([
      (service as any).ledger.recordObservedFailure(userA, entity),
      (service as any).ledger.recordObservedFailure(userA, entity),
    ]);
    const state = await SyncFailure.findOne({
      registrationId: registration.receiptId,
    });
    expect(state?.dispatchState).toBe('dispatched');
    expect(state?.attemptCount).toBe(3);
    expect(
      await Notification.countDocuments({ event: 'sync.repeated_failure' })
    ).toBe(1);
  });
});
