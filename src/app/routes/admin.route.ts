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
import { analyticsReportScheduleController } from '../controllers/analytics-report-schedule.controller';
import { auditRequest } from '../middleware/audit.middleware';
import { AuditAction } from '../models/audit-log.model';

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
/**
 * @swagger
 * /admin/analytics/reports:
 *   get:
 *     summary: List the current Admin's scheduled analytics reports
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Schedules, current verified recipient status, and active limit
 *   post:
 *     summary: Create a weekly or monthly analytics report sent to the current Admin's verified email
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [frequency, hour, timezone, days, comparison, language]
 *             properties:
 *               frequency: { type: string, enum: [weekly, monthly] }
 *               weekday: { type: integer, minimum: 1, maximum: 7, description: ISO weekday, Monday=1 }
 *               monthDay: { type: integer, minimum: 1, maximum: 28 }
 *               hour: { type: integer, minimum: 0, maximum: 23, description: Local hour in timezone }
 *               timezone: { type: string, example: Africa/Cairo }
 *               days: { type: integer, enum: [7, 30, 90] }
 *               comparison: { type: string, enum: [previous, yearAgo] }
 *               plan: { type: string, enum: [free, pro, premium] }
 *               type: { type: string, enum: [income, outcome] }
 *               language: { type: string, enum: [en, ar] }
 *     responses:
 *       200:
 *         description: Schedule created
 *       409:
 *         description: Email verification or schedule limit requirement not met
 * /admin/analytics/reports/{id}:
 *   put:
 *     summary: Replace an owned report schedule
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [frequency, hour, timezone, days, comparison, language]
 *             properties:
 *               frequency: { type: string, enum: [weekly, monthly] }
 *               weekday: { type: integer, minimum: 1, maximum: 7 }
 *               monthDay: { type: integer, minimum: 1, maximum: 28 }
 *               hour: { type: integer, minimum: 0, maximum: 23 }
 *               timezone: { type: string, maxLength: 80 }
 *               days: { type: integer, enum: [7, 30, 90] }
 *               comparison: { type: string, enum: [previous, yearAgo] }
 *               plan: { type: string, enum: [free, pro, premium] }
 *               type: { type: string, enum: [income, outcome] }
 *               language: { type: string, enum: [en, ar] }
 *     responses:
 *       200: { description: Schedule updated }
 *       404: { description: Owned schedule not found }
 *   delete:
 *     summary: Soft-cancel an owned report schedule
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Schedule cancelled }
 *       404: { description: Owned schedule not found }
 * /admin/analytics/reports/{id}/status:
 *   patch:
 *     summary: Pause or resume an owned report schedule
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [active]
 *             properties:
 *               active: { type: boolean }
 *     responses:
 *       200: { description: Schedule status updated }
 *       404: { description: Owned schedule not found }
 */
router.get(
  '/analytics/reports',
  requireAdmin,
  analyticsReportScheduleController.list
);
router.post(
  '/analytics/reports',
  requireAdmin,
  auditRequest(AuditAction.ANALYTICS_REPORT_SCHEDULE_CREATED),
  analyticsReportScheduleController.create
);
router.put(
  '/analytics/reports/:id',
  requireAdmin,
  auditRequest(AuditAction.ANALYTICS_REPORT_SCHEDULE_UPDATED),
  analyticsReportScheduleController.update
);
router.patch(
  '/analytics/reports/:id/status',
  requireAdmin,
  auditRequest(AuditAction.ANALYTICS_REPORT_SCHEDULE_UPDATED),
  analyticsReportScheduleController.setActive
);
router.delete(
  '/analytics/reports/:id',
  requireAdmin,
  auditRequest(AuditAction.ANALYTICS_REPORT_SCHEDULE_CANCELLED),
  analyticsReportScheduleController.cancel
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
