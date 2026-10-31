import {
  User,
  UserRole,
  canManageTargetRole,
  canAssignRole,
  UserDocument,
} from '../../models/user.model';
import { Expense } from '../../models/expense.model';
import { Category } from '../../models/category.model';
import logger from '../logger.service';
import { permissionCacheService } from '../permission-cache.service';
import bcrypt from 'bcryptjs';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { UserService } from '../user.service';
import { Request } from 'express';
import { AuditAction } from '../../models/audit-log.model';
import { safeSearchPattern, safeSortField } from '../../shared/search';
import { auditAndNotifyStaff } from '../audit-notifier.service';

/** Credentials and one-time-token hashes that must never leave the server, even to staff. */
const PRIVATE_USER_FIELDS = [
  'password',
  'sessions',
  'passwordResetTokenHash',
  'passwordResetExpiresAt',
  'passwordResetRequestedAt',
  'accountDeletionTokenHash',
  'accountDeletionExpiresAt',
] as const;
const PRIVATE_USER_PROJECTION = PRIVATE_USER_FIELDS.map(
  (field) => `-${field}`
).join(' ');

function stripPrivateUserFields<T extends Record<string, any>>(user: T): T {
  const copy: Record<string, any> = { ...user };
  for (const field of PRIVATE_USER_FIELDS) delete copy[field];
  return copy as T;
}

export class AdminUsersService {
  /**
   * List all users with pagination, search, and status filter
   */
  async getUsers(
    page: number = 1,
    limit: number = 10,
    search?: string,
    status: string = 'active',
    sortField: string = 'createdAt',
    sortOrder: number = -1
  ) {
    sortField = safeSortField(sortField, 'createdAt', [
      'createdAt',
      'updatedAt',
      'email',
      'role',
      'plan',
      'isActive',
      '_isDeleted',
      'emailVerified',
    ]);
    try {
      const query: any = {};

      if (status === 'active') {
        query.isActive = { $ne: false };
        query._isDeleted = { $ne: true };
      }
      if (status === 'inactive') {
        query.isActive = false;
        query._isDeleted = { $ne: true };
      }
      if (status === 'deleted') query._isDeleted = true;

      const userPattern = safeSearchPattern(search);
      if (userPattern) {
        query.$or = [
          { email: { $regex: userPattern, $options: 'i' } },
          { username: { $regex: userPattern, $options: 'i' } },
          { fullName: { $regex: userPattern, $options: 'i' } },
        ];
      }

      const skip = (page - 1) * limit;

      const [users, total] = await Promise.all([
        User.find(query)
          .select(PRIVATE_USER_PROJECTION)
          .sort({ [sortField]: sortOrder as 1 | -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        User.countDocuments(query),
      ]);

      return {
        data: users,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('Error fetching admin users:', error as Error);
      throw error;
    }
  }

  /**
   * Get user by ID with their stats
   */
  async getUserById(userId: string) {
    try {
      const user = await User.findById(userId)
        .select(PRIVATE_USER_PROJECTION)
        .lean();
      if (!user) throw new NotFoundError('User');

      const stats = await Expense.aggregate([
        { $match: { user: user._id } },
        {
          $group: {
            _id: null,
            totalSpent: { $sum: '$amount' },
            expenseCount: { $sum: 1 },
          },
        },
      ]);

      return {
        ...user,
        stats: stats[0] || { totalSpent: 0, expenseCount: 0 },
      };
    } catch (error) {
      logger.error('Error fetching admin user by id:', error as Error);
      throw error;
    }
  }

  /**
   * Update user details (e.g., role, plan, permissions)
   * Note: For plan assignment with subscription tracking, use planService.assignPlan()
   */
  async updateUser(
    actorRole: UserRole,
    userId: string,
    updateData: Partial<UserDocument>,
    req?: Request
  ) {
    try {
      const userToUpdate = await User.findById(userId);
      if (!userToUpdate) throw new NotFoundError('User');

      if (!canManageTargetRole(actorRole, userToUpdate.role as UserRole)) {
        throw new Error('You do not have permission to modify this user');
      }

      if (
        updateData.role &&
        !canAssignRole(actorRole, updateData.role as UserRole)
      ) {
        throw new Error(
          `You do not have permission to assign the role: ${updateData.role}`
        );
      }

      const ALLOWED_FIELDS = [
        'role',
        'fullName',
        'phone',
        'currency',
        'username',
        'isActive',
        '_isDeleted',
        'plan',
        'planExpiresAt',
        'planStartedAt',
        'customPermissions',
      ];
      const safeUpdate: Record<string, any> = {};
      for (const field of ALLOWED_FIELDS) {
        if ((updateData as any)[field] !== undefined) {
          safeUpdate[field] = (updateData as any)[field];
        }
      }

      Object.assign(userToUpdate, safeUpdate);
      await userToUpdate.save();

      if (safeUpdate.role || safeUpdate.plan || safeUpdate.customPermissions) {
        permissionCacheService.invalidateUser(userId);
        logger.debug(`Invalidated permission cache for user ${userId}`);
      }

      await auditAndNotifyStaff({
        req,
        actorRole,
        action: AuditAction.USER_UPDATED,
        notification: {
          title: 'User Updated',
          message: `User ${userToUpdate.email} has been updated.`,
          type: 'info',
        },
        changes: safeUpdate,
        targetUserId: userToUpdate._id.toString(),
        targetResourceType: 'User',
        targetResourceId: userToUpdate._id.toString(),
      });

      return stripPrivateUserFields(userToUpdate.toObject());
    } catch (error) {
      logger.error('Error updating user:', error as Error);
      throw error;
    }
  }

  /**
   * Delete user (soft delete)
   */
  async deleteUser(actorRole: UserRole, userId: string, req?: Request) {
    try {
      const user = await User.findById(userId);
      if (!user) throw new NotFoundError('User');

      if (!canManageTargetRole(actorRole, user.role as UserRole)) {
        throw new Error('You do not have permission to delete this user');
      }

      user._isDeleted = true;
      await user.save();

      await Expense.updateMany({ user: user._id }, { _isDeleted: true });
      await Category.updateMany(
        { user: user._id, isDefault: false },
        { _isDeleted: true }
      );

      await auditAndNotifyStaff({
        req,
        actorRole,
        action: AuditAction.USER_DELETED,
        notification: {
          title: 'User Deleted',
          message: `User ${user.email} was deleted.`,
          type: 'warn',
        },
        targetUserId: user._id.toString(),
        targetResourceType: 'User',
        targetResourceId: user._id.toString(),
      });

      return user;
    } catch (error) {
      logger.error('Error soft deleting user:', error as Error);
      throw error;
    }
  }

  /**
   * Restore user (undo soft delete)
   */
  async restoreUser(actorRole: UserRole, userId: string, req?: Request) {
    try {
      const user = await User.findById(userId);
      if (!user) throw new NotFoundError('User');

      if (!canManageTargetRole(actorRole, user.role as UserRole)) {
        throw new Error('You do not have permission to restore this user');
      }

      user._isDeleted = false;
      await user.save();

      await Expense.updateMany({ user: user._id }, { _isDeleted: false });
      await Category.updateMany(
        { user: user._id, isDefault: false },
        { _isDeleted: false }
      );

      await auditAndNotifyStaff({
        req,
        actorRole,
        action: AuditAction.USER_RESTORED,
        notification: {
          title: 'User Restored',
          message: `User ${user.email} was restored.`,
          type: 'success',
        },
        targetUserId: user._id.toString(),
        targetResourceType: 'User',
        targetResourceId: user._id.toString(),
      });

      return user;
    } catch (error) {
      logger.error('Error restoring user:', error as Error);
      throw error;
    }
  }

  /**
   * Create a new user (Admin action)
   */
  async createUser(
    actorRole: UserRole,
    data: Partial<UserDocument>,
    req?: Request
  ) {
    try {
      if (data.role && !canAssignRole(actorRole, data.role as UserRole)) {
        throw new Error(
          `You do not have permission to create a user with role: ${data.role}`
        );
      }

      const existingUser = await UserService.findByEmail((data as any).email);
      if (existingUser) {
        throw new ConflictError('User with this email already exists');
      }

      const hashedPassword = await bcrypt.hash(
        (data as any).password as string,
        10
      );

      const newUser = new User({
        ...data,
        password: hashedPassword,
        emailVerified: true,
      });

      await newUser.save();

      const userObj = newUser.toObject();
      delete (userObj as any).password;
      delete (userObj as any).sessions;

      await auditAndNotifyStaff({
        req,
        actorRole,
        action: AuditAction.USER_CREATED,
        notification: {
          title: 'New User Created',
          message: `User ${newUser.email} joined.`,
          type: 'success',
        },
        changes: data,
        targetUserId: newUser._id.toString(),
        targetResourceType: 'User',
        targetResourceId: newUser._id.toString(),
      });

      return userObj;
    } catch (error) {
      logger.error('Error creating user (Admin):', error as Error);
      throw error;
    }
  }
}
