import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { conditionalCsrfProtection } from './csrf.middleware';

/**
 * Minimal app: cookie parsing + the real CSRF middleware in front of stub
 * handlers, so each test exercises only the exemption rules.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(conditionalCsrfProtection);
  const ok = (_req: Request, res: Response) => res.status(200).json({ ok: true });
  app.post('/v1/user/signup', ok);
  app.post('/v1/user/login', ok);
  app.post('/v1/categories', ok);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err?.status || 500).json({ code: err?.code });
  });
  return app;
}

describe('conditionalCsrfProtection', () => {
  const app = buildApp();

  it('lets email sign-up through without a CSRF token (token-based client)', async () => {
    const res = await request(app).post('/v1/user/signup').send({});
    expect(res.status).toBe(200);
  });

  it('lets password sign-in through without a CSRF token', async () => {
    const res = await request(app).post('/v1/user/login').send({});
    expect(res.status).toBe(200);
  });

  it('still rejects a cookie-style mutation without a CSRF token', async () => {
    const res = await request(app).post('/v1/categories').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EBADCSRFTOKEN');
  });

  it('skips CSRF for Bearer-authenticated requests', async () => {
    const res = await request(app)
      .post('/v1/categories')
      .set('Authorization', 'Bearer synthetic-token')
      .send({});
    expect(res.status).toBe(200);
  });
});
