import cron, { type ScheduledTask } from 'node-cron';
import { temporaryPermissionService } from '../services/temporary-permission.service';
import logger from '../services/logger.service';
import { jobRuns } from './job-runs';

const JOB_NAME = 'permissionExpiry';
const DEFAULT_PERMISSION_EXPIRY_CRON = '0 * * * *';

jobRuns.register(JOB_NAME, DEFAULT_PERMISSION_EXPIRY_CRON);

/**
 * Permission Expiry Job
 * 
 * Runs periodically to process expired temporary permissions.
 * Deactivates expired permissions and invalidates user caches.
 */
class PermissionExpiryJob {
  private task: ScheduledTask | null = null;

  /**
   * Start the cron job
   * Runs every hour by default
   */
  start(cronExpression: string = DEFAULT_PERMISSION_EXPIRY_CRON): void {
    if (this.task) {
      logger.warn('Permission expiry job is already running');
      return;
    }

    jobRuns.register(JOB_NAME, cronExpression);
    this.task = cron.schedule(cronExpression, () => {
      void jobRuns.track(JOB_NAME, () => this.execute());
    });
    jobRuns.markScheduled(JOB_NAME, true);

    logger.info(`Permission expiry job started with schedule: ${cronExpression}`);
  }

  /**
   * Stop the cron job
   */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      jobRuns.markScheduled(JOB_NAME, false);
      logger.info('Permission expiry job stopped');
    }
  }

  /**
   * Execute the job manually
   */
  async execute(): Promise<void> {
    try {
      logger.info('Running permission expiry job...');

      const processedCount = await temporaryPermissionService.processExpiredPermissions();

      if (processedCount > 0) {
        logger.info(`Permission expiry job completed: ${processedCount} permissions processed`);
      } else {
        logger.debug('Permission expiry job completed: no expired permissions found');
      }
    } catch (error: any) {
      jobRuns.fail(JOB_NAME, error);
      logger.error('Error in permission expiry job:', error.message);
    }
  }

  /**
   * Get job status
   */
  isRunning(): boolean {
    return this.task !== null;
  }
}

export const permissionExpiryJob = new PermissionExpiryJob();
