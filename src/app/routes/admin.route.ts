import { Router, Request, Response, NextFunction } from 'express';
import { adminController } from '../controllers/admin.controller';
import { planController } from '../controllers/plan.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import {
  requireAdmin,
  requireModerator,
  requireSuperAdmin,
} from '../middleware/admin.middleware';
import { UserRole } from '../models/user.model';
import { adminAnalyticsController } from '../controllers/admin-analytics.controller';

const router = Router();

// All admin routes require authentication
router.use(verifyAccessToken);

// ==================== DASHBOARD STATS (Moderator+) ====================
router.get(
  '/analytics/engagement',
  requireModerator,
  adminAnalyticsController.engagement
);
router.get(
  '/analytics/funnel',
  requireModerator,
  adminAnalyticsController.funnel
);
router.get(
  '/analytics/subscriptions',
  requireAdmin,
  adminAnalyticsController.subscriptions
);
// Plan assignments already require Admin. Filtering must not bypass that boundary.
const requireAnalyticsPlanAccess = (
  req: Request,
  res: Response,
  next: NextFunction
) =>
  Object.prototype.hasOwnProperty.call(req.query, 'plan')
    ? requireAdmin(req, res, next)
    : next();

router.get(
  '/analytics',
  requireModerator,
  requireAnalyticsPlanAccess,
  adminAnalyticsController.overview
);
router.get(
  '/analytics/records',
  requireModerator,
  requireAnalyticsPlanAccess,
  adminAnalyticsController.records
);
router.get(
  '/stats',
  requireModerator,
  adminController.getStats.bind(adminController)
);
router.get(
  '/health',
  requireModerator,
  adminController.getSystemHealth.bind(adminController)
);
router.get(
  '/health/jobs',
  requireModerator,
  adminController.getJobHealth.bind(adminController)
);

// ==================== EXPENSES (Moderator: Read, Admin: Write) ====================
router.get(
  '/expenses',
  requireModerator,
  adminController.getExpenses.bind(adminController)
);
router.get(
  '/expenses/:id',
  requireModerator,
  adminController.getExpenseById.bind(adminController)
);
router.delete(
  '/expenses/:id',
  requireAdmin,
  adminController.deleteExpense.bind(adminController)
);
router.put(
  '/expenses/:id/restore',
  requireAdmin,
  adminController.restoreExpense.bind(adminController)
);

// ==================== USERS (Moderator: Read, Admin: Write) ====================
router.get(
  '/users',
  requireModerator,
  adminController.getUsers.bind(adminController)
);
router.get(
  '/users/:id',
  requireModerator,
  adminController.getUserById.bind(adminController)
);
router.post(
  '/users',
  requireAdmin,
  adminController.createUser.bind(adminController)
);
router.put(
  '/users/:id',
  requireAdmin,
  adminController.updateUser.bind(adminController)
);
router.put(
  '/users/:id/restore',
  requireAdmin,
  adminController.restoreUser.bind(adminController)
);
router.delete(
  '/users/:id',
  requireAdmin,
  adminController.deleteUser.bind(adminController)
);

// ==================== USER PLAN MANAGEMENT (Admin+) ====================
router.put(
  '/users/:userId/plan',
  requireAdmin,
  planController.adminAssignUserPlan.bind(planController)
);

// ==================== CATEGORIES (Moderator: Read, Admin: Write) ====================
router.get(
  '/categories',
  requireModerator,
  adminController.getCategories.bind(adminController)
);
router.get(
  '/categories/:id',
  requireModerator,
  adminController.getCategoryById.bind(adminController)
);
router.post(
  '/categories',
  requireAdmin,
  adminController.createCategory.bind(adminController)
);
router.put(
  '/categories/:id',
  requireAdmin,
  adminController.updateCategory.bind(adminController)
);
router.delete(
  '/categories/:id',
  requireAdmin,
  adminController.deleteCategory.bind(adminController)
);
router.put(
  '/categories/:id/restore',
  requireAdmin,
  adminController.restoreCategory.bind(adminController)
);

// ==================== SYNC (Moderator: Read, Admin: Write) ====================
router.get(
  '/sync/operations',
  requireModerator,
  adminController.getSyncOperations.bind(adminController)
);
router.get(
  '/sync/trend',
  requireModerator,
  adminController.getSyncTrend.bind(adminController)
);
router.get(
  '/sync/conflicts',
  requireModerator,
  adminController.getSyncConflicts.bind(adminController)
);

// ==================== PLANS MANAGEMENT (SuperAdmin Only) ====================
router.get(
  '/plans',
  requireAdmin,
  planController.getAllPlans.bind(planController)
);
router.get(
  '/plans/distribution',
  requireAdmin,
  planController.getPlanDistribution.bind(planController)
);
router.post(
  '/plans',
  requireSuperAdmin,
  planController.createPlan.bind(planController)
);
router.put(
  '/plans/:id',
  requireSuperAdmin,
  planController.updatePlan.bind(planController)
);
router.delete(
  '/plans/:id',
  requireSuperAdmin,
  planController.deactivatePlan.bind(planController)
);

export default router;
