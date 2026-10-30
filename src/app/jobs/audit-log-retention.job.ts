import cron, { type ScheduledTask } from 'node-cron';
import logger from '../services/logger.service';
import { auditLogService } from '../services/audit-log.service';
import { jobRuns } from './job-runs';

export const AUDIT_LOG_RETENTION_CRON = '0 3 * * *';
const JOB_NAME = 'auditLogRetention';

jobRuns.register(JOB_NAME, AUDIT_LOG_RETENTION_CRON);
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365;
/** Lower bound so a typo in the env var cannot wipe recent security history. */
export const MIN_AUDIT_LOG_RETENTION_DAYS = 30;

export function resolveAuditLogRetentionDays(
  raw: string | undefined = process.env.AUDIT_LOG_RETENTION_DAYS
): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
  return Math.max(parsed, MIN_AUDIT_LOG_RETENTION_DAYS);
}

/**
 * Deletes audit logs older than the retention period once a day.
 * Audit logs contain IP addresses, user agents, and e-mails (personal data).
 */
export class AuditLogRetentionJob {
  private task: ScheduledTask | null = null;
  private executing = false;

  start(): void {
    if (this.task) return;
    this.task = cron.schedule(AUDIT_LOG_RETENTION_CRON, () => {
      void jobRuns.track(JOB_NAME, () => this.execute());
    });
    jobRuns.markScheduled(JOB_NAME, true);
    logger.info(
      `[AuditLogRetentionJob] Scheduler started with schedule: ${AUDIT_LOG_RETENTION_CRON}, retention ${resolveAuditLogRetentionDays()} days`
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
    jobRuns.markScheduled(JOB_NAME, false);
  }

  async execute(
    retentionDays: number = resolveAuditLogRetentionDays()
  ): Promise<number> {
    if (this.executing) return 0;
    this.executing = true;
    try {
      const deleted = await auditLogService.deleteOldLogs(retentionDays);
      logger.info('[AuditLogRetentionJob] Retention completed', {
        retentionDays,
        deleted,
      });
      return deleted;
    } catch (error: any) {
      jobRuns.fail(JOB_NAME, error);
      logger.error(
        '[AuditLogRetentionJob] Retention failed',
        error?.message || 'unknown error'
      );
      return 0;
    } finally {
      this.executing = false;
    }
  }

  isRunning(): boolean {
    return this.task !== null;
  }
}

export const auditLogRetentionJob = new AuditLogRetentionJob();
