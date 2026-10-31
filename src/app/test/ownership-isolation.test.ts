import express from 'express';
import request from 'supertest';
import { configureExpressApp } from '../app';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { planService } from '../services/plan.service';

const app = configureExpressApp();
const PASSWORD = 'Testing-Password-42!';
let ip = 0;
const freshIp = () => `10.88.0.${++ip}`;

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
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function seed() {
  const a = await token('iso-a@example.test');
  const b = await token('iso-b@example.test');
  const cat = await request(app).post('/v1/categories/create').set(auth(a))
    .send({ title: 'A private', icon: 'cart-outline', color: '#3366CC', type: 'outcome' });
  expect(cat.status).toBe(201);
  const exp = await request(app).post('/v1/expenses').set(auth(a))
    .send({ description: 'A secret', amount: 12, category: cat.body.data._id, date: new Date().toISOString() });
  expect([200, 201]).toContain(exp.status);
  return { a, b, catId: cat.body.data._id as string, expId: exp.body.data._id as string };
}

beforeEach(async () => { await planService.seedDefaultPlans(); });

describe('cross-user isolation (IDOR)', () => {
  it('user B cannot read, update or delete user A category', async () => {
    const { b, catId } = await seed();
    expect((await request(app).get(`/v1/categories/${catId}`).set(auth(b))).status).toBeGreaterThanOrEqual(403);
    const upd = await request(app).put(`/v1/categories/update/${catId}`).set(auth(b)).send({ title: 'hijacked' });
    expect(upd.status).toBeGreaterThanOrEqual(403);
    expect((await request(app).delete(`/v1/categories/delete/${catId}`).set(auth(b))).status).toBeGreaterThanOrEqual(403);
  });

  it('user B cannot read, update or delete user A expense', async () => {
    const { b, expId, catId } = await seed();
    expect((await request(app).get(`/v1/expenses/${expId}`).set(auth(b))).status).toBeGreaterThanOrEqual(403);
    const upd = await request(app).put(`/v1/expenses/${expId}`).set(auth(b))
      .send({ description: 'hijacked', amount: 1, category: catId, date: new Date().toISOString() });
    expect(upd.status).toBeGreaterThanOrEqual(403);
    expect((await request(app).delete(`/v1/expenses/${expId}`).set(auth(b))).status).toBeGreaterThanOrEqual(403);
  });

  it("lists never include another user's data", async () => {
    const { b } = await seed();
    const cats = await request(app).get('/v1/categories/list').set(auth(b));
    const exps = await request(app).get('/v1/expenses').set(auth(b));
    expect(JSON.stringify(cats.body)).not.toContain('A private');
    expect(JSON.stringify(exps.body)).not.toContain('A secret');
  });

  it("update-order cannot reorder another user's category", async () => {
    const { b, a, catId } = await seed();
    await request(app).put('/v1/categories/update-order').set(auth(b))
      .send({ categories: [{ categoryId: catId, order: 99 }] });
    const mine = await request(app).get('/v1/categories/list').set(auth(a));
    const found = JSON.stringify(mine.body);
    expect(found).toContain('A private');
    expect(found).not.toMatch(/"order":99/);
  });

  it("an expense cannot be created against another user's category", async () => {
    const { b, catId } = await seed();
    const res = await request(app).post('/v1/expenses').set(auth(b))
      .send({ description: 'cross ref', amount: 5, category: catId, date: new Date().toISOString() });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
