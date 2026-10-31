import { Permission } from '../types/permissions.types';
import { PermissionScope } from '../types/permission-scopes.types';
import { UserRole } from '../models/user.model';
import { PlanSlug } from '../types/plan.types';

/**
 * Permission Testing Utilities
 *
 * Helper functions for testing permission-related functionality.
 * Useful for unit tests, integration tests, and debugging.
 */

/**
 * Mock user data for testing
 */
export interface MockUser {
  _id: string;
  email: string;
  role: UserRole;
  plan: PlanSlug;
  permissions: Permission[];
  customPermissions?: Permission[];
}

/**
 * Create a mock user with specific permissions
 */
export function createMockUser(overrides?: Partial<MockUser>): MockUser {
  return {
    _id: '507f1f77bcf86cd799439011',
    email: 'test@example.com',
    role: UserRole.User,
    plan: PlanSlug.Free,
    permissions: [],
    ...overrides,
  };
}

/**
 * Create a mock user with a specific role
 */
export function createMockUserWithRole(role: UserRole): MockUser {
  const rolePermissions = getRoleDefaultPermissions(role);
  return createMockUser({
    role,
    permissions: rolePermissions,
  });
}

/**
 * Create a mock user with a specific plan
 */
export function createMockUserWithPlan(plan: PlanSlug): MockUser {
  const planPermissions = getPlanDefaultPermissions(plan);
  return createMockUser({
    plan,
    permissions: planPermissions,
  });
}

/**
 * Create a mock user with specific permissions
 */
export function createMockUserWithPermissions(
  permissions: Permission[]
): MockUser {
  return createMockUser({ permissions });
}

/**
 * Get default permissions for a role
 */
function getRoleDefaultPermissions(role: UserRole): Permission[] {
  const basePermissions = [
    Permission.EXPENSE_CREATE,
    Permission.EXPENSE_READ,
    Permission.EXPENSE_UPDATE,
    Permission.EXPENSE_DELETE,
    Permission.CATEGORY_CREATE,
    Permission.CATEGORY_READ,
    Permission.CATEGORY_UPDATE,
    Permission.CATEGORY_DELETE,
  ];

  if (
    role === UserRole.Moderator ||
    role === UserRole.Admin ||
    role === UserRole.SuperAdmin
  ) {
    basePermissions.push(Permission.ADMIN_DASHBOARD, Permission.ADMIN_HEALTH);
  }

  if (role === UserRole.Admin || role === UserRole.SuperAdmin) {
    basePermissions.push(
      Permission.ADMIN_USERS,
      Permission.ADMIN_CATEGORIES,
      Permission.ADMIN_EXPENSES
    );
  }

  if (role === UserRole.SuperAdmin) {
    basePermissions.push(Permission.ADMIN_PLANS);
  }

  return basePermissions;
}

/**
 * Get default permissions for a plan
 */
function getPlanDefaultPermissions(plan: PlanSlug): Permission[] {
  const freePermissions = [
    Permission.EXPENSE_CREATE,
    Permission.EXPENSE_READ,
    Permission.EXPENSE_UPDATE,
    Permission.EXPENSE_DELETE,
    Permission.CATEGORY_CREATE,
    Permission.CATEGORY_READ,
    Permission.CATEGORY_UPDATE,
    Permission.CATEGORY_DELETE,
    Permission.REPORT_VIEW,
    Permission.PROFILE_UPDATE,
    Permission.BACKUP_LOCAL,
  ];

  if (plan === PlanSlug.Pro || plan === PlanSlug.Premium) {
    freePermissions.push(
      Permission.EXPENSE_EXPORT,
      Permission.REPORT_ADVANCED,
      Permission.BACKUP_GDRIVE,
      Permission.SYNC_MULTI_DEVICE,
      Permission.PROFILE_AVATAR,
      Permission.SECURITY_ADVANCED_ENCRYPTION,
      Permission.SECURITY_BIOMETRIC,
      Permission.SUPPORT_PRIORITY
    );
  }

  return freePermissions;
}

/**
 * Test Scenarios
 */
export const TestScenarios = {
  /**
   * Free user trying to export expenses
   */
  freeUserExport: {
    user: createMockUserWithPlan(PlanSlug.Free),
    permission: Permission.EXPENSE_EXPORT,
    shouldPass: false,
    expectedError: 'PERMISSION_DENIED',
  },

  /**
   * Pro user trying to export expenses
   */
  proUserExport: {
    user: createMockUserWithPlan(PlanSlug.Pro),
    permission: Permission.EXPENSE_EXPORT,
    shouldPass: true,
  },

  /**
   * Regular user trying to access admin dashboard
   */
  userAccessAdmin: {
    user: createMockUserWithRole(UserRole.User),
    permission: Permission.ADMIN_DASHBOARD,
    shouldPass: false,
    expectedError: 'PERMISSION_DENIED',
  },

  /**
   * Admin trying to manage plans
   */
  adminManagePlans: {
    user: createMockUserWithRole(UserRole.Admin),
    permission: Permission.ADMIN_PLANS,
    shouldPass: false,
    expectedError: 'PERMISSION_DENIED',
  },

  /**
   * SuperAdmin trying to manage plans
   */
  superAdminManagePlans: {
    user: createMockUserWithRole(UserRole.SuperAdmin),
    permission: Permission.ADMIN_PLANS,
    shouldPass: true,
  },
};

/**
 * Permission Matrix for Testing
 * Maps roles and plans to their expected permissions
 */
export const PermissionMatrix = {
  roles: {
    [UserRole.User]: getRoleDefaultPermissions(UserRole.User),
    [UserRole.Moderator]: getRoleDefaultPermissions(UserRole.Moderator),
    [UserRole.Admin]: getRoleDefaultPermissions(UserRole.Admin),
    [UserRole.SuperAdmin]: getRoleDefaultPermissions(UserRole.SuperAdmin),
  },
  plans: {
    [PlanSlug.Free]: getPlanDefaultPermissions(PlanSlug.Free),
    [PlanSlug.Pro]: getPlanDefaultPermissions(PlanSlug.Pro),
    [PlanSlug.Premium]: getPlanDefaultPermissions(PlanSlug.Premium),
  },
};

/**
 * Assert that a user has a specific permission
 */
export function assertHasPermission(
  user: MockUser,
  permission: Permission
): void {
  if (!user.permissions.includes(permission)) {
    throw new Error(
      `Expected user to have permission "${permission}" but it was not found`
    );
  }
}

/**
 * Assert that a user does NOT have a specific permission
 */
export function assertLacksPermission(
  user: MockUser,
  permission: Permission
): void {
  if (user.permissions.includes(permission)) {
    throw new Error(
      `Expected user NOT to have permission "${permission}" but it was found`
    );
  }
}

/**
 * Assert that a user has all permissions in a list
 */
export function assertHasAllPermissions(
  user: MockUser,
  permissions: Permission[]
): void {
  const missing = permissions.filter((p) => !user.permissions.includes(p));
  if (missing.length > 0) {
    throw new Error(
      `Expected user to have all permissions but missing: ${missing.join(', ')}`
    );
  }
}

/**
 * Assert that a user has any of the permissions in a list
 */
export function assertHasAnyPermission(
  user: MockUser,
  permissions: Permission[]
): void {
  const hasAny = permissions.some((p) => user.permissions.includes(p));
  if (!hasAny) {
    throw new Error(
      `Expected user to have at least one of: ${permissions.join(', ')}`
    );
  }
}

/**
 * Get missing permissions for a user to access a scope
 */
export function getMissingPermissionsForScope(
  user: MockUser,
  scope: PermissionScope
): Permission[] {
  // This would use the actual scope expansion logic
  // For now, return empty array as placeholder
  return [];
}

/**
 * Simulate permission check
 */
export function simulatePermissionCheck(
  user: MockUser,
  permission: Permission
): {
  granted: boolean;
  reason?: string;
} {
  const hasPermission = user.permissions.includes(permission);

  if (hasPermission) {
    return { granted: true };
  }

  return {
    granted: false,
    reason: `User does not have permission: ${permission}`,
  };
}

/**
 * Generate test cases for all permission combinations
 */
export function generatePermissionTestCases(): Array<{
  role: UserRole;
  plan: PlanSlug;
  permission: Permission;
  expected: boolean;
}> {
  const testCases: Array<{
    role: UserRole;
    plan: PlanSlug;
    permission: Permission;
    expected: boolean;
  }> = [];

  const roles = Object.values(UserRole);
  const plans = Object.values(PlanSlug);
  const permissions = Object.values(Permission);

  roles.forEach((role) => {
    plans.forEach((plan) => {
      permissions.forEach((permission) => {
        const rolePerms = PermissionMatrix.roles[role];
        const planPerms = PermissionMatrix.plans[plan];
        const expected =
          rolePerms.includes(permission) || planPerms.includes(permission);

        testCases.push({ role, plan, permission, expected });
      });
    });
  });

  return testCases;
}

/**
 * Validate permission matrix consistency
 */
export function validatePermissionMatrix(): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check that higher roles include lower role permissions
  const userPerms = PermissionMatrix.roles[UserRole.User];
  const modPerms = PermissionMatrix.roles[UserRole.Moderator];
  const adminPerms = PermissionMatrix.roles[UserRole.Admin];
  const superAdminPerms = PermissionMatrix.roles[UserRole.SuperAdmin];

  // Moderator should have all User permissions
  userPerms.forEach((perm) => {
    if (!modPerms.includes(perm)) {
      errors.push(`Moderator missing User permission: ${perm}`);
    }
  });

  // Admin should have all Moderator permissions
  modPerms.forEach((perm) => {
    if (!adminPerms.includes(perm)) {
      errors.push(`Admin missing Moderator permission: ${perm}`);
    }
  });

  // SuperAdmin should have all Admin permissions
  adminPerms.forEach((perm) => {
    if (!superAdminPerms.includes(perm)) {
      errors.push(`SuperAdmin missing Admin permission: ${perm}`);
    }
  });

  // Check that higher plans include lower plan permissions
  const freePerms = PermissionMatrix.plans[PlanSlug.Free];
  const proPerms = PermissionMatrix.plans[PlanSlug.Pro];
  const premiumPerms = PermissionMatrix.plans[PlanSlug.Premium];

  // Pro should have all Free permissions
  freePerms.forEach((perm) => {
    if (!proPerms.includes(perm)) {
      errors.push(`Pro plan missing Free permission: ${perm}`);
    }
  });

  // Premium should have all Pro permissions
  proPerms.forEach((perm) => {
    if (!premiumPerms.includes(perm)) {
      errors.push(`Premium plan missing Pro permission: ${perm}`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Print permission matrix for debugging
 */
export function printPermissionMatrix(): void {
  console.log('\n=== PERMISSION MATRIX ===\n');

  console.log('ROLES:');
  Object.entries(PermissionMatrix.roles).forEach(([role, perms]) => {
    console.log(`\n${role} (${perms.length} permissions):`);
    perms.forEach((perm) => console.log(`  - ${perm}`));
  });

  console.log('\n\nPLANS:');
  Object.entries(PermissionMatrix.plans).forEach(([plan, perms]) => {
    console.log(`\n${plan} (${perms.length} permissions):`);
    perms.forEach((perm) => console.log(`  - ${perm}`));
  });

  console.log('\n========================\n');
}
