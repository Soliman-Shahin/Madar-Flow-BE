import express from 'express';
import request from 'supertest';
import { User, UserRole } from '../models/user.model';
import {
  TelemetryEvent,
  TELEMETRY_RETENTION_DAYS,
} from '../models/telemetry-event.model';
import {
  telemetryRoutes,
  telemetryAdminRoutes,
} from '../routes/telemetry.route';
import { telemetryService } from '../services/telemetry.service';
import { enhancedErrorHandler } from '../middleware/error-handler-enhanced';

const app = express();
app.use(express.json());
app.use('/v1/telemetry', telemetryRoutes);
app.use('/v1/admin/telemetry', telemetryAdminRoutes);
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

const INSTALL = '3f2b8c1e-9d4a-4e7b-8a61-5c0d2f7e9b11';
const OTHER_INSTALL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const batch = (over: Record<string, unknown> = {}) => ({
  installId: INSTALL,
  appVersion: '1.1.0',
  platform: 'android',
  lang: 'ar',
  events: [{ name: 'app_open' }, { name: 'transaction_added' }],
  ...over,
});

describe('Telemetry events (anonymous, opt-in)', () => {
  it('requires a signed-in session', async () => {
    const res = await request(app).post('/v1/telemetry/events').send(batch());
    expect(res.status).toBe(401);
    expect(await TelemetryEvent.countDocuments()).toBe(0);
  });

  it('stores events without any account reference', async () => {
    const token = await tokenFor(UserRole.User, 'telemetry-user@example.test');
    const res = await request(app)
      .post('/v1/telemetry/events')
      .auth(token, { type: 'bearer' })
      .send(batch());
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ accepted: 2 });

    const docs = await TelemetryEvent.find().lean();
    expect(docs).toHaveLength(2);
    const keys = new Set(docs.flatMap((d) => Object.keys(d)));
    // Nothing that identifies a person or device can be on the document.
    for (const forbidden of ['user', 'userId', 'email', 'ip', 'userAgent']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(docs[0]).toMatchObject({
      installId: INSTALL,
      appVersion: '1.1.0',
      platform: 'android',
      lang: 'ar',
    });
  });

  it('rejects unknown keys, unknown events and malformed ids instead of storing them', async () => {
    const token = await tokenFor(UserRole.User, 'strict@example.test');
    const send = (body: unknown) =>
      request(app)
        .post('/v1/telemetry/events')
        .auth(token, { type: 'bearer' })
        .send(body as object);

    expect((await send(batch({ userId: 'abc' }))).status).toBe(400);
    expect((await send(batch({ email: 'a@b.c' }))).status).toBe(400);
    expect(
      (await send(batch({ events: [{ name: 'transaction_amount_9000' }] }))).status
    ).toBe(400);
    expect(
      (await send(batch({ events: [{ name: 'app_open', note: 'free text' }] })))
        .status
    ).toBe(400);
    expect((await send(batch({ installId: 'not-a-uuid' }))).status).toBe(400);
    expect((await send(batch({ platform: 'windows' }))).status).toBe(400);
    expect((await send(batch({ events: [] }))).status).toBe(400);
    expect(
      (
        await send(
          batch({ events: Array.from({ length: 26 }, () => ({ name: 'app_open' })) })
        )
      ).status
    ).toBe(400);
    expect(await TelemetryEvent.countDocuments()).toBe(0);
  });

  it('does not trust client clocks outside a narrow window', async () => {
    const now = new Date('2026-10-30T12:00:00Z');
    await telemetryService.record(
      {
        installId: INSTALL,
        appVersion: '1.1.0',
        platform: 'web',
        lang: 'en',
        events: [
          { name: 'app_open', ts: now.getTime() - 60_000 }, // fine
          { name: 'app_open', ts: now.getTime() - 30 * 24 * 3600 * 1000 }, // too old
          { name: 'app_open', ts: now.getTime() + 24 * 3600 * 1000 }, // future
          { name: 'app_open' }, // none
        ],
      },
      now
    );
    const times = (await TelemetryEvent.find().sort({ at: 1 }).lean()).map((d) =>
      d.at.getTime()
    );
    expect(times).toEqual([
      now.getTime() - 60_000,
      now.getTime(),
      now.getTime(),
      now.getTime(),
    ]);
  });

  it('lets an install erase its own events and nothing else', async () => {
    const token = await tokenFor(UserRole.User, 'erase@example.test');
    const post = (installId: string) =>
      request(app)
        .post('/v1/telemetry/events')
        .auth(token, { type: 'bearer' })
        .send(batch({ installId }));
    await post(INSTALL);
    await post(OTHER_INSTALL);

    const res = await request(app)
      .delete('/v1/telemetry/events')
      .auth(token, { type: 'bearer' })
      .send({ installId: INSTALL });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: 2 });
    const left = await TelemetryEvent.find().lean();
    expect(left.every((d) => d.installId === OTHER_INSTALL)).toBe(true);

    const bad = await request(app)
      .delete('/v1/telemetry/events')
      .auth(token, { type: 'bearer' })
      .send({ installId: INSTALL, extra: true });
    expect(bad.status).toBe(400);
  });

  it('expires events automatically', async () => {
    const indexes = await TelemetryEvent.collection.indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl?.key).toEqual({ at: 1 });
    expect(ttl?.expireAfterSeconds).toBe(TELEMETRY_RETENTION_DAYS * 24 * 60 * 60);
  });

  it('limits how often one account can report', async () => {
    const token = await tokenFor(UserRole.User, 'flood@example.test');
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (
        await request(app)
          .post('/v1/telemetry/events')
          .auth(token, { type: 'bearer' })
          .send(batch({ events: [{ name: 'app_open' }] }))
      ).status;
    }
    expect(last).toBe(429);
  });

  describe('dashboard summary', () => {
    it('is limited to Moderator and above', async () => {
      const user = await tokenFor(UserRole.User, 'plain@example.test');
      const mod = await tokenFor(UserRole.Moderator, 'mod@example.test');
      expect(
        (
          await request(app)
            .get('/v1/admin/telemetry/summary')
            .auth(user, { type: 'bearer' })
        ).status
      ).toBe(403);
      expect(
        (
          await request(app)
            .get('/v1/admin/telemetry/summary')
            .auth(mod, { type: 'bearer' })
        ).status
      ).toBe(200);
      expect((await request(app).get('/v1/admin/telemetry/summary')).status).toBe(401);
    });

    it('aggregates counts, installs and activation, and validates the window', async () => {
      const now = new Date();
      const rec = (installId: string, names: string[]) =>
        telemetryService.record(
          {
            installId,
            appVersion: '1.1.0',
            platform: 'android',
            lang: 'ar',
            events: names.map((name) => ({ name: name as any })),
          },
          now
        );
      await rec(INSTALL, ['app_open', 'transaction_added', 'transaction_added']);
      await rec(OTHER_INSTALL, ['app_open']);

      const mod = await tokenFor(UserRole.Moderator, 'summary@example.test');
      const res = await request(app)
        .get('/v1/admin/telemetry/summary?days=7')
        .auth(mod, { type: 'bearer' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        days: 7,
        optedInInstalls: 2,
        installsWithTransaction: 1,
        totals: { app_open: 2, transaction_added: 2 },
      });
      const day = now.toISOString().slice(0, 10);
      expect(res.body.data.perDay).toEqual(
        expect.arrayContaining([
          { day, name: 'app_open', count: 2 },
          { day, name: 'transaction_added', count: 2 },
        ])
      );

      for (const q of ['days=0', 'days=91', 'days=abc', 'days=7&x=1']) {
        expect(
          (
            await request(app)
              .get('/v1/admin/telemetry/summary?' + q)
              .auth(mod, { type: 'bearer' })
          ).status
        ).toBe(400);
      }
    });
  });
});
