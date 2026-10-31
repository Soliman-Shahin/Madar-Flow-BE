import request from 'supertest';
import { configureExpressApp } from '../app';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { planService } from '../services/plan.service';
import { User } from '../models';

const app = configureExpressApp();
const PASSWORD = 'Testing-Password-42!';
let ip = 0;
const freshIp = () => `10.99.0.${++ip}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signup(email: string) {
  const res = await request(app).post('/v1/user/signup').set('X-Forwarded-For', freshIp()).send({
    data: encryptCryptoJS({
      email, password: PASSWORD, termsAccepted: true, privacyAccepted: true,
      termsVersion: CONSENT_VERSIONS.terms, privacyVersion: CONSENT_VERSIONS.privacy,
    }),
  });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}
async function staffToken(role: string, email: string) {
  const user = await User.create({ email, password: 'not-used', role } as any);
  await user.createSession();
  return (await User.findById(user._id))!.generateAccessAuthToken();
}

beforeEach(async () => { await planService.seedDefaultPlans(); });

describe('operator and regex injection', () => {
  it('login: operator objects as credentials are rejected without a 5xx or a session', async () => {
    await signup('inj-login@example.test');
    for (const body of [
      { email: { $gt: '' }, password: { $gt: '' } },
      { email: 'inj-login@example.test', password: { $ne: null } },
      { email: { $regex: '.*' }, password: PASSWORD },
    ]) {
      const res = await request(app).post('/v1/user/login').set('X-Forwarded-For', freshIp()).send(body);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(JSON.stringify(res.body)).not.toMatch(/accessToken/);
    }
  });

  it('consumer list filters: operator-style query values never widen the result or crash', async () => {
    const a = await signup('inj-a@example.test');
    const b = await signup('inj-b@example.test');
    const cat = await request(app).post('/v1/categories/create').set(auth(a))
      .send({ title: 'A only', icon: 'x', color: '#000000', type: 'outcome' });
    await request(app).post('/v1/expenses').set(auth(a))
      .send({ description: 'A secret meal', amount: 9, category: cat.body.data._id, date: new Date().toISOString() });

    const probes = [
      '/v1/expenses?category[$ne]=000000000000000000000000',
      '/v1/expenses?search[$regex]=.*',
      '/v1/expenses?search=.*&type[$ne]=income',
      '/v1/expenses?startDate[$gt]=1970-01-01',
      '/v1/expenses?user[$ne]=000000000000000000000000',
      '/v1/categories/list?search[$regex]=.*',
      '/v1/categories/list?sort[$gt]=a',
      '/v1/categories/list?sort=-password',
      '/v1/categories/list?user[$ne]=000000000000000000000000',
    ];
    for (const url of probes) {
      const res = await request(app).get(url).set(auth(b));
      expect(res.status).toBeLessThan(500);
      expect(JSON.stringify(res.body)).not.toMatch(/A secret meal|A only/);
    }
  });

  it('regex metacharacters in search are matched literally and a catastrophic pattern returns quickly', async () => {
    const t = await signup('inj-regex@example.test');
    const started = Date.now();
    const res = await request(app).get(`/v1/expenses?search=${encodeURIComponent('(a+)+$')}${encodeURIComponent('a'.repeat(40))}!`).set(auth(t));
    expect(res.status).toBeLessThan(500);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('admin lists: operator values and secret sort fields are not honoured and never 5xx', async () => {
    const admin = await staffToken('admin', 'inj-admin@example.test');
    const probes = [
      '/v1/admin/users?search[$regex]=.*',
      '/v1/admin/users?status[$ne]=x',
      '/v1/admin/users?sortField=password',
      '/v1/admin/users?sortField=sessions.token',
      '/v1/admin/users?sortField=$where',
      '/v1/admin/categories?sortField[$gt]=a',
      '/v1/admin/expenses?search[$regex]=.*&sortField=user.password',
    ];
    for (const url of probes) {
      const res = await request(app).get(url).set(auth(admin));
      expect(res.status).toBeLessThan(500);
      expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$|"password"|refreshToken/);
    }
  });

  it('request bodies: $-keys are stripped before reaching validation or storage', async () => {
    const t = await signup('inj-body@example.test');
    const res = await request(app).post('/v1/categories/create').set(auth(t))
      .send({ title: 'ok', icon: 'x', color: '#000000', type: 'outcome', $where: 'sleep(5000)', 'user.role': 'admin' });
    expect(res.status).toBeLessThan(500);
    const me = await request(app).get('/v1/user/me').set(auth(t));
    expect(me.body.data.role ?? 'user').toBe('user');
  });
});

describe('malformed and oversized input', () => {
  it('answers 400 (not 500) for broken JSON and a deeply nested payload', async () => {
    const t = await signup('inj-json@example.test');
    const broken = await request(app).post('/v1/expenses').set(auth(t)).set('Content-Type', 'application/json').send('{"a":');
    expect(broken.status).toBe(400);
    let deep = 'null';
    for (let i = 0; i < 5000; i++) deep = `{"a":${deep}}`;
    const nested = await request(app).post('/v1/expenses').set(auth(t)).set('Content-Type', 'application/json').send(deep);
    expect(nested.status).toBe(400);
  });

  it('clamps junk paging values instead of crashing the query', async () => {
    const t = await signup('inj-paging@example.test');
    for (const qs of ['limit=1000000000&skip=-5', 'limit=abc&skip=xyz', 'limit=-1', 'skip=-100']) {
      const res = await request(app).get(`/v1/expenses?${qs}`).set(auth(t));
      expect(res.status).toBe(200);
    }
  });
});
