import request from 'supertest';
import { configureExpressApp } from '../app';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { planService } from '../services/plan.service';
import { Plan } from '../models';
import { PlanSlug } from '../types/plan.types';
import { assetLimitFor } from '../services/asset-limit';
import { MarketPriceService } from '../services/market-price.service';

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

const gold = (over: Record<string, unknown> = {}) => ({
  type: 'gold',
  name: 'Wedding ring',
  purchasedAt: '2026-01-10',
  cost: { amount: 38000, currency: 'EGP' },
  details: { grams: 8, karat: 21, form: 'jewelry', pricePerGram: 4750 },
  updatedAt: '2026-01-10T10:00:00.000Z',
  ...over,
});

beforeEach(async () => {
  await planService.seedDefaultPlans();
});

describe('vault assets', () => {
  it('saves, lists, updates and removes', async () => {
    const t = await signup(`vault-${Date.now()}@test.dev`);
    const id = 'asset-aaaa-0001';

    const put = await request(app).put(`/v1/vault/assets/${id}`).set(auth(t)).send(gold());
    expect(put.status).toBe(200);
    expect(put.body.data.cost).toEqual({ amount: 38000, currency: 'EGP' });

    // retrying the same save does not duplicate
    await request(app).put(`/v1/vault/assets/${id}`).set(auth(t)).send(gold());
    let list = await request(app).get('/v1/vault/assets').set(auth(t));
    expect(list.body.data).toHaveLength(1);

    const edit = await request(app)
      .put(`/v1/vault/assets/${id}`)
      .set(auth(t))
      .send(gold({ name: 'Ring', updatedAt: '2026-02-01T10:00:00.000Z' }));
    expect(edit.body.data.name).toBe('Ring');

    // an older edit never overwrites a newer one
    const stale = await request(app)
      .put(`/v1/vault/assets/${id}`)
      .set(auth(t))
      .send(gold({ name: 'Old', updatedAt: '2026-01-15T10:00:00.000Z' }));
    expect(stale.body.data.name).toBe('Ring');

    await request(app).delete(`/v1/vault/assets/${id}`).set(auth(t)).expect(200);
    list = await request(app).get('/v1/vault/assets').set(auth(t));
    expect(list.body.data[0].isDeleted).toBe(true);
    const usage = await request(app).get('/v1/vault/usage').set(auth(t));
    expect(usage.body.data.used).toBe(0);
  });

  it('keeps each person’s items private', async () => {
    const a = await signup(`vault-a-${Date.now()}@test.dev`);
    const b = await signup(`vault-b-${Date.now()}@test.dev`);
    await request(app).put('/v1/vault/assets/asset-priv-0001').set(auth(a)).send(gold());
    const list = await request(app).get('/v1/vault/assets').set(auth(b));
    expect(list.body.data).toHaveLength(0);
  });

  it('rejects bad input', async () => {
    const t = await signup(`vault-bad-${Date.now()}@test.dev`);
    const bad = await request(app)
      .put('/v1/vault/assets/asset-bad-00001')
      .set(auth(t))
      .send(gold({ details: { grams: -3, karat: 19, form: 'bar' } }));
    expect(bad.status).toBe(400);
    const cur = await request(app)
      .put('/v1/vault/assets/asset-bad-00002')
      .set(auth(t))
      .send(gold({ cost: { amount: 10, currency: 'egp' } }));
    expect(cur.status).toBe(400);
  });

  it('needs a login', async () => {
    await request(app).get('/v1/vault/assets').expect(401);
  });

  it('stops at the plan limit but lets existing items be edited', async () => {
    const t = await signup(`vault-lim-${Date.now()}@test.dev`);
    await Plan.updateOne({ slug: PlanSlug.Free }, { $set: { 'limits.maxAssets': 1 } });
    await request(app).put('/v1/vault/assets/asset-lim-00001').set(auth(t)).send(gold()).expect(200);
    const over = await request(app).put('/v1/vault/assets/asset-lim-00002').set(auth(t)).send(gold());
    expect(over.status).toBe(403);
    expect(over.body.error?.code ?? over.body.code).toBe('PLAN_LIMIT_EXCEEDED');
    await request(app)
      .put('/v1/vault/assets/asset-lim-00001')
      .set(auth(t))
      .send(gold({ name: 'Edited', updatedAt: '2026-03-01T00:00:00.000Z' }))
      .expect(200);
    await Plan.updateOne({ slug: PlanSlug.Free }, { $set: { 'limits.maxAssets': 10 } });
  });
});

describe('asset limit helper', () => {
  it('reads the plan, treats null as unlimited, and falls back when unset', () => {
    expect(assetLimitFor({ maxAssets: null } as any, 'free')).toBeNull();
    expect(assetLimitFor({ maxAssets: 4 } as any, 'free')).toBe(4);
    expect(assetLimitFor({} as any, 'free')).toBe(10);
    expect(assetLimitFor({} as any, 'premium')).toBeNull();
    expect(assetLimitFor(undefined, 'custom')).toBe(10);
  });
});

describe('market prices', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const fx = { usd: { egp: 50, eur: 0.9, xau: 0.0004 } };

  it('uses gold-api and the currency table', async () => {
    const fetchFn = jest.fn(async (url: string) =>
      url.includes('gold-api') ? ok({ price: 3110.34768 }) : ok(fx)
    );
    const s = await new MarketPriceService(fetchFn as any).get();
    expect(s.goldUsdPerGram24).toBeCloseTo(100, 4);
    expect(s.usdPer.EGP).toBe(50);
    expect(s.sources.gold).toBe('gold-api');
  });

  it('falls back to the currency table for gold and to the mirror for FX', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('gold-api') || url.includes('jsdelivr')) throw new Error('down');
      return ok(fx);
    });
    const s = await new MarketPriceService(fetchFn as any).get();
    expect(s.sources.gold).toBe('currency-api');
    expect(s.goldUsdPerGram24).toBeCloseTo(1 / 0.0004 / 31.1034768, 4);
  });

  it('serves the last good prices, marked stale, when everything fails', async () => {
    let t = 0;
    let down = false;
    const fetchFn = jest.fn(async (url: string) => {
      if (down) throw new Error('down');
      return url.includes('gold-api') ? ok({ price: 3000 }) : ok(fx);
    });
    const svc = new MarketPriceService(fetchFn as any, () => t);
    await svc.get();
    down = true;
    t += 60 * 60 * 1000;
    const s = await svc.get();
    expect(s.stale).toBe(true);
    expect(s.usdPer.EGP).toBe(50);
  });

  it('caches within 15 minutes', async () => {
    const fetchFn = jest.fn(async (url: string) =>
      url.includes('gold-api') ? ok({ price: 3000 }) : ok(fx)
    );
    const svc = new MarketPriceService(fetchFn as any, () => 1000);
    await svc.get();
    const calls = fetchFn.mock.calls.length;
    await svc.get();
    expect(fetchFn.mock.calls.length).toBe(calls);
  });
});
