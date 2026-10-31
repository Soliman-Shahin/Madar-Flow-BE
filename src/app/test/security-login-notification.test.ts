import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import express from 'express';
import { createServer, Server as HttpServer } from 'http';
import request from 'supertest';
import { Types } from 'mongoose';
import { User } from '../models/user.model';
import { Notification } from '../models/notification.model';
import { UserNotification } from '../models/user-notification.model';
import { UserService } from '../services/user.service';
import { NotificationService } from '../services/notification.service';
import { PushDeliveryService } from '../services/push-delivery.service';
import { initializeSocketService } from '../services/socket.service';
import userRoutes from '../routes/user.route';
import { advancedEncryptionMiddleware } from '../middleware/encryption-advanced.middleware';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';

const app = express();
app.use(express.json());
app.use(advancedEncryptionMiddleware);
app.use('/v1/user', userRoutes);

const hash = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

async function account(email = 'login-alert@example.test') {
  return User.create({
    email,
    password: await bcrypt.hash('Testing-Password-42!', 4),
  });
}

describe('security.new_login session boundary', () => {
  let dispatch: jest.SpiedFunction<
    typeof NotificationService.dispatchUserEvent
  >;

  beforeEach(() => {
    dispatch = jest
      .spyOn(NotificationService, 'dispatchUserEvent')
      .mockResolvedValue({
        created: true,
        channels: ['inbox', 'realtime', 'push'],
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it('fans out one canonical security notification identity to inbox, realtime, and push', async () => {
    dispatch.mockRestore();
    const user = await account('canonical-fanout-alert@example.test');
    const canonicalId = new Types.ObjectId();
    const httpServer: HttpServer = createServer();
    const socketService = initializeSocketService(httpServer);
    const realtime = jest
      .spyOn(socketService, 'sendNotificationToUser')
      .mockImplementation(() => undefined);
    const inbox = jest
      .spyOn(UserNotification, 'updateOne')
      .mockResolvedValue({} as any);
    const push = jest
      .spyOn(PushDeliveryService, 'sendToUsers')
      .mockResolvedValue({} as any);
    const create = jest
      .spyOn(Notification, 'create')
      .mockResolvedValue({ _id: canonicalId } as any);

    try {
      const result = await NotificationService.dispatchUserEvent({
        userId: user._id.toString(),
        event: 'security.new_login',
        dedupeKey: 'security.new_login:canonical-fanout',
        title: 'New login',
        message: 'A new authenticated session was created.',
        metadata: {
          authenticationMethod: 'password',
          occurredAt: new Date().toISOString(),
        },
      });

      expect(result.created).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      expect(inbox).toHaveBeenCalledTimes(1);
      expect(inbox.mock.calls[0][0]).toEqual({
        notificationId: canonicalId,
        userId: expect.any(Types.ObjectId),
      });
      expect(realtime).toHaveBeenCalledTimes(1);
      expect(realtime.mock.calls[0][0]).toBe(user._id.toString());
      expect(realtime.mock.calls[0][1].id).toBe(canonicalId.toString());
      expect((realtime.mock.calls[0][1] as any).event).toBe(
        'security.new_login'
      );
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0][0].notificationId).toBe(canonicalId.toString());
    } finally {
      httpServer.close();
    }
  });

  it('password login persists a session and dispatches one approved event', async () => {
    const user = await account();
    const response = await request(app)
      .post('/v1/user/login')
      .send({
        data: encryptCryptoJS({
          email: user.email,
          password: 'Testing-Password-42!',
        }),
      });

    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const input = dispatch.mock.calls[0][0];
    expect(input.userId).toBe(user._id.toString());
    expect(input.event).toBe('security.new_login');
    expect(input.dedupeKey).toBe(
      `security.new_login:${hash(response.body.data.refreshToken)}`
    );
    expect(input.metadata).toEqual({
      authenticationMethod: 'password',
      occurredAt: expect.any(String),
    });
    expect(JSON.stringify(input.metadata)).not.toContain(
      response.body.data.refreshToken
    );
    expect((await User.findById(user._id))!.sessions).toHaveLength(1);
  });

  it('invalid credentials create no login event', async () => {
    const user = await account('invalid-login-alert@example.test');
    const response = await request(app)
      .post('/v1/user/login')
      .send({
        data: encryptCryptoJS({
          email: user.email,
          password: 'wrong-password',
        }),
      });

    expect(response.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('failed session persistence creates no event', async () => {
    const user = await account('failed-session-alert@example.test');
    jest
      .spyOn(UserService, 'addRefreshToken')
      .mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      UserService.createAuthenticatedSession(user, 'password')
    ).rejects.toThrow('db unavailable');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('notification dispatch failure does not fail authentication', async () => {
    const user = await account('dispatch-failure-alert@example.test');
    dispatch.mockRejectedValueOnce(new Error('push unavailable'));

    const tokens = await UserService.createAuthenticatedSession(
      user,
      'password'
    );

    expect(tokens.refreshToken).toMatch(/^[a-f0-9]{128}$/);
    expect(tokens.accessToken).toBeTruthy();
    expect((await User.findById(user._id))!.sessions).toHaveLength(1);
  });

  it('uses distinct trusted identities for distinct sessions', async () => {
    const user = await account('distinct-session-alert@example.test');
    await UserService.createAuthenticatedSession(user, 'google_native');
    await UserService.createAuthenticatedSession(user, 'google_native');

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0].dedupeKey).not.toBe(
      dispatch.mock.calls[1][0].dedupeKey
    );
    expect((await User.findById(user._id))!.sessions).toHaveLength(2);
  });

  it('keeps refresh rotation outside the login event boundary', async () => {
    const user = await account('refresh-alert@example.test');
    const session = await UserService.createAuthenticatedSession(
      user,
      'password'
    );
    dispatch.mockClear();

    expect(
      await UserService.rotateRefreshToken(session.refreshToken)
    ).not.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('logout followed by genuine relogin creates one new event', async () => {
    const user = await account('logout-relogin-alert@example.test');
    const first = await request(app)
      .post('/v1/user/login')
      .send({
        data: encryptCryptoJS({
          email: user.email,
          password: 'Testing-Password-42!',
        }),
      });
    expect(first.status).toBe(200);
    dispatch.mockClear();

    const logout = await request(app)
      .post('/v1/user/logout')
      .send({
        data: encryptCryptoJS({ refreshToken: first.body.data.refreshToken }),
      });
    expect(logout.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();

    const second = await request(app)
      .post('/v1/user/login')
      .send({
        data: encryptCryptoJS({
          email: user.email,
          password: 'Testing-Password-42!',
        }),
      });
    expect(second.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('passes only the selected authentication method to the shared boundary', async () => {
    const user = await account('method-alert@example.test');
    for (const method of [
      'google_web',
      'google_native',
      'biometric',
    ] as const) {
      await UserService.createAuthenticatedSession(user, method);
    }

    expect(dispatch.mock.calls.map(([input]) => input.metadata)).toEqual([
      { authenticationMethod: 'google_web', occurredAt: expect.any(String) },
      { authenticationMethod: 'google_native', occurredAt: expect.any(String) },
      { authenticationMethod: 'biometric', occurredAt: expect.any(String) },
    ]);
  });

  it('does not allow request headers to influence recipient or dedupe identity', async () => {
    const user = await account('header-alert@example.test');
    const response = await request(app)
      .post('/v1/user/login')
      .set('x-user-id', 'attacker')
      .set('x-login-event-id', 'attacker-controlled')
      .send({
        data: encryptCryptoJS({
          email: user.email,
          password: 'Testing-Password-42!',
          userId: 'attacker',
          eventId: 'attacker-controlled',
        }),
      });

    expect(response.status).toBe(200);
    const input = dispatch.mock.calls[0][0];
    expect(input.userId).toBe(user._id.toString());
    expect(input.dedupeKey).not.toContain('attacker');
  });

  it('canonical notification uniqueness deduplicates the same trusted session identity', async () => {
    const user = await account('canonical-alert@example.test');
    dispatch.mockRestore();
    const input = {
      userId: user._id.toString(),
      event: 'security.new_login' as const,
      dedupeKey: 'security.new_login:trusted-session-hash',
      title: 'New login',
      message: 'A new authenticated session was created.',
      metadata: {
        authenticationMethod: 'password',
        occurredAt: new Date().toISOString(),
      },
    };
    jest
      .spyOn(NotificationService, 'resolveChannelsForUser')
      .mockResolvedValue([]);
    let createCalls = 0;
    const create = jest
      .spyOn(Notification, 'create')
      .mockImplementation(async () => {
        createCalls += 1;
        if (createCalls === 2) throw { code: 11000 };
        return { _id: 'notification-1' } as any;
      });

    const first = await NotificationService.dispatchUserEvent(input);
    const second = await NotificationService.dispatchUserEvent(input);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(second.created).toBe(false);
  });

  it('keeps security.new_login mandatory regardless of disabled preferences', async () => {
    const channels = await NotificationService.resolveChannelsForUser(
      '507f1f77bcf86cd799439011',
      'security',
      'mandatory'
    );
    expect(channels).toEqual(['inbox', 'realtime', 'push']);
  });

  it('keeps concurrent new sessions distinct', async () => {
    const user = await account('concurrent-alert@example.test');
    const results = await Promise.all([
      UserService.createAuthenticatedSession(user, 'password'),
      UserService.createAuthenticatedSession(user, 'password'),
    ]);

    expect(new Set(results.map((result) => result.refreshToken)).size).toBe(2);
    expect(
      new Set(dispatch.mock.calls.map(([input]) => input.dedupeKey)).size
    ).toBe(2);
    expect((await User.findById(user._id))!.sessions).toHaveLength(2);
  });
});
