import { Expense } from '../models/expense.model';
import mongoose from 'mongoose';
import { getSocketService } from './socket.service';
import { Request } from 'express';
import { auditLogService } from './audit-log.service';
import { AuditAction } from '../models/audit-log.model';
import logger from './logger.service';
import { safeSearchPattern } from '../shared/search';

export class ExpenseService {
  private static async notifyAndAudit(params: {
    req?: Request;
    actorId?: string;
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
        actor: { id: params.actorId },
        resource: { type: params.targetResourceType, id: params.targetResourceId, name: params.targetResourceType },
        changes: params.changes,
        auditLogId: auditLogId
      });
    } catch (err) {
      logger.error('Failed to broadcast socket notification in notifyAndAudit', err as Error);
    }
  }

  static async createExpense(data: any, userId: string, req?: Request) {
    const expense = new Expense({
      ...data,
      user: userId,
      _syncStatus: 'synced',
      _lastModified: new Date(),
      _version: 1,
      _isDeleted: false,
    });
    const saved = await expense.save();

    await this.notifyAndAudit({
      req,
      actorId: userId,
      action: AuditAction.EXPENSE_CREATED,
      notification: {
        title: 'Expense Created',
        message: `A new expense was created.`,
        type: 'success'
      },
      changes: data,
      targetUserId: userId,
      targetResourceType: 'Expense',
      targetResourceId: saved._id.toString()
    });

    return saved;
  }

  static async getExpenses(
    userId: string,
    filters?: {
      search?: string;
      category?: string;
      categories?: string;
      type?: 'income' | 'outcome';
      startDate?: string;
      endDate?: string;
      limit?: number;
      skip?: number;
    }
  ) {
    // Build aggregation pipeline for type filter (requires category lookup)
    if (filters?.type) {
      const skip = filters?.skip || 0;
      const limit = filters?.limit || 50;

      // Build query with ObjectId conversion for aggregation
      const query: any = {
        user: new mongoose.Types.ObjectId(userId),
        _isDeleted: { $ne: true },
      };

      // Date range filter
      if (filters?.startDate || filters?.endDate) {
        query.date = {};
        if (filters.startDate) query.date.$gte = new Date(filters.startDate);
        if (filters.endDate) query.date.$lte = new Date(filters.endDate);
      }

      // Search filter
      const searchPattern = safeSearchPattern(filters?.search);
      if (searchPattern) {
        query.description = { $regex: searchPattern, $options: 'i' };
      }

      // Category filter (convert to ObjectId if present)
      if (filters?.category) {
        query.category = new mongoose.Types.ObjectId(filters.category);
      } else if (filters?.categories) {
        const categoryIds = filters.categories
          .split(',')
          .map((id) => new mongoose.Types.ObjectId(id));
        query.category = { $in: categoryIds };
      }

      const pipeline = [
        { $match: query },
        {
          $lookup: {
            from: 'categories',
            localField: 'category',
            foreignField: '_id',
            as: 'categoryDetails',
          },
        },
        { $unwind: '$categoryDetails' },
        { $match: { 'categoryDetails.type': filters.type } },
        { $sort: { date: -1 } },
        // Add a stage to replace category ID with full category object
        {
          $addFields: {
            category: '$categoryDetails',
          },
        },
        // Remove the temporary categoryDetails field
        {
          $project: {
            categoryDetails: 0,
          },
        },
        {
          $facet: {
            data: [{ $skip: skip }, { $limit: limit }],
            total: [{ $count: 'count' }],
          },
        },
      ];

      const result = await Expense.aggregate(pipeline as any);
      const data = result[0]?.data || [];
      const total = result[0]?.total[0]?.count || 0;

      // No need to populate since aggregation already included category details

      return {
        data,
        total,
        hasMore: skip + limit < total,
      };
    }

    // Standard query without type filter
    const query: any = {
      user: userId,
      _isDeleted: { $ne: true },
    };

    // Date range filter
    if (filters?.startDate || filters?.endDate) {
      query.date = {};
      if (filters.startDate) query.date.$gte = new Date(filters.startDate);
      if (filters.endDate) query.date.$lte = new Date(filters.endDate);
    }

    // Search filter
    const searchPattern = safeSearchPattern(filters?.search);
    if (searchPattern) {
      query.description = { $regex: searchPattern, $options: 'i' };
    }

    // Category filter
    if (filters?.category) {
      query.category = filters.category;
    } else if (filters?.categories) {
      query.category = { $in: filters.categories.split(',') };
    }

    const skip = filters?.skip || 0;
    const limit = filters?.limit || 50;

    const [data, total] = await Promise.all([
      Expense.find(query)
        .populate('category')
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Expense.countDocuments(query),
    ]);

    return {
      data,
      total,
      hasMore: skip + limit < total,
    };
  }

  static async getExpenseById(id: string, userId: string) {
    return Expense.findOne({
      _id: id,
      user: userId,
      _isDeleted: { $ne: true },
    }).populate('category');
  }

  static async updateExpense(id: string, data: any, userId: string, req?: Request) {
    const expense = await Expense.findOne({ _id: id, user: userId });
    if (!expense) return null;

    const currentVersion = expense._version || 0;

    const updated = await Expense.findOneAndUpdate(
      { _id: id, user: userId },
      {
        ...data,
        _syncStatus: 'synced',
        _lastModified: new Date(),
        _version: currentVersion + 1,
      },
      { new: true, runValidators: true }
    ).populate('category');

    await this.notifyAndAudit({
      req,
      actorId: userId,
      action: AuditAction.EXPENSE_UPDATED,
      notification: {
        title: 'Expense Updated',
        message: `An expense was updated.`,
        type: 'info'
      },
      changes: data,
      targetUserId: userId,
      targetResourceType: 'Expense',
      targetResourceId: id
    });

    return updated;
  }

  static async deleteExpense(id: string, userId: string, req?: Request) {
    // Soft delete for sync purposes
    const deleted = await Expense.findOneAndUpdate(
      { _id: id, user: userId },
      {
        _isDeleted: true,
        _syncStatus: 'synced',
        _lastModified: new Date(),
      },
      { new: true }
    );

    await this.notifyAndAudit({
      req,
      actorId: userId,
      action: AuditAction.EXPENSE_DELETED,
      notification: {
        title: 'Expense Deleted',
        message: `An expense was deleted.`,
        type: 'warn'
      },
      targetUserId: userId,
      targetResourceType: 'Expense',
      targetResourceId: id
    });

    return deleted;
  }

  static async getExpenseTotals(
    userId: string,
    startDate: string,
    endDate: string
  ) {
    const totals = await Expense.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(userId),
          _isDeleted: { $ne: true },
          date: {
            $gte: new Date(startDate),
            $lte: new Date(endDate),
          },
        },
      },
      {
        $lookup: {
          from: 'categories',
          localField: 'category',
          foreignField: '_id',
          as: 'categoryDetails',
        },
      },
      { $unwind: '$categoryDetails' },
      {
        $group: {
          _id: '$categoryDetails.type',
          total: { $sum: '$amount' },
        },
      },
    ]);
    const result = { income: 0, expenses: 0 };
    totals.forEach((item: any) => {
      if (item._id === 'income') result.income = item.total;
      else if (item._id === 'outcome') result.expenses = item.total;
    });
    return result;
  }
}
