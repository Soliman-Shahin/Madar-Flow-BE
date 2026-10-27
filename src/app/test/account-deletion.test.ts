import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import {
  AuditLog,
  Category,
  DevicePushToken,
  Expense,
  User,
  UserRole,
} from '../models';
import { AuditAction } from '../models/audit-log.model';
import userRoutes from '../routes/user.route';
import { advancedEncryptionMiddleware } from '../middleware/encryption-advanced.middleware';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { verifyAccessToken } from '../middleware/access.middleware';

const app = express();
app.use(express.json());
app.use(advancedEncryptionMiddleware);
app.use('/v1/user', userRoutes);
app.get('/v1/protected', verifyAccessToken, (_req, res) => res.json({}));

const PASSWORD = 'Testing-Password-42!';

async function signedIn(extra: Record<string, unknown> = {}) {
  const user = await User.create({
    email: `delete-${new Types.ObjectId()}@example.test`,
    password: await bcrypt.hash(PASSWORD, 4),
    ...extra,
  });
  const refreshToken = await user.createSession();
  const fresh = (await User.findById(user._id))!;
  const accessToken = await fresh.generateAccessAuthToken();
  return { user: fresh, accessToken, refreshToken };
}

function deleteRequest(accessToken: string, body: Record<string, unknown>) {
  return request(app)
    .post('/v1/user/me/delete')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ data: encryptCryptoJS(body) });
}

async function seedOwnedData(userId: Types.ObjectId) {
  const category = await Category.create({
    user: userId,
    title: 'Food',
    icon: 'fast-food',
    color: '#FF0000',
    type: 'outcome',
  } as any);
  await Expense.create({
    user: userId,
    description: 'Lunch',
    amount: 10,
    category: category._id,
    date: new Date(),
  } as any);
  await DevicePushToken.create({
    userId,
    deviceId: 'device-1',
    platform: 'android',
    token: `synthetic-push-token-${userId}`,
  } as any);
  await AuditLog.create({
    actorId: userId.toString(),
    actorEmail: 'owner@example.test',
    action: AuditAction.USER_LOGIN,
    timestamp: new Date(),
  } as any);
}

describe('Self-service account deletion', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/v1/user/me/delete')
      .send({ data: encryptCryptoJS({ confirmation: 'DELETE' }) });
    expect(res.status).toBe(401);
  });

  it('requires the DELETE confirmation', async () => {
    const { user, accessToken } = await signedIn();
    const res = await deleteRequest(accessToken, { password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it('rejects a wrong password and keeps the account', async () => {
    const { user, accessToken } = await signedIn();
    const res = await deleteRequest(accessToken, {
      password: 'wrong-password',
      confirmation: 'DELETE',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_PASSWORD');
    const saved = await User.findById(user._id);
    expect(saved?._isDeleted).toBe(false);
    expect(saved?.sessions.length).toBe(1);
  });

  it('refuses staff accounts', async () => {
    const { user, accessToken } = await signedIn({ role: UserRole.Admin });
    const res = await deleteRequest(accessToken, {
      password: PASSWORD,
      confirmation: 'DELETE',
    });
    expect(res.status).toBe(403);
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it('deletes the account, owned data, and sessions; anonymises audit logs', async () => {
    const { user, accessToken, refreshToken } = await signedIn();
    const other = await signedIn();
    await seedOwnedData(user._id as Types.ObjectId);
    await seedOwnedData(other.user._id as Types.ObjectId);

    const res = await deleteRequest(accessToken, {
      password: PASSWORD,
      confirmation: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(await User.exists({ _id: user._id })).toBeNull();
    expect(await Expense.countDocuments({ user: user._id })).toBe(0);
    expect(await Category.countDocuments({ user: user._id })).toBe(0);
    expect(await DevicePushToken.countDocuments({ userId: user._id })).toBe(0);

    const logs = await AuditLog.find({ actorId: user._id.toString() }).lean();
    expect(logs.some((l) => l.action === AuditAction.USER_DELETED)).toBe(true);
    expect(logs.every((l) => !l.actorEmail)).toBe(true);

    // Other accounts are untouched.
    expect(await Expense.countDocuments({ user: other.user._id })).toBe(1);
    expect(
      await DevicePushToken.countDocuments({ userId: other.user._id })
    ).toBe(1);

    // Old credentials no longer work.
    const protectedRes = await request(app)
      .get('/v1/protected')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(protectedRes.status).toBe(401);
    const refreshRes = await request(app)
      .post('/v1/user/refresh-token')
      .send({ data: encryptCryptoJS({ refreshToken }) });
    expect(refreshRes.status).not.toBe(200);
  });

  it('lets Google accounts without a password delete with confirmation only', async () => {
    const user = await User.create({
      email: 'google-delete@example.test',
      signupType: 'google',
      socialId: 'google-subject',
    } as any);
    await user.createSession();
    const fresh = (await User.findById(user._id))!;
    const accessToken = await fresh.generateAccessAuthToken();

    const res = await deleteRequest(accessToken, { confirmation: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await User.exists({ _id: user._id })).toBeNull();
  });
});
