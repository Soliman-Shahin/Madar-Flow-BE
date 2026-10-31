import request from 'supertest';
import { configureExpressApp } from '../app';
import { User, UserRole } from '../models/user.model';

const app = configureExpressApp();

async function tokenFor(role: UserRole, email: string) {
  const user = await User.create({ email, password: 'not-used', role });
  await user.createSession();
  return (await User.findById(user._id))!.generateAccessAuthToken();
}

describe('health endpoints', () => {
  it('/health/detailed stays public (the Mobile app polls it) but exposes only the status', async () => {
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(200);
    expect(['healthy', 'degraded']).toContain(res.body.status);
    expect(Object.keys(res.body).sort()).toEqual(['status', 'timestamp']);
    expect(JSON.stringify(res.body)).not.toMatch(/version|environment|memory|checks/i);
  });

  it('/health/diagnostics is not available anonymously', async () => {
    const res = await request(app).get('/health/diagnostics');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/version|environment|memory/i);
  });

  it('/health/diagnostics is forbidden for a plain consumer', async () => {
    const token = await tokenFor(UserRole.User, 'hd-user@example.test');
    const res = await request(app).get('/health/diagnostics').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('/health/diagnostics returns the full report to a moderator', async () => {
    const token = await tokenFor(UserRole.Moderator, 'hd-mod@example.test');
    const res = await request(app).get('/health/diagnostics').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.checks).toHaveProperty('database');
    expect(res.body).toHaveProperty('version');
  });

  it('keeps public liveness/readiness reachable for the platform healthcheck', async () => {
    expect((await request(app).get('/health/ready')).status).toBe(200);
    expect((await request(app).get('/health/live')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
  });
});
