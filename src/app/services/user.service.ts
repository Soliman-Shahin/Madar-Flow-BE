import { User, UserDocument } from '../models/user.model';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
import { NotificationService } from './notification.service';
import logger from './logger.service';
import { QueryFilter } from 'mongoose';
import { maskEmail, normalizeEmail } from '../shared/email';
config();

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET!;
const configuredRefreshDays = parseInt(
  process.env.REFRESH_TOKEN_EXPIRY_DAYS || '10',
  10
);

const REFRESH_TOKEN_EXPIRY_DAYS =
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
      | 'biometric'
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const refreshToken = await this.generateRefreshToken();
    const sessionId = await this.addRefreshToken(user, refreshToken);
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
    } catch (error: any) {
      logger.warn('Security login notification dispatch failed', {
        userId: user._id.toString(),
        error: error?.message || 'unknown error',
      });
    }

    return { accessToken, refreshToken };
  }

  /**
   * Finds a user by e-mail, case-insensitively.
   *
   * The indexed lookup uses the normalized (lowercase) address. Accounts
   * created before e-mail normalization may still be stored mixed-case
   * until `npm run migrate:emails -- --apply` has run, so a miss falls back
   * to a case-insensitive collation match. If that fallback is ambiguous
   * (two accounts differing only by case), nothing is returned rather than
   * guessing. TRANSITION: remove the fallback once production is migrated
   * and the migration reports no collisions.
   */
  static async findByEmail(
    rawEmail: unknown,
    filter: QueryFilter<UserDocument> = {},
    select?: string
  ): Promise<UserDocument | null> {
    const email = normalizeEmail(rawEmail);
    if (!email) return null;

    const exactQuery = User.findOne({ ...filter, email });
    if (select) exactQuery.select(select);
    const exact = await exactQuery;
    if (exact) return exact;

    const legacyQuery = User.find({ ...filter, email })
      .collation({ locale: 'en', strength: 2 })
      .limit(2);
    if (select) legacyQuery.select(select);
    const legacy = await legacyQuery;
    if (legacy.length > 1) {
      logger.warn('Ambiguous mixed-case e-mail match; run the e-mail migration', {
        email: maskEmail(email),
      });
      return null;
    }
    return legacy[0] ?? null;
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
    refreshToken: string
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
        $push: { sessions: { sessionId, token: hashed, expiresAt } },
      }
    );
    if (!result.matchedCount) throw new Error('Account unavailable');
    return sessionId;
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
