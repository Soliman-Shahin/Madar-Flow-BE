import { Expense } from '../models/expense.model';
import { Category } from '../models/category.model';
import { BadRequestError } from '../shared/errors';
import mongoose from 'mongoose';
import { Request } from 'express';
import { AuditAction } from '../models/audit-log.model';
import logger from './logger.service';
import { safeSearchPattern } from '../shared/search';
import { auditAndNotifyStaff } from './audit-notifier.service';

export class ExpenseService {
  /** An expense may only reference a category owned by the same user (populate would otherwise leak it). */
  private static async assertOwnCategory(categoryId: unknown, userId: string) {
    if (categoryId === undefined || categoryId === null) return;
    if (!mongoose.isValidObjectId(categoryId) || !(await Category.exists({ _id: categoryId as any, user: userId }))) {
      throw new BadRequestError('Category not found');
    }
  }

  static async createExpense(data: any, userId: string, req?: Request) {
    await this.assertOwnCategory(data?.category, userId);
    const expense = new Expense({
      ...data,
      user: userId,
      _syncStatus: 'synced',
      _lastModified: new Date(),
      _version: 1,
      _isDeleted: false,
    });
    const saved = await expense.save();

    await auditAndNotifyStaff({
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
            _serverRecordedAt: 0,
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
    await this.assertOwnCategory(data?.category, userId);
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
      { returnDocument: 'after', runValidators: true }
    ).populate('category');

    await auditAndNotifyStaff({
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
      { returnDocument: 'after' }
    );

    await auditAndNotifyStaff({
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
