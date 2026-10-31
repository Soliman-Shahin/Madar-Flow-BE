import { AdminUsersService } from './admin/admin-users.service';
import { AdminCategoriesService } from './admin/admin-categories.service';
import { AdminExpensesService } from './admin/admin-expenses.service';
import { AdminSystemService } from './admin/admin-system.service';

export type { SyncTrendDay } from './admin/admin-system.service';

/**
 * Admin Service (facade)
 *
 * Cross-user queries and system-wide aggregations for the Admin Dashboard. The implementation is
 * split by resource under ./admin/; this class keeps the original API for controllers and tests.
 */
export class AdminService {
  private readonly users = new AdminUsersService();
  private readonly categories = new AdminCategoriesService();
  private readonly expenses = new AdminExpensesService();
  private readonly system = new AdminSystemService();

  getUsers(...args: Parameters<AdminUsersService['getUsers']>) {
    return this.users.getUsers(...args);
  }

  getUserById(...args: Parameters<AdminUsersService['getUserById']>) {
    return this.users.getUserById(...args);
  }

  updateUser(...args: Parameters<AdminUsersService['updateUser']>) {
    return this.users.updateUser(...args);
  }

  deleteUser(...args: Parameters<AdminUsersService['deleteUser']>) {
    return this.users.deleteUser(...args);
  }

  restoreUser(...args: Parameters<AdminUsersService['restoreUser']>) {
    return this.users.restoreUser(...args);
  }

  createUser(...args: Parameters<AdminUsersService['createUser']>) {
    return this.users.createUser(...args);
  }

  getCategories(...args: Parameters<AdminCategoriesService['getCategories']>) {
    return this.categories.getCategories(...args);
  }

  getCategoryById(
    ...args: Parameters<AdminCategoriesService['getCategoryById']>
  ) {
    return this.categories.getCategoryById(...args);
  }

  updateCategory(
    ...args: Parameters<AdminCategoriesService['updateCategory']>
  ) {
    return this.categories.updateCategory(...args);
  }

  deleteCategory(
    ...args: Parameters<AdminCategoriesService['deleteCategory']>
  ) {
    return this.categories.deleteCategory(...args);
  }

  restoreCategory(
    ...args: Parameters<AdminCategoriesService['restoreCategory']>
  ) {
    return this.categories.restoreCategory(...args);
  }

  createCategory(
    ...args: Parameters<AdminCategoriesService['createCategory']>
  ) {
    return this.categories.createCategory(...args);
  }

  getExpenses(...args: Parameters<AdminExpensesService['getExpenses']>) {
    return this.expenses.getExpenses(...args);
  }

  getExpenseById(...args: Parameters<AdminExpensesService['getExpenseById']>) {
    return this.expenses.getExpenseById(...args);
  }

  deleteExpense(...args: Parameters<AdminExpensesService['deleteExpense']>) {
    return this.expenses.deleteExpense(...args);
  }

  restoreExpense(...args: Parameters<AdminExpensesService['restoreExpense']>) {
    return this.expenses.restoreExpense(...args);
  }

  getSystemStats(...args: Parameters<AdminSystemService['getSystemStats']>) {
    return this.system.getSystemStats(...args);
  }

  getSystemHealth(...args: Parameters<AdminSystemService['getSystemHealth']>) {
    return this.system.getSystemHealth(...args);
  }

  getSyncOperations(
    ...args: Parameters<AdminSystemService['getSyncOperations']>
  ) {
    return this.system.getSyncOperations(...args);
  }

  getSyncTrend(...args: Parameters<AdminSystemService['getSyncTrend']>) {
    return this.system.getSyncTrend(...args);
  }

  getSyncConflicts(
    ...args: Parameters<AdminSystemService['getSyncConflicts']>
  ) {
    return this.system.getSyncConflicts(...args);
  }
}

export const adminService = new AdminService();
export default adminService;
