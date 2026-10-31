import { Permission } from './permissions.types';

/**
 * Permission Scopes
 *
 * Logical groupings of related permissions for easier management.
 * Scopes use wildcard notation (e.g., 'expenses:*') to represent
 * all permissions within a resource area.
 */
export enum PermissionScope {
  // ==================== Resource Scopes ====================
  /** All expense-related permissions */
  EXPENSES_FULL = 'expenses:*',
  /** Read-only access to expenses */
  EXPENSES_READ = 'expenses:read',
  /** Write access to expenses (create, update, delete) */
  EXPENSES_WRITE = 'expenses:write',

  /** All category-related permissions */
  CATEGORIES_FULL = 'categories:*',
  /** Read-only access to categories */
  CATEGORIES_READ = 'categories:read',
  /** Write access to categories (create, update, delete) */
  CATEGORIES_WRITE = 'categories:write',

  /** All report-related permissions */
  REPORTS_FULL = 'reports:*',
  /** Basic reports only */
  REPORTS_BASIC = 'reports:basic',

  /** All backup-related permissions */
  BACKUP_FULL = 'backup:*',

  /** All profile-related permissions */
  PROFILE_FULL = 'profile:*',

  // ==================== Admin Scopes ====================
  /** Read-only admin access (view only) */
  ADMIN_READ = 'admin:read',
  /** Write admin access (manage users, resources) */
  ADMIN_WRITE = 'admin:write',
  /** Full admin access (everything except plans) */
  ADMIN_FULL = 'admin:*',
  /** SuperAdmin access (including plan management) */
  ADMIN_SUPER = 'admin:super',

  // ==================== Feature Scopes ====================
  /** All security features */
  SECURITY_FULL = 'security:*',
  /** All sync features */
  SYNC_FULL = 'sync:*',
}

/**
 * Maps each scope to its constituent permissions
 */
export const SCOPE_PERMISSIONS: Record<PermissionScope, Permission[]> = {
  // ==================== Expense Scopes ====================
  [PermissionScope.EXPENSES_FULL]: [
    Permission.EXPENSE_CREATE,
    Permission.EXPENSE_READ,
    Permission.EXPENSE_UPDATE,
    Permission.EXPENSE_DELETE,
    Permission.EXPENSE_EXPORT,
  ],
  [PermissionScope.EXPENSES_READ]: [Permission.EXPENSE_READ],
  [PermissionScope.EXPENSES_WRITE]: [
    Permission.EXPENSE_CREATE,
    Permission.EXPENSE_UPDATE,
    Permission.EXPENSE_DELETE,
  ],

  // ==================== Category Scopes ====================
  [PermissionScope.CATEGORIES_FULL]: [
    Permission.CATEGORY_CREATE,
    Permission.CATEGORY_READ,
    Permission.CATEGORY_UPDATE,
    Permission.CATEGORY_DELETE,
  ],
  [PermissionScope.CATEGORIES_READ]: [Permission.CATEGORY_READ],
  [PermissionScope.CATEGORIES_WRITE]: [
    Permission.CATEGORY_CREATE,
    Permission.CATEGORY_UPDATE,
    Permission.CATEGORY_DELETE,
  ],

  // ==================== Report Scopes ====================
  [PermissionScope.REPORTS_FULL]: [
    Permission.REPORT_VIEW,
    Permission.REPORT_ADVANCED,
  ],
  [PermissionScope.REPORTS_BASIC]: [Permission.REPORT_VIEW],

  // ==================== Backup Scopes ====================
  [PermissionScope.BACKUP_FULL]: [
    Permission.BACKUP_LOCAL,
    Permission.BACKUP_GDRIVE,
    Permission.SYNC_MULTI_DEVICE,
  ],

  // ==================== Profile Scopes ====================
  [PermissionScope.PROFILE_FULL]: [
    Permission.PROFILE_UPDATE,
    Permission.PROFILE_AVATAR,
  ],

  // ==================== Admin Scopes ====================
  [PermissionScope.ADMIN_READ]: [
    Permission.ADMIN_DASHBOARD,
    Permission.ADMIN_HEALTH,
  ],
  [PermissionScope.ADMIN_WRITE]: [
    Permission.ADMIN_DASHBOARD,
    Permission.ADMIN_USERS,
    Permission.ADMIN_CATEGORIES,
    Permission.ADMIN_EXPENSES,
    Permission.ADMIN_SYNC,
    Permission.ADMIN_HEALTH,
  ],
  [PermissionScope.ADMIN_FULL]: [
    Permission.ADMIN_DASHBOARD,
    Permission.ADMIN_USERS,
    Permission.ADMIN_CATEGORIES,
    Permission.ADMIN_EXPENSES,
    Permission.ADMIN_SYNC,
    Permission.ADMIN_HEALTH,
  ],
  [PermissionScope.ADMIN_SUPER]: [
    Permission.ADMIN_DASHBOARD,
    Permission.ADMIN_USERS,
    Permission.ADMIN_CATEGORIES,
    Permission.ADMIN_EXPENSES,
    Permission.ADMIN_SYNC,
    Permission.ADMIN_HEALTH,
    Permission.ADMIN_PLANS,
  ],

  // ==================== Security Scopes ====================
  [PermissionScope.SECURITY_FULL]: [
    Permission.SECURITY_ADVANCED_ENCRYPTION,
    Permission.SECURITY_BIOMETRIC,
  ],

  // ==================== Sync Scopes ====================
  [PermissionScope.SYNC_FULL]: [
    Permission.SYNC_MULTI_DEVICE,
    Permission.BACKUP_GDRIVE,
  ],
};

/**
 * Helper function to expand a scope into its permissions
 */
export function expandScope(scope: PermissionScope): Permission[] {
  return SCOPE_PERMISSIONS[scope] || [];
}

/**
 * Helper function to expand multiple scopes into a unique set of permissions
 */
export function expandScopes(scopes: PermissionScope[]): Permission[] {
  const permissions = new Set<Permission>();

  scopes.forEach((scope) => {
    const scopePerms = expandScope(scope);
    scopePerms.forEach((perm) => permissions.add(perm));
  });

  return Array.from(permissions);
}

/**
 * Check if a set of permissions satisfies a scope requirement
 */
export function hasScope(
  userPermissions: Permission[],
  requiredScope: PermissionScope
): boolean {
  const requiredPermissions = expandScope(requiredScope);
  return requiredPermissions.every((perm) => userPermissions.includes(perm));
}

/**
 * Check if a set of permissions satisfies any of the given scopes
 */
export function hasAnyScope(
  userPermissions: Permission[],
  requiredScopes: PermissionScope[]
): boolean {
  return requiredScopes.some((scope) => hasScope(userPermissions, scope));
}

/**
 * Check if a set of permissions satisfies all of the given scopes
 */
export function hasAllScopes(
  userPermissions: Permission[],
  requiredScopes: PermissionScope[]
): boolean {
  return requiredScopes.every((scope) => hasScope(userPermissions, scope));
}

/**
 * Get all scopes that a user has based on their permissions
 */
export function getUserScopes(
  userPermissions: Permission[]
): PermissionScope[] {
  const scopes: PermissionScope[] = [];

  Object.entries(SCOPE_PERMISSIONS).forEach(([scope, permissions]) => {
    if (permissions.every((perm) => userPermissions.includes(perm))) {
      scopes.push(scope as PermissionScope);
    }
  });

  return scopes;
}

/**
 * Predefined scope bundles for common user types
 */
export const SCOPE_BUNDLES = {
  /** Basic user - can manage their own data */
  BASIC_USER: [
    PermissionScope.EXPENSES_FULL,
    PermissionScope.CATEGORIES_FULL,
    PermissionScope.REPORTS_BASIC,
    PermissionScope.PROFILE_FULL,
  ],

  /** Premium user - includes advanced features */
  PREMIUM_USER: [
    PermissionScope.EXPENSES_FULL,
    PermissionScope.CATEGORIES_FULL,
    PermissionScope.REPORTS_FULL,
    PermissionScope.BACKUP_FULL,
    PermissionScope.PROFILE_FULL,
    PermissionScope.SECURITY_FULL,
    PermissionScope.SYNC_FULL,
  ],

  /** Moderator - read-only admin access */
  MODERATOR: [PermissionScope.ADMIN_READ],

  /** Admin - full admin access except plans */
  ADMIN: [PermissionScope.ADMIN_FULL],

  /** SuperAdmin - unrestricted access */
  SUPERADMIN: [PermissionScope.ADMIN_SUPER],
};

/**
 * Get permissions for a scope bundle
 */
export function getBundlePermissions(
  bundleKey: keyof typeof SCOPE_BUNDLES
): Permission[] {
  const scopes = SCOPE_BUNDLES[bundleKey];
  return expandScopes(scopes);
}
