import express from 'express';
import request from 'supertest';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

function build(opts: { skipSuccessfulRequests?: boolean }) {
  const app = express();
  app.use(express.json());
  app.post(
    '/login',
    createRateLimiter({ windowMs: 60_000, maxRequests: 3, ...opts }),
    (req, res) => (req.body?.ok ? res.json({ ok: true }) : res.status(401).json({ ok: false }))
  );
  return app;
}

describe('rate limiter skipSuccessfulRequests (D-022)', () => {
  it('does not count successful requests, so shared-IP users are not locked out', async () => {
    const app = build({ skipSuccessfulRequests: true });
    for (let i = 0; i < 10; i++) {
      await request(app).post('/login').send({ ok: true }).expect(200);
    }
  });

  it('still blocks after the failed-attempt budget is spent', async () => {
    const app = build({ skipSuccessfulRequests: true });
    for (let i = 0; i < 3; i++) {
      await request(app).post('/login').send({ ok: false }).expect(401);
    }
    const blocked = await request(app).post('/login').send({ ok: true });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error?.code ?? blocked.body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('counts every request when the option is off', async () => {
    const app = build({});
    for (let i = 0; i < 3; i++) await request(app).post('/login').send({ ok: true }).expect(200);
    await request(app).post('/login').send({ ok: true }).expect(429);
  });
});
