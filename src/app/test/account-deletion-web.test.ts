import request from 'supertest';
import bcrypt from 'bcryptjs';
import { configureExpressApp } from '../app';
import { Expense, Category, User, UserRole } from '../models';
import { MailService } from '../services/mail.service';

const app = configureExpressApp();
const FOREIGN_ORIGIN = 'https://not-in-allowlist.example';

let sentTokens: string[] = [];
beforeEach(() => {
  sentTokens = [];
  jest
    .spyOn(MailService, 'sendAccountDeletionLink')
    .mockImplementation(async (_email: string, token: string) => {
      sentTokens.push(token);
    });
});
afterEach(() => jest.restoreAllMocks());

async function account(extra: Record<string, unknown> = {}) {
  return User.create({
    email: 'web-delete@example.test',
    password: await bcrypt.hash('Testing-Password-42!', 4),
    ...extra,
  });
}

const requestLink = (email: string) =>
  request(app)
    .post('/account/delete')
    .set('Origin', FOREIGN_ORIGIN)
    .type('form')
    .send({ email });

describe('Public web account deletion', () => {
  it('serves the request page with strict security headers', async () => {
    const res = await request(app).get('/account/delete');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.text).toContain('action="/account/delete"');
  });

  it('answers identically for known and unknown e-mails', async () => {
    await account();
    const known = await requestLink('Web-Delete@example.test');
    const unknown = await requestLink('nobody@example.test');
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.text).toBe(unknown.text);
    expect(sentTokens).toHaveLength(1);
  });

  it('does not send links to staff accounts', async () => {
    await account({ role: UserRole.Admin });
    await requestLink('web-delete@example.test');
    expect(sentTokens).toHaveLength(0);
  });

  it('confirms via e-mailed token, deletes data, and burns the token', async () => {
    const user = await account();
    await Category.create({
      user: user._id,
      title: 'Food',
      icon: 'fast-food',
      color: '#FF0000',
      type: 'outcome',
    } as any);
    await requestLink('web-delete@example.test');
    const token = sentTokens[0];
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const stored = await User.findById(user._id).select('+accountDeletionTokenHash');
    expect(stored!.accountDeletionTokenHash).toBeDefined();
    expect(stored!.accountDeletionTokenHash).not.toBe(token);

    // GET only renders a confirmation form; it never deletes.
    const page = await request(app).get(`/account/delete/confirm?token=${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`value="${token}"`);
    expect(await User.exists({ _id: user._id })).toBeTruthy();

    const confirm = await request(app)
      .post('/account/delete/confirm')
      .set('Origin', FOREIGN_ORIGIN)
      .type('form')
      .send({ token });
    expect(confirm.status).toBe(200);
    expect(await User.exists({ _id: user._id })).toBeNull();
    expect(await Category.countDocuments({ user: user._id })).toBe(0);
    expect(await Expense.countDocuments({ user: user._id })).toBe(0);

    const replay = await request(app)
      .post('/account/delete/confirm')
      .type('form')
      .send({ token });
    expect(replay.status).toBe(400);
  });

  it('rejects malformed and expired tokens without deleting', async () => {
    const user = await account();
    await requestLink('web-delete@example.test');
    const token = sentTokens[0];
    await User.updateOne(
      { _id: user._id },
      { $set: { accountDeletionExpiresAt: new Date(Date.now() - 1000) } }
    );

    const expired = await request(app)
      .post('/account/delete/confirm')
      .type('form')
      .send({ token });
    expect(expired.status).toBe(400);

    const malformed = await request(app)
      .post('/account/delete/confirm')
      .type('form')
      .send({ token: '<script>' });
    expect(malformed.status).toBe(400);
    expect(malformed.text).not.toContain('<script>');

    const page = await request(app).get('/account/delete/confirm?token=abc');
    expect(page.status).toBe(400);
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });
});
