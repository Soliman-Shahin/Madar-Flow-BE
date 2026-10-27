import { User, UserRole, canManageTargetRole, canAssignRole, UserDocument } from '../models/user.model';
import { Expense } from '../models/expense.model';
import { Category } from '../models/category.model';
import logger from './logger.service';
import { permissionCacheService } from './permission-cache.service';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ConflictError } from '../shared/errors';
import { UserService } from './user.service';
import { getSocketService } from './socket.service';
import { Request } from 'express';
import { auditLogService } from './audit-log.service';
import { AuditAction } from '../models/audit-log.model';
import { safeSearchPattern } from '../shared/search';

/**
 * Admin Service
 *
 * Handles cross-user queries and system-wide aggregations for the Admin Dashboard.
 * Bypasses user-scoped logic found in regular services.
 */
export class AdminService {
  private async notifyAndAudit(params: {
    req?: Request;
    actorId?: string;
    actorEmail?: string;
    actorRole?: UserRole;
    action: AuditAction;
    notification: { title: string; message: string; type: 'info' | 'success' | 'warn' | 'error' };
    changes?: Record<string, any>;
    targetUserId?: string;
    targetResourceType?: string;
    targetResourceId?: string;
  }) {
    let auditLogId: string | undefined;

    try {
      const auditLog = await auditLogService.log({
        req: params.req,
        actorId: params.actorId,
        actorEmail: params.actorEmail,
        actorRole: params.actorRole,
        action: params.action,
        targetUserId: params.targetUserId,
        targetResourceType: params.targetResourceType,
        targetResourceId: params.targetResourceId,
        changes: params.changes
      });
      auditLogId = auditLog._id.toString();
    } catch (err) {
      logger.error('Failed to log audit event in notifyAndAudit', err as Error);
    }

    try {
      const socketService = getSocketService();
      socketService.broadcastNotification({
        title: params.notification.title,
        message: params.notification.message,
        type: params.notification.type,
        action: params.action,
        actor: { id: params.actorId, email: params.actorEmail, role: params.actorRole },
        resource: { type: params.targetResourceType, id: params.targetResourceId, name: params.targetResourceType },
        changes: params.changes,
        auditLogId: auditLogId
      });
    } catch (err) {
      logger.error('Failed to broadcast socket notification in notifyAndAudit', err as Error);
    }
  }

  /**
   * Get global system statistics
   */
  async getSystemStats() {
    try {
      const [totalUsers, totalExpenses, totalCategories, recentExpenses] =
        await Promise.all([
          User.countDocuments(),
          Expense.countDocuments(),
          Category.countDocuments(),
          // Get 5 most recent expenses across all users for activity feed
          Expense.find()
            .sort({ date: -1 })
            .limit(5)
            .populate('user', 'email username currency')
            .lean(),
        ]);

      return {
        totalUsers,
        totalExpenses,
        totalCategories,
        recentExpenses,
      };
    } catch (error) {
      logger.error('Error fetching system stats:', error as Error);
      throw error;
    }
  }

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
      const user = await User.findById(userId).lean();
      if (!user) throw new Error('User not found');

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
  async updateUser(actorRole: UserRole, userId: string, updateData: Partial<UserDocument>, req?: Request) {
    try {
      const userToUpdate = await User.findById(userId);
      if (!userToUpdate) throw new Error('User not found');

      if (!canManageTargetRole(actorRole, userToUpdate.role as UserRole)) {
        throw new Error('You do not have permission to modify this user');
      }

      if (updateData.role && !canAssignRole(actorRole, updateData.role as UserRole)) {
        throw new Error(`You do not have permission to assign the role: ${updateData.role}`);
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
      
      await this.notifyAndAudit({
        req,
        actorRole,
        action: AuditAction.USER_UPDATED,
        notification: {
          title: 'User Updated',
          message: `User ${userToUpdate.email} has been updated.`,
          type: 'info'
        },
        changes: safeUpdate,
        targetUserId: userToUpdate._id.toString(),
        targetResourceType: 'User',
        targetResourceId: userToUpdate._id.toString()
      });

      return userToUpdate.toObject();
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
      if (!user) throw new Error('User not found');

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

      await this.notifyAndAudit({
        req,
        actorRole,
        action: AuditAction.USER_DELETED,
        notification: {
          title: 'User Deleted',
          message: `User ${user.email} was deleted.`,
          type: 'warn'
        },
        targetUserId: user._id.toString(),
        targetResourceType: 'User',
        targetResourceId: user._id.toString()
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
      if (!user) throw new Error('User not found');

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

      await this.notifyAndAudit({
        req,
        actorRole,
        action: AuditAction.USER_RESTORED,
        notification: {
          title: 'User Restored',
          message: `User ${user.email} was restored.`,
          type: 'success'
        },
        targetUserId: user._id.toString(),
        targetResourceType: 'User',
        targetResourceId: user._id.toString()
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
  async createUser(actorRole: UserRole, data: Partial<UserDocument>, req?: Request) {
    try {
      if (data.role && !canAssignRole(actorRole, data.role as UserRole)) {
        throw new Error(`You do not have permission to create a user with role: ${data.role}`);
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

      await this.notifyAndAudit({
        req,
        actorRole,
        action: AuditAction.USER_CREATED,
        notification: {
          title: 'New User Created',
          message: `User ${newUser.email} joined.`,
          type: 'success'
        },
        changes: data,
        targetUserId: newUser._id.toString(),
        targetResourceType: 'User',
        targetResourceId: newUser._id.toString()
      });

      return userObj;
    } catch (error) {
      logger.error('Error creating user (Admin):', error as Error);
      throw error;
    }
  }

  /**
   * List all categories with pagination, search, and status filter
   */
  async getCategories(
    page: number = 1,
    limit: number = 10,
    search?: string,
    status: string = 'active',
    sortField: string = 'createdAt',
    sortOrder: number = -1
  ) {
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
      if (status === 'deleted') {
        query._isDeleted = true;
      }

      const titlePattern = safeSearchPattern(search);
      if (titlePattern) {
        query.$or = [{ title: { $regex: titlePattern, $options: 'i' } }];
      }

      const skip = (page - 1) * limit;

      const [categories, total] = await Promise.all([
        Category.find(query)
          .sort({ isDefault: -1, [sortField]: sortOrder as 1 | -1 })
          .skip(skip)
          .limit(limit)
          .populate('user', 'email username')
          .lean(),
        Category.countDocuments(query),
      ]);

      return {
        data: categories,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('Error fetching admin categories:', error as Error);
      throw error;
    }
  }

  /**
   * Get category by ID
   */
  async getCategoryById(categoryId: string) {
    try {
      const category = await Category.findById(categoryId)
        .populate('user', 'email username')
        .lean();
      if (!category) throw new Error('Category not found');

      // Get stats for this category across all users
      const stats = await Expense.aggregate([
        { $match: { category: category._id } },
        {
          $group: {
            _id: null,
            totalSpent: { $sum: '$amount' },
            expenseCount: { $sum: 1 },
          },
        },
      ]);

      return {
        ...category,
        stats: stats[0] || { totalSpent: 0, expenseCount: 0 },
      };
    } catch (error) {
      logger.error('Error fetching admin category by id:', error as Error);
      throw error;
    }
  }

  /**
   * Update category details
   */
  async updateCategory(
    categoryId: string,
    updateData: Partial<typeof Category>,
    req?: Request
  ) {
    try {
      const category = await Category.findById(categoryId);
      if (!category) throw new Error('Category not found');

      const ALLOWED_FIELDS = ['title', 'icon', 'color', 'type', 'isActive'];
      const safeUpdate: Record<string, any> = {};
      for (const field of ALLOWED_FIELDS) {
        if ((updateData as any)[field] !== undefined) {
          safeUpdate[field] = (updateData as any)[field];
        }
      }
      if ((updateData as any)['name'] !== undefined) {
        safeUpdate['title'] = (updateData as any)['name'];
      }

      Object.assign(category, safeUpdate);
      await category.save();

      await this.notifyAndAudit({
        req,
        action: AuditAction.CATEGORY_UPDATED,
        notification: {
          title: 'Category Updated',
          message: `Category '${category.title}' was updated.`,
          type: 'info'
        },
        changes: safeUpdate,
        targetResourceType: 'Category',
        targetResourceId: category._id.toString()
      });

      return category;
    } catch (error) {
      logger.error('Error updating category:', error as Error);
      throw error;
    }
  }

  /**
   * Delete category (soft delete)
   */
  async deleteCategory(categoryId: string, req?: Request) {
    try {
      const category = await Category.findById(categoryId);
      if (!category) throw new Error('Category not found');

      if (category.isDefault) {
        throw new Error('Cannot delete a system default category');
      }

      category._isDeleted = true;
      await category.save();

      await Expense.updateMany(
        { category: category._id },
        { $set: { _isDeleted: true } }
      );

      await this.notifyAndAudit({
        req,
        action: AuditAction.CATEGORY_DELETED,
        notification: {
          title: 'Category Deleted',
          message: `Category '${category.title}' was deleted.`,
          type: 'warn'
        },
        targetResourceType: 'Category',
        targetResourceId: category._id.toString()
      });

      return category;
    } catch (error) {
      logger.error('Error soft deleting category:', error as Error);
      throw error;
    }
  }

  /**
   * Restore category
   */
  async restoreCategory(categoryId: string, req?: Request) {
    try {
      const category = await Category.findById(categoryId);
      if (!category) throw new Error('Category not found');

      category._isDeleted = false;
      await category.save();

      await Expense.updateMany(
        { category: category._id },
        { _isDeleted: false }
      );

      await this.notifyAndAudit({
        req,
        action: AuditAction.CATEGORY_RESTORED,
        notification: {
          title: 'Category Restored',
          message: `Category '${category.title}' was restored.`,
          type: 'success'
        },
        targetResourceType: 'Category',
        targetResourceId: category._id.toString()
      });

      return category;
    } catch (error) {
      logger.error('Error restoring category:', error as Error);
      throw error;
    }
  }

  /**
   * Create a system default category
   */
  async createCategory(categoryData: Partial<typeof Category>, req?: Request) {
    try {
      const adminUser = await User.findOne({ role: UserRole.Admin });
      if (!adminUser)
        throw new Error('No admin user found to assign the category to');

      const data: any = { ...categoryData };
      if (data.name && !data.title) {
        data.title = data.name;
        delete data.name;
      }

      const category = new Category({
        ...data,
        user: adminUser._id,
        isDefault: true,
      });
      await category.save();
      
      await this.notifyAndAudit({
        req,
        action: AuditAction.CATEGORY_CREATED,
        notification: {
          title: 'New Category',
          message: `Category '${category.title}' was created.`,
          type: 'success'
        },
        changes: data,
        targetResourceType: 'Category',
        targetResourceId: category._id.toString()
      });

      return category;
    } catch (error) {
      logger.error('Error creating category:', error as Error);
      throw error;
    }
  }

  /**
   * List all expenses with pagination and search/filters
   */
  async getExpenses(
    page: number = 1,
    limit: number = 10,
    search?: string,
    status: string = 'active',
    sortField: string = 'date',
    sortOrder: number = -1
  ) {
    try {
      const query: any = {};

      if (status === 'active') query._isDeleted = { $ne: true };
      if (status === 'deleted') query._isDeleted = true;

      const descriptionPattern = safeSearchPattern(search);
      if (descriptionPattern) {
        query.$or = [{ description: { $regex: descriptionPattern, $options: 'i' } }];
      }

      const skip = (page - 1) * limit;

      const [expenses, total] = await Promise.all([
        Expense.find(query)
          .sort({ [sortField]: sortOrder as 1 | -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate('user', 'email username fullName currency')
          .populate('category', 'title icon color type')
          .lean(),
        Expense.countDocuments(query),
      ]);

      return {
        data: expenses,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('Error fetching admin expenses:', error as Error);
      throw error;
    }
  }

  /**
   * Get expense by ID
   */
  async getExpenseById(expenseId: string) {
    try {
      const expense = await Expense.findById(expenseId)
        .populate('user', 'email username fullName currency')
        .populate('category', 'title icon color type')
        .lean();

      if (!expense) throw new Error('Expense not found');
      return expense;
    } catch (error) {
      logger.error('Error fetching admin expense by id:', error as Error);
      throw error;
    }
  }

  /**
   * Delete expense (soft delete)
   */
  async deleteExpense(expenseId: string, req?: Request) {
    try {
      const expense = await Expense.findById(expenseId);
      if (!expense) throw new Error('Expense not found');

      expense._isDeleted = true;
      await expense.save();

      await this.notifyAndAudit({
        req,
        action: AuditAction.EXPENSE_DELETED,
        notification: {
          title: 'Expense Deleted',
          message: `An expense of ${expense.amount} was deleted.`,
          type: 'warn'
        },
        targetResourceType: 'Expense',
        targetResourceId: expense._id.toString()
      });

      return expense;
    } catch (error) {
      logger.error('Error soft deleting expense:', error as Error);
      throw error;
    }
  }

  /**
   * Restore expense (undo soft delete)
   */
  async restoreExpense(expenseId: string, req?: Request) {
    try {
      const expense = await Expense.findById(expenseId);
      if (!expense) throw new Error('Expense not found');

      expense._isDeleted = false;
      await expense.save();

      await this.notifyAndAudit({
        req,
        action: AuditAction.EXPENSE_RESTORED,
        notification: {
          title: 'Expense Restored',
          message: `An expense of ${expense.amount} was restored.`,
          type: 'success'
        },
        targetResourceType: 'Expense',
        targetResourceId: expense._id.toString()
      });

      return expense;
    } catch (error) {
      logger.error('Error restoring expense:', error as Error);
      throw error;
    }
  }

  /**
   * Get system health metrics
   */
  async getSystemHealth() {
    try {
      const os = require('os');
      const mongoose = require('mongoose');

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = (usedMem / totalMem) * 100;

      const cpus = os.cpus();
      const cpuLoad = os.loadavg();

      const dbState = mongoose.connection.readyState;
      const dbStatus =
        dbState === 1
          ? 'Connected'
          : dbState === 2
            ? 'Connecting'
            : dbState === 0
              ? 'Disconnected'
              : 'Unknown';

      return {
        status: 'OK',
        uptime: process.uptime(),
        memory: {
          total: totalMem,
          free: freeMem,
          used: usedMem,
          usagePercent: memUsagePercent.toFixed(2),
        },
        cpu: {
          cores: cpus.length,
          model: cpus[0].model,
          loadAverage: cpuLoad,
        },
        database: {
          status: dbStatus,
          state: dbState,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error('Error fetching system health:', error as Error);
      throw error;
    }
  }
  /**
   * Get sync operations across all users
   */
  async getSyncOperations(
    page: number = 1,
    limit: number = 20,
    status?: string,
    sortField: string = 'timestamp',
    sortOrder: number = -1
  ) {
    try {
      const SyncOperation = mongoose.model('SyncOperation');
      const query: any = {};
      if (status) query.status = status;

      const skip = (page - 1) * limit;
      const [operations, total] = await Promise.all([
        SyncOperation.find(query)
          .sort({ [sortField]: sortOrder as 1 | -1 })
          .skip(skip)
          .limit(limit)
          .populate('user', 'email username')
          .lean(),
        SyncOperation.countDocuments(query),
      ]);

      return {
        data: operations,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      };
    } catch (error) {
      logger.error('Error fetching admin sync operations:', error as Error);
      throw error;
    }
  }

  /**
   * Get sync conflicts
   */
  async getSyncConflicts(
    page: number = 1,
    limit: number = 20,
    sortField: string = 'timestamp',
    sortOrder: number = -1
  ) {
    try {
      const ConflictResolution = mongoose.model('ConflictResolution');
      const skip = (page - 1) * limit;

      const [conflicts, total] = await Promise.all([
        ConflictResolution.find()
          .sort({ [sortField]: sortOrder as 1 | -1 })
          .skip(skip)
          .limit(limit)
          .populate('user', 'email username')
          .lean(),
        ConflictResolution.countDocuments(),
      ]);

      return {
        data: conflicts,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      };
    } catch (error) {
      logger.error('Error fetching admin sync conflicts:', error as Error);
      throw error;
    }
  }
}

export const adminService = new AdminService();
export default adminService;
