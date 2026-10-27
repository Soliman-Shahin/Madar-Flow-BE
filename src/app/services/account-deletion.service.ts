import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { MailService } from './mail.service';
import { UserService } from './user.service';
import { Types } from 'mongoose';
import {
  AuditLog,
  BiometricCredential,
  Category,
  ConflictResolution,
  DevicePushToken,
  Expense,
  GoogleOAuthExchange,
  NotificationPreference,
  Subscription,
  SyncConflict,
  SyncMetadata,
  SyncOperation,
  TemporaryPermission,
  User,
  UserNotification,
  UserRole,
} from '../models';
import { AuditAction } from '../models/audit-log.model';
import { SyncFailure } from '../models/sync-failure.model';
import { SyncRegistration } from '../models/sync-registration.model';
import { auditLogService } from './audit-log.service';
import { getSocketService } from './socket.service';
import logger from './logger.service';

export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE';
const DELETION_LINK_TTL_MS = 30 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hashToken = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');
const isTokenShape = (token: unknown): token is string =>
  typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);

export class AccountDeletionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
  }
}

export interface AccountDeletionRequest {
  userId: string;
  password?: unknown;
  confirmation?: unknown;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Permanently deletes a consumer account and every record owned by it.
 * Audit entries are kept for security accountability but lose the e-mail.
 */
export class AccountDeletionService {
  static async deleteOwnAccount(
    request: AccountDeletionRequest
  ): Promise<void> {
    if (!Types.ObjectId.isValid(request.userId))
      throw new AccountDeletionError('User not found', 404, 'USER_NOT_FOUND');

    if (request.confirmation !== ACCOUNT_DELETION_CONFIRMATION)
      throw new AccountDeletionError(
        `Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm account deletion`,
        400,
        'CONFIRMATION_REQUIRED'
      );

    const user = await User.findOne({
      _id: request.userId,
      _isDeleted: { $ne: true },
    }).select('-image');
    if (!user)
      throw new AccountDeletionError('User not found', 404, 'USER_NOT_FOUND');

    if ((user.role || UserRole.User) !== UserRole.User)
      throw new AccountDeletionError(
        'Staff accounts must be removed by another administrator',
        403,
        'STAFF_ACCOUNT'
      );

    if (user.password) {
      const password =
        typeof request.password === 'string' ? request.password : '';
      if (!password || !(await bcrypt.compare(password, user.password)))
        throw new AccountDeletionError(
          'Password is incorrect',
          422,
          'INVALID_PASSWORD'
        );
    }

    await this.purge(user._id as Types.ObjectId, request.ipAddress, 'app');
  }

  /**
   * Public web flow, step 1: e-mail a one-time deletion link. Always resolves
   * so the caller can return the same response whether or not the account
   * exists.
   */
  static async requestDeletionByEmail(rawEmail: unknown): Promise<void> {
    const email =
      typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!EMAIL_PATTERN.test(email) || email.length > 254) return;

    const user = await UserService.findByEmail(
      email,
      { _isDeleted: { $ne: true }, isActive: { $ne: false } },
      '_id role'
    );
    if (!user || (user.role || UserRole.User) !== UserRole.User) return;

    const token = crypto.randomBytes(32).toString('hex');
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          accountDeletionTokenHash: hashToken(token),
          accountDeletionExpiresAt: new Date(Date.now() + DELETION_LINK_TTL_MS),
        },
      }
    );
    try {
      await MailService.sendAccountDeletionLink(email, token);
    } catch {
      logger.error('Account deletion link could not be sent');
    }
  }

  /** Public web flow, step 2: check a link before showing the confirm form. */
  static async isDeletionTokenValid(token: unknown): Promise<boolean> {
    if (!isTokenShape(token)) return false;
    return !!(await User.exists({
      accountDeletionTokenHash: hashToken(token),
      accountDeletionExpiresAt: { $gt: new Date() },
      _isDeleted: { $ne: true },
    }));
  }

  /** Public web flow, step 3: consume the one-time token and delete. */
  static async deleteByEmailToken(
    token: unknown,
    ipAddress?: string
  ): Promise<void> {
    if (!isTokenShape(token))
      throw new AccountDeletionError('Invalid or expired link', 400, 'INVALID_TOKEN');
    const user = await User.findOneAndUpdate(
      {
        accountDeletionTokenHash: hashToken(token),
        accountDeletionExpiresAt: { $gt: new Date() },
        _isDeleted: { $ne: true },
        role: UserRole.User,
      },
      { $unset: { accountDeletionTokenHash: '', accountDeletionExpiresAt: '' } },
      { projection: { _id: 1 } }
    );
    if (!user)
      throw new AccountDeletionError('Invalid or expired link', 400, 'INVALID_TOKEN');
    await this.purge(user._id as Types.ObjectId, ipAddress, 'web');
  }

  private static async purge(
    userId: Types.ObjectId,
    ipAddress: string | undefined,
    channel: 'app' | 'web'
  ): Promise<void> {
    const id = userId.toString();

    // Block every session and refresh credential before removing data so a
    // partial failure can never leave the account usable.
    await User.updateOne(
      { _id: userId },
      { $set: { _isDeleted: true, isActive: false, sessions: [] } }
    );

    try {
      getSocketService().disconnectUser(id);
    } catch {
      // Socket.IO is not initialised in scripts and tests.
    }

    try {
      await Promise.all([
        Expense.deleteMany({ user: userId }),
        Category.deleteMany({ user: userId }),
        Subscription.deleteMany({ user: userId }),
        SyncOperation.deleteMany({ user: userId }),
        ConflictResolution.deleteMany({ user: userId }),
        SyncConflict.deleteMany({ user: userId }),
        SyncMetadata.deleteMany({ user: userId }),
        SyncFailure.deleteMany({ user: userId }),
        SyncRegistration.deleteMany({ user: userId }),
        DevicePushToken.deleteMany({ userId }),
        BiometricCredential.deleteMany({ userId }),
        UserNotification.deleteMany({ userId }),
        NotificationPreference.deleteMany({ userId }),
        GoogleOAuthExchange.deleteMany({ userId }),
        TemporaryPermission.deleteMany({ userId }),
        AuditLog.updateMany(
          { actorId: id },
          { $unset: { actorEmail: '', userAgent: '' } }
        ),
      ]);
      await User.deleteOne({ _id: userId });
    } catch (error: any) {
      logger.error(
        'Account deletion incomplete; account remains disabled',
        error instanceof Error ? error : undefined,
        undefined,
        { userId: id }
      );
      throw new AccountDeletionError(
        'Account deletion could not be completed. Please try again later.',
        500,
        'DELETION_INCOMPLETE'
      );
    }

    try {
      await auditLogService.log({
        actorId: id,
        actorRole: UserRole.User,
        action: AuditAction.USER_DELETED,
        targetUserId: id,
        metadata: { selfService: true, channel },
        ipAddress,
        success: true,
      });
    } catch {
      // Audit failure must not resurrect or block a completed deletion.
    }
  }
}
