import request from 'supertest';
import { configureExpressApp } from '../app';
import { User, UserRole } from '../models/user.model';

const app = configureExpressApp();
const FORBIDDEN = ['"password"', '"sessions"', 'passwordResetTokenHash', 'accountDeletionTokenHash', '$2a$', '$2b$'];

async function staff(role: UserRole, email: string) {
  const user = await User.create({ email, password: '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', role });
  await user.createSession();
  return { id: String(user._id), token: await (await User.findById(user._id))!.generateAccessAuthToken() };
}

function expectClean(body: unknown) {
  const text = JSON.stringify(body);
  for (const needle of FORBIDDEN) expect(text).not.toContain(needle);
}

describe('admin user endpoints never expose credentials or session tokens', () => {
  it('list, detail and update responses are free of password hashes and sessions', async () => {
    const admin = await staff(UserRole.Admin, 'privacy-admin@example.test');
    const target = await staff(UserRole.User, 'privacy-target@example.test');
    const auth = { Authorization: `Bearer ${admin.token}` };

    const list = await request(app).get('/v1/admin/users').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.data.users?.length ?? list.body.data.data?.length ?? 1).toBeGreaterThan(0);
    expectClean(list.body);

    const detail = await request(app).get(`/v1/admin/users/${target.id}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.email).toBe('privacy-target@example.test');
    expectClean(detail.body);

    const update = await request(app).put(`/v1/admin/users/${target.id}`).set(auth).send({ isActive: true });
    expect(update.status).toBe(200);
    expectClean(update.body);
  });

  it('also hides them from a moderator', async () => {
    const mod = await staff(UserRole.Moderator, 'privacy-mod@example.test');
    await staff(UserRole.User, 'privacy-other@example.test');
    const res = await request(app).get('/v1/admin/users').set('Authorization', `Bearer ${mod.token}`);
    expect(res.status).toBe(200);
    expectClean(res.body);
  });
});
