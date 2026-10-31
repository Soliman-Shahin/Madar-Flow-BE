import express from 'express';
import request from 'supertest';
import { configureExpressApp } from '../app';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { planService } from '../services/plan.service';

const app = configureExpressApp();
const PASSWORD = 'Testing-Password-42!';
let ip = 0;
const freshIp = () => `10.77.0.${++ip}`;

async function token(email: string) {
  const res = await request(app)
    .post('/v1/user/signup')
    .set('X-Forwarded-For', freshIp())
    .send({
      data: encryptCryptoJS({
        email, password: PASSWORD, termsAccepted: true, privacyAccepted: true,
        termsVersion: CONSENT_VERSIONS.terms, privacyVersion: CONSENT_VERSIONS.privacy,
      }),
    });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

const create = (t: string, body: object) =>
  request(app).post('/v1/categories/create').set({ Authorization: `Bearer ${t}` }).send(body);

beforeEach(async () => { await planService.seedDefaultPlans(); });

describe('Category input validation', () => {
  it('rejects an empty title with 400 VALIDATION_ERROR (not a 500 leaking Mongoose text)', async () => {
    const t = await token('cat-val-1@example.test');
    const res = await create(t, { title: '', icon: 'x', color: '#000000', type: 'outcome' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/Path `title`|validation failed:/i);
  });

  it('rejects missing fields and an unknown type', async () => {
    const t = await token('cat-val-2@example.test');
    expect((await create(t, { title: 'Only title' })).status).toBe(400);
    expect((await create(t, { title: 'T', icon: 'i', color: '#fff', type: 'weird' })).status).toBe(400);
  });

  it('still accepts a valid category', async () => {
    const t = await token('cat-val-3@example.test');
    const res = await create(t, { title: 'Valid', icon: 'cart-outline', color: '#3366CC', type: 'outcome' });
    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe('Valid');
  });
});
