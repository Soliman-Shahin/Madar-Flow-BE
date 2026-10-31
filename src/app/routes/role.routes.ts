import { Router } from 'express';
import { roleController } from '../controllers/role.controller';
import { attachPlanContext } from '../middleware/plan.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { Permission } from '../types/permissions.types';
import { validateRequestWithZod } from '../middleware/validation.middleware';
import { z } from 'zod';
import { verifyAccessToken } from '../middleware';
import { Role } from '../models/role.model';
import { sendError } from '../shared/helper';
import type { NextFunction, Request, Response } from 'express';
import { requireRole } from '../middleware/admin.middleware';
import { UserRole } from '../models/user.model';

const router = Router();

// Validation schemas
const createRoleSchema = z.object({
  name: z.string().min(2).max(50),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-z0-9-]+$/,
      'Slug can only contain lowercase letters, numbers, and hyphens'
    ),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  isSystem: z.boolean().optional(),
});

const updateRoleSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

// All role routes require ADMIN_USERS permission (or a new ADMIN_ROLES permission if added)
router.use(
  verifyAccessToken,
  attachPlanContext,
  requirePermission(Permission.ADMIN_USERS)
);

// Reading roles needs ADMIN_USERS (moderators included); changing role definitions needs Admin+.
const adminOrAbove = requireRole(UserRole.Admin, UserRole.SuperAdmin);

/**
 * System roles (user, moderator, admin, superadmin) define what staff can do, so only a
 * SuperAdmin may change or delete them or flag a role as "system" (D-021: an Admin must not
 * be able to grant their own role more permissions).
 */
const protectSystemRoles = async (req: Request, res: Response, next: NextFunction) => {
  const actorRole = (req as any).user?.role as UserRole | undefined;
  if (actorRole === UserRole.SuperAdmin) return next();
  const forbid = () =>
    sendError(res, 'Only a superadmin can change system roles', 403, 'SYSTEM_ROLE_PROTECTED');
  if (req.body && 'isSystem' in req.body) {
    if (req.body.isSystem) return forbid();
    delete req.body.isSystem;
  }
  const id = req.params.id as string | undefined;
  if (id) {
    try {
      const role = await Role.findById(id).select('isSystem').lean();
      if (role?.isSystem) return forbid();
    } catch {
      // A malformed id falls through to the controller's own handling.
    }
  }
  return next();
};

router.get('/', roleController.getRoles);
router.get('/:id', roleController.getRoleById);
router.post(
  '/',
  adminOrAbove,
  protectSystemRoles,
  validateRequestWithZod(createRoleSchema),
  roleController.createRole
);
router.put(
  '/:id',
  adminOrAbove,
  protectSystemRoles,
  validateRequestWithZod(updateRoleSchema),
  roleController.updateRole
);
router.delete('/:id', adminOrAbove, protectSystemRoles, roleController.deleteRole);

export default router;
