import request from 'supertest';
import { configureExpressApp } from '../app';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { planService } from '../services/plan.service';

const app = configureExpressApp();
const PASSWORD = 'Testing-Password-42!';
let ip = 0;
const freshIp = () => `10.98.0.${++ip}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signup(email: string) {
  const res = await request(app)
    .post('/v1/user/signup')
    .set('X-Forwarded-For', freshIp())
    .send({
      data: encryptCryptoJS({
        email,
        password: PASSWORD,
        termsAccepted: true,
        privacyAccepted: true,
        termsVersion: CONSENT_VERSIONS.terms,
        privacyVersion: CONSENT_VERSIONS.privacy,
      }),
    });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeEach(async () => {
  await planService.seedDefaultPlans();
});

describe('PUT /v1/user/me validation', () => {
  it('accepts a valid profile update and trims the name', async () => {
    const t = await signup('profile-ok@example.test');
    const res = await request(app)
      .put('/v1/user/me')
      .set(auth(t))
      .send({
        username: '  Sara Ali  ',
        phone: '+20 100 123 4567',
        currency: 'egp',
        salary: [{ label: 'Salary', amount: 1200 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe('Sara Ali');
    expect(res.body.data.currency).toBe('EGP');
  });

  it.each([
    ['blank name', { username: '   ' }],
    ['one-letter name', { username: 'A' }],
    ['letters in phone', { phone: 'abc12345' }],
    ['bad currency', { currency: 'DOLLARS' }],
    ['negative salary', { salary: [{ label: 'Salary', amount: -5 }] }],
    ['empty salary label', { salary: [{ label: ' ', amount: 5 }] }],
    ['non-array salary object', { salary: { label: 'x', amount: 1 } }],
  ])('rejects %s with 400', async (_name, body) => {
    const t = await signup(`profile-bad-${++ip}@example.test`);
    const res = await request(app).put('/v1/user/me').set(auth(t)).send(body);
    expect(res.status).toBe(400);
  });
});
