import express from 'express';
import request from 'supertest';
import { User } from '../models';
import userRoutes from '../routes/user.route';
import { advancedEncryptionMiddleware } from '../middleware/encryption-advanced.middleware';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { MailService } from '../services/mail.service';
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

const signup = (email: string) => post('/signup', { email, password: PASSWORD, ...consent });

describe('normalizeEmail helpers', () => {
  it('trims and lowercases, and masks for logs', () => {
    expect(normalizeEmail('  Ahmed@Gmail.COM ')).toBe('ahmed@gmail.com');
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail({ $ne: null })).toBe('');
    expect(maskEmail('ahmed@gmail.com')).toBe('a***@gmail.com');
  });
});

describe('e-mail case handling', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stores a mixed-case signup lowercase and logs in with any case', async () => {
    expect((await signup('Mixed.Case@Example.Test')).status).toBe(200);
    expect(await User.exists({ email: 'mixed.case@example.test' })).toBeTruthy();

    const login = await post('/login', { email: 'MIXED.CASE@example.test', password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('treats e-mails differing only by case as the same account', async () => {
    await signup('dup@example.test');
    expect((await signup('DUP@Example.test')).status).toBe(409);
    expect(await User.countDocuments()).toBe(1);
  });

  it('finds the account for forgot-password in any case', async () => {
    await signup('Sara@Example.Test');
    const send = jest.spyOn(MailService, 'sendPasswordReset').mockResolvedValue();
    await post('/password/forgot', { email: 'SARA@example.test' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('links native Google sign-in to an existing account regardless of case', async () => {
    const created = await signup('Google.User@Gmail.com');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        sub: 'google-subject',
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
    expect(String(res.body.data.user._id)).toBe(String(created.body.data.user._id));
  });
});
