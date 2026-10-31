import crypto from 'crypto';
import { User } from '../models/user.model';
import { UserService } from '../services/user.service';
import { SessionCleanupService } from '../services/session-cleanup.service';
import { SessionCleanupJob } from '../jobs/session-cleanup.job';

const atSeconds = (seconds: number) => new Date(seconds * 1000);

describe('expired embedded session cleanup', () => {
  it('uses the expired-session boundary consistently', () => {
    const now = 2_000_000_000;
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now * 1000);

    expect(User.hasRefreshTokenExpired(now - 1)).toBe(true);
    expect(User.hasRefreshTokenExpired(now)).toBe(true);
    expect(User.hasRefreshTokenExpired(now + 1)).toBe(false);
    dateNow.mockRestore();
  });

  it('removes expired legacy/new sessions and preserves valid sessions and user fields', async () => {
    const now = 2_000_000_000;
    const user = await User.create({
      email: 'cleanup@example.test',
      password: 'not-used',
      username: 'preserved',
      sessions: [
        { token: 'legacy-expired', expiresAt: now },
        {
          sessionId: crypto.randomUUID(),
          token: 'new-expired',
          expiresAt: now - 1,
        },
        {
          sessionId: crypto.randomUUID(),
          token: 'valid',
          expiresAt: now + 1,
        },
      ],
    });

    const result = await SessionCleanupService.cleanupExpiredSessions(
      atSeconds(now)
    );
    const saved = await User.findById(user._id).lean();

    expect(result).toEqual({ matchedUsers: 1, modifiedUsers: 1 });
    expect(saved?.username).toBe('preserved');
    expect(saved?.sessions).toHaveLength(1);
    expect(saved?.sessions[0].token).toBe('valid');
  });

  it('supports multiple users and leaves users without expired sessions unchanged', async () => {
    const now = 2_000_000_000;
    await User.create([
      {
        email: 'expired@example.test',
        password: 'not-used',
        sessions: [{ token: 'expired', expiresAt: now - 1 }],
      },
      {
        email: 'valid@example.test',
        password: 'not-used',
        sessions: [{ token: 'valid', expiresAt: now + 1 }],
      },
      { email: 'empty@example.test', password: 'not-used' },
    ]);

    const result = await SessionCleanupService.cleanupExpiredSessions(
      atSeconds(now)
    );

    expect(result).toEqual({ matchedUsers: 1, modifiedUsers: 1 });
    expect(
      (await User.findOne({ email: 'expired@example.test' }))!.sessions
    ).toHaveLength(0);
    expect(
      (await User.findOne({ email: 'valid@example.test' }))!.sessions
    ).toHaveLength(1);
    expect(
      (await User.findOne({ email: 'empty@example.test' }))!.sessions
    ).toHaveLength(0);
  });

  it('is idempotent and does not remove a newly valid session', async () => {
    const now = 2_000_000_000;
    const user = await User.create({
      email: 'idempotent@example.test',
      password: 'not-used',
      sessions: [{ token: 'expired', expiresAt: now - 1 }],
    });

    const first = await SessionCleanupService.cleanupExpiredSessions(
      atSeconds(now)
    );
    const second = await SessionCleanupService.cleanupExpiredSessions(
      atSeconds(now)
    );
    await User.updateOne(
      { _id: user._id },
      { $push: { sessions: { token: 'new', expiresAt: now + 1 } } }
    );
    const third = await SessionCleanupService.cleanupExpiredSessions(
      atSeconds(now)
    );

    expect(first.modifiedUsers).toBe(1);
    expect(second).toEqual({ matchedUsers: 0, modifiedUsers: 0 });
    expect(third).toEqual({ matchedUsers: 0, modifiedUsers: 0 });
    expect(
      (await User.findById(user._id))!.sessions.map((s) => s.token)
    ).toEqual(['new']);
  });

  it('preserves a session renewed before cleanup and rejects cleanup-first refresh', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const user = await User.create({
      email: 'refresh-first@example.test',
      password: 'not-used',
      sessions: [
        {
          sessionId: crypto.randomUUID(),
          token: crypto.createHash('sha256').update(refreshToken).digest('hex'),
          expiresAt: now + 60,
        },
      ],
    });

    const rotated = await UserService.rotateRefreshToken(refreshToken);
    expect(rotated).not.toBeNull();
    await SessionCleanupService.cleanupExpiredSessions(atSeconds(now));
    expect((await User.findById(user._id))!.sessions).toHaveLength(1);

    const expiredToken = crypto.randomBytes(64).toString('hex');
    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          sessions: {
            token: crypto
              .createHash('sha256')
              .update(expiredToken)
              .digest('hex'),
            expiresAt: now,
          },
        },
      }
    );
    await SessionCleanupService.cleanupExpiredSessions(atSeconds(now));
    expect(await UserService.rotateRefreshToken(expiredToken)).toBeNull();
  });

  it('does not remove a newly created valid login session', async () => {
    const reference = new Date((Math.floor(Date.now() / 1000) - 1) * 1000);
    const user = await User.create({
      email: 'login-interleave@example.test',
      password: 'not-used',
    });
    const refreshToken = crypto.randomBytes(64).toString('hex');

    await UserService.addRefreshToken(user, refreshToken);
    await SessionCleanupService.cleanupExpiredSessions(reference);

    expect((await User.findById(user._id))!.sessions).toHaveLength(1);
  });

  it('keeps destructive logout and password reset idempotent with cleanup', async () => {
    const now = Math.floor(Date.now() / 1000);
    const first = crypto.randomBytes(64).toString('hex');
    const second = crypto.randomBytes(64).toString('hex');
    const user = await User.create({
      email: 'destructive-race@example.test',
      password: 'not-used',
      sessions: [
        {
          token: crypto.createHash('sha256').update(first).digest('hex'),
          expiresAt: now,
        },
        {
          token: crypto.createHash('sha256').update(second).digest('hex'),
          expiresAt: now + 60,
        },
      ],
    });

    await Promise.all([
      SessionCleanupService.cleanupExpiredSessions(atSeconds(now)),
      UserService.revokeRefreshToken(first),
    ]);
    expect((await User.findById(user._id))!.sessions).toHaveLength(1);

    await Promise.all([
      SessionCleanupService.cleanupExpiredSessions(atSeconds(now)),
      UserService.removeAllRefreshTokens((await User.findById(user._id))!),
    ]);
    expect((await User.findById(user._id))!.sessions).toHaveLength(0);
  });
});

describe('session cleanup job', () => {
  it('registers once and does not execute during start', () => {
    const job = new SessionCleanupJob();
    const execute = jest.spyOn(job, 'execute').mockResolvedValue({
      matchedUsers: 0,
      modifiedUsers: 0,
    });
    job.start();
    job.start();
    expect(job.isRunning()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    job.stop();
  });

  it('resets its overlap guard after success and failure', async () => {
    const job = new SessionCleanupJob();
    const service = jest
      .spyOn(SessionCleanupService, 'cleanupExpiredSessions')
      .mockResolvedValue({ matchedUsers: 1, modifiedUsers: 1 });
    await expect(job.execute()).resolves.toEqual({
      matchedUsers: 1,
      modifiedUsers: 1,
    });
    service.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(job.execute()).resolves.toEqual({
      matchedUsers: 0,
      modifiedUsers: 0,
    });
    service.mockResolvedValue({ matchedUsers: 2, modifiedUsers: 2 });
    await expect(job.execute()).resolves.toEqual({
      matchedUsers: 2,
      modifiedUsers: 2,
    });
    service.mockRestore();
  });

  it('skips an overlapping execution and runs again after completion', async () => {
    const job = new SessionCleanupJob();
    let release!: (value: {
      matchedUsers: number;
      modifiedUsers: number;
    }) => void;
    const pending = new Promise<{
      matchedUsers: number;
      modifiedUsers: number;
    }>((resolve) => {
      release = resolve;
    });
    const service = jest
      .spyOn(SessionCleanupService, 'cleanupExpiredSessions')
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ matchedUsers: 3, modifiedUsers: 2 });

    const first = job.execute();
    await expect(job.execute()).resolves.toEqual({
      matchedUsers: 0,
      modifiedUsers: 0,
    });
    release({ matchedUsers: 1, modifiedUsers: 1 });
    await expect(first).resolves.toEqual({ matchedUsers: 1, modifiedUsers: 1 });
    await expect(job.execute()).resolves.toEqual({
      matchedUsers: 3,
      modifiedUsers: 2,
    });
    expect(service).toHaveBeenCalledTimes(2);
    service.mockRestore();
  });
});
