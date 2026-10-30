import express from 'express';
import request from 'supertest';
import { User } from '../models/user.model';
import adminRoutes from '../routes/admin.route';
import { jobRuns } from '../jobs/job-runs';
// Importing a job module mirrors server startup: the cron schedule registers itself.
import { SESSION_CLEANUP_CRON } from '../jobs/session-cleanup.job';

const app = express();
app.use('/v1/admin', adminRoutes);

async function moderatorToken(email: string) {
  const user = await User.create({
    email,
    password: 'unused-in-this-test',
    role: 'moderator',
  });
  await user.createSession();
  return (await User.findById(user._id))!.generateAccessAuthToken();
}

const job = (name: string) =>
  jobRuns.snapshot().find((entry) => entry.name === name);

describe('Scheduled job health', () => {
  it('requires a staff session and returns the registry for moderator+', async () => {
    expect((await request(app).get('/v1/admin/health/jobs')).status).toBe(401);

    const token = await moderatorToken('jobs-moderator@example.test');
    const response = await request(app)
      .get('/v1/admin/health/jobs')
      .auth(token, { type: 'bearer' });

    expect(response.status).toBe(200);
    expect(typeof response.body.data.processStartedAt).toBe('string');
    expect(new Date(response.body.data.generatedAt).toString()).not.toBe(
      'Invalid Date'
    );
    expect(
      response.body.data.jobs.find(
        (entry: { name: string }) => entry.name === 'sessionCleanup'
      )
    ).toMatchObject({
      schedule: SESSION_CLEANUP_CRON,
      scheduled: false,
      running: false,
      status: 'idle',
      runs: 0,
      failures: 0,
      lastStartedAt: null,
      lastError: null,
    });
  });

  it('records success and preserves the job return value', async () => {
    expect(await jobRuns.track('unitSuccess', async () => 7)).toBe(7);
    expect(job('unitSuccess')).toMatchObject({
      status: 'success',
      runs: 1,
      failures: 0,
      running: false,
    });
    expect(job('unitSuccess')?.lastFinishedAt).not.toBeNull();
    expect(job('unitSuccess')?.lastDurationMs).not.toBeNull();
  });

  it('counts a logged-and-recovered failure without discarding its fallback', async () => {
    const result = await jobRuns.track('unitSoft', async () => {
      jobRuns.fail('unitSoft', new Error('soft failure'));
      return 'fallback';
    });

    expect(result).toBe('fallback');
    expect(job('unitSoft')).toMatchObject({
      status: 'failed',
      runs: 1,
      failures: 1,
      lastError: 'soft failure',
    });
  });

  it('counts a thrown failure and keeps the job observable', async () => {
    expect(
      await jobRuns.track('unitThrown', async () => {
        throw new Error('boom');
      })
    ).toBeUndefined();

    expect(job('unitThrown')).toMatchObject({
      status: 'failed',
      runs: 1,
      failures: 1,
      lastError: 'boom',
    });
  });

  it('ignores an overlapping run instead of double counting it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = jobRuns.track('unitOverlap', async () => {
      await gate;
      return 1;
    });
    const overlapping = await jobRuns.track('unitOverlap', async () => 2);
    release();

    expect(overlapping).toBeUndefined();
    expect(await first).toBe(1);
    expect(job('unitOverlap')).toMatchObject({
      status: 'success',
      runs: 1,
      failures: 0,
    });
  });

  it('mirrors the cron registration state of the current process', () => {
    jobRuns.markScheduled('sessionCleanup', true);
    expect(job('sessionCleanup')?.scheduled).toBe(true);

    jobRuns.markScheduled('sessionCleanup', false);
    expect(job('sessionCleanup')?.scheduled).toBe(false);
  });
});
