import NodeCache from 'node-cache';
import { Permission } from '../types/permissions.types';
import { UserPlanContext } from '../types/plan.types';
import { planService } from './plan.service';
import logger from './logger.service';

/**
 * Permission Cache Service
 *
 * Caches user permissions and plan contexts to reduce database queries.
 * Uses in-memory caching with TTL (Time To Live) for automatic expiration.
 */
class PermissionCacheService {
  private cache: NodeCache;
  private readonly DEFAULT_TTL = 300; // 5 minutes
  private readonly STATS_INTERVAL = 60000; // Log stats every minute

  constructor() {
    this.cache = new NodeCache({
      stdTTL: this.DEFAULT_TTL,
      checkperiod: 60, // Check for expired keys every 60 seconds
      useClones: false, // Don't clone objects for better performance
      deleteOnExpire: true,
    });

    // Log cache statistics periodically
    if (process.env.NODE_ENV !== 'production') {
      setInterval(() => this.logStats(), this.STATS_INTERVAL);
    }

    // Listen to cache events
    this.cache.on('expired', (key, value) => {
      logger.debug(`Cache key expired: ${key}`);
    });

    this.cache.on('flush', () => {
      logger.info('Permission cache flushed');
    });
  }

  /**
   * Get user plan context from cache or database
   */
  async getUserPlanContext(userId: string): Promise<UserPlanContext> {
    const cacheKey = this.getPlanContextKey(userId);

    try {
      // Try to get from cache first
      const cached = this.cache.get<UserPlanContext>(cacheKey);
      if (cached) {
        logger.debug(`Cache HIT: ${cacheKey}`);
        return cached;
      }

      // Cache miss - fetch from database
      logger.debug(`Cache MISS: ${cacheKey}`);
      const planContext = await planService.getUserPlanContext(userId);

      // Store in cache
      this.cache.set(cacheKey, planContext);

      return planContext;
    } catch (error: any) {
      logger.error(`Error getting plan context from cache: ${error.message}`);
      // On error, bypass cache and fetch directly
      return await planService.getUserPlanContext(userId);
    }
  }

  /**
   * Get user permissions from cache or database
   */
  async getUserPermissions(userId: string): Promise<Permission[]> {
    const planContext = await this.getUserPlanContext(userId);
    return planContext.permissions;
  }

  /**
   * Check if user has a specific permission (cached)
   */
  async hasPermission(
    userId: string,
    permission: Permission
  ): Promise<boolean> {
    const permissions = await this.getUserPermissions(userId);
    return permissions.includes(permission);
  }

  /**
   * Check if user has any of the specified permissions (cached)
   */
  async hasAnyPermission(
    userId: string,
    permissions: Permission[]
  ): Promise<boolean> {
    const userPermissions = await this.getUserPermissions(userId);
    return permissions.some((p) => userPermissions.includes(p));
  }

  /**
   * Check if user has all of the specified permissions (cached)
   */
  async hasAllPermissions(
    userId: string,
    permissions: Permission[]
  ): Promise<boolean> {
    const userPermissions = await this.getUserPermissions(userId);
    return permissions.every((p) => userPermissions.includes(p));
  }

  /**
   * Invalidate cache for a specific user
   */
  invalidateUser(userId: string): void {
    const keys = [
      this.getPlanContextKey(userId),
      this.getPermissionsKey(userId),
    ];

    keys.forEach((key) => {
      const deleted = this.cache.del(key);
      if (deleted > 0) {
        logger.debug(`Invalidated cache key: ${key}`);
      }
    });
  }

  /**
   * Invalidate cache for multiple users
   */
  invalidateUsers(userIds: string[]): void {
    userIds.forEach((userId) => this.invalidateUser(userId));
    logger.info(`Invalidated cache for ${userIds.length} users`);
  }

  /**
   * Invalidate all users on a specific plan
   */
  async invalidatePlan(planSlug: string): Promise<void> {
    // Get all cache keys
    const keys = this.cache.keys();

    // Filter keys related to this plan (we'll need to check each cached value)
    const keysToDelete: string[] = [];

    keys.forEach((key) => {
      if (key.startsWith('plan_context:')) {
        const cached = this.cache.get<UserPlanContext>(key);
        if (cached && cached.planSlug === planSlug) {
          keysToDelete.push(key);
        }
      }
    });

    // Delete all matching keys
    this.cache.del(keysToDelete);
    logger.info(
      `Invalidated cache for plan ${planSlug}: ${keysToDelete.length} users`
    );
  }

  /**
   * Clear entire cache
   */
  flush(): void {
    this.cache.flushAll();
    logger.warn('Permission cache completely flushed');
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    keys: number;
    hits: number;
    misses: number;
    ksize: number;
    vsize: number;
    hitRate: number;
  } {
    const stats = this.cache.getStats();
    const total = stats.hits + stats.misses;
    const hitRate = total > 0 ? (stats.hits / total) * 100 : 0;

    return {
      keys: stats.keys,
      hits: stats.hits,
      misses: stats.misses,
      ksize: stats.ksize,
      vsize: stats.vsize,
      hitRate: Math.round(hitRate * 100) / 100,
    };
  }

  /**
   * Log cache statistics
   */
  private logStats(): void {
    const stats = this.getStats();
    logger.debug(
      `Permission Cache Stats: ${stats.keys} keys, ` +
        `${stats.hits} hits, ${stats.misses} misses, ` +
        `${stats.hitRate}% hit rate`
    );
  }

  /**
   * Set custom TTL for a specific user
   */
  setUserTTL(userId: string, ttl: number): void {
    const key = this.getPlanContextKey(userId);
    const cached = this.cache.get<UserPlanContext>(key);

    if (cached) {
      this.cache.set(key, cached, ttl);
      logger.debug(`Updated TTL for ${key} to ${ttl} seconds`);
    }
  }

  /**
   * Warm up cache for multiple users
   */
  async warmUp(userIds: string[]): Promise<void> {
    logger.info(`Warming up cache for ${userIds.length} users...`);

    const promises = userIds.map((userId) =>
      this.getUserPlanContext(userId).catch((err) => {
        logger.warn(
          `Failed to warm up cache for user ${userId}: ${err.message}`
        );
      })
    );

    await Promise.all(promises);
    logger.info('Cache warm-up completed');
  }

  /**
   * Get cache key for plan context
   */
  private getPlanContextKey(userId: string): string {
    return `plan_context:${userId}`;
  }

  /**
   * Get cache key for permissions
   */
  private getPermissionsKey(userId: string): string {
    return `permissions:${userId}`;
  }

  /**
   * Preload permissions for a user (useful for background jobs)
   */
  async preload(userId: string): Promise<void> {
    await this.getUserPlanContext(userId);
    logger.debug(`Preloaded permissions for user ${userId}`);
  }

  /**
   * Get TTL for a specific user's cache
   */
  getTTL(userId: string): number | undefined {
    const key = this.getPlanContextKey(userId);
    return this.cache.getTtl(key);
  }

  /**
   * Check if user's permissions are cached
   */
  isCached(userId: string): boolean {
    const key = this.getPlanContextKey(userId);
    return this.cache.has(key);
  }
}

// Export singleton instance
export const permissionCacheService = new PermissionCacheService();
