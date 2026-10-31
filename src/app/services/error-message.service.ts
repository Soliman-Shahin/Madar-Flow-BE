import { Permission } from '../types/permissions.types';
import { PermissionScope } from '../types/permission-scopes.types';
import { PlanSlug } from '../types/plan.types';

/**
 * Error Message Service
 *
 * Provides enhanced, user-friendly error messages with actionable suggestions.
 */
class ErrorMessageService {
  /**
   * Generate a detailed permission denied message with upgrade suggestions
   */
  getPermissionDeniedMessage(params: {
    permission: Permission;
    currentPlan: PlanSlug;
    userEmail?: string;
  }): {
    message: string;
    suggestion: string;
    upgradeUrl: string;
    requiredPlan: PlanSlug;
    learnMoreUrl: string;
  } {
    const { permission, currentPlan } = params;

    // Determine which plan includes this permission
    const requiredPlan = this.getMinimumPlanForPermission(permission);

    // Generate user-friendly message
    const featureName = this.getFeatureName(permission);
    const message = `Access to "${featureName}" is not available on your current ${this.getPlanDisplayName(currentPlan)} plan.`;

    const suggestion =
      requiredPlan === currentPlan
        ? 'This feature is not available on any plan yet. Contact support for more information.'
        : `Upgrade to ${this.getPlanDisplayName(requiredPlan)} to unlock this feature.`;

    return {
      message,
      suggestion,
      upgradeUrl: `/plans/upgrade?from=${currentPlan}&to=${requiredPlan}&feature=${permission}`,
      requiredPlan,
      learnMoreUrl: `/plans/compare?highlight=${permission}`,
    };
  }

  /**
   * Generate a detailed scope denied message
   */
  getScopeDeniedMessage(params: {
    scope: PermissionScope;
    currentPlan: PlanSlug;
  }): {
    message: string;
    suggestion: string;
    upgradeUrl: string;
    requiredPlan: PlanSlug;
  } {
    const { scope, currentPlan } = params;

    const requiredPlan = this.getMinimumPlanForScope(scope);
    const scopeName = this.getScopeName(scope);

    return {
      message: `The "${scopeName}" feature set is not available on your ${this.getPlanDisplayName(currentPlan)} plan.`,
      suggestion: `Upgrade to ${this.getPlanDisplayName(requiredPlan)} to access all ${scopeName} features.`,
      upgradeUrl: `/plans/upgrade?from=${currentPlan}&to=${requiredPlan}&scope=${scope}`,
      requiredPlan,
    };
  }

  /**
   * Generate plan limit exceeded message
   */
  getPlanLimitMessage(params: {
    limitType: 'categories' | 'transactions' | 'backups' | 'devices';
    currentCount: number;
    maxAllowed: number;
    currentPlan: PlanSlug;
  }): {
    message: string;
    suggestion: string;
    upgradeUrl: string;
    details: {
      current: number;
      limit: number;
      remaining: number;
    };
  } {
    const { limitType, currentCount, maxAllowed, currentPlan } = params;

    const limitName = this.getLimitDisplayName(limitType);
    const nextPlan = this.getNextPlan(currentPlan);

    return {
      message: `You've reached your ${limitName} limit (${currentCount}/${maxAllowed}) on the ${this.getPlanDisplayName(currentPlan)} plan.`,
      suggestion: nextPlan
        ? `Upgrade to ${this.getPlanDisplayName(nextPlan)} for ${this.getNextPlanLimit(limitType, nextPlan)} ${limitName}.`
        : 'You are on the highest plan. Contact support for enterprise options.',
      upgradeUrl: `/plans/upgrade?from=${currentPlan}&to=${nextPlan}&reason=limit_${limitType}`,
      details: {
        current: currentCount,
        limit: maxAllowed,
        remaining: Math.max(0, maxAllowed - currentCount),
      },
    };
  }

  /**
   * Generate plan expired message
   */
  getPlanExpiredMessage(params: { plan: PlanSlug; expiredAt: Date }): {
    message: string;
    suggestion: string;
    renewUrl: string;
    daysExpired: number;
  } {
    const { plan, expiredAt } = params;
    const daysExpired = Math.floor(
      (Date.now() - new Date(expiredAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    return {
      message: `Your ${this.getPlanDisplayName(plan)} subscription expired ${daysExpired} day${daysExpired !== 1 ? 's' : ''} ago.`,
      suggestion:
        'Renew your subscription to continue accessing premium features.',
      renewUrl: `/plans/renew?plan=${plan}`,
      daysExpired,
    };
  }

  /**
   * Generate access denied message with context
   */
  getAccessDeniedMessage(params: {
    resourceType: string;
    resourceId?: string;
    reason: string;
  }): {
    message: string;
    suggestion: string;
    helpUrl: string;
  } {
    const { resourceType, reason } = params;

    return {
      message: `Access denied to ${resourceType}. ${reason}`,
      suggestion: this.getAccessDeniedSuggestion(reason),
      helpUrl: '/help/access-denied',
    };
  }

  /**
   * Generate rate limit exceeded message
   */
  getRateLimitMessage(params: {
    limit: number;
    windowMs: number;
    retryAfter: number;
  }): {
    message: string;
    suggestion: string;
    retryAfter: number;
    retryAt: Date;
  } {
    const { limit, windowMs, retryAfter } = params;
    const windowMinutes = Math.floor(windowMs / 60000);
    const retryAt = new Date(Date.now() + retryAfter * 1000);

    return {
      message: `Rate limit exceeded. You can make ${limit} requests per ${windowMinutes} minute${windowMinutes !== 1 ? 's' : ''}.`,
      suggestion: `Please wait ${Math.ceil(retryAfter / 60)} minute${Math.ceil(retryAfter / 60) !== 1 ? 's' : ''} before trying again.`,
      retryAfter,
      retryAt,
    };
  }

  // ==================== Helper Methods ====================

  /**
   * Get minimum plan required for a permission
   */
  private getMinimumPlanForPermission(permission: Permission): PlanSlug {
    // Basic permissions (free plan)
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

    // Pro permissions
    const proPermissions = [
      Permission.EXPENSE_EXPORT,
      Permission.REPORT_ADVANCED,
      Permission.BACKUP_GDRIVE,
      Permission.SYNC_MULTI_DEVICE,
      Permission.PROFILE_AVATAR,
      Permission.SECURITY_ADVANCED_ENCRYPTION,
      Permission.SECURITY_BIOMETRIC,
      Permission.SUPPORT_PRIORITY,
    ];

    if (freePermissions.includes(permission)) return PlanSlug.Free;
    if (proPermissions.includes(permission)) return PlanSlug.Pro;
    return PlanSlug.Premium;
  }

  /**
   * Get minimum plan required for a scope
   */
  private getMinimumPlanForScope(scope: PermissionScope): PlanSlug {
    if (scope.includes('admin')) return PlanSlug.Premium;
    if (scope.includes('advanced') || scope.includes('full'))
      return PlanSlug.Pro;
    return PlanSlug.Free;
  }

  /**
   * Get user-friendly feature name
   */
  private getFeatureName(permission: Permission): string {
    const featureNames: Record<string, string> = {
      [Permission.EXPENSE_EXPORT]: 'Export Expenses',
      [Permission.REPORT_ADVANCED]: 'Advanced Reports',
      [Permission.BACKUP_GDRIVE]: 'Google Drive Backup',
      [Permission.SYNC_MULTI_DEVICE]: 'Multi-Device Sync',
      [Permission.SECURITY_ADVANCED_ENCRYPTION]: 'Advanced Encryption',
      [Permission.SECURITY_BIOMETRIC]: 'Biometric Authentication',
      [Permission.SUPPORT_PRIORITY]: 'Priority Support',
      [Permission.PROFILE_AVATAR]: 'Custom Avatar',
    };

    return featureNames[permission] || permission.replace(/[_:]/g, ' ');
  }

  /**
   * Get user-friendly scope name
   */
  private getScopeName(scope: PermissionScope): string {
    return scope.replace(/[:*]/g, ' ').replace(/_/g, ' ');
  }

  /**
   * Get user-friendly plan name
   */
  private getPlanDisplayName(plan: PlanSlug): string {
    const names: Record<PlanSlug, string> = {
      [PlanSlug.Free]: 'Free',
      [PlanSlug.Pro]: 'Pro',
      [PlanSlug.Premium]: 'Premium',
    };
    return names[plan] || plan;
  }

  /**
   * Get user-friendly limit name
   */
  private getLimitDisplayName(limitType: string): string {
    const names: Record<string, string> = {
      categories: 'categories',
      transactions: 'monthly transactions',
      backups: 'backup files',
      devices: 'connected devices',
    };
    return names[limitType] || limitType;
  }

  /**
   * Get next plan in hierarchy
   */
  private getNextPlan(currentPlan: PlanSlug): PlanSlug | null {
    const hierarchy = [PlanSlug.Free, PlanSlug.Pro, PlanSlug.Premium];
    const currentIndex = hierarchy.indexOf(currentPlan);
    return currentIndex < hierarchy.length - 1
      ? hierarchy[currentIndex + 1]
      : null;
  }

  /**
   * Get limit for next plan
   */
  private getNextPlanLimit(limitType: string, plan: PlanSlug): string {
    // This would ideally fetch from plan configuration
    const limits: Record<PlanSlug, Record<string, string>> = {
      [PlanSlug.Free]: {
        categories: '10',
        transactions: '50',
        backups: '3',
        devices: '1',
      },
      [PlanSlug.Pro]: {
        categories: '50',
        transactions: '500',
        backups: '20',
        devices: '5',
      },
      [PlanSlug.Premium]: {
        categories: 'unlimited',
        transactions: 'unlimited',
        backups: 'unlimited',
        devices: 'unlimited',
      },
    };

    return limits[plan]?.[limitType] || 'more';
  }

  /**
   * Get suggestion for access denied reason
   */
  private getAccessDeniedSuggestion(reason: string): string {
    if (reason.includes('not found')) {
      return 'The resource you are trying to access does not exist or has been deleted.';
    }
    if (reason.includes('not owner')) {
      return 'You can only access resources that you own. Contact the owner for access.';
    }
    return 'Please check your permissions and try again.';
  }
}

export const errorMessageService = new ErrorMessageService();
