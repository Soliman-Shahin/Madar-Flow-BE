import { Router } from 'express';
import { verifyAccessToken } from '../middleware/access.middleware';
import {
  attachPlanContext,
  checkPlanLimit,
} from '../middleware/plan.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { requireOwnership, canAccessResource } from '../middleware/resource-ownership.middleware';
import { validateRequestWithZod } from '../middleware';
import { categorySchema, categoryUpdateSchema } from '../validations/category.validation';
import { Permission } from '../types/permissions.types';
import {
  createCategory,
  deleteCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  updateOrder,
} from '../controllers';

const router = Router();

// ==================== CATEGORY ROUTES ====================
// All routes require authentication and plan context
router.use(verifyAccessToken, attachPlanContext);

// CREATE - Check permission and plan limit
router.post(
  '/create',
  requirePermission(Permission.CATEGORY_CREATE),
  checkPlanLimit('categories'),
  validateRequestWithZod(categorySchema),
  createCategory
);

// READ - Basic permission check
router.get('/list', requirePermission(Permission.CATEGORY_READ), getCategories);

router.get(
  '/:id',
  requirePermission(Permission.CATEGORY_READ),
  canAccessResource('category'),
  getCategoryById
);

// UPDATE - Permission and ownership check
router.put(
  '/update/:id',
  requirePermission(Permission.CATEGORY_UPDATE),
  requireOwnership('category'),
  validateRequestWithZod(categoryUpdateSchema),
  updateCategory
);

router.put(
  '/update-order',
  requirePermission(Permission.CATEGORY_UPDATE),
  updateOrder
);

// DELETE - Permission and ownership check
router.delete(
  '/delete/:id',
  requirePermission(Permission.CATEGORY_DELETE),
  requireOwnership('category'),
  deleteCategory
);

export default router;
