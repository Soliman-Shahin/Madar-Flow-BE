import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import CryptoJS from 'crypto-js';
import { User } from '../models/user.model';
import { UserService } from '../services/user.service';
import userRoutes from '../routes/user.route';
import { advancedEncryptionMiddleware } from '../middleware/encryption-advanced.middleware';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import logger from '../services/logger.service';
import { verifyAccessToken } from '../middleware/access.middleware';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(advancedEncryptionMiddleware);
app.use('/v1/user', userRoutes);
app.get('/v1/protected', verifyAccessToken, (req, res) =>
  res.json({ userId: (req as any).user_id })
);
const hash = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');
async function account() {
  return User.create({
    email: 'session@example.test',
    password: await bcrypt.hash('Testing-Password-42!', 4),
  });
}
async function session() {
  const user = await account();
  return { user, token: await user.createSession() };
}

describe('AUTH.1 session contract', () => {
  it('password login stores only a hash and issues a one-hour JWT', async () => {
    const user = await account();
    const res = await request(app)
      .post('/v1/user/login')
      .send({
        data: encryptCryptoJS({
          email: user.email,
          password: 'Testing-Password-42!',
        }),
      });
    expect(res.status).toBe(200);
    const { accessToken, refreshToken } = res.body.data;
    const saved = await User.findById(user._id);
    expect(saved!.sessions[0].token).toBe(hash(refreshToken));
    expect(saved!.sessions[0].sessionId).toEqual(expect.any(String));
    const payload = jwt.verify(
      accessToken,
      process.env.ACCESS_TOKEN_SECRET!
    ) as jwt.JwtPayload;
    expect(payload.exp! - payload.iat!).toBe(3600);
    expect(payload.sid).toBe(saved!.sessions[0].sessionId);
    expect(res.body.data.user.password).toBeUndefined();
  });
  it('browser login rotates refresh credentials through an HttpOnly cookie', async () => {
    const user = await account();
    const login = await request(app)
      .post('/v1/user/login')
      .set('X-Auth-Transport', 'cookie')
      .set('X-Auth-Persistence', 'persistent')
      .send({
        data: encryptCryptoJS({
          email: user.email,
          password: 'Testing-Password-42!',
        }),
      });

    expect(login.status).toBe(200);
    expect(login.body.data.refreshToken).toBeUndefined();
    expect(login.headers['refresh-token']).toBeUndefined();
    const cookieHeaders: string[] = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie']
      : [String(login.headers['set-cookie'] || '')];
    const cookie = cookieHeaders.find((value) => value.startsWith('mf_refresh='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/v1/user');

    const refresh = await request(app)
      .post('/v1/user/refresh-token')
      .set('X-Auth-Transport', 'cookie')
      .set('Cookie', String(cookie).split(';')[0])
      .send({ data: encryptCryptoJS({}) });
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.refreshToken).toBeUndefined();
    expect(refresh.body.data.accessToken).toEqual(expect.any(String));
    expect(refresh.body.data.user._id).toBe(user._id.toString());
    expect(refresh.headers['set-cookie']?.[0]).toContain('mf_refresh=');
  });
  it('native Google issues the same hashed format and preserves other sessions', async () => {
    const { user, token } = await session();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        sub: 'test-google-subject',
        email: user.email,
        aud: process.env.GOOGLE_WEB_CLIENT_ID,
        email_verified: true,
      }),
    } as any);
    const res = await request(app)
      .post('/v1/user/auth/google/native')
      .send({ idToken: 'synthetic-google-credential' });
    expect(res.status).toBe(200);
    const saved = await User.findById(user._id);
    expect(saved!.sessions.map((s) => s.token)).toEqual(
      expect.arrayContaining([
        hash(token),
        hash(res.body.data.tokens.refreshToken),
      ])
    );
    expect(
      await UserService.rotateRefreshToken(res.body.data.tokens.refreshToken)
    ).not.toBeNull();
  });
  it('model issuance used by web Google is refresh compatible', async () => {
    const { token } = await session();
    expect(await UserService.rotateRefreshToken(token)).not.toBeNull();
  });
  it('encrypted refresh rotates, returns the standard envelope, and rejects reuse', async () => {
    const { token } = await session();
    const res = await request(app)
      .post('/v1/user/refresh-token')
      .send({ data: encryptCryptoJS({ refreshToken: token }) });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.refreshToken).not.toBe(token);
    expect(await UserService.rotateRefreshToken(token)).toBeNull();
    expect(
      await UserService.findByRefreshToken(res.body.data.refreshToken)
    ).not.toBeNull();
    const saved = await User.findOne({ email: 'session@example.test' });
    const persistedSession = saved!.sessions.find(
      (item) => item.token === hash(res.body.data.refreshToken)
    );
    const payload = jwt.verify(
      res.body.data.accessToken,
      process.env.ACCESS_TOKEN_SECRET!
    ) as jwt.JwtPayload;
    expect(payload.sid).toBe(persistedSession!.sessionId);
  });
  it('upgrades a pre-AUTH.1 Google credential to a hash on its first renewal', async () => {
    const user = await account();
    const legacy = crypto.randomBytes(64).toString('hex');
    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          sessions: {
            token: legacy,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        },
      }
    );
    const rotated = await UserService.rotateRefreshToken(legacy);
    expect(rotated).not.toBeNull();
    const saved = await User.findById(user._id);
    expect(saved!.sessions[0].token).toBe(hash(rotated!.refreshToken));
    expect(saved!.sessions[0].sessionId).toEqual(expect.any(String));
    expect(await UserService.rotateRefreshToken(legacy)).toBeNull();
  });
  it('allows only one simultaneous rotation', async () => {
    const { token } = await session();
    const results = await Promise.all([
      UserService.rotateRefreshToken(token),
      UserService.rotateRefreshToken(token),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
  });
  it('upgrades one legacy session atomically without changing mixed sessions', async () => {
    const user = await account();
    const legacy = crypto.randomBytes(64).toString('hex');
    const other = await user.createSession();
    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          sessions: {
            token: hash(legacy),
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        },
      }
    );
    const results = await Promise.all([
      UserService.rotateRefreshToken(legacy),
      UserService.rotateRefreshToken(legacy),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const saved = await User.findById(user._id);
    expect(saved!.sessions).toHaveLength(2);
    expect(saved!.sessions.filter((item) => item.token === hash(other))).toHaveLength(1);
    const upgraded = saved!.sessions.find((item) => item.token !== hash(other));
    expect(upgraded?.sessionId).toEqual(expect.any(String));
    expect(upgraded?.token).toBe(hash(results.find(Boolean)!.refreshToken));
    expect(await UserService.rotateRefreshToken(legacy)).toBeNull();
  });
  it('rejects invalid, expired and revoked credentials', async () => {
    const { user, token } = await session();
    expect(await UserService.rotateRefreshToken('invalid')).toBeNull();
    await User.updateOne(
      { _id: user._id },
      { $set: { 'sessions.0.expiresAt': 1 } }
    );
    expect(await UserService.rotateRefreshToken(token)).toBeNull();
    const live = await user.createSession();
    await UserService.revokeRefreshToken(live);
    expect(await UserService.rotateRefreshToken(live)).toBeNull();
  });
  it.each(['isActive', '_isDeleted'])(
    'rejects restricted accounts: %s',
    async (field) => {
      const { user, token } = await session();
      await User.updateOne(
        { _id: user._id },
        { $set: { [field]: field === '_isDeleted' } }
      );
      expect(await UserService.rotateRefreshToken(token)).toBeNull();
    }
  );
  it('logout revokes only the presented session', async () => {
    const { user, token } = await session();
    const other = await user.createSession();
    const res = await request(app)
      .post('/v1/user/logout')
      .send({ data: encryptCryptoJS({ refreshToken: token }) });
    expect(res.status).toBe(200);
    expect(await UserService.rotateRefreshToken(token)).toBeNull();
    expect(await UserService.rotateRefreshToken(other)).not.toBeNull();
  });
  it('rejects sid-less access tokens under the session-bound policy', async () => {
    const { user } = await session();
    const legacy = jwt.sign(
      { _id: user._id },
      process.env.ACCESS_TOKEN_SECRET!,
      {
        expiresIn: '1h',
      }
    );
    const res = await request(app)
      .get('/v1/protected')
      .set('Authorization', `Bearer ${legacy}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
  });
  it.each([null, '', 42, {}, []])(
    'rejects malformed sid claim safely: %p',
    async (sid) => {
      const { user } = await session();
      const malformed = jwt.sign(
        { _id: user._id.toString(), sid },
        process.env.ACCESS_TOKEN_SECRET!,
        { expiresIn: '1h' }
      );
      const res = await request(app)
        .get('/v1/protected')
        .set('Authorization', `Bearer ${malformed}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
    }
  );
  it('rejects malformed user identifiers without a server error', async () => {
    const malformed = jwt.sign(
      { _id: { $ne: null }, sid: 'not-a-real-session' },
      process.env.ACCESS_TOKEN_SECRET!,
      { expiresIn: '1h' }
    );
    const res = await request(app)
      .get('/v1/protected')
      .set('Authorization', `Bearer ${malformed}`);
    expect(res.status).toBe(401);
  });
  it('immediately revokes one session access token without affecting another', async () => {
    const user = await account();
    const first = await UserService.createAuthenticatedSession(
      user,
      'password'
    );
    const second = await UserService.createAuthenticatedSession(
      user,
      'password'
    );

    expect(
      (
        await request(app)
          .get('/v1/protected')
          .set('Authorization', `Bearer ${first.accessToken}`)
      ).status
    ).toBe(200);
    await UserService.revokeRefreshToken(first.refreshToken);
    expect(
      (
        await request(app)
          .get('/v1/protected')
          .set('Authorization', `Bearer ${first.accessToken}`)
      ).status
    ).toBe(401);
    expect(
      (
        await request(app)
          .get('/v1/protected')
          .set('Authorization', `Bearer ${second.accessToken}`)
      ).status
    ).toBe(200);
  });
  it('lists safe active sessions and revokes only other devices on request', async () => {
    const user = await account();
    const current = await UserService.createAuthenticatedSession(user, 'password', 'ios');
    const other = await UserService.createAuthenticatedSession(user, 'password', 'web');
    const listed = await request(app)
      .get('/v1/user/sessions')
      .set('Authorization', `Bearer ${current.accessToken}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.sessions).toHaveLength(2);
    expect(listed.body.data.sessions.find((item: any) => item.current)).toMatchObject({ platform: 'ios', current: true });
    expect(JSON.stringify(listed.body)).not.toContain(hash(current.refreshToken));
    expect(JSON.stringify(listed.body)).not.toContain('refreshToken');

    const revoked = await request(app)
      .delete('/v1/user/sessions/others')
      .set('Authorization', `Bearer ${current.accessToken}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.revoked).toBe(true);
    expect(await UserService.rotateRefreshToken(current.refreshToken)).not.toBeNull();
    expect(await UserService.rotateRefreshToken(other.refreshToken)).toBeNull();
  });
  it('does not let a session-management endpoint revoke the current session accidentally', async () => {
    const user = await account();
    const current = await UserService.createAuthenticatedSession(user, 'password');
    const revoked = await request(app)
      .delete(`/v1/user/sessions/${user.sessions[0]?.sessionId || (jwt.verify(current.accessToken, process.env.ACCESS_TOKEN_SECRET!) as any).sid}`)
      .set('Authorization', `Bearer ${current.accessToken}`);
    expect(revoked.status).toBe(400);
    expect(await UserService.rotateRefreshToken(current.refreshToken)).not.toBeNull();
  });
  it('rejects access tokens whose persisted session has expired', async () => {
    const user = await account();
    const tokens = await UserService.createAuthenticatedSession(
      user,
      'password'
    );
    await User.updateOne(
      { _id: user._id },
      { $set: { 'sessions.0.expiresAt': Math.floor(Date.now() / 1000) - 1 } }
    );
    const res = await request(app)
      .get('/v1/protected')
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(res.status).toBe(401);
  });
  it('does not log sensitive payloads, including malformed decrypted JSON', async () => {
    const info = jest.spyOn(logger, 'info');
    const debug = jest.spyOn(logger, 'debug');
    const error = jest.spyOn(logger, 'error');
    const marker = 'PRIVATE-SYNTHETIC-PAYLOAD';
    await request(app)
      .post('/v1/user/refresh-token')
      .send({
        data: encryptCryptoJS({ refreshToken: marker, password: marker }),
      });
    await request(app)
      .post('/v1/user/login')
      .send({
        data: CryptoJS.AES.encrypt(
          '{"password":"' + marker,
          'TEMP_TRANSPORT_KEY'
        ).toString(),
      });
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('tokeninfo?id_token=' + marker));
    await request(app)
      .post('/v1/user/auth/google/native')
      .send({ idToken: marker });
    const output = JSON.stringify([
      ...info.mock.calls,
      ...debug.mock.calls,
      ...error.mock.calls,
    ]);
    expect(output).not.toContain(marker);
  });
});
