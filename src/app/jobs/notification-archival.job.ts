import cron, { type ScheduledTask } from 'node-cron';
import logger from '../services/logger.service';
import { NotificationArchivalService } from '../services/notification-archival.service';
import { NotificationRetentionService } from '../services/notification-retention.service';
import { jobRuns } from './job-runs';

export const NOTIFICATION_ARCHIVAL_CRON = '0 2 * * *';
const JOB_NAME = 'notificationArchival';

jobRuns.register(JOB_NAME, NOTIFICATION_ARCHIVAL_CRON);

export class NotificationArchivalJob {
  private task: ScheduledTask | null = null;
  private executing = false;

  start(): void {
    if (this.task) return;
    this.task = cron.schedule(NOTIFICATION_ARCHIVAL_CRON, () =>
      jobRuns.track(JOB_NAME, () => this.execute())
    );
    jobRuns.markScheduled(JOB_NAME, true);
    logger.info(
      `[NotificationArchivalJob] Scheduler started with schedule: ${NOTIFICATION_ARCHIVAL_CRON}`
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
    jobRuns.markScheduled(JOB_NAME, false);
  }

  async execute(referenceTime: Date = new Date()): Promise<number> {
    if (this.executing) return 0;
    this.executing = true;
    try {
      await NotificationArchivalService.archiveEligible(referenceTime);
      const result = await NotificationRetentionService.deleteExpired(referenceTime);
      return result.deletedUserNotifications;
    } catch (error: any) {
      jobRuns.fail(JOB_NAME, error);
      logger.error(
        '[NotificationArchivalJob] Execution failed',
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

export const notificationArchivalJob = new NotificationArchivalJob();
