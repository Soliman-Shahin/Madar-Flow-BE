import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../shared/helper';
import { adminService } from '../services/admin.service';
import logger from '../services/logger.service';
import { AuthenticatedRequest } from '../middleware/access.middleware';
import { UserRole } from '../models/user.model';
import { jobRuns } from '../jobs/job-runs';

/**
 * Admin Controller
 *
 * Handles administrative endpoints.
 */
export class AdminController {
  /**
   * Get global system statistics
   * GET /v1/admin/stats
   */
  async getStats(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      logger.info('Admin pulling system stats');
      const stats = await adminService.getSystemStats();
      sendSuccess(res, stats, 'System statistics retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get all users
   * GET /v1/admin/users
   */
  async getUsers(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const search = req.query.search as string;
      const status = (req.query.status as string) || 'active';
      const sortField = (req.query.sortField as string) || 'createdAt';
      const sortOrder = parseInt(req.query.sortOrder as string) || -1;

      const result = await adminService.getUsers(
        page,
        limit,
        search,
        status,
        sortField,
        sortOrder
      );
      sendSuccess(res, result, 'Users retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a new user
   * POST /v1/admin/users
   */
  async createUser(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const actorRole = authReq.user?.role as UserRole;
      const user = await adminService.createUser(actorRole, req.body, req);
      sendSuccess(res, user, 'User created successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a specific user by ID
   * GET /v1/admin/users/:id
   */
  async getUserById(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const user = await adminService.getUserById(req.params.id as string);
      sendSuccess(res, user, 'User retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update a user (e.g., role)
   * PUT /v1/admin/users/:id
   */
  async updateUser(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const actorRole = authReq.user?.role as UserRole;
      const user = await adminService.updateUser(
        actorRole,
        req.params.id as string,
        req.body,
        req
      );
      sendSuccess(res, user, 'User updated successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a user
   * DELETE /v1/admin/users/:id
   */
  async deleteUser(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const actorRole = authReq.user?.role as UserRole;
      const user = await adminService.deleteUser(actorRole, req.params.id as string, req);
      sendSuccess(res, user, 'User deleted successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Restore a user
   * PUT /v1/admin/users/:id/restore
   */
  async restoreUser(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const actorRole = authReq.user?.role as UserRole;
      const user = await adminService.restoreUser(actorRole, req.params.id as string, req);
      sendSuccess(res, user, 'User restored successfully');
    } catch (error) {
      next(error);
    }
  }
  /**
   * Get all categories
   * GET /v1/admin/categories
   */
  async getCategories(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const search = req.query.search as string;
      const status = (req.query.status as string) || 'active';
      const sortField = (req.query.sortField as string) || 'createdAt';
      const sortOrder = parseInt(req.query.sortOrder as string) || -1;

      const result = await adminService.getCategories(
        page,
        limit,
        search,
        status,
        sortField,
        sortOrder
      );
      sendSuccess(res, result, 'Categories retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a specific category by ID
   * GET /v1/admin/categories/:id
   */
  async getCategoryById(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const category = await adminService.getCategoryById(
        req.params.id as string
      );
      sendSuccess(res, category, 'Category retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update a category
   * PUT /v1/admin/categories/:id
   */
  async updateCategory(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const category = await adminService.updateCategory(
        req.params.id as string,
        req.body,
        req
      );
      sendSuccess(res, category, 'Category updated successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a system category
   * POST /v1/admin/categories
   */
  async createCategory(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const category = await adminService.createCategory(req.body, req);
      sendSuccess(res, category, 'System category created successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a category
   * DELETE /v1/admin/categories/:id
   */
  async deleteCategory(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const category = await adminService.deleteCategory(
        req.params.id as string,
        req
      );
      sendSuccess(res, category, 'Category deleted successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Restore a category
   * PUT /v1/admin/categories/:id/restore
   */
  async restoreCategory(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const category = await adminService.restoreCategory(
        req.params.id as string,
        req
      );
      sendSuccess(res, category, 'Category restored successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get all expenses
   * GET /v1/admin/expenses
   */
  async getExpenses(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const search = req.query.search as string;
      const status = (req.query.status as string) || 'active';
      const sortField = (req.query.sortField as string) || 'date';
      const sortOrder = parseInt(req.query.sortOrder as string) || -1;

      const result = await adminService.getExpenses(
        page,
        limit,
        search,
        status,
        sortField,
        sortOrder
      );
      sendSuccess(res, result, 'Expenses retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a specific expense by ID
   * GET /v1/admin/expenses/:id
   */
  async getExpenseById(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const expense = await adminService.getExpenseById(
        req.params.id as string
      );
      sendSuccess(res, expense, 'Expense retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete an expense
   * DELETE /v1/admin/expenses/:id
   */
  async deleteExpense(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const expense = await adminService.deleteExpense(req.params.id as string, req);
      sendSuccess(res, expense, 'Expense deleted successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Restore an expense
   * PUT /v1/admin/expenses/:id/restore
   */
  async restoreExpense(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const expense = await adminService.restoreExpense(req.params.id as string, req);
      sendSuccess(res, expense, 'Expense restored successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get system health metrics
   * GET /v1/admin/health
   */
  async getSystemHealth(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const health = await adminService.getSystemHealth();
      sendSuccess(res, health, 'System health retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get scheduled job health for this process
   * GET /v1/admin/health/jobs
   */
  async getJobHealth(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      sendSuccess(
        res,
        {
          processStartedAt: new Date(
            Date.now() - process.uptime() * 1000
          ).toISOString(),
          generatedAt: new Date().toISOString(),
          jobs: jobRuns.snapshot(),
        },
        'Scheduled jobs retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }
  /**
   * Get sync operations
   * GET /v1/admin/sync/operations
   */
  async getSyncOperations(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;
      const sortField = (req.query.sortField as string) || 'timestamp';
      const sortOrder = parseInt(req.query.sortOrder as string) || -1;

      const result = await adminService.getSyncOperations(
        page,
        limit,
        status,
        sortField,
        sortOrder
      );
      sendSuccess(res, result, 'Sync operations retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get the daily sync trend
   * GET /v1/admin/sync/trend
   */
  async getSyncTrend(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const days = parseInt(req.query.days as string, 10) || 14;

      const result = await adminService.getSyncTrend(days);
      sendSuccess(res, result, 'Sync trend retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get sync conflicts
   * GET /v1/admin/sync/conflicts
   */
  async getSyncConflicts(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const sortField = (req.query.sortField as string) || 'timestamp';
      const sortOrder = parseInt(req.query.sortOrder as string) || -1;

      const result = await adminService.getSyncConflicts(
        page,
        limit,
        sortField,
        sortOrder
      );
      sendSuccess(res, result, 'Sync conflicts retrieved successfully');
    } catch (error) {
      next(error);
    }
  }
}
export const adminController = new AdminController();
export default adminController;
