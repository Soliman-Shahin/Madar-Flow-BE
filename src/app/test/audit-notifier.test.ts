import { AuditAction } from '../models/audit-log.model';
import { auditAndNotifyStaff } from '../services/audit-notifier.service';
import { auditLogService } from '../services/audit-log.service';
import * as socketModule from '../services/socket.service';

const base = {
  action: AuditAction.CATEGORY_CREATED,
  notification: { title: 'T', message: 'M', type: 'info' as const },
  targetResourceType: 'Category',
  targetResourceId: 'abc',
  changes: { title: 'x' },
};

describe('auditAndNotifyStaff', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs the audit entry and sends it to staff rooms only, carrying the audit id', async () => {
    jest.spyOn(auditLogService, 'log').mockResolvedValue({ _id: { toString: () => 'audit-1' } } as any);
    const fake = { broadcastToStaff: jest.fn(), broadcastNotification: jest.fn() };
    jest.spyOn(socketModule, 'getSocketService').mockReturnValue(fake as any);

    await auditAndNotifyStaff({ ...base, actorId: 'u1', actorEmail: 'a@b.c' });

    expect(fake.broadcastNotification).not.toHaveBeenCalled();
    expect(fake.broadcastToStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        auditLogId: 'audit-1',
        action: AuditAction.CATEGORY_CREATED,
        actor: expect.objectContaining({ id: 'u1', email: 'a@b.c' }),
        resource: expect.objectContaining({ type: 'Category', id: 'abc' }),
      })
    );
  });

  it('still notifies when the audit log write fails, and never throws', async () => {
    jest.spyOn(auditLogService, 'log').mockRejectedValue(new Error('db down'));
    const fake = { broadcastToStaff: jest.fn() };
    jest.spyOn(socketModule, 'getSocketService').mockReturnValue(fake as any);
    await expect(auditAndNotifyStaff(base)).resolves.toBeUndefined();
    expect(fake.broadcastToStaff).toHaveBeenCalledWith(expect.objectContaining({ auditLogId: undefined }));
  });

  it('does not throw when the socket service is unavailable', async () => {
    jest.spyOn(auditLogService, 'log').mockResolvedValue({ _id: { toString: () => 'a' } } as any);
    jest.spyOn(socketModule, 'getSocketService').mockImplementation(() => { throw new Error('not initialized'); });
    await expect(auditAndNotifyStaff(base)).resolves.toBeUndefined();
  });
});
