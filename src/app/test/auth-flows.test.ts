import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { Category, User } from '../models';
import userRoutes from '../routes/user.route';
import { advancedEncryptionMiddleware } from '../middleware/encryption-advanced.middleware';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { verifyAccessToken } from '../middleware/access.middleware';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { MailService } from '../services/mail.service';
import { resetLoginAttempts } from '../middleware/brute-force.middleware';

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(advancedEncryptionMiddleware);
app.use('/v1/user', userRoutes);
app.get('/v1/protected', verifyAccessToken, (_req, res) => res.json({ ok: true }));

const STRONG = 'Testing-Password-42!';
const consent = {
  termsAccepted: true,
  privacyAccepted: true,
  termsVersion: CONSENT_VERSIONS.terms,
  privacyVersion: CONSENT_VERSIONS.privacy,
};
let ipCounter = 0;
// A distinct client IP per test keeps the in-memory brute-force state isolated.
const freshIp = () => `10.0.0.${++ipCounter}`;

// Login/signup bodies are encrypted by the app; password recovery is plain JSON
// (it is not in the encryption middleware's includePaths).
const post = (path: string, body: Record<string, unknown>, ip: string) =>
  request(app)
    .post(`/v1/user${path}`)
    .set('X-Forwarded-For', ip)
    .send(path.startsWith('/password/') ? body : { data: encryptCryptoJS(body) });

describe('signup', () => {
  it('creates a hashed account with consent, a default category, and a working session', async () => {
    const ip = freshIp();
    const res = await post('/signup', { email: 'new@example.test', password: STRONG, ...consent }, ip);
    expect(res.status).toBe(200);
    expect(res.body.data.user.password).toBeUndefined();
    // D-004: no storage internals in auth responses
    expect(res.body.data.user.__v).toBeUndefined();
    expect(res.body.data.user._isDeleted).toBeUndefined();

    const saved = await User.findOne({ email: 'new@example.test' });
    expect(saved!.password).not.toBe(STRONG);
    expect(await bcrypt.compare(STRONG, saved!.password)).toBe(true);
    expect(saved!.termsVersion).toBe(CONSENT_VERSIONS.terms);
    expect(await Category.countDocuments({ user: saved!._id, isDefault: true })).toBe(1);

    const me = await request(app)
      .get('/v1/protected')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('requires current terms and privacy consent', async () => {
    const res = await post(
      '/signup',
      { email: 'noconsent@example.test', password: STRONG, ...consent, termsVersion: '2020-01-01' },
      freshIp()
    );
    expect(res.status).toBe(400);
    expect(await User.exists({ email: 'noconsent@example.test' })).toBeNull();
  });

  it('rejects a weak password', async () => {
    const res = await post('/signup', { email: 'weak@example.test', password: 'abcdef', ...consent }, freshIp());
    expect(res.status).toBe(400);
    expect(await User.exists({ email: 'weak@example.test' })).toBeNull();
  });

  it('returns 409 for an existing e-mail regardless of the password and leaks no database error', async () => {
    await User.create({ email: 'taken@example.test', password: await bcrypt.hash(STRONG, 4) });

    const samePassword = await post('/signup', { email: 'taken@example.test', password: STRONG, ...consent }, freshIp());
    const otherPassword = await post(
      '/signup',
      { email: 'taken@example.test', password: 'Another-Password-77!', ...consent },
      freshIp()
    );

    expect(samePassword.status).toBe(409);
    expect(otherPassword.status).toBe(409);
    expect(JSON.stringify(otherPassword.body)).not.toMatch(/E11000|duplicate key/i);
    expect(await User.countDocuments({ email: 'taken@example.test' })).toBe(1);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await User.create({ email: 'login@example.test', password: await bcrypt.hash(STRONG, 4) });
  });

  it('rejects a wrong password without issuing tokens', async () => {
    const res = await post('/login', { email: 'login@example.test', password: 'wrong-password' }, freshIp());
    expect(res.status).toBe(401);
    expect(res.body.data?.accessToken).toBeUndefined();
    expect((await User.findOne({ email: 'login@example.test' }))!.sessions).toHaveLength(0);
  });

  it('rejects deactivated and deleted accounts', async () => {
    await User.updateOne({ email: 'login@example.test' }, { $set: { isActive: false } });
    const res = await post('/login', { email: 'login@example.test', password: STRONG }, freshIp());
    expect(res.status).not.toBe(200);
    expect(res.body.data?.accessToken).toBeUndefined();
  });

  it('locks the account after 5 failed attempts, even with the right password', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++)
      await post('/login', { email: 'login@example.test', password: `wrong-${i}` }, ip);

    const locked = await post('/login', { email: 'login@example.test', password: STRONG }, ip);
    // Existing contract: lockout is 429 with code ACCOUNT_LOCKED.
    expect(locked.status).toBe(429);
    expect(locked.body.error?.code ?? locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(locked.body.data?.accessToken).toBeUndefined();
    resetLoginAttempts('login@example.test', ip);
  });
});

describe('password reset', () => {
  let sentToken: string | undefined;
  beforeEach(async () => {
    sentToken = undefined;
    jest.spyOn(MailService, 'sendPasswordReset').mockImplementation(async (_e, token) => {
      sentToken = token;
    });
    await User.create({ email: 'reset@example.test', password: await bcrypt.hash(STRONG, 4) });
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers identically for known and unknown e-mails', async () => {
    const known = await post('/password/forgot', { email: 'reset@example.test' }, freshIp());
    const unknown = await post('/password/forgot', { email: 'ghost@example.test' }, freshIp());
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(sentToken).toBeDefined();
  });

  it('resets once, revokes every session and access token, and burns the token', async () => {
    const user = (await User.findOne({ email: 'reset@example.test' }))!;
    await user.createSession();
    const oldAccess = await (await User.findById(user._id))!.generateAccessAuthToken();

    await post('/password/forgot', { email: 'reset@example.test' }, freshIp());
    const NEW = 'Brand-New-Password-58!';
    const reset = await post('/password/reset', { token: sentToken, password: NEW }, freshIp());
    expect(reset.status).toBe(200);

    const saved = (await User.findById(user._id))!;
    expect(saved.sessions).toHaveLength(0);
    expect(await bcrypt.compare(NEW, saved.password)).toBe(true);
    const old = await request(app).get('/v1/protected').set('Authorization', `Bearer ${oldAccess}`);
    expect(old.status).toBe(401);

    const replay = await post('/password/reset', { token: sentToken, password: 'Third-Password-91!' }, freshIp());
    expect(replay.status).toBe(400);
  });

  it('rejects a reset without a password as a client error, not 503', async () => {
    await post('/password/forgot', { email: 'reset@example.test' }, freshIp());
    const res = await post('/password/reset', { token: sentToken }, freshIp());
    expect(res.status).toBe(400);
  });

  it('rejects an expired token', async () => {
    await post('/password/forgot', { email: 'reset@example.test' }, freshIp());
    await User.updateOne(
      { email: 'reset@example.test' },
      { $set: { passwordResetExpiresAt: new Date(Date.now() - 1000) } }
    );
    const res = await post('/password/reset', { token: sentToken, password: 'Brand-New-Password-58!' }, freshIp());
    expect(res.status).toBe(400);
    expect(await bcrypt.compare(STRONG, (await User.findOne({ email: 'reset@example.test' }))!.password)).toBe(true);
  });
});
