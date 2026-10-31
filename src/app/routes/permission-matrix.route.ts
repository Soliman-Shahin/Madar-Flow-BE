import { Router } from 'express';
import permissionMatrixController from '../controllers/permission-matrix.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import { requireAdmin } from '../middleware/admin.middleware';

const router = Router();

// All permission matrix routes require authentication and admin access
router.use(verifyAccessToken);
router.use(requireAdmin);

// ==================== PERMISSION MATRIX ====================

/**
 * GET /v1/permissions/matrix
 * Get complete permission matrix
 *
 * Returns full matrix with all permissions, plans, roles, and scopes
 *
 * @access Admin
 */
router.get(
  '/matrix',
  permissionMatrixController.getMatrix.bind(permissionMatrixController)
);

/**
 * GET /v1/permissions/summary
 * Get permission system summary
 *
 * Returns quick overview with statistics and highlights
 *
 * @access Admin
 */
router.get(
  '/summary',
  permissionMatrixController.getSummary.bind(permissionMatrixController)
);

/**
 * GET /v1/permissions/visualization
 * Get visualization data for charts
 *
 * Returns data formatted for:
 * - Pie charts (permissions by group)
 * - Bar charts (permissions by plan/role)
 * - Heatmaps (coverage matrix)
 *
 * @access Admin
 */
router.get(
  '/visualization',
  permissionMatrixController.getVisualizationData.bind(
    permissionMatrixController
  )
);

// ==================== EXPORT ====================

/**
 * GET /v1/permissions/export
 * Export permission matrix in various formats
 *
 * Query params:
 * - format: json | csv | markdown (default: json)
 *
 * Downloads file with appropriate content-type
 *
 * @access Admin
 */
router.get(
  '/export',
  permissionMatrixController.exportMatrix.bind(permissionMatrixController)
);

// ==================== COMPARISON ====================

/**
 * GET /v1/permissions/compare/plans
 * Compare two subscription plans
 *
 * Query params:
 * - plan1: PlanSlug (required)
 * - plan2: PlanSlug (required)
 *
 * Returns:
 * - Common permissions
 * - Unique to each plan
 * - Similarity percentage
 *
 * @access Admin
 */
router.get(
  '/compare/plans',
  permissionMatrixController.comparePlans.bind(permissionMatrixController)
);

/**
 * GET /v1/permissions/compare/roles
 * Compare two roles
 *
 * Query params:
 * - role1: Role (required)
 * - role2: Role (required)
 *
 * Returns:
 * - Common permissions
 * - Unique to each role
 * - Similarity percentage
 *
 * @access Admin
 */
router.get(
  '/compare/roles',
  permissionMatrixController.compareRoles.bind(permissionMatrixController)
);

// ==================== SPECIFIC QUERIES ====================

/**
 * GET /v1/permissions/plan/:slug
 * Get all permissions for a specific plan
 *
 * Params:
 * - slug: PlanSlug
 *
 * Returns detailed permission info for the plan
 *
 * @access Admin
 */
router.get(
  '/plan/:slug',
  permissionMatrixController.getPlanPermissions.bind(permissionMatrixController)
);

/**
 * GET /v1/permissions/role/:role
 * Get all permissions for a specific role
 *
 * Params:
 * - role: Role
 *
 * Returns detailed permission info for the role
 *
 * @access Admin
 */
router.get(
  '/role/:role',
  permissionMatrixController.getRolePermissions.bind(permissionMatrixController)
);

export default router;
