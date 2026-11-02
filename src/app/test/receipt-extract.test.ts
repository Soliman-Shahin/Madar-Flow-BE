process.env.RECEIPT_AI_PROVIDER = 'openai';
process.env.RECEIPT_AI_BASE_URL = 'http://provider.test/v1';
process.env.RECEIPT_AI_MODEL = 'test-model';

import request from 'supertest';
import { configureExpressApp } from '../app';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { planService } from '../services/plan.service';
import { Plan, ReceiptScanUsage } from '../models';
import { PlanSlug } from '../types/plan.types';
import {
  ReceiptScanService,
  sanitizeExtraction,
  scanLimitFor,
} from '../services/receipt-extract.service';

const app = configureExpressApp();
const PASSWORD = 'Testing-Password-42!';
let ip = 0;
const freshIp = () => `10.97.0.${++ip}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD';

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

const modelAnswer = (obj: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }),
});

beforeEach(async () => {
  await planService.seedDefaultPlans();
});
afterEach(() => jest.restoreAllMocks());

describe('receipt reading helpers', () => {
  it('never trusts the model output', () => {
    const r = sanitizeExtraction({
      merchant: '  Fresh Market  ',
      date: '2026-11-03',
      total: '114.57',
      currency: 'egp',
      items: [{ name: 'Milk', amount: 32 }, { name: '', amount: 5 }, { name: 'X', amount: -1 }],
    });
    expect(r).toEqual({
      merchant: 'Fresh Market',
      date: '2026-11-03',
      total: 114.57,
      currency: 'EGP',
      items: [{ name: 'Milk', amount: 32 }],
    });
    expect(sanitizeExtraction({ total: 'abc', date: 'tomorrow', currency: 'dollars' })).toEqual({
      merchant: null,
      date: null,
      total: null,
      currency: null,
      items: [],
    });
    expect(sanitizeExtraction(null).total).toBeNull();
  });

  it('uses a safe allowance for plans saved before the setting existed', () => {
    expect(scanLimitFor({}, 'free')).toBe(10);
    expect(scanLimitFor({}, 'premium')).toBeNull();
    expect(scanLimitFor({ maxReceiptScansPerMonth: null } as any, 'free')).toBeNull();
    expect(scanLimitFor({ maxReceiptScansPerMonth: 3 } as any, 'free')).toBe(3);
  });

  it('has no provider unless one is configured', () => {
    expect(new ReceiptScanService(null).available).toBe(false);
  });
});

describe('POST /v1/receipts/extract', () => {
  it('reads a receipt and counts it', async () => {
    const t = await signup('rcpt-ok@example.test');
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(modelAnswer({ merchant: 'Cafe', date: '2026-11-03', total: 62.7, currency: 'EGP', items: [] }) as any);
    const res = await request(app).post('/v1/receipts/extract').set(auth(t)).send({ image: IMAGE });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ merchant: 'Cafe', total: 62.7, currency: 'EGP' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const usage = await request(app).get('/v1/receipts/usage').set(auth(t));
    expect(usage.body.data).toMatchObject({ used: 1, limit: 10, available: true });
  });

  it('stops at the plan allowance with 429', async () => {
    const t = await signup('rcpt-limit@example.test');
    await Plan.updateOne({ slug: PlanSlug.Free }, { $set: { 'limits.maxReceiptScansPerMonth': 1 } });
    jest.spyOn(global, 'fetch').mockResolvedValue(modelAnswer({ total: 5 }) as any);
    const first = await request(app).post('/v1/receipts/extract').set(auth(t)).send({ image: IMAGE });
    expect(first.status).toBe(200);
    const second = await request(app).post('/v1/receipts/extract').set(auth(t)).send({ image: IMAGE });
    expect(second.status).toBe(429);
    await Plan.updateOne({ slug: PlanSlug.Free }, { $set: { 'limits.maxReceiptScansPerMonth': 10 } });
  });

  it('gives the scan back when the reader fails', async () => {
    const t = await signup('rcpt-fail@example.test');
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network'));
    const res = await request(app).post('/v1/receipts/extract').set(auth(t)).send({ image: IMAGE });
    expect(res.status).toBe(502);
    const usage = await request(app).get('/v1/receipts/usage').set(auth(t));
    expect(usage.body.data.used).toBe(0);
  });

  it('rejects anything that is not a small image', async () => {
    const t = await signup('rcpt-bad@example.test');
    const spy = jest.spyOn(global, 'fetch');
    for (const image of ['hello', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA']) {
      const res = await request(app).post('/v1/receipts/extract').set(auth(t)).send({ image });
      expect(res.status).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('needs a signed-in user', async () => {
    const res = await request(app).post('/v1/receipts/extract').send({ image: IMAGE });
    expect([401, 403]).toContain(res.status);
  });

  afterAll(async () => {
    await ReceiptScanUsage.deleteMany({});
  });
});

describe('Gemini provider', () => {
  it('moves on to the next model when one is unknown (404) and remembers the one that works', async () => {
    const { GeminiProvider } = await import('../services/receipt-extract.service');
    const answer = {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"total": 12.5}' }] } }],
      }),
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as any)
      .mockResolvedValue(answer as any);
    const p = new GeminiProvider('key', 'gemini-old-retired');
    const image = { mime: 'image/jpeg', base64: 'AAAA' };
    expect(await p.extract(image)).toEqual({ total: 12.5 });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('gemini-old-retired');
    expect(urls[1]).toContain('gemini-3.5-flash-lite');
    // the next call goes straight to the working model
    await p.extract(image);
    expect(String(fetchMock.mock.calls[2][0])).toContain('gemini-3.5-flash-lite');
    // the key travels in a header, never in the URL
    expect(urls.every((u) => !u.includes('key='))).toBe(true);
  });

  it('does not hide other failures behind the model list', async () => {
    const { GeminiProvider } = await import('../services/receipt-extract.service');
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as any);
    await expect(
      new GeminiProvider('key', 'm').extract({ mime: 'image/jpeg', base64: 'AAAA' })
    ).rejects.toThrow(/403/);
  });
});

describe('Gemini provider under load', () => {
  it('falls to the next (lighter) model when one is overloaded or rate limited', async () => {
    const { GeminiProvider } = await import('../services/receipt-extract.service');
    const ok = {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"total": 3136.5}' }] } }] }),
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as any)
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) } as any)
      .mockResolvedValue(ok as any);
    const p = new GeminiProvider('key', 'gemini-3.5-flash-lite');
    expect(await p.extract({ mime: 'image/jpeg', base64: 'AAAA' })).toEqual({ total: 3136.5 });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('gemini-3.5-flash-lite:');
    expect(urls[1]).toContain('gemini-3.1-flash-lite');
    expect(urls[2]).toContain('gemini-3.5-flash:');
  });
});
