import { Types } from 'mongoose';
import { AuditLog, TemporaryPermission } from '../models';
import { AuditAction } from '../models/audit-log.model';
import { Permission } from '../types/permissions.types';
import { PlanSlug } from '../types/plan.types';
import {
  AuditLogRetentionJob,
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  MIN_AUDIT_LOG_RETENTION_DAYS,
  resolveAuditLogRetentionDays,
} from '../jobs/audit-log-retention.job';
import { permissionExpiryJob } from '../jobs/permission-expiry.job';
import { attachPlanContext } from '../middleware/plan.middleware';
import { permissionCacheService } from '../services/permission-cache.service';
import { temporaryPermissionService } from '../services/temporary-permission.service';

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const TEMP = Object.values(Permission)[0] as Permission;

describe('audit log retention', () => {
  it('resolves the retention period with a safe lower bound', () => {
    expect(resolveAuditLogRetentionDays(undefined)).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
    expect(resolveAuditLogRetentionDays('not-a-number')).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
    expect(resolveAuditLogRetentionDays('180')).toBe(180);
    expect(resolveAuditLogRetentionDays('1')).toBe(MIN_AUDIT_LOG_RETENTION_DAYS);
  });

  it('deletes only logs older than the retention period', async () => {
    await AuditLog.create([
      { action: AuditAction.USER_LOGIN, timestamp: daysAgo(400) },
      { action: AuditAction.USER_LOGIN, timestamp: daysAgo(366) },
      { action: AuditAction.USER_LOGIN, timestamp: daysAgo(364) },
      { action: AuditAction.USER_LOGIN, timestamp: daysAgo(1) },
    ] as any);

    const deleted = await new AuditLogRetentionJob().execute(365);

    expect(deleted).toBe(2);
    expect(await AuditLog.countDocuments()).toBe(2);
  });
});

describe('permission expiry job', () => {
  it('deactivates expired temporary permissions, audits them, and invalidates the cache', async () => {
    const userId = new Types.ObjectId();
    const invalidate = jest.spyOn(permissionCacheService, 'invalidateUser');
    const base = {
      userId,
      permission: TEMP,
      grantedBy: new Types.ObjectId(),
      grantedAt: daysAgo(10),
      startDate: daysAgo(10),
      isActive: true,
    };
    // Raw inserts bypass the pre-save "end date must be in the future" rule.
    const { insertedIds } = await TemporaryPermission.collection.insertMany([
      { ...base, endDate: daysAgo(1) },
      { ...base, endDate: new Date(Date.now() + 86_400_000) },
    ]);

    await permissionExpiryJob.execute();

    const expired = await TemporaryPermission.findById(insertedIds[0]).lean();
    const current = await TemporaryPermission.findById(insertedIds[1]).lean();
    expect(expired?.isActive).toBe(false);
    expect(current?.isActive).toBe(true);
    expect(invalidate).toHaveBeenCalledWith(userId.toString());
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.PERMISSION_EXPIRE_TEMPORARY,
        targetUserId: userId.toString(),
      })
    ).toBe(1);
    invalidate.mockRestore();
  });
});

describe('attachPlanContext cache isolation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('never writes request-scoped temporary permissions into the cached context', async () => {
    const cached = {
      planSlug: PlanSlug.Free,
      permissions: [] as Permission[],
      limits: {} as any,
      planExpiresAt: null,
      isExpired: false,
    };
    jest
      .spyOn(permissionCacheService, 'getUserPlanContext')
      .mockResolvedValue(cached);
    const temp = jest
      .spyOn(temporaryPermissionService, 'getActivePermissionsList')
      .mockResolvedValueOnce([TEMP])
      .mockResolvedValueOnce([]);

    const run = async () => {
      const req: any = { user_id: new Types.ObjectId().toString() };
      const res: any = { status: () => res, json: () => res };
      await attachPlanContext(req, res, () => undefined);
      return req.planContext.permissions as Permission[];
    };

    expect(await run()).toContain(TEMP); // while the grant is active
    expect(cached.permissions).toEqual([]); // cache untouched
    expect(await run()).not.toContain(TEMP); // after it expires
    expect(temp).toHaveBeenCalledTimes(2);
  });
});
