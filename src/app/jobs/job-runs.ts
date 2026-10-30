import logger from '../services/logger.service';

/**
 * In-process scheduler health registry.
 *
 * Each scheduled job registers its name and cron expression at module load and
 * reports through `track()` / `fail()` when it runs. The registry is deliberately
 * memory-only: it describes the current process, which is exactly what a reader
 * of `/admin/health/jobs` needs to judge whether cron work is actually running.
 */

export type JobRunStatus = 'idle' | 'running' | 'success' | 'failed';

export interface JobRunSnapshot {
  name: string;
  schedule: string;
  /** The cron task is registered on this process. */
  scheduled: boolean;
  /** A run is in progress right now. */
  running: boolean;
  status: JobRunStatus;
  runs: number;
  failures: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface JobRunState extends JobRunSnapshot {
  /** A job that logs and returns a fallback value still counts as failed. */
  failedThisRun: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

class JobRunRegistry {
  private readonly jobs = new Map<string, JobRunState>();

  register(name: string, schedule: string): void {
    const existing = this.jobs.get(name);
    if (existing) {
      existing.schedule = schedule;
      return;
    }
    this.jobs.set(name, {
      name,
      schedule,
      scheduled: false,
      running: false,
      status: 'idle',
      runs: 0,
      failures: 0,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastDurationMs: null,
      lastSuccessAt: null,
      lastError: null,
      failedThisRun: false,
    });
  }

  /** Reflects whether the cron task is currently registered on this process. */
  markScheduled(name: string, scheduled: boolean): void {
    this.ensure(name).scheduled = scheduled;
  }

  /** Records a failure raised inside a job that logs and returns a fallback. */
  fail(name: string, error: unknown): void {
    const state = this.ensure(name);
    if (!state.running) return;
    state.failedThisRun = true;
    state.lastError = errorMessage(error);
  }

  async track<T>(
    name: string,
    task: () => Promise<T>
  ): Promise<T | undefined> {
    const state = this.ensure(name);
    if (state.running) return undefined;
    const startedAt = new Date();
    state.running = true;
    state.status = 'running';
    state.failedThisRun = false;
    state.lastStartedAt = startedAt.toISOString();
    state.runs += 1;

    try {
      const result = await task();
      if (state.failedThisRun) {
        state.status = 'failed';
        state.failures += 1;
      } else {
        state.status = 'success';
        state.lastSuccessAt = new Date().toISOString();
      }
      return result;
    } catch (error) {
      state.status = 'failed';
      state.failures += 1;
      state.lastError = errorMessage(error);
      logger.error(`[JobRuns] ${name} failed`, error as Error);
      return undefined;
    } finally {
      const finishedAt = new Date();
      state.running = false;
      state.lastFinishedAt = finishedAt.toISOString();
      state.lastDurationMs = finishedAt.getTime() - startedAt.getTime();
    }
  }

  snapshot(): JobRunSnapshot[] {
    return [...this.jobs.values()]
      .map((state) => {
        const { failedThisRun, ...job } = state;
        void failedThisRun;
        return { ...job };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private ensure(name: string): JobRunState {
    const existing = this.jobs.get(name);
    if (existing) return existing;
    this.register(name, '');
    return this.jobs.get(name) as JobRunState;
  }
}

export const jobRuns = new JobRunRegistry();
