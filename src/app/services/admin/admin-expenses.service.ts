import { Expense } from '../../models/expense.model';
import logger from '../logger.service';
import { NotFoundError } from '../../shared/errors';
import { Request } from 'express';
import { AuditAction } from '../../models/audit-log.model';
import { safeSearchPattern, safeSortField } from '../../shared/search';
import { auditAndNotifyStaff } from '../audit-notifier.service';

export class AdminExpensesService {
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
    sortField = safeSortField(sortField, 'date', [
      'date',
      'createdAt',
      'updatedAt',
      'amount',
      'description',
      '_isDeleted',
    ]);
    try {
      const query: any = {};

      if (status === 'active') query._isDeleted = { $ne: true };
      if (status === 'deleted') query._isDeleted = true;

      const descriptionPattern = safeSearchPattern(search);
      if (descriptionPattern) {
        query.$or = [
          { description: { $regex: descriptionPattern, $options: 'i' } },
        ];
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

      if (!expense) throw new NotFoundError('Expense');
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
      if (!expense) throw new NotFoundError('Expense');

      expense._isDeleted = true;
      await expense.save();

      await auditAndNotifyStaff({
        req,
        action: AuditAction.EXPENSE_DELETED,
        notification: {
          title: 'Expense Deleted',
          message: `An expense of ${expense.amount} was deleted.`,
          type: 'warn',
        },
        targetResourceType: 'Expense',
        targetResourceId: expense._id.toString(),
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
      if (!expense) throw new NotFoundError('Expense');

      expense._isDeleted = false;
      await expense.save();

      await auditAndNotifyStaff({
        req,
        action: AuditAction.EXPENSE_RESTORED,
        notification: {
          title: 'Expense Restored',
          message: `An expense of ${expense.amount} was restored.`,
          type: 'success',
        },
        targetResourceType: 'Expense',
        targetResourceId: expense._id.toString(),
      });

      return expense;
    } catch (error) {
      logger.error('Error restoring expense:', error as Error);
      throw error;
    }
  }
}
