import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { User } from '../models';
import userRoutes from '../routes/user.route';
import { advancedEncryptionMiddleware } from '../middleware/encryption-advanced.middleware';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { MailService } from '../services/mail.service';
import { UserService } from '../services/user.service';
import { normalizeStoredEmails } from '../services/email-normalization.service';
import { maskEmail, normalizeEmail } from '../shared/email';

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(advancedEncryptionMiddleware);
app.use('/v1/user', userRoutes);

const PASSWORD = 'Testing-Password-42!';
const consent = {
  termsAccepted: true,
  privacyAccepted: true,
  termsVersion: CONSENT_VERSIONS.terms,
  privacyVersion: CONSENT_VERSIONS.privacy,
};
let ip = 0;
const post = (path: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/v1/user${path}`)
    .set('X-Forwarded-For', `10.1.0.${++ip}`)
    .send(path.startsWith('/password/') ? body : { data: encryptCryptoJS(body) });

/** Insert a pre-normalization account exactly as stored before this change. */
async function legacyUser(email: string, extra: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await User.collection.insertOne({
    _id,
    email,
    password: await bcrypt.hash(PASSWORD, 4),
    signupType: 'normal',
    role: 'user',
    sessions: [],
    isActive: true,
    _isDeleted: false,
    createdAt: new Date(),
    ...extra,
  } as any);
  return _id;
}

const storedEmail = async (id: Types.ObjectId) =>
  ((await User.collection.findOne({ _id: id })) as any)?.email;

describe('normalizeEmail helpers', () => {
  it('trims and lowercases, and masks for logs', () => {
    expect(normalizeEmail('  Ahmed@Gmail.COM ')).toBe('ahmed@gmail.com');
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail({ $ne: null })).toBe('');
    expect(maskEmail('ahmed@gmail.com')).toBe('a***@gmail.com');
  });
});

describe('new accounts', () => {
  it('stores a mixed-case signup lowercase and logs in with any case', async () => {
    const signup = await post('/signup', { email: 'Mixed.Case@Example.Test', password: PASSWORD, ...consent });
    expect(signup.status).toBe(200);
    expect(await User.exists({ email: 'mixed.case@example.test' })).toBeTruthy();

    const login = await post('/login', { email: 'MIXED.CASE@example.test', password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('treats e-mails differing only by case as the same account', async () => {
    await post('/signup', { email: 'dup@example.test', password: PASSWORD, ...consent });
    const second = await post('/signup', { email: 'DUP@Example.test', password: PASSWORD, ...consent });
    expect(second.status).toBe(409);
    expect(await User.countDocuments()).toBe(1);
  });
});

describe('legacy mixed-case accounts', () => {
  afterEach(() => jest.restoreAllMocks());

  /** A pre-normalization account after `npm run migrate:emails -- --apply`. */
  async function migratedLegacyUser(email: string) {
    const id = await legacyUser(email);
    await normalizeStoredEmails(true);
    return id;
  }

  it('are not matched until migrated (the migration is required)', async () => {
    await legacyUser('Unmigrated@Example.Test');
    expect(await UserService.findByEmail('unmigrated@example.test')).toBeNull();
  });

  it('log in with any case once migrated', async () => {
    await migratedLegacyUser('Ahmed@Gmail.com');
    expect((await post('/login', { email: 'ahmed@gmail.com', password: PASSWORD })).status).toBe(200);
    expect((await post('/login', { email: 'Ahmed@Gmail.com', password: PASSWORD })).status).toBe(200);
  });

  it('can use forgot-password once migrated', async () => {
    await migratedLegacyUser('Sara@Example.Test');
    const send = jest.spyOn(MailService, 'sendPasswordReset').mockResolvedValue();
    await post('/password/forgot', { email: 'SARA@example.test' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('block a duplicate signup in a different case once migrated', async () => {
    await migratedLegacyUser('Omar@Example.Test');
    const res = await post('/signup', { email: 'omar@example.test', password: PASSWORD, ...consent });
    expect(res.status).toBe(409);
  });

  it('link native Google sign-in instead of creating a duplicate once migrated', async () => {
    const id = await migratedLegacyUser('Google.User@Gmail.com');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        sub: 'google-subject-legacy',
        email: 'google.user@gmail.com',
        aud: process.env.GOOGLE_WEB_CLIENT_ID,
        email_verified: true,
      }),
    } as any);
    const res = await request(app)
      .post('/v1/user/auth/google/native')
      .send({ idToken: 'synthetic-google-credential' });
    expect(res.status).toBe(200);
    expect(await User.countDocuments()).toBe(1);
    expect(String(res.body.data.user._id)).toBe(id.toString());
  });
});

describe('normalizeStoredEmails migration', () => {
  it('dry-run reports without writing', async () => {
    const id = await legacyUser('Dry.Run@Example.Test');
    await legacyUser('already@example.test');

    const report = await normalizeStoredEmails(false);

    expect(report).toMatchObject({ apply: false, totalUsers: 2, needsNormalization: 1, updated: 0 });
    expect(report.collisions).toHaveLength(0);
    expect(await storedEmail(id)).toBe('Dry.Run@Example.Test');
  });

  it('apply rewrites safe rows, never touches collisions, and is idempotent', async () => {
    const safe = await legacyUser('  Safe@Example.Test ');
    const twinA = await legacyUser('Twin@Example.Test');
    const twinB = await legacyUser('twin@example.test');

    const first = await normalizeStoredEmails(true);
    expect(first.updated).toBe(1);
    expect(await storedEmail(safe)).toBe('safe@example.test');
    expect(first.collisions).toHaveLength(1);
    expect(first.collisions[0].email).toBe('t***@example.test');
    expect(first.collisions[0].accounts.map((a) => a.id).sort()).toEqual(
      [twinA.toString(), twinB.toString()].sort()
    );
    expect(await storedEmail(twinA)).toBe('Twin@Example.Test');
    expect(await storedEmail(twinB)).toBe('twin@example.test');

    const second = await normalizeStoredEmails(true);
    expect(second.updated).toBe(0);
    // Migrated account still logs in.
    expect((await post('/login', { email: 'SAFE@example.test', password: PASSWORD })).status).toBe(200);
  });
});
