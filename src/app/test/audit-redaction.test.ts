import request from 'supertest';
import { configureExpressApp } from '../app';
import { User, UserRole } from '../models/user.model';
import { AuditLog, AuditAction } from '../models/audit-log.model';
import { redactSensitive } from '../shared/redact';

const app = configureExpressApp();

describe('redactSensitive', () => {
  it('masks credential-like keys at any depth and keeps the rest', () => {
    const out: any = redactSensitive({ email: 'a@b.test', password: 'Secret1!', nested: { refreshToken: 'x', list: [{ apiKey: 'k', ok: 1 }] }, empty: '' });
    expect(out.email).toBe('a@b.test');
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.refreshToken).toBe('[REDACTED]');
    expect(out.nested.list[0]).toEqual({ apiKey: '[REDACTED]', ok: 1 });
  });
});

describe('audit log never stores the password of an admin-created user', () => {
  it('redacts changes.password in both the database and the API response', async () => {
    const admin = await User.create({ email: 'audit-admin@example.test', password: 'not-used', role: UserRole.Admin });
    await admin.createSession();
    const token = await (await User.findById(admin._id))!.generateAccessAuthToken();
    const create = await request(app)
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'audit-created@example.test', password: 'Plaintext-Pass-42!', role: 'user', username: 'audit-created' });
    expect(create.status).toBe(201);

    const stored = await AuditLog.find({ action: AuditAction.USER_CREATED }).lean();
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain('Plaintext-Pass-42!');

    const api = await request(app).get('/v1/audit-logs').set('Authorization', `Bearer ${token}`);
    expect(api.status).toBe(200);
    expect(JSON.stringify(api.body)).not.toContain('Plaintext-Pass-42!');
  });
});
