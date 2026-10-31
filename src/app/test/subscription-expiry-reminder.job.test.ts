import cron from 'node-cron';
import { SubscriptionExpiryReminderService } from '../services/subscription-expiry-reminder.service';
import {
  SUBSCRIPTION_EXPIRY_REMINDER_CRON,
  SubscriptionExpiryReminderJob,
} from '../jobs/subscription-expiry-reminder.job';

jest.mock('node-cron', () => ({
  __esModule: true,
  default: { schedule: jest.fn() },
}));

describe('subscription expiry reminder job', () => {
  let job: SubscriptionExpiryReminderJob;
  let callback: (() => void) | undefined;
  let task: { stop: jest.Mock };
  let processExpiringSubscriptions: jest.SpiedFunction<
    typeof SubscriptionExpiryReminderService.processExpiringSubscriptions
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    job = new SubscriptionExpiryReminderJob();
    callback = undefined;
    task = { stop: jest.fn() };
    (cron.schedule as jest.Mock).mockImplementation(
      (_expression: string, scheduledCallback: () => void) => {
        callback = scheduledCallback;
        return task;
      }
    );
    processExpiringSubscriptions = jest
      .spyOn(SubscriptionExpiryReminderService, 'processExpiringSubscriptions')
      .mockResolvedValue({
        scanned: 0,
        eligible: 0,
        created: 0,
        skipped: 0,
        failures: 0,
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it('uses the hourly cron expression and invokes the processor with an explicit Date', async () => {
    const reference = new Date('2026-10-03T15:00:00.000Z');
    job.start();
    await new Promise((resolve) => setImmediate(resolve));
    processExpiringSubscriptions.mockClear();
    await job.execute(reference);

    expect(cron.schedule).toHaveBeenCalledWith(
      SUBSCRIPTION_EXPIRY_REMINDER_CRON,
      expect.any(Function)
    );
    expect(processExpiringSubscriptions).toHaveBeenCalledWith(reference);
    expect(processExpiringSubscriptions.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it('supports manual execution without waiting for cron', async () => {
    await job.execute();
    expect(processExpiringSubscriptions).toHaveBeenCalledTimes(1);
    expect(processExpiringSubscriptions.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it('skips overlapping execution and resets the guard after success', async () => {
    let resolveFirst!: () => void;
    processExpiringSubscriptions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = () =>
          resolve({
            scanned: 0,
            eligible: 0,
            created: 0,
            skipped: 0,
            failures: 0,
          });
      })
    );

    const first = job.execute();
    await job.execute();
    expect(processExpiringSubscriptions).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
    await job.execute();
    expect(processExpiringSubscriptions).toHaveBeenCalledTimes(2);
  });

  it('resets the guard after failure and allows a later execution', async () => {
    processExpiringSubscriptions
      .mockRejectedValueOnce(new Error('processor unavailable'))
      .mockResolvedValueOnce({
        scanned: 0,
        eligible: 0,
        created: 0,
        skipped: 0,
        failures: 0,
      });

    await job.execute();
    await job.execute();

    expect(processExpiringSubscriptions).toHaveBeenCalledTimes(2);
  });

  it('contains scheduled execution failures and keeps the scheduler alive', async () => {
    processExpiringSubscriptions.mockRejectedValueOnce(
      new Error('temporary failure')
    );
    job.start();
    callback!();
    await new Promise((resolve) => setImmediate(resolve));

    expect(job.isRunning()).toBe(true);
    expect(processExpiringSubscriptions).toHaveBeenCalled();
  });

  it('registers only once and stop prevents future scheduled invocation', async () => {
    job.start();
    job.start();
    expect(cron.schedule).toHaveBeenCalledTimes(1);

    job.stop();
    expect(task.stop).toHaveBeenCalledTimes(1);
    expect(job.isRunning()).toBe(false);
  });

  it('performs one startup/current-window execution and retains the same-process guard', async () => {
    job.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(processExpiringSubscriptions).toHaveBeenCalledTimes(1);
    expect(processExpiringSubscriptions.mock.calls[0][0]).toBeInstanceOf(Date);
  });
});
