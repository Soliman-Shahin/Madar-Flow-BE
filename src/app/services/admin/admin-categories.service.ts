import { User, UserRole } from '../../models/user.model';
import { Expense } from '../../models/expense.model';
import { Category } from '../../models/category.model';
import logger from '../logger.service';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { Request } from 'express';
import { AuditAction } from '../../models/audit-log.model';
import { safeSearchPattern, safeSortField } from '../../shared/search';
import { auditAndNotifyStaff } from '../audit-notifier.service';

export class AdminCategoriesService {
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
    sortField = safeSortField(sortField, 'createdAt', [
      'createdAt',
      'updatedAt',
      'title',
      'type',
      'isDefault',
      'isActive',
      'order',
      '_isDeleted',
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
      if (!category) throw new NotFoundError('Category');

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
      if (!category) throw new NotFoundError('Category');

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

      await auditAndNotifyStaff({
        req,
        action: AuditAction.CATEGORY_UPDATED,
        notification: {
          title: 'Category Updated',
          message: `Category '${category.title}' was updated.`,
          type: 'info',
        },
        changes: safeUpdate,
        targetResourceType: 'Category',
        targetResourceId: category._id.toString(),
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
      if (!category) throw new NotFoundError('Category');

      if (category.isDefault) {
        throw new ConflictError('Cannot delete a system default category');
      }

      category._isDeleted = true;
      await category.save();

      await Expense.updateMany(
        { category: category._id },
        { $set: { _isDeleted: true } }
      );

      await auditAndNotifyStaff({
        req,
        action: AuditAction.CATEGORY_DELETED,
        notification: {
          title: 'Category Deleted',
          message: `Category '${category.title}' was deleted.`,
          type: 'warn',
        },
        targetResourceType: 'Category',
        targetResourceId: category._id.toString(),
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
      if (!category) throw new NotFoundError('Category');

      category._isDeleted = false;
      await category.save();

      await Expense.updateMany(
        { category: category._id },
        { _isDeleted: false }
      );

      await auditAndNotifyStaff({
        req,
        action: AuditAction.CATEGORY_RESTORED,
        notification: {
          title: 'Category Restored',
          message: `Category '${category.title}' was restored.`,
          type: 'success',
        },
        targetResourceType: 'Category',
        targetResourceId: category._id.toString(),
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
        // Not a per-user default: isDefault marks the fallback category used by deleteOne
        // reassignment and blocks deletion, so admin-created categories must stay deletable.
        isDefault: false,
      });
      await category.save();

      await auditAndNotifyStaff({
        req,
        action: AuditAction.CATEGORY_CREATED,
        notification: {
          title: 'New Category',
          message: `Category '${category.title}' was created.`,
          type: 'success',
        },
        changes: data,
        targetResourceType: 'Category',
        targetResourceId: category._id.toString(),
      });

      return category;
    } catch (error) {
      logger.error('Error creating category:', error as Error);
      throw error;
    }
  }
}
