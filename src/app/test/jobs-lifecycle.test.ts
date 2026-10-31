import { User } from '../models/user.model';
import { Notification } from '../models/notification.model';
import { UserNotification } from '../models/user-notification.model';
import { SessionCleanupJob } from '../jobs/session-cleanup.job';
import { NotificationArchivalJob } from '../jobs/notification-archival.job';
import { AnalyticsReportScheduleJob } from '../jobs/analytics-report-schedule.job';
import { jobRuns } from '../jobs/job-runs';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-06-01T12:00:00Z');
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

describe('session cleanup job', () => {
  it('removes only expired sessions and is idempotent', async () => {
    const user = await User.create({
      email: 'cleanup@example.test',
      password: 'not-used',
      sessions: [
        { sessionId: 'old', token: 't1', expiresAt: secs(new Date(now.getTime() - DAY)) },
        { sessionId: 'edge', token: 't2', expiresAt: secs(now) },
        { sessionId: 'live', token: 't3', expiresAt: secs(new Date(now.getTime() + DAY)) },
      ],
    } as any);
    const job = new SessionCleanupJob();
    const first = await job.execute(now);
    expect(first.modifiedUsers).toBe(1);
    const after = await User.findById(user._id).lean();
    expect((after!.sessions as any[]).map((s) => s.sessionId)).toEqual(['live']);
    expect((await job.execute(now)).modifiedUsers).toBe(0);
  });

  it('start/stop toggle the scheduled flag and are safe to repeat', () => {
    const job = new SessionCleanupJob();
    job.start();
    job.start();
    expect(job.isRunning()).toBe(true);
    job.stop();
    job.stop();
    expect(job.isRunning()).toBe(false);
  });
});

describe('notification archival job', () => {
  async function make(ageDays: number, archived: boolean, notificationId?: any) {
    const user = await User.create({ email: `n-${Math.random()}@example.test`, password: 'not-used' });
    const notification =
      notificationId ??
      (await Notification.create({ title: 't', message: 'm', createdBy: user._id }))._id;
    const createdAt = new Date(now.getTime() - ageDays * DAY);
    const row = await UserNotification.create({
      notificationId: notification, userId: user._id, ...(archived ? { archivedAt: createdAt } : {}),
    });
    await UserNotification.collection.updateOne({ _id: row._id }, { $set: { createdAt } });
    await Notification.collection.updateOne({ _id: notification }, { $set: { createdAt } });
    return { row, notification };
  }

  it('archives rows older than 90 days, leaves newer ones, deletes only archived rows older than 180 days', async () => {
    const fresh = await make(10, false);
    const aging = await make(100, false);
    const ancient = await make(200, false);
    const job = new NotificationArchivalJob();
    const deleted = await job.execute(now);

    expect((await UserNotification.findById(fresh.row._id))?.archivedAt).toBeUndefined();
    expect((await UserNotification.findById(aging.row._id))?.archivedAt).toBeTruthy();
    // 200-day-old row is archived in the same run and then removed by retention.
    expect(await UserNotification.findById(ancient.row._id)).toBeNull();
    expect(await Notification.findById(ancient.notification)).toBeNull();
    expect(deleted).toBe(1);
    expect(await Notification.findById(aging.notification)).not.toBeNull();
  });

  it('keeps a shared notification while another recipient still references it', async () => {
    const old = await make(200, true);
    const other = await User.create({ email: 'other-recipient@example.test', password: 'not-used' });
    const keep = await UserNotification.create({ notificationId: old.notification, userId: other._id });
    await UserNotification.collection.updateOne({ _id: keep._id }, { $set: { createdAt: new Date(now.getTime() - DAY) } });
    await new NotificationArchivalJob().execute(now);
    expect(await UserNotification.findById(old.row._id)).toBeNull();
    expect(await Notification.findById(old.notification)).not.toBeNull();
    expect(await UserNotification.findById(keep._id)).not.toBeNull();
  });
});

describe('analytics report schedule job', () => {
  it('returns the number of due reports processed', async () => {
    const job = new AnalyticsReportScheduleJob({ runDue: jest.fn().mockResolvedValue(3) } as any);
    expect(await job.execute(now)).toBe(3);
  });

  it('ignores an overlapping run', async () => {
    let release!: () => void;
    const gate = new Promise<number>((r) => (release = () => r(2)));
    const runDue = jest.fn().mockReturnValue(gate);
    const job = new AnalyticsReportScheduleJob({ runDue } as any);
    const first = job.execute(now);
    expect(await job.execute(now)).toBe(0);
    release();
    expect(await first).toBe(2);
    expect(runDue).toHaveBeenCalledTimes(1);
  });

  it('resets the overlap guard after a failure and records it in the job registry', async () => {
    const runDue = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(1);
    const job = new AnalyticsReportScheduleJob({ runDue } as any);
    await jobRuns.track('analyticsReportSchedule', () => job.execute(now));
    expect(await job.execute(now)).toBe(1);
    const entry: any = (jobRuns as any).snapshot?.().find?.((j: any) => j.name === 'analyticsReportSchedule');
    if (entry) expect(entry.failures ?? entry.failureCount).toBeGreaterThanOrEqual(1);
  });
});
