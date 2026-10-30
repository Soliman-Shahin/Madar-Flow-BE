import cron, { type ScheduledTask } from 'node-cron';
import { analyticsReportScheduleService } from '../services/analytics-report-schedule.service';
import logger from '../services/logger.service';
import { jobRuns } from './job-runs';

export const ANALYTICS_REPORT_SCHEDULE_CRON = '*/5 * * * *';
const JOB_NAME = 'analyticsReportSchedule';

jobRuns.register(JOB_NAME, ANALYTICS_REPORT_SCHEDULE_CRON);

export class AnalyticsReportScheduleJob {
  private task: ScheduledTask | null = null;
  private executing = false;

  constructor(
    private readonly schedules = analyticsReportScheduleService
  ) {}

  start(): void {
    if (this.task) return;
    this.task = cron.schedule(ANALYTICS_REPORT_SCHEDULE_CRON, () =>
      jobRuns.track(JOB_NAME, () => this.execute())
    );
    jobRuns.markScheduled(JOB_NAME, true);
    logger.info(
      `[AnalyticsReportScheduleJob] Scheduler started: ${ANALYTICS_REPORT_SCHEDULE_CRON}`
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
      return await this.schedules.runDue(referenceTime);
    } finally {
      this.executing = false;
    }
  }

  isRunning(): boolean {
    return this.task !== null;
  }
}

export const analyticsReportScheduleJob = new AnalyticsReportScheduleJob();
