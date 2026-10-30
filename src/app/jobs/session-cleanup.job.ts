import cron, { type ScheduledTask } from 'node-cron';
import logger from '../services/logger.service';
import {
  SessionCleanupService,
  type SessionCleanupResult,
} from '../services/session-cleanup.service';
import { jobRuns } from './job-runs';

export const SESSION_CLEANUP_CRON = '30 2 * * *';
const JOB_NAME = 'sessionCleanup';

jobRuns.register(JOB_NAME, SESSION_CLEANUP_CRON);

export class SessionCleanupJob {
  private task: ScheduledTask | null = null;
  private executing = false;

  start(): void {
    if (this.task) return;
    this.task = cron.schedule(SESSION_CLEANUP_CRON, () => {
      void jobRuns.track(JOB_NAME, () => this.execute());
    });
    jobRuns.markScheduled(JOB_NAME, true);
    logger.info(
      `[SessionCleanupJob] Scheduler started with schedule: ${SESSION_CLEANUP_CRON}`
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
    jobRuns.markScheduled(JOB_NAME, false);
  }

  async execute(
    referenceTime: Date = new Date()
  ): Promise<SessionCleanupResult> {
    if (this.executing) return { matchedUsers: 0, modifiedUsers: 0 };
    this.executing = true;
    try {
      const result =
        await SessionCleanupService.cleanupExpiredSessions(referenceTime);
      logger.info('[SessionCleanupJob] Cleanup completed', result);
      return result;
    } catch (error: any) {
      jobRuns.fail(JOB_NAME, error);
      logger.error(
        '[SessionCleanupJob] Cleanup failed',
        error?.message || 'unknown error'
      );
      return { matchedUsers: 0, modifiedUsers: 0 };
    } finally {
      this.executing = false;
    }
  }

  isRunning(): boolean {
    return this.task !== null;
  }
}

export const sessionCleanupJob = new SessionCleanupJob();
