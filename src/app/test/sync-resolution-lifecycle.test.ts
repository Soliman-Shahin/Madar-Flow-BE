jest.mock('../services/socket.service', () => ({
  getSocketService: () => ({ sendNotificationToUser: jest.fn() }),
}));
jest.mock('../services/push-delivery.service', () => ({
  PushDeliveryService: { sendToUsers: jest.fn().mockResolvedValue({}) },
}));

import { Expense } from '../models/expense.model';
import { Category } from '../models/category.model';
import { SyncConflict, ConflictResolution } from '../models/sync.model';
import { SyncService } from '../services/sync.service';

describe('sync conflict resolution lifecycle', () => {
  const userA = '507f1f77bcf86cd799439011';
  const userB = '507f1f77bcf86cd799439013';

  async function seedConflict(user = userA) {
    const category = await Category.create({
      user,
      _clientId: `qa_${Date.now()}_${Math.random()}`,
      title: 'QA',
      icon: 'folder',
      color: '#123456',
      _version: 1,
    });
    const expense = await Expense.create({
      user,
      _clientId: `qa_expense_${Date.now()}_${Math.random()}`,
      category: category._id,
      description: 'server',
      amount: 300,
      date: new Date(),
      _version: 2,
    });
    const conflict = await SyncConflict.create({
      dedupeKey: `${user}:expense:${expense._id}:2:2`,
      entityId: expense._id.toString(),
      entityType: 'expense',
      user,
      localData: {
        _id: expense._id.toString(),
        user,
        category: category._id,
        description: 'local',
        amount: 200,
        date: expense.date,
        _version: 1,
      },
      serverData: {
        _id: expense._id.toString(),
        user,
        category: category._id,
        description: 'server',
        amount: 300,
        date: expense.date,
        _version: 2,
      },
    });
    return { expense, conflict };
  }

  it.each([
    ['local', { amount: 200 }],
    ['server', { amount: 300 }],
  ] as const)(
    'resolves %s from persisted conflict data and advances revision',
    async (resolution, expected) => {
      const { expense, conflict } = await seedConflict();
      const result = await new SyncService().resolveConflict(userA, {
        conflictId: conflict._id.toString(),
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution,
      });
      expect(result.entity.amount).toBe(expected.amount);
      expect(result.entity._version).toBe(resolution === 'server' ? 2 : 3);
      expect(await SyncConflict.findById(conflict._id)).toEqual(
        expect.objectContaining({ resolvedAt: expect.any(Date) })
      );
      expect(
        await ConflictResolution.countDocuments({
          entityId: expense._id.toString(),
        })
      ).toBe(1);
    }
  );

  it('resolves a valid merge and rejects malformed merge data', async () => {
    const first = await seedConflict();
    const merged = await new SyncService().resolveConflict(userA, {
      conflictId: first.conflict._id.toString(),
      entityId: first.expense._id.toString(),
      entityType: 'expense',
      resolution: 'merge',
      mergedData: { amount: 250, description: 'merged' },
    });
    expect(merged.entity.amount).toBe(250);
    expect(merged.entity._version).toBe(3);
    const second = await seedConflict();
    await expect(
      new SyncService().resolveConflict(userA, {
        conflictId: second.conflict._id.toString(),
        entityId: second.expense._id.toString(),
        entityType: 'expense',
        resolution: 'merge',
        mergedData: [] as any,
      })
    ).rejects.toThrow('Merged data is required');
  });

  it.each(['local', 'server', 'merge'] as const)(
    'rejects stale %s resolution after a third server edit',
    async (resolution) => {
      const { expense, conflict } = await seedConflict();
      await Expense.updateOne(
        { _id: expense._id, user: userA },
        { $set: { amount: 400, _version: 3 } }
      );
      await expect(
        new SyncService().resolveConflict(userA, {
          conflictId: conflict._id.toString(),
          entityId: expense._id.toString(),
          entityType: 'expense',
          resolution,
          mergedData: resolution === 'merge' ? { amount: 250 } : undefined,
        })
      ).rejects.toThrow('SYNC_CONFLICT_STALE_RESOLUTION');
      expect((await Expense.findById(expense._id))?.amount).toBe(400);
      expect(
        (await SyncConflict.findById(conflict._id))?.resolvedAt
      ).toBeUndefined();
      expect(
        await ConflictResolution.countDocuments({
          entityId: expense._id.toString(),
        })
      ).toBe(0);
    }
  );

  it('enforces owner isolation and deterministic already-resolved retry behavior', async () => {
    const { expense, conflict } = await seedConflict();
    await expect(
      new SyncService().resolveConflict(userB, {
        conflictId: conflict._id.toString(),
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution: 'local',
      })
    ).rejects.toThrow('Conflict not found or already resolved');
    const first = await new SyncService().resolveConflict(userA, {
      conflictId: conflict._id.toString(),
      entityId: expense._id.toString(),
      entityType: 'expense',
      resolution: 'server',
    });
    expect(first.entity._version).toBe(2);
    const retry = await new SyncService().resolveConflict(userA, {
      conflictId: conflict._id.toString(),
      entityId: expense._id.toString(),
      entityType: 'expense',
      resolution: 'server',
    });
    expect(retry.entity._version).toBe(2);
    expect((await Expense.findById(expense._id))?._version).toBe(2);
    expect(
      await ConflictResolution.countDocuments({
        entityId: expense._id.toString(),
      })
    ).toBe(1);
  });

  it.each(['local', 'merge'] as const)(
    'converges after %s entity application before history',
    async (resolution) => {
      const { expense, conflict } = await seedConflict();
      await Expense.updateOne(
        { _id: expense._id, user: userA },
        {
          $set: {
            amount: resolution === 'local' ? 200 : 250,
            _version: 3,
            _resolutionConflictId: String(conflict._id),
          },
        }
      );
      await SyncConflict.updateOne(
        { _id: conflict._id },
        {
          $set: {
            resolutionState: 'resolving',
            claimedResolution: resolution,
            appliedRevision: 3,
          },
        }
      );
      const result = await new SyncService().resolveConflict(userA, {
        conflictId: conflict._id.toString(),
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution,
        mergedData: resolution === 'merge' ? { amount: 250 } : undefined,
      });
      expect(result.entity._version).toBe(3);
      expect((await Expense.findById(expense._id))?._version).toBe(3);
      expect(
        await ConflictResolution.countDocuments({ conflictId: conflict._id })
      ).toBe(1);
      expect((await SyncConflict.findById(conflict._id))?.resolvedAt).toEqual(
        expect.any(Date)
      );
    }
  );

  it('converges after Use Server CAS before history without changing revision', async () => {
    const { expense, conflict } = await seedConflict();
    await SyncConflict.updateOne(
      { _id: conflict._id },
      {
        $set: {
          resolutionState: 'resolving',
          claimedResolution: 'server',
          appliedRevision: 2,
        },
      }
    );
    const result = await new SyncService().resolveConflict(userA, {
      conflictId: conflict._id.toString(),
      entityId: expense._id.toString(),
      entityType: 'expense',
      resolution: 'server',
    });
    expect(result.entity._version).toBe(2);
    expect((await Expense.findById(expense._id))?._version).toBe(2);
    expect(
      await ConflictResolution.countDocuments({ conflictId: conflict._id })
    ).toBe(1);
  });

  it('finalizes an existing history record without duplicating it', async () => {
    const { expense, conflict } = await seedConflict();
    await SyncConflict.updateOne(
      { _id: conflict._id },
      {
        $set: {
          resolutionState: 'resolving',
          claimedResolution: 'local',
          appliedRevision: 3,
        },
      }
    );
    await Expense.updateOne(
      { _id: expense._id },
      {
        $set: {
          amount: 200,
          _version: 3,
          _resolutionConflictId: String(conflict._id),
        },
      }
    );
    await ConflictResolution.create({
      conflictId: conflict._id,
      entityId: expense._id.toString(),
      entityType: 'expense',
      localData: { amount: 200 },
      serverData: { amount: 300 },
      resolution: 'local',
      user: userA,
    });
    const result = await new SyncService().resolveConflict(userA, {
      conflictId: conflict._id.toString(),
      entityId: expense._id.toString(),
      entityType: 'expense',
      resolution: 'local',
    });
    expect(result.entity._version).toBe(3);
    expect(
      await ConflictResolution.countDocuments({ conflictId: conflict._id })
    ).toBe(1);
    expect((await SyncConflict.findById(conflict._id))?.resolvedAt).toEqual(
      expect.any(Date)
    );
  });

  it.each(['local', 'merge'] as const)(
    'continues a claimed-but-not-applied %s resolution exactly once',
    async (resolution) => {
      const { expense, conflict } = await seedConflict();
      await SyncConflict.updateOne(
        { _id: conflict._id },
        {
          $set: { resolutionState: 'resolving', claimedResolution: resolution },
        }
      );
      const result = await new SyncService().resolveConflict(userA, {
        conflictId: conflict._id.toString(),
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution,
        mergedData: resolution === 'merge' ? { amount: 250 } : undefined,
      });
      expect(result.entity._version).toBe(3);
      expect(
        await ConflictResolution.countDocuments({ conflictId: conflict._id })
      ).toBe(1);
    }
  );

  it('rejects a different choice while a resolution is in progress', async () => {
    const { expense, conflict } = await seedConflict();
    await SyncConflict.updateOne(
      { _id: conflict._id },
      { $set: { resolutionState: 'resolving', claimedResolution: 'local' } }
    );
    await expect(
      new SyncService().resolveConflict(userA, {
        conflictId: conflict._id.toString(),
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution: 'server',
      })
    ).rejects.toThrow('Conflict already claimed with a different choice');
    expect((await Expense.findById(expense._id))?.amount).toBe(300);
    expect(
      await ConflictResolution.countDocuments({ conflictId: conflict._id })
    ).toBe(0);
  });

  it('does not treat an unrelated entity marker as proof of application', async () => {
    const { expense, conflict } = await seedConflict();
    await Expense.updateOne(
      { _id: expense._id },
      { $set: { _resolutionConflictId: 'unrelated-conflict', _version: 3 } }
    );
    await expect(
      new SyncService().resolveConflict(userA, {
        conflictId: conflict._id.toString(),
        entityId: expense._id.toString(),
        entityType: 'expense',
        resolution: 'local',
      })
    ).rejects.toThrow('SYNC_CONFLICT_STALE_RESOLUTION');
    expect(
      await ConflictResolution.countDocuments({ conflictId: conflict._id })
    ).toBe(0);
  });
});
