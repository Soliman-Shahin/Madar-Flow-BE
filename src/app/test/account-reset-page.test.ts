import request from 'supertest';
import { configureExpressApp } from '../app';

const app = configureExpressApp();
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('GET /account/reset-password (https landing for the reset e-mail)', () => {
  const originalFrontend = process.env.FRONTEND_URL;
  afterEach(() => {
    if (originalFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontend;
  });

  it('offers the app deep link and the web dashboard link for a valid-looking token', async () => {
    process.env.FRONTEND_URL = 'https://flow-admin.orbit-madar.com';
    const res = await request(app).get(`/account/reset-password?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      `href="madarflow://auth/reset-password?token=${TOKEN}"`
    );
    expect(res.text).toContain(
      `href="https://flow-admin.orbit-madar.com/reset-password?token=${TOKEN}"`
    );
    expect(res.text).toContain('Open Madar Flow');
    expect(res.text).toContain('افتح مدار فلو');
  });

  it('is not cached, hides the referrer, and sends a locked-down CSP', async () => {
    const res = await request(app).get(`/account/reset-password?token=${TOKEN}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('omits the web link when no https frontend is configured', async () => {
    process.env.FRONTEND_URL = 'http://localhost:4400';
    const res = await request(app).get(`/account/reset-password?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('reset-password?token=' + TOKEN + '" rel');
    expect(res.text).not.toContain('localhost');
  });

  it.each([
    ['missing token', ''],
    ['too short', '?token=abc'],
    ['markup injection', '?token="><script>alert(1)</script>'],
    ['non-token characters', '?token=' + encodeURIComponent('a'.repeat(20) + ' b/c')],
    ['array parameter', '?token=' + TOKEN + '&token=' + TOKEN],
  ])('rejects a %s without echoing it', async (_name, query) => {
    const res = await request(app).get(`/account/reset-password${query}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('not valid');
    expect(res.text).not.toContain('madarflow://');
    expect(res.text).not.toContain('<script>alert');
  });
});
