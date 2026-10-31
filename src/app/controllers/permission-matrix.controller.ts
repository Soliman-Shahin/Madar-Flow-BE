import { errorMessage } from '../shared/errors';
import { Request, Response } from 'express';
import permissionExportService from '../services/permission-export.service';
import { PlanSlug } from '../types/plan.types';
import { Role } from '../types/role.types';

/**
 * Permission Matrix Controller
 *
 * Provides HTTP handlers for permission matrix operations:
 * - View complete permission matrix
 * - Compare plans and roles
 * - Export in various formats (JSON, CSV, Markdown)
 * - Get visualization data for charts
 */

class PermissionMatrixController {
  /**
   * GET /v1/permissions/matrix
   * Get complete permission matrix
   *
   * @access Admin
   */
  async getMatrix(req: Request, res: Response): Promise<void> {
    try {
      const matrix = await permissionExportService.buildPermissionMatrix();

      res.status(200).json({
        success: true,
        data: matrix,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: 'Failed to build permission matrix',
        error: errorMessage(error),
      });
    }
  }

  /**
   * GET /v1/permissions/export
   * Export permission matrix in specified format
   *
   * Query params:
   * - format: json | csv | markdown (default: json)
   *
   * @access Admin
   */
  async exportMatrix(req: Request, res: Response): Promise<void> {
    try {
      const format = (req.query.format as string) || 'json';

      let content: string;
      let contentType: string;
      let filename: string;

      switch (format.toLowerCase()) {
        case 'csv':
          content = await permissionExportService.exportAsCSV();
          contentType = 'text/csv';
          filename = 'permission-matrix.csv';
          break;

        case 'markdown':
        case 'md':
          content = await permissionExportService.exportAsMarkdown();
          contentType = 'text/markdown';
          filename = 'permission-matrix.md';
          break;

        case 'json':
        default:
          content = await permissionExportService.exportAsJSON();
          contentType = 'application/json';
          filename = 'permission-matrix.json';
          break;
      }

      // Set headers for file download
      res.setHeader('Content-Type', contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );
      res.status(200).send(content);
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: 'Failed to export permission matrix',
        error: errorMessage(error),
      });
    }
  }

  /**
   * GET /v1/permissions/compare/plans
   * Compare two subscription plans
   *
   * Query params:
   * - plan1: PlanSlug (required)
   * - plan2: PlanSlug (required)
   *
   * @access Admin
   */
  async comparePlans(req: Request, res: Response): Promise<void> {
    try {
      const { plan1, plan2 } = req.query;

      if (!plan1 || !plan2) {
        res.status(400).json({
          success: false,
          message: 'Both plan1 and plan2 query parameters are required',
        });
        return;
      }

      const comparison = await permissionExportService.comparePlans(
        plan1 as PlanSlug,
        plan2 as PlanSlug
      );

      res.status(200).json({
        success: true,
        data: comparison,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: 'Failed to compare plans',
        error: errorMessage(error),
      });
    }
  }

  /**
   * GET /v1/permissions/compare/roles
   * Compare two roles
   *
   * Query params:
   * - role1: Role (required)
   * - role2: Role (required)
   *
   * @access Admin
   */
  async compareRoles(req: Request, res: Response): Promise<void> {
    try {
      const { role1, role2 } = req.query;

      if (!role1 || !role2) {
        res.status(400).json({
          success: false,
          message: 'Both role1 and role2 query parameters are required',
        });
        return;
      }

      const comparison = await permissionExportService.compareRoles(
        role1 as Role,
        role2 as Role
      );

      res.status(200).json({
        success: true,
        data: comparison,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: 'Failed to compare roles',
        error: errorMessage(error),
      });
    }
  }

  /**
   * GET /v1/permissions/visualization
   * Get visualization data for charts and graphs
   *
   * Returns:
   * - Permissions by group (pie chart)
   * - Permissions by plan (bar chart)
   * - Permissions by role (bar chart)
   * - Coverage matrix (heatmap)
   *
   * @access Admin
   */
  async getVisualizationData(req: Request, res: Response): Promise<void> {
    try {
      const data = await permissionExportService.getVisualizationData();

      res.status(200).json({
        success: true,
        data,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: 'Failed to get visualization data',
        error: errorMessage(error),
      });
    }
  }

  /**
   * GET /v1/permissions/summary
   * Get a quick summary of the permission system
   *
   * @access Admin
   */
  async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const matrix = await permissionExportService.buildPermissionMatrix();

      // Calculate summary statistics
      const summary = {
        totalPermissions: matrix.metadata.totalPermissions,
        totalPlans: matrix.metadata.totalPlans,
        totalRoles: matrix.metadata.totalRoles,
        totalScopes: matrix.metadata.totalScopes,

        // Permissions by group
        permissionsByGroup: matrix.permissions.reduce(
          (acc, entry) => {
            acc[entry.group] = (acc[entry.group] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        ),

        // Plans overview
        plans: matrix.plans.map((plan) => ({
          slug: plan.slug,
          name: plan.name,
          permissionCount: plan.permissions.length,
        })),

        // Roles overview
        roles: matrix.roles.map((role) => ({
          role: role.role,
          permissionCount: role.permissions.length,
        })),

        // Most common permissions (in most plans)
        mostCommonPermissions: matrix.permissions
          .map((entry) => ({
            permission: entry.permission,
            planCount: Object.values(entry.plans).filter(Boolean).length,
          }))
          .sort((a, b) => b.planCount - a.planCount)
          .slice(0, 10),

        // Least common permissions (in fewest plans)
        leastCommonPermissions: matrix.permissions
          .map((entry) => ({
            permission: entry.permission,
            planCount: Object.values(entry.plans).filter(Boolean).length,
          }))
          .sort((a, b) => a.planCount - b.planCount)
          .slice(0, 10),

        generatedAt: matrix.metadata.generatedAt,
      };

      res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: 'Failed to get permission summary',
        error: errorMessage(error),
      });
    }
  }

  /**
   * GET /v1/permissions/plan/:slug
   * Get all permissions for a specific plan
   *
   * @access Admin
   */
  async getPlanPermissions(req: Request, res: Response): Promise<void> {
    try {
      const { slug } = req.params;
      const matrix = await permissionExportService.buildPermissionMatrix();

      const plan = matrix.plans.find((p) => p.slug === slug);

      if (!plan) {
        res.status(404).json({
          success: false,
          message: `Plan '${slug}' not found`,
        });
        return;
      }

      // Get detailed permission info
      const detailedPermissions = matrix.permissions.filter((entry) =>
        plan.permissions.includes(entry.permission)
      );

      res.status(200).json({
        success: true,
        data: {
          plan: {
            slug: plan.slug,
            name: plan.name,
          },
          permissions: detailedPermissions,
          count: plan.permissions.length,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: 'Failed to get plan permissions',
        error: errorMessage(error),
      });
    }
  }

  /**
   * GET /v1/permissions/role/:role
   * Get all permissions for a specific role
   *
   * @access Admin
   */
  async getRolePermissions(req: Request, res: Response): Promise<void> {
    try {
      const { role } = req.params;
      const matrix = await permissionExportService.buildPermissionMatrix();

      const roleData = matrix.roles.find((r) => r.role === role);

      if (!roleData) {
        res.status(404).json({
          success: false,
          message: `Role '${role}' not found`,
        });
        return;
      }

      // Get detailed permission info
      const detailedPermissions = matrix.permissions.filter((entry) =>
        roleData.permissions.includes(entry.permission)
      );

      res.status(200).json({
        success: true,
        data: {
          role: roleData.role,
          permissions: detailedPermissions,
          count: roleData.permissions.length,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: 'Failed to get role permissions',
        error: errorMessage(error),
      });
    }
  }
}

export default new PermissionMatrixController();
