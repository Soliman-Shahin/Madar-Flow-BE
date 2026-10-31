import { Permission } from '../types/permissions.types';
import {
  PermissionScope,
  expandScope,
  expandScopes,
  hasScope,
  hasAnyScope,
  hasAllScopes,
  getUserScopes,
  SCOPE_BUNDLES,
  getBundlePermissions,
} from '../types/permission-scopes.types';
import { permissionCacheService } from './permission-cache.service';
import logger from './logger.service';

/**
 * Scope Service
 *
 * Provides utility functions for working with permission scopes.
 * Scopes are logical groupings of permissions for easier management.
 */
class ScopeService {
  /**
   * Check if a user has a specific scope
   */
  async userHasScope(userId: string, scope: PermissionScope): Promise<boolean> {
    try {
      const permissions =
        await permissionCacheService.getUserPermissions(userId);
      return hasScope(permissions, scope);
    } catch (error: any) {
      logger.error(`Error checking user scope: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if a user has any of the specified scopes
   */
  async userHasAnyScope(
    userId: string,
    scopes: PermissionScope[]
  ): Promise<boolean> {
    try {
      const permissions =
        await permissionCacheService.getUserPermissions(userId);
      return hasAnyScope(permissions, scopes);
    } catch (error: any) {
      logger.error(`Error checking user scopes: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if a user has all of the specified scopes
   */
  async userHasAllScopes(
    userId: string,
    scopes: PermissionScope[]
  ): Promise<boolean> {
    try {
      const permissions =
        await permissionCacheService.getUserPermissions(userId);
      return hasAllScopes(permissions, scopes);
    } catch (error: any) {
      logger.error(`Error checking user scopes: ${error.message}`);
      return false;
    }
  }

  /**
   * Get all scopes that a user has
   */
  async getUserScopes(userId: string): Promise<PermissionScope[]> {
    try {
      const permissions =
        await permissionCacheService.getUserPermissions(userId);
      return getUserScopes(permissions);
    } catch (error: any) {
      logger.error(`Error getting user scopes: ${error.message}`);
      return [];
    }
  }

  /**
   * Get missing scopes for a user
   */
  async getMissingScopes(
    userId: string,
    requiredScopes: PermissionScope[]
  ): Promise<PermissionScope[]> {
    try {
      const permissions =
        await permissionCacheService.getUserPermissions(userId);
      return requiredScopes.filter((scope) => !hasScope(permissions, scope));
    } catch (error: any) {
      logger.error(`Error getting missing scopes: ${error.message}`);
      return requiredScopes;
    }
  }

  /**
   * Expand a scope into its constituent permissions
   */
  expandScope(scope: PermissionScope): Permission[] {
    return expandScope(scope);
  }

  /**
   * Expand multiple scopes into a unique set of permissions
   */
  expandScopes(scopes: PermissionScope[]): Permission[] {
    return expandScopes(scopes);
  }

  /**
   * Get permissions for a predefined scope bundle
   */
  getBundlePermissions(bundleKey: keyof typeof SCOPE_BUNDLES): Permission[] {
    return getBundlePermissions(bundleKey);
  }

  /**
   * Get all available scopes
   */
  getAllScopes(): PermissionScope[] {
    return Object.values(PermissionScope);
  }

  /**
   * Get scope details (name, description, permissions)
   */
  getScopeDetails(scope: PermissionScope): {
    scope: PermissionScope;
    permissions: Permission[];
    permissionCount: number;
    category: string;
  } {
    const permissions = expandScope(scope);
    const category = this.getScopeCategory(scope);

    return {
      scope,
      permissions,
      permissionCount: permissions.length,
      category,
    };
  }

  /**
   * Get all scopes with their details
   */
  getAllScopeDetails(): Array<{
    scope: PermissionScope;
    permissions: Permission[];
    permissionCount: number;
    category: string;
  }> {
    return this.getAllScopes().map((scope) => this.getScopeDetails(scope));
  }

  /**
   * Get scopes by category
   */
  getScopesByCategory(
    category: 'resource' | 'admin' | 'feature'
  ): PermissionScope[] {
    const allScopes = this.getAllScopes();
    return allScopes.filter(
      (scope) => this.getScopeCategory(scope) === category
    );
  }

  /**
   * Helper: Determine scope category
   */
  private getScopeCategory(scope: PermissionScope): string {
    if (scope.startsWith('admin:')) return 'admin';
    if (
      scope.startsWith('expenses:') ||
      scope.startsWith('categories:') ||
      scope.startsWith('reports:') ||
      scope.startsWith('profile:')
    ) {
      return 'resource';
    }
    return 'feature';
  }

  /**
   * Compare two sets of scopes and return the difference
   */
  compareScopesets(
    currentScopes: PermissionScope[],
    targetScopes: PermissionScope[]
  ): {
    added: PermissionScope[];
    removed: PermissionScope[];
    unchanged: PermissionScope[];
  } {
    const added = targetScopes.filter((s) => !currentScopes.includes(s));
    const removed = currentScopes.filter((s) => !targetScopes.includes(s));
    const unchanged = currentScopes.filter((s) => targetScopes.includes(s));

    return { added, removed, unchanged };
  }

  /**
   * Suggest minimum plan for required scopes
   */
  suggestPlanForScopes(requiredScopes: PermissionScope[]): string {
    const requiredPermissions = expandScopes(requiredScopes);

    // Check if basic user bundle covers it
    const basicPerms = getBundlePermissions('BASIC_USER');
    if (requiredPermissions.every((p) => basicPerms.includes(p))) {
      return 'free';
    }

    // Check if premium user bundle covers it
    const premiumPerms = getBundlePermissions('PREMIUM_USER');
    if (requiredPermissions.every((p) => premiumPerms.includes(p))) {
      return 'pro';
    }

    // Requires admin access
    return 'enterprise';
  }
}

export const scopeService = new ScopeService();
