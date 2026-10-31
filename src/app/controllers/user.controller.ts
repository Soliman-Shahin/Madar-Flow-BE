import { Response } from 'express';
import { sendError, sendSuccess } from '../shared/helper';
import { CustomRequest } from '../types/custom-request';
import { UserService } from '../services/user.service';
import {
  clearRefreshCookie,
  setRefreshCookie,
  usesHttpOnlyRefreshCookie,
} from '../services/refresh-cookie.service';
import { User, Category } from '../models';
import bcrypt from 'bcryptjs';
import { validatePassword } from '../services/password-validation.service';

/** Auth responses expose the account, not storage internals (`__v`, soft-delete flag). */
function publicAuthUser(user: any) {
  const plain = typeof user?.toJSON === 'function' ? user.toJSON() : { ...user };
  delete plain.__v;
  delete plain._isDeleted;
  return plain;
}
import {
  recordFailedLogin,
  resetLoginAttempts,
} from '../middleware/brute-force.middleware';
import {
  ConflictError,
  InvalidCredentialsError,
  ValidationError,
} from '../shared/errors';
import logger from '../services/logger.service';
import crypto from 'crypto';
import { MailService } from '../services/mail.service';
import { BiometricCredentialService } from '../services/biometric-credential.service';
import { auditLogService } from '../services/audit-log.service';
import { AuditAction } from '../models/audit-log.model';
import {
  AccountDeletionError,
  AccountDeletionService,
} from '../services/account-deletion.service';
import {
  UserCredentials,
  UserUpdatePayload,
  UserResponse,
  UploadedFile,
  ErrorWithContext,
} from '../types/user-types';
import {
  assertNewAccountConsent,
  consentFields,
} from '../config/consent.config';

// Use higher salt rounds in production for better security
const SALT_ROUNDS =
  process.env.NODE_ENV === 'production'
    ? 12
    : Number(process.env.SALT_ROUNDS) || 10;

const requestPlatform = (req: CustomRequest): 'web' | 'android' | 'ios' => {
  const value = req.get('x-client-platform');
  return value === 'android' || value === 'ios' ? value : 'web';
};

// POST /signup
const signUp = async (req: CustomRequest, res: Response) => {
  try {
    const { email, password } = req.body as UserCredentials;
    assertNewAccountConsent(req.body);

    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      throw new ValidationError('Password validation failed', {
        errors: passwordValidation.errors,
        suggestions: passwordValidation.suggestions,
        strength: passwordValidation.strength,
        score: passwordValidation.score,
      });
    }

    // Check if the e-mail is taken, whatever password was supplied.
    if (await UserService.findByEmail(email)) {
      throw new ConflictError('Email already used');
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const user = await UserService.createUser(
      email,
      hashedPassword,
      consentFields()
    );

    // Log user creation
    logger.info('New user registered', { userId: user._id.toString(), email });

    // Create a default category for the new user
    await Category.create({
      title: 'Uncategorized',
      icon: 'help-circle-outline',
      color: '#9E9E9E',
      type: 'outcome',
      user: user._id,
      isDefault: true,
    });

    // Generate tokens
    const refreshToken = await UserService.generateRefreshToken();
    const sessionId = await UserService.addRefreshToken(
      user,
      refreshToken,
      requestPlatform(req)
    );
    const accessToken = await UserService.generateAccessToken(user, sessionId);

    const cookieAuth = usesHttpOnlyRefreshCookie(req);
    if (cookieAuth) setRefreshCookie(req, res, refreshToken);

    // Also return tokens in headers for native and legacy client compatibility.
    res.setHeader('access-token', accessToken);
    if (!cookieAuth) res.setHeader('refresh-token', refreshToken);

    sendSuccess(
      res,
      { user: publicAuthUser(user), accessToken, ...(!cookieAuth ? { refreshToken } : {}) },
      'Signup successful'
    );
  } catch (error: unknown) {
    const context = {
      ip: req.ip || req.socket.remoteAddress,
      method: req.method,
      path: req.path,
    };
    const err = error as ErrorWithContext;
    logger.error('Signup failed', undefined, context);
    // A concurrent signup can still hit the unique index; never leak it.
    if ((error as any)?.code === 11000)
      return sendError(res, 'Email already used', 409, 'CONFLICT');
    sendError(
      res,
      err.message || 'Signup failed',
      err.statusCode || 500,
      (err as any).code
    );
  }
};

// POST /users/login
const login = async (req: CustomRequest, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  try {
    const { email, password } = req.body as UserCredentials;

    // Validate user credentials
    const user = await UserService.validateUserCredentials(email, password);

    // Reset login attempts on successful login
    resetLoginAttempts(email, ip);

    // Log successful login
    logger.info('User logged in', {
      userId: user._id.toString(),
      email,
      ip,
    });

    const { accessToken, refreshToken } =
      await UserService.createAuthenticatedSession(
        user,
        'password',
        requestPlatform(req)
      );

    const cookieAuth = usesHttpOnlyRefreshCookie(req);
    if (cookieAuth) setRefreshCookie(req, res, refreshToken);

    // Also return tokens in headers for native and legacy client compatibility.
    res.setHeader('access-token', accessToken);
    if (!cookieAuth) res.setHeader('refresh-token', refreshToken);

    sendSuccess(
      res,
      { user: publicAuthUser(user), accessToken, ...(!cookieAuth ? { refreshToken } : {}) },
      'Login successful'
    );
  } catch (error: unknown) {
    // Record failed login attempt
    const email = req.body?.email;
    if (email) {
      recordFailedLogin(email, ip);
    }

    const context = {
      ip: req.ip || req.socket.remoteAddress,
      method: req.method,
      path: req.path,
    };
    const err = error as Error;
    logger.warn('Login failed', context, {
      email,
      reason: err.message || 'Unknown error',
    });

    // Send error response instead of throwing
    return sendError(
      res,
      'Invalid email or password',
      401,
      'INVALID_CREDENTIALS'
    );
  }
};

// GET /users/me/access-token
const userAccessToken = async (req: CustomRequest, res: Response) => {
  try {
    if (!req.userObject) {
      return sendError(res, 'User not found in request', 401);
    }
    const session = req.userObject.sessions.find(
      (candidate) =>
        candidate.token ===
          crypto
            .createHash('sha256')
            .update(req.refreshToken || '')
            .digest('hex') && candidate.sessionId
    );
    if (!session?.sessionId)
      return sendError(
        res,
        'Invalid or expired session',
        401,
        'SESSION_INVALID'
      );
    const accessToken = await UserService.generateAccessToken(
      req.userObject,
      session.sessionId
    );
    // Mirror in header for clients that read headers
    res.setHeader('access-token', accessToken);
    sendSuccess(res, { accessToken }, 'Access token generated successfully');
  } catch (error: unknown) {
    const err = error as Error;
    sendError(res, err.message || 'An error occurred');
  }
};

// POST /refresh-token
const refreshToken = async (req: CustomRequest, res: Response) => {
  try {
    const cookieAuth = usesHttpOnlyRefreshCookie(req);
    const credential = cookieAuth
      ? req.cookies?.mf_refresh || req.body?.refreshToken
      : req.body?.refreshToken;
    if (typeof credential !== 'string') {
      if (cookieAuth) clearRefreshCookie(req, res);
      return sendError(res, 'Refresh token required', 400);
    }
    const tokens = await UserService.rotateRefreshToken(credential);
    if (!tokens) {
      if (cookieAuth) clearRefreshCookie(req, res);
      return sendError(
        res,
        'Invalid or expired session',
        401,
        'SESSION_INVALID'
      );
    }
    if (cookieAuth) setRefreshCookie(req, res, tokens.refreshToken);
    res.setHeader('access-token', tokens.accessToken);
    if (!cookieAuth) res.setHeader('refresh-token', tokens.refreshToken);
    const cookieUser = cookieAuth
      ? await UserService.findByRefreshToken(tokens.refreshToken)
      : null;
    const safeUser = cookieUser
      ? (({ password, sessions, ...user }) => user)(cookieUser.toJSON())
      : null;
    return sendSuccess(
      res,
      cookieAuth
        ? { accessToken: tokens.accessToken, user: safeUser }
        : tokens,
      'Token refreshed successfully'
    );
  } catch {
    return sendError(res, 'Session renewal temporarily unavailable', 503);
  }
};

const logout = async (req: CustomRequest, res: Response) => {
  try {
    const cookieAuth = usesHttpOnlyRefreshCookie(req);
    const credential = cookieAuth
      ? req.cookies?.mf_refresh || req.body?.refreshToken
      : req.body?.refreshToken;
    if (typeof credential !== 'string') {
      if (cookieAuth) clearRefreshCookie(req, res);
      return sendError(res, 'Refresh token required', 400);
    }
    await UserService.revokeRefreshToken(credential);
    if (cookieAuth) clearRefreshCookie(req, res);
    return sendSuccess(res, {}, 'Logged out');
  } catch {
    return sendError(res, 'Session revocation temporarily unavailable', 503);
  }
};

const requestPasswordReset = async (req: CustomRequest, res: Response) => {
  const generic =
    'If an account exists for that email, a password reset link has been sent.';
  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    if (!email) return sendSuccess(res, {}, generic);
    const user = await UserService.findByEmail(email, {
      _isDeleted: { $ne: true },
      isActive: { $ne: false },
    });
    if (user) {
      const raw = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 20 * 60 * 1000);
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            passwordResetTokenHash: UserService.hashPasswordResetToken(raw),
            passwordResetExpiresAt: expires,
            passwordResetRequestedAt: new Date(),
          },
        }
      );
      try {
        await MailService.sendPasswordReset(email, raw);
      } catch {
        await User.updateOne(
          { _id: user._id },
          {
            $unset: {
              passwordResetTokenHash: 1,
              passwordResetExpiresAt: 1,
              passwordResetRequestedAt: 1,
            },
          }
        );
      }
    }
    return sendSuccess(res, {}, generic);
  } catch {
    return sendSuccess(res, {}, generic);
  }
};

const resetPassword = async (req: CustomRequest, res: Response) => {
  try {
    const { token, password } = req.body || {};
    if (
      typeof token !== 'string' ||
      typeof password !== 'string' ||
      !validatePassword(password).isValid
    )
      return sendError(
        res,
        'Invalid or expired reset link',
        400,
        'PASSWORD_RESET_INVALID'
      );
    const user = await User.findOne({
      passwordResetTokenHash: UserService.hashPasswordResetToken(token),
      passwordResetExpiresAt: { $gt: new Date() },
      _isDeleted: { $ne: true },
      isActive: { $ne: false },
    }).select('+passwordResetTokenHash +passwordResetExpiresAt');
    if (!user)
      return sendError(
        res,
        'Invalid or expired reset link',
        400,
        'PASSWORD_RESET_INVALID'
      );
    user.password = await bcrypt.hash(password, SALT_ROUNDS);
    user.sessions = [];
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpiresAt = undefined;
    user.passwordResetRequestedAt = undefined;
    await BiometricCredentialService.revokeAllForUser(
      user._id.toString(),
      'password_reset'
    );
    try {
      await auditLogService.log({
        req,
        action: AuditAction.BIOMETRIC_RESET_REVOKED,
        targetUserId: user._id.toString(),
        metadata: { reason: 'password_reset' },
      });
    } catch {
      /* do not expose secrets or fail a completed reset */
    }
    await user.save();
    return sendSuccess(res, {}, 'Password reset successfully');
  } catch {
    return sendError(
      res,
      'Unable to reset password right now',
      503,
      'PASSWORD_RESET_UNAVAILABLE'
    );
  }
};

export {
  login,
  signUp,
  userAccessToken,
  refreshToken,
  logout,
  requestPasswordReset,
  resetPassword,
};

// GET /user/me
const getMe = async (
  req: CustomRequest & { user_id?: string },
  res: Response
) => {
  try {
    const userId = req.user_id;
    if (!userId) return sendError(res, 'Unauthorized', 401);
    const user = await User.findById(userId);
    if (!user) return sendError(res, 'User not found', 404);
    // Normalize salary in response to array shape for legacy documents
    const obj = user.toJSON() as unknown as UserResponse;
    if (typeof obj.salary === 'number') {
      obj.salary = [{ label: 'Salary', amount: obj.salary }];
    }
    return sendSuccess(res, obj, 'User fetched successfully');
  } catch (error: unknown) {
    const err = error as Error;
    return sendError(res, err.message || 'Failed to fetch user');
  }
};

// PUT /user/me
const updateMe = async (
  req: CustomRequest & { user_id?: string },
  res: Response
) => {
  try {
    const userId = req.user_id;
    if (!userId) return sendError(res, 'Unauthorized', 401);

    // Explicitly remove email from the update payload to prevent changes
    if ((req.body as any).email) {
      delete (req.body as any).email;
    }

    // Normalize: if fullName is provided without username, use it as username
    if ((req.body as any)?.fullName && !(req.body as any)?.username) {
      (req.body as any).username = (req.body as any).fullName;
    }

    const allowed: Array<keyof typeof req.body> = [
      // We deliberately omit 'fullName' from persistence to standardize on 'username'
      'phone',
      'salary',
      'currency',
      'username',
      'image',
    ];

    const updatePayload: Partial<UserUpdatePayload> = {};
    // Coerce numeric salary into array shape if provided
    if (req.body && req.body.salary !== undefined) {
      const incoming = req.body.salary as
        | number
        | Array<{ label: string; amount: number }>;
      if (typeof incoming === 'number') {
        (req.body as any).salary = [{ label: 'Salary', amount: incoming }];
      }
    }
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        (updatePayload as any)[key] = req.body[key];
      }
    }

    const updated = await User.findByIdAndUpdate(userId, updatePayload, {
      returnDocument: 'after',
      runValidators: true,
    });

    if (!updated) return sendError(res, 'User not found', 404);
    return sendSuccess(res, updated, 'User updated successfully');
  } catch (error: unknown) {
    const err = error as Error;
    return sendError(res, err.message || 'Failed to update user');
  }
};

export { getMe, updateMe };

// POST /user/me/avatar
const uploadAvatar = async (
  req: CustomRequest & {
    user_id?: string;
    file?: UploadedFile;
    files?: UploadedFile[];
  },
  res: Response
) => {
  try {
    const userId = req.user_id;
    if (!userId) return sendError(res, 'Unauthorized', 401);
    let file: UploadedFile | undefined = req.file;
    if (!file && Array.isArray(req.files) && (req as any).files.length > 0) {
      file = (req as any).files[0];
    }
    if (!file) return sendError(res, 'No file uploaded', 400);

    // Convert to Data URL for quick dev. In production, store to object storage or disk.
    const base64 = file.buffer.toString('base64');
    const dataUrl = `data:${file.mimetype};base64,${base64}`;

    const updated = await User.findByIdAndUpdate(
      userId,
      { image: dataUrl },
      { returnDocument: 'after' }
    );
    if (!updated) return sendError(res, 'User not found', 404);

    // Return in a shape the frontend can understand
    return sendSuccess(
      res,
      { avatarUrl: updated.image, user: updated },
      'Avatar updated'
    );
  } catch (error: unknown) {
    const err = error as Error;
    return sendError(res, err.message || 'Failed to upload avatar');
  }
};

export { uploadAvatar };

const deleteMe = async (req: CustomRequest, res: Response) => {
  const userId = req.user_id;
  if (!userId) return sendError(res, 'Unauthorized', 401);
  try {
    await AccountDeletionService.deleteOwnAccount({
      userId,
      password: req.body?.password,
      confirmation: req.body?.confirmation,
      ipAddress: req.ip,
    });
    return sendSuccess(res, {}, 'Account deleted');
  } catch (error: unknown) {
    if (error instanceof AccountDeletionError)
      return sendError(res, error.message, error.statusCode, error.code);
    logger.error('Account deletion failed');
    return sendError(res, 'Account deletion failed', 500);
  }
};

export { deleteMe };
