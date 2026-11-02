import { errorMessage } from '../shared/errors';
import { User, UserDocument } from '../models/user.model';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
import { NotificationService } from './notification.service';
import logger from './logger.service';
import { QueryFilter } from 'mongoose';
import { normalizeEmail } from '../shared/email';
import { Plan } from '../models/plan.model';
config();

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET!;
const configuredRefreshDays = parseInt(
  process.env.REFRESH_TOKEN_EXPIRY_DAYS || '10',
  10
);

export const REFRESH_TOKEN_EXPIRY_DAYS =
  Number.isFinite(configuredRefreshDays) && configuredRefreshDays > 0
    ? configuredRefreshDays
    : 10;

// Hash a refresh token before storing in DB
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class UserService {
  static async createAuthenticatedSession(
    user: UserDocument,
    authenticationMethod:
      | 'password'
      | 'google_web'
      | 'google_native'
      | 'biometric',
    platform: 'web' | 'android' | 'ios' = 'web',
    device?: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const refreshToken = await this.generateRefreshToken();
    const sessionId = await this.addRefreshToken(
      user,
      refreshToken,
      platform,
      device
    );
    const accessToken = await this.generateAccessToken(user, sessionId);
    const occurredAt = new Date().toISOString();

    try {
      await NotificationService.dispatchUserEvent({
        userId: user._id.toString(),
        event: 'security.new_login',
        dedupeKey: `security.new_login:${hashToken(refreshToken)}`,
        title: 'New login',
        message: 'A new authenticated session was created.',
        metadata: { authenticationMethod, occurredAt },
      });
    } catch (error: unknown) {
      logger.warn('Security login notification dispatch failed', {
        userId: user._id.toString(),
        error: errorMessage(error) || 'unknown error',
      });
    }

    return { accessToken, refreshToken };
  }

  /**
   * Finds a user by e-mail. Stored e-mails are lowercase (schema
   * `lowercase: true`), so the normalized address is an exact, indexed match.
   */
  static async findByEmail(
    rawEmail: unknown,
    filter: QueryFilter<UserDocument> = {},
    select?: string
  ): Promise<UserDocument | null> {
    const email = normalizeEmail(rawEmail);
    if (!email) return null;
    const query = User.findOne({ ...filter, email });
    if (select) query.select(select);
    return query.exec();
  }

  // Create a new user
  static async createUser(
    email: string,
    hashedPassword: string,
    extra: Record<string, unknown> = {}
  ): Promise<UserDocument> {
    const user = new User({
      email: normalizeEmail(email),
      password: hashedPassword,
      ...extra,
    });
    await user.save();
    return user;
  }

  // Validate user credentials
  static async validateUserCredentials(
    email: string,
    password: string
  ): Promise<UserDocument> {
    // Exclude large profile fields (e.g. base64 avatar) — loading them from
    // Atlas was adding 10-15s to every login for users with uploaded images.
    const user = await this.findByEmail(email, {}, '-image');
    if (!user) throw new Error('User not found');
    if (user._isDeleted) throw new Error('Account has been deleted');
    if (user.isActive === false) throw new Error('Account is deactivated');
    const isPasswordMatch = await bcrypt.compare(password, user.password);
    if (!isPasswordMatch) throw new Error('Invalid Password');
    return user;
  }

  // Generate access token
  static async generateAccessToken(
    user: UserDocument,
    sessionId: string
  ): Promise<string> {
    return jwt.sign({ _id: user._id, sid: sessionId }, ACCESS_TOKEN_SECRET, {
      expiresIn: '1h',
      algorithm: 'HS256',
      jwtid: crypto.randomUUID(),
    });
  }

  // Generate a secure refresh token
  static async generateRefreshToken(): Promise<string> {
    return crypto.randomBytes(64).toString('hex');
  }

  static generateSessionId(): string {
    return crypto.randomUUID();
  }

  // Add a hashed refresh credential without replacing another device session
  static async addRefreshToken(
    user: UserDocument,
    refreshToken: string,
    platform: 'web' | 'android' | 'ios' = 'web',
    device?: string
  ): Promise<string> {
    const hashed = hashToken(refreshToken);
    const sessionId = this.generateSessionId();
    const expiresAt =
      Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60;
    if (user._isDeleted || user.isActive === false)
      throw new Error('Account unavailable');
    await User.updateOne(
      { _id: user._id },
      {
        $pull: {
          sessions: { expiresAt: { $lte: Math.floor(Date.now() / 1000) } },
        },
      }
    );
    const result = await User.updateOne(
      { _id: user._id, _isDeleted: { $ne: true }, isActive: { $ne: false } },
      {
        $push: {
          sessions: {
            sessionId,
            token: hashed,
            expiresAt,
            createdAt: new Date(),
            lastAuthenticatedAt: new Date(),
            platform,
            ...(device ? { device } : {}),
          },
        },
      }
    );
    if (!result.matchedCount) throw new Error('Account unavailable');
    await this.enforceDeviceLimit(user, sessionId);
    return sessionId;
  }

  /**
   * The plan's "devices" number is how many sessions may be signed in at once.
   * Signing in is never refused: when a new session pushes the account over
   * the limit, the least recently active older sessions are ended instead, so
   * the device the person is holding right now always works.
   */
  static async enforceDeviceLimit(
    user: UserDocument,
    keepSessionId: string
  ): Promise<void> {
    try {
      const plan = await Plan.findOne({ slug: user.plan })
        .select('limits.maxDevices')
        .lean();
      const max = (plan as any)?.limits?.maxDevices;
      if (typeof max !== 'number' || max < 1) return; // unlimited / not set

      const now = Math.floor(Date.now() / 1000);
      const fresh = await User.findById(user._id).select('sessions').lean();
      const active = (fresh?.sessions || []).filter(
        (s: any) => s.expiresAt > now
      );
      if (active.length <= max) return;

      const when = (s: any) =>
        new Date(s.lastAuthenticatedAt || s.createdAt || 0).getTime();
      const ended = active
        .filter((s: any) => s.sessionId !== keepSessionId)
        .sort((a: any, b: any) => when(a) - when(b))
        .slice(0, active.length - max);
      const surplus = ended.map((s: any) => s.sessionId);
      if (!surplus.length) return;

      await User.updateOne(
        { _id: user._id },
        { $pull: { sessions: { sessionId: { $in: surplus } } } }
      );
      logger.info('Ended older sessions over the plan device limit', {
        userId: user._id.toString(),
        ended: surplus.length,
        max,
      });

      // Tell the person, in the inbox, why a device was signed out.
      const labels = ended.map(
        (s: any) => s.device || (s.platform === 'web' ? 'Web browser' : s.platform === 'ios' ? 'iPhone or iPad' : 'Android device')
      );
      await NotificationService.dispatchUserEvent({
        userId: user._id.toString(),
        event: 'security.session_limit',
        dedupeKey: `security.session_limit:${keepSessionId}`,
        title: 'Signed out on another device',
        message: `${labels.join(', ')} was signed out because your plan allows ${max} device${max === 1 ? '' : 's'} at a time.`,
        metadata: { endedDevices: labels, maxDevices: max },
      });
    } catch (error: unknown) {
      // Never let the limit check break a sign-in.
      logger.warn('Device limit check failed', {
        error: errorMessage(error) || 'unknown error',
      });
    }
  }

  // Remove a refresh token (on logout or rotation)
  static async removeRefreshToken(
    user: UserDocument,
    refreshToken: string
  ): Promise<void> {
    const hashed = hashToken(refreshToken);
    await User.updateOne(
      { _id: user._id },
      { $pull: { sessions: { token: hashed } } }
    );
  }

  // Find user by refresh token (hashed)
  static async findByRefreshToken(
    refreshToken: string
  ): Promise<UserDocument | null> {
    const hashed = hashToken(refreshToken);
    return User.findOne({ 'sessions.token': hashed });
  }

  // One MongoDB update consumes the old credential and replaces it atomically.
  static async rotateRefreshToken(
    refreshToken: string
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    if (!/^[a-f0-9]{128}$/.test(refreshToken)) return null;
    // Read-only compatibility with pre-AUTH.1 Google sessions. Rotation replaces
    // the legacy plaintext value with a hash; no issuance path writes plaintext.
    const nextToken = await this.generateRefreshToken();
    const nextSessionId = this.generateSessionId();
    const now = Math.floor(Date.now() / 1000);
    const user = await User.findOneAndUpdate(
      {
        _isDeleted: { $ne: true },
        isActive: { $ne: false },
        sessions: {
          $elemMatch: {
            token: { $in: [hashToken(refreshToken), refreshToken] },
            expiresAt: { $gt: now },
          },
        },
      },
      [
        {
          $set: {
            sessions: {
              $map: {
                input: '$sessions',
                as: 'session',
                in: {
                  $cond: [
                    {
                      $and: [
                        {
                          $in: [
                            '$$session.token',
                            [hashToken(refreshToken), refreshToken],
                          ],
                        },
                        { $gt: ['$$session.expiresAt', now] },
                      ],
                    },
                    {
                      $mergeObjects: [
                        '$$session',
                        {
                          sessionId: {
                            $ifNull: ['$$session.sessionId', nextSessionId],
                          },
                          token: hashToken(nextToken),
                          expiresAt: now + REFRESH_TOKEN_EXPIRY_DAYS * 86400,
                          createdAt: {
                            $ifNull: [
                              '$$session.createdAt',
                              new Date(now * 1000),
                            ],
                          },
                          lastAuthenticatedAt: new Date(now * 1000),
                          platform: { $ifNull: ['$$session.platform', 'web'] },
                        },
                      ],
                    },
                    '$$session',
                  ],
                },
              },
            },
          },
        },
      ],
      { returnDocument: 'after', updatePipeline: true }
    );
    if (!user) return null;
    const sessionId = user.sessions.find(
      (session) => session.token === hashToken(nextToken)
    )?.sessionId;
    if (!sessionId) return null;
    return {
      accessToken: await this.generateAccessToken(user, sessionId),
      refreshToken: nextToken,
    };
  }

  static async revokeRefreshToken(refreshToken: string): Promise<void> {
    if (!/^[a-f0-9]{128}$/.test(refreshToken)) return;
    const accepted = [hashToken(refreshToken), refreshToken];
    await User.updateOne(
      { 'sessions.token': { $in: accepted } },
      {
        $pull: { sessions: { token: { $in: accepted } } },
      }
    );
  }

  // Remove all refresh tokens (on password change, etc)
  static async removeAllRefreshTokens(user: UserDocument): Promise<void> {
    user.sessions = [];
    await user.save();
  }

  static hashPasswordResetToken(token: string): string {
    return hashToken(token);
  }
}
