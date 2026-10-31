import { Router } from 'express';
import {
  createExpense,
  deleteExpense,
  getExpenseById,
  getExpenses,
  getExpenseTotals,
  updateExpense,
} from '../controllers';
import { validateRequestWithZod } from '../middleware';
import { verifyAccessToken } from '../middleware/access.middleware';
import {
  attachPlanContext,
  checkPlanLimit,
} from '../middleware/plan.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import {
  requireOwnership,
  canAccessResource,
} from '../middleware/resource-ownership.middleware';
import { Permission } from '../types/permissions.types';
import { expenseSchema } from '../validations/expense.validation';

const router = Router();

// ==================== EXPENSE ROUTES ====================
// All routes require authentication and plan context
router.use(verifyAccessToken, attachPlanContext);

// CREATE - Check permission and plan limit
router.post(
  '/',
  requirePermission(Permission.EXPENSE_CREATE),
  checkPlanLimit('transactions'),
  validateRequestWithZod(expenseSchema),
  createExpense
);

// READ - Basic permission check
router.get(
  '/totals',
  requirePermission(Permission.EXPENSE_READ),
  getExpenseTotals
);

router.get('/', requirePermission(Permission.EXPENSE_READ), getExpenses);

router.get(
  '/:id',
  requirePermission(Permission.EXPENSE_READ),
  canAccessResource('expense'),
  getExpenseById
);

// UPDATE - Permission and ownership check
router.put(
  '/:id',
  requirePermission(Permission.EXPENSE_UPDATE),
  requireOwnership('expense'),
  validateRequestWithZod(expenseSchema),
  updateExpense
);

// DELETE - Permission and ownership check
router.delete(
  '/:id',
  requirePermission(Permission.EXPENSE_DELETE),
  requireOwnership('expense'),
  deleteExpense
);

export default router;
