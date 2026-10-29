import express from 'express';
import request from 'supertest';
import { User, UserRole } from '../models/user.model';
import { AuditLog, AuditAction } from '../models/audit-log.model';
import { AppSettings } from '../models/app-settings.model';
import {
  appSettingsPublicRoutes,
  appSettingsAdminRoutes,
} from '../routes/app-settings.route';
import { enhancedErrorHandler } from '../middleware/error-handler-enhanced';

const app = express();
app.use(express.json());
app.use('/v1/app-settings', appSettingsPublicRoutes);
app.use('/v1/admin/app-settings', appSettingsAdminRoutes);
app.use(enhancedErrorHandler);

async function tokenFor(role: UserRole, email: string) {
  const user = await User.create({
    email,
    password: 'unused-in-this-test',
    role,
  });
  await user.createSession();
  return (await User.findById(user._id))!.generateAccessAuthToken();
}

const support = {
  email: 'help@example.test',
  whatsapp: '+20 100 123 4567',
  website: 'https://example.test/help',
  hours: { en: 'Sun-Thu 10-18', ar: 'الأحد-الخميس ١٠-١٨' },
};

const legalDoc = (version: string, body = 'Body') => ({
  version,
  title: { en: 'Terms' },
  body: { en: body, ar: 'نص' },
});

describe('App settings (dashboard-managed content)', () => {
  it('serves an empty public document before anything is configured', async () => {
    const res = await request(app).get('/v1/app-settings');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ revision: 0, updatedAt: null });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('does not report empty sections as configured once the document exists', async () => {
    const admin = await tokenFor(UserRole.Admin, 'reader@example.test');
    const adminRes = await request(app)
      .get('/v1/admin/app-settings')
      .auth(admin, { type: 'bearer' });
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.data.faq).toBeUndefined();
    const publicRes = await request(app).get('/v1/app-settings');
    expect(publicRes.body.data.faq).toBeUndefined();
    expect(Object.keys(publicRes.body.data).sort()).toEqual(['revision', 'updatedAt']);
  });

  it('requires staff for reads and SuperAdmin for writes', async () => {
    const path = '/v1/admin/app-settings';
    expect((await request(app).get(path)).status).toBe(401);

    const user = await tokenFor(UserRole.User, 'plain@example.test');
    const moderator = await tokenFor(UserRole.Moderator, 'mod@example.test');
    const admin = await tokenFor(UserRole.Admin, 'admin@example.test');

    for (const token of [user, moderator])
      expect(
        (await request(app).get(path).auth(token, { type: 'bearer' })).status
      ).toBe(403);
    expect(
      (await request(app).get(path).auth(admin, { type: 'bearer' })).status
    ).toBe(200);

    for (const token of [user, moderator, admin])
      expect(
        (
          await request(app)
            .put(path)
            .auth(token, { type: 'bearer' })
            .send({ revision: 0, support })
        ).status
      ).toBe(403);
    expect(await AppSettings.countDocuments({ revision: { $gt: 0 } })).toBe(0);
  });

  it('saves sections, bumps the revision, and exposes them publicly without staff fields', async () => {
    const token = await tokenFor(UserRole.SuperAdmin, 'root@example.test');
    const res = await request(app)
      .put('/v1/admin/app-settings')
      .auth(token, { type: 'bearer' })
      .send({
        revision: 0,
        support,
        faq: [{ question: { en: 'Q?' }, answer: { en: 'A.' } }],
        maintenance: { enabled: false },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.revision).toBe(1);
    expect(res.body.data.support.whatsapp).toBe('201001234567');

    const publicRes = await request(app).get('/v1/app-settings');
    expect(publicRes.body.data.revision).toBe(1);
    expect(publicRes.body.data.support.email).toBe('help@example.test');
    expect(publicRes.body.data.faq).toHaveLength(1);
    expect('links' in publicRes.body.data.support).toBe(false);
    expect(publicRes.body.data.updatedBy).toBeUndefined();
    expect(publicRes.body.data.legal).toBeUndefined();
  });

  it('rejects a stale revision with 409 and the current revision', async () => {
    const token = await tokenFor(UserRole.SuperAdmin, 'root2@example.test');
    const put = (body: object) =>
      request(app)
        .put('/v1/admin/app-settings')
        .auth(token, { type: 'bearer' })
        .send(body);
    expect((await put({ revision: 0, support })).status).toBe(200);
    const stale = await put({ revision: 0, maintenance: { enabled: true } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    // details are omitted in production, so clients must reload on 409.
    expect(
      (await AppSettings.findOne({ key: 'app' }))!.maintenance
    ).toBeUndefined();
  });

  it('validates shape, schemes and sizes, and never echoes submitted content', async () => {
    const token = await tokenFor(UserRole.SuperAdmin, 'root3@example.test');
    const put = (body: object) =>
      request(app)
        .put('/v1/admin/app-settings')
        .auth(token, { type: 'bearer' })
        .send(body);

    const bad: object[] = [
      {},
      { revision: 0 },
      { revision: -1, support },
      { revision: 0, support: { email: 'not-an-email' } },
      { revision: 0, support: { whatsapp: 'call-me' } },
      { revision: 0, support: { website: 'http://insecure.test' } },
      { revision: 0, support: { website: 'javascript:alert(1)' } },
      { revision: 0, support: { website: 'https://user:pw@example.test' } },
      { revision: 0, support: { unknown: 'x' } },
      { revision: 0, extra: 1, support },
      { revision: 0, legal: { terms: { version: '1', body: {} } } },
      { revision: 0, legal: { terms: legalDoc('1', 'x'.repeat(60_001)) } },
      { revision: 0, versioning: { minVersion: '1.2' } },
      { revision: 0, maintenance: { enabled: 'yes' } },
    ];
    for (const body of bad) expect((await put(body)).status).toBe(400);

    const secret = 'SECRET-PAYLOAD-MARKER';
    const res = await put({ revision: 0, support: { email: secret } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(await AppSettings.countDocuments({ revision: { $gt: 0 } })).toBe(0);
  });

  it('strips control characters and trims text', async () => {
    const token = await tokenFor(UserRole.SuperAdmin, 'root4@example.test');
    const res = await request(app)
      .put('/v1/admin/app-settings')
      .auth(token, { type: 'bearer' })
      .send({
        revision: 0,
        support: { hours: { en: '  Open\u0000 daily\u0007\nAll day  ' } },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.support.hours.en).toBe('Open daily\nAll day');
  });

  it('clears a section with null and keeps legal "updated" dates stable until the text changes', async () => {
    const token = await tokenFor(UserRole.SuperAdmin, 'root5@example.test');
    const put = (body: object) =>
      request(app)
        .put('/v1/admin/app-settings')
        .auth(token, { type: 'bearer' })
        .send(body);

    const first = await put({ revision: 0, legal: { terms: legalDoc('1') } });
    const stamp = first.body.data.legal.terms.updatedAt;
    expect(stamp).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 15));
    const same = await put({
      revision: 1,
      legal: { terms: legalDoc('1') },
      support,
    });
    expect(same.body.data.legal.terms.updatedAt).toBe(stamp);

    await new Promise((resolve) => setTimeout(resolve, 15));
    const changed = await put({
      revision: 2,
      legal: { terms: legalDoc('2', 'New body') },
    });
    expect(changed.body.data.legal.terms.updatedAt).not.toBe(stamp);

    const cleared = await put({ revision: 3, support: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.support).toBeUndefined();
    expect(cleared.body.data.legal.terms.version).toBe('2');
    const publicRes = await request(app).get('/v1/app-settings');
    expect(publicRes.body.data.support).toBeUndefined();
  });

  it('records an audit entry with section names and revisions, not the content', async () => {
    const token = await tokenFor(UserRole.SuperAdmin, 'root6@example.test');
    await request(app)
      .put('/v1/admin/app-settings')
      .auth(token, { type: 'bearer' })
      .send({ revision: 0, legal: { privacy: legalDoc('1', 'PRIVATE-BODY') } });

    const log = await AuditLog.findOne({
      action: AuditAction.APP_SETTINGS_UPDATED,
    }).lean<any>();
    expect(log).toBeTruthy();
    expect(log.changes).toEqual({
      sections: ['legal'],
      fromRevision: 0,
      toRevision: 1,
    });
    expect(JSON.stringify(log)).not.toContain('PRIVATE-BODY');
  });
});
