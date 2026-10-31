import { Permission, PERMISSION_GROUPS } from '../types/permissions.types';
import {
  PermissionScope,
  SCOPE_PERMISSIONS,
} from '../types/permission-scopes.types';
import { PlanSlug } from '../types/plan.types';
import { Plan } from '../models/plan.model';
import { Role } from '../types/role.types';

/**
 * Permission Export Service
 *
 * Provides functionality to export permission matrices in various formats:
 * - JSON: Structured data for API consumption
 * - CSV: Spreadsheet-compatible format
 * - Excel-ready: Enhanced CSV with proper formatting
 * - Markdown: Human-readable documentation
 */

export interface PermissionMatrixEntry {
  permission: Permission;
  group: string;
  description: string;
  plans: {
    [key in PlanSlug]?: boolean;
  };
  roles: {
    [key in Role]?: boolean;
  };
  scopes: PermissionScope[];
}

export interface PermissionMatrix {
  permissions: PermissionMatrixEntry[];
  plans: {
    slug: PlanSlug;
    name: string;
    permissions: Permission[];
  }[];
  roles: {
    role: Role;
    permissions: Permission[];
  }[];
  scopes: {
    scope: PermissionScope;
    permissions: Permission[];
  }[];
  metadata: {
    totalPermissions: number;
    totalPlans: number;
    totalRoles: number;
    totalScopes: number;
    generatedAt: Date;
  };
}

export interface ComparisonResult {
  entity1: string;
  entity2: string;
  type: 'plan' | 'role';
  permissions1: Permission[];
  permissions2: Permission[];
  common: Permission[];
  onlyIn1: Permission[];
  onlyIn2: Permission[];
  similarity: number; // percentage
}

class PermissionExportService {
  /**
   * Get permission description
   */
  private getPermissionDescription(permission: Permission): string {
    const descriptions: Record<Permission, string> = {
      // Categories
      [Permission.CATEGORY_CREATE]: 'Create new expense categories',
      [Permission.CATEGORY_READ]: 'View and list categories',
      [Permission.CATEGORY_UPDATE]: 'Modify existing categories',
      [Permission.CATEGORY_DELETE]: 'Delete categories',

      // Expenses
      [Permission.EXPENSE_CREATE]: 'Create new expenses/transactions',
      [Permission.EXPENSE_READ]: 'View and list expenses',
      [Permission.EXPENSE_UPDATE]: 'Modify existing expenses',
      [Permission.EXPENSE_DELETE]: 'Delete expenses',
      [Permission.EXPENSE_EXPORT]: 'Export expenses to CSV/PDF',

      // Reports
      [Permission.REPORT_VIEW]: 'View basic financial reports',
      [Permission.REPORT_ADVANCED]: 'Access advanced analytics and insights',

      // Backup & Sync
      [Permission.BACKUP_LOCAL]: 'Create local backups',
      [Permission.BACKUP_GDRIVE]: 'Sync with Google Drive',
      [Permission.SYNC_MULTI_DEVICE]: 'Sync data across multiple devices',

      // Profile
      [Permission.PROFILE_UPDATE]: 'Update profile information',
      [Permission.PROFILE_AVATAR]: 'Upload and change avatar',

      // Support
      [Permission.SUPPORT_PRIORITY]: 'Access priority customer support',

      // Security
      [Permission.SECURITY_ADVANCED_ENCRYPTION]:
        'Use advanced end-to-end encryption',
      [Permission.SECURITY_BIOMETRIC]: 'Enable biometric authentication',

      // Admin
      [Permission.ADMIN_DASHBOARD]: 'Access admin dashboard',
      [Permission.ADMIN_USERS]: 'Manage users',
      [Permission.ADMIN_CATEGORIES]: 'Manage categories (admin panel)',
      [Permission.ADMIN_EXPENSES]: 'Manage expenses (admin panel)',
      [Permission.ADMIN_SYNC]: 'View sync operations and conflicts',
      [Permission.ADMIN_HEALTH]: 'View system health metrics',
      [Permission.ADMIN_PLANS]: 'Manage subscription plans',
    };

    return descriptions[permission] || permission;
  }

  /**
   * Get permission group name
   */
  private getPermissionGroup(permission: Permission): string {
    for (const [group, permissions] of Object.entries(PERMISSION_GROUPS)) {
      if (permissions.includes(permission)) {
        return group;
      }
    }
    return 'other';
  }

  /**
   * Get scopes that include this permission
   */
  private getScopesForPermission(permission: Permission): PermissionScope[] {
    const scopes: PermissionScope[] = [];

    for (const [scope, permissions] of Object.entries(SCOPE_PERMISSIONS)) {
      if (permissions.includes(permission)) {
        scopes.push(scope as PermissionScope);
      }
    }

    return scopes;
  }

  /**
   * Get role permissions (mock data - should be fetched from DB in production)
   */
  private getRolePermissions(): { role: Role; permissions: Permission[] }[] {
    return [
      {
        role: Role.User,
        permissions: [
          Permission.CATEGORY_CREATE,
          Permission.CATEGORY_READ,
          Permission.CATEGORY_UPDATE,
          Permission.CATEGORY_DELETE,
          Permission.EXPENSE_CREATE,
          Permission.EXPENSE_READ,
          Permission.EXPENSE_UPDATE,
          Permission.EXPENSE_DELETE,
          Permission.REPORT_VIEW,
          Permission.BACKUP_LOCAL,
          Permission.PROFILE_UPDATE,
          Permission.PROFILE_AVATAR,
        ],
      },
      {
        role: Role.Moderator,
        permissions: [Permission.ADMIN_DASHBOARD, Permission.ADMIN_HEALTH],
      },
      {
        role: Role.Admin,
        permissions: [
          Permission.ADMIN_DASHBOARD,
          Permission.ADMIN_USERS,
          Permission.ADMIN_CATEGORIES,
          Permission.ADMIN_EXPENSES,
          Permission.ADMIN_SYNC,
          Permission.ADMIN_HEALTH,
        ],
      },
      {
        role: Role.SuperAdmin,
        permissions: Object.values(Permission),
      },
    ];
  }

  /**
   * Build complete permission matrix
   */
  async buildPermissionMatrix(): Promise<PermissionMatrix> {
    // Fetch all plans from database
    const plans = await Plan.find({ isActive: true }).sort({ order: 1 });

    // Get role permissions
    const rolePermissions = this.getRolePermissions();

    // Build permission entries
    const permissions: PermissionMatrixEntry[] = Object.values(Permission).map(
      (permission) => {
        const entry: PermissionMatrixEntry = {
          permission,
          group: this.getPermissionGroup(permission),
          description: this.getPermissionDescription(permission),
          plans: {},
          roles: {},
          scopes: this.getScopesForPermission(permission),
        };

        // Check which plans include this permission
        plans.forEach((plan) => {
          entry.plans[plan.slug] = plan.features.includes(permission);
        });

        // Check which roles include this permission
        rolePermissions.forEach(({ role, permissions: perms }) => {
          entry.roles[role] = perms.includes(permission);
        });

        return entry;
      }
    );

    return {
      permissions,
      plans: plans.map((plan) => ({
        slug: plan.slug,
        name: plan.name,
        permissions: plan.features,
      })),
      roles: rolePermissions,
      scopes: Object.entries(SCOPE_PERMISSIONS).map(([scope, permissions]) => ({
        scope: scope as PermissionScope,
        permissions,
      })),
      metadata: {
        totalPermissions: Object.values(Permission).length,
        totalPlans: plans.length,
        totalRoles: rolePermissions.length,
        totalScopes: Object.values(PermissionScope).length,
        generatedAt: new Date(),
      },
    };
  }

  /**
   * Export matrix as JSON
   */
  async exportAsJSON(): Promise<string> {
    const matrix = await this.buildPermissionMatrix();
    return JSON.stringify(matrix, null, 2);
  }

  /**
   * Export matrix as CSV
   */
  async exportAsCSV(): Promise<string> {
    const matrix = await this.buildPermissionMatrix();

    // Build CSV header
    const planColumns = matrix.plans.map((p) => p.name);
    const roleColumns = Object.values(Role);
    const header = [
      'Permission',
      'Group',
      'Description',
      ...planColumns,
      ...roleColumns,
      'Scopes',
    ].join(',');

    // Build CSV rows
    const rows = matrix.permissions.map((entry) => {
      const planValues = matrix.plans.map((p) =>
        entry.plans[p.slug] ? 'Yes' : 'No'
      );
      const roleValues = Object.values(Role).map((r) =>
        entry.roles[r] ? 'Yes' : 'No'
      );
      const scopes = entry.scopes.join('; ');

      return [
        `"${entry.permission}"`,
        `"${entry.group}"`,
        `"${entry.description}"`,
        ...planValues,
        ...roleValues,
        `"${scopes}"`,
      ].join(',');
    });

    return [header, ...rows].join('\n');
  }

  /**
   * Export matrix as Markdown table
   */
  async exportAsMarkdown(): Promise<string> {
    const matrix = await this.buildPermissionMatrix();

    let markdown = '# Permission Matrix\n\n';
    markdown += `Generated at: ${matrix.metadata.generatedAt.toISOString()}\n\n`;
    markdown += `**Statistics:**\n`;
    markdown += `- Total Permissions: ${matrix.metadata.totalPermissions}\n`;
    markdown += `- Total Plans: ${matrix.metadata.totalPlans}\n`;
    markdown += `- Total Roles: ${matrix.metadata.totalRoles}\n`;
    markdown += `- Total Scopes: ${matrix.metadata.totalScopes}\n\n`;

    // Group permissions by group
    const groupedPermissions: Record<string, PermissionMatrixEntry[]> = {};
    matrix.permissions.forEach((entry) => {
      if (!groupedPermissions[entry.group]) {
        groupedPermissions[entry.group] = [];
      }
      groupedPermissions[entry.group].push(entry);
    });

    // Create table for each group
    Object.entries(groupedPermissions).forEach(([group, entries]) => {
      markdown += `## ${group.charAt(0).toUpperCase() + group.slice(1)}\n\n`;

      // Table header
      const planColumns = matrix.plans.map((p) => p.name);
      markdown += `| Permission | Description | ${planColumns.join(' | ')} |\n`;
      markdown += `|------------|-------------|${planColumns.map(() => '---').join('|')}|\n`;

      // Table rows
      entries.forEach((entry) => {
        const planValues = matrix.plans.map((p) =>
          entry.plans[p.slug] ? '✅' : '❌'
        );
        markdown += `| ${entry.permission} | ${entry.description} | ${planValues.join(' | ')} |\n`;
      });

      markdown += '\n';
    });

    return markdown;
  }

  /**
   * Compare two plans
   */
  async comparePlans(
    slug1: PlanSlug,
    slug2: PlanSlug
  ): Promise<ComparisonResult> {
    const plan1 = await Plan.findOne({ slug: slug1 });
    const plan2 = await Plan.findOne({ slug: slug2 });

    if (!plan1 || !plan2) {
      throw new Error('One or both plans not found');
    }

    const permissions1 = plan1.features;
    const permissions2 = plan2.features;

    const common = permissions1.filter((p) => permissions2.includes(p));
    const onlyIn1 = permissions1.filter((p) => !permissions2.includes(p));
    const onlyIn2 = permissions2.filter((p) => !permissions1.includes(p));

    const similarity =
      (common.length / Math.max(permissions1.length, permissions2.length)) *
      100;

    return {
      entity1: plan1.name,
      entity2: plan2.name,
      type: 'plan',
      permissions1,
      permissions2,
      common,
      onlyIn1,
      onlyIn2,
      similarity: Math.round(similarity * 100) / 100,
    };
  }

  /**
   * Compare two roles
   */
  async compareRoles(role1: Role, role2: Role): Promise<ComparisonResult> {
    const rolePermissions = this.getRolePermissions();

    const roleData1 = rolePermissions.find((r) => r.role === role1);
    const roleData2 = rolePermissions.find((r) => r.role === role2);

    if (!roleData1 || !roleData2) {
      throw new Error('One or both roles not found');
    }

    const permissions1 = roleData1.permissions;
    const permissions2 = roleData2.permissions;

    const common = permissions1.filter((p) => permissions2.includes(p));
    const onlyIn1 = permissions1.filter((p) => !permissions2.includes(p));
    const onlyIn2 = permissions2.filter((p) => !permissions1.includes(p));

    const similarity =
      (common.length / Math.max(permissions1.length, permissions2.length)) *
      100;

    return {
      entity1: role1,
      entity2: role2,
      type: 'role',
      permissions1,
      permissions2,
      common,
      onlyIn1,
      onlyIn2,
      similarity: Math.round(similarity * 100) / 100,
    };
  }

  /**
   * Get visualization data for charts
   */
  async getVisualizationData(): Promise<any> {
    const matrix = await this.buildPermissionMatrix();

    // Permissions by group
    const permissionsByGroup: Record<string, number> = {};
    matrix.permissions.forEach((entry) => {
      permissionsByGroup[entry.group] =
        (permissionsByGroup[entry.group] || 0) + 1;
    });

    // Permissions by plan
    const permissionsByPlan = matrix.plans.map((plan) => ({
      plan: plan.name,
      count: plan.permissions.length,
      permissions: plan.permissions,
    }));

    // Permissions by role
    const permissionsByRole = matrix.roles.map((role) => ({
      role: role.role,
      count: role.permissions.length,
      permissions: role.permissions,
    }));

    // Coverage matrix (which plans cover which groups)
    const coverageMatrix = matrix.plans.map((plan) => {
      const coverage: Record<string, number> = {};

      Object.entries(PERMISSION_GROUPS).forEach(([group, permissions]) => {
        const coveredCount = permissions.filter((p) =>
          plan.permissions.includes(p)
        ).length;
        coverage[group] = (coveredCount / permissions.length) * 100;
      });

      return {
        plan: plan.name,
        coverage,
      };
    });

    return {
      permissionsByGroup,
      permissionsByPlan,
      permissionsByRole,
      coverageMatrix,
      metadata: matrix.metadata,
    };
  }
}

export default new PermissionExportService();
