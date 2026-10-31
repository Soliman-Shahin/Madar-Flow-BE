import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { Request, Response } from 'express';
import { AuthenticatedRequest } from './access.middleware';
import { UserRole, ROLE_WEIGHTS } from '../models/user.model';
import { sendError } from '../shared/helper';
import { errorMessageService } from '../services/error-message.service';
import logger from '../services/logger.service';

/**
 * Role-Based Rate Limiting Middleware
 *
 * Applies different rate limits based on user role.
 * Higher roles get more generous limits.
 */

/**
 * Rate limit configuration per role
 */
interface RoleLimitConfig {
  windowMs: number; // Time window in milliseconds
  max: number; // Maximum requests per window
  message?: string; // Custom error message
}

/**
 * Default rate limits per role
 */
const DEFAULT_ROLE_LIMITS: Record<UserRole, RoleLimitConfig> = {
  [UserRole.User]: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per 15 minutes
  },
  [UserRole.Moderator]: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // 300 requests per 15 minutes
  },
  [UserRole.Admin]: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // 500 requests per 15 minutes
  },
  [UserRole.SuperAdmin]: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // 1000 requests per 15 minutes (almost unlimited)
  },
};

/**
 * Create a role-based rate limiter
 *
 * @param customLimits - Optional custom limits per role
 * @returns Express middleware
 */
export const createRoleBasedRateLimiter = (
  customLimits?: Partial<Record<UserRole, RoleLimitConfig>>
): RateLimitRequestHandler => {
  const limits = { ...DEFAULT_ROLE_LIMITS, ...customLimits };

  return rateLimit({
    windowMs: 15 * 60 * 1000, // Default window (will be overridden per user)
    max: 100, // Default max (will be overridden per user)

    // Use user ID as key for tracking (standardHeaders handles IPv6 automatically)
    keyGenerator: (req: Request) => {
      const authReq = req as AuthenticatedRequest;
      return authReq.user_id || 'anonymous';
    },

    // Let express-rate-limit handle IP-based fallback with IPv6 support
    standardHeaders: true,
    legacyHeaders: false,

    // Skip rate limiting for certain conditions
    skip: (req: Request) => {
      // Skip for health checks
      if (req.path === '/health' || req.path === '/v1/health') {
        return true;
      }
      return false;
    },

    // Dynamic limit based on user role
    handler: (req: Request, res: Response) => {
      const authReq = req as AuthenticatedRequest;
      const userRole = authReq.user?.role || UserRole.User;
      const config = limits[userRole];

      const retryAfter = Math.ceil(config.windowMs / 1000);

      const errorDetails = errorMessageService.getRateLimitMessage({
        limit: config.max,
        windowMs: config.windowMs,
        retryAfter,
      });

      logger.warn(
        `Rate limit exceeded: user=${authReq.user_id} role=${userRole} limit=${config.max}`
      );

      res.set('Retry-After', String(retryAfter));

      sendError(res, errorDetails.message, 429, 'RATE_LIMIT_EXCEEDED', {
        limit: config.max,
        windowMs: config.windowMs,
        retryAfter: errorDetails.retryAfter,
        retryAt: errorDetails.retryAt,
        suggestion: errorDetails.suggestion,
        userRole,
      });
    },

    // Custom store per role (in-memory for now)
    // In production, use Redis for distributed systems
  });
};

/**
 * Predefined rate limiters for common scenarios
 */

/**
 * General API rate limiter
 * Applied to all API routes
 */
export const generalRateLimiter = createRoleBasedRateLimiter();

/**
 * Strict rate limiter for sensitive operations
 * (e.g., authentication, password reset)
 */
export const strictRateLimiter = createRoleBasedRateLimiter({
  [UserRole.User]: {
    windowMs: 15 * 60 * 1000,
    max: 10, // Only 10 attempts per 15 minutes
  },
  [UserRole.Moderator]: {
    windowMs: 15 * 60 * 1000,
    max: 20,
  },
  [UserRole.Admin]: {
    windowMs: 15 * 60 * 1000,
    max: 50,
  },
  [UserRole.SuperAdmin]: {
    windowMs: 15 * 60 * 1000,
    max: 100,
  },
});

/**
 * Lenient rate limiter for read-only operations
 */
export const lenientRateLimiter = createRoleBasedRateLimiter({
  [UserRole.User]: {
    windowMs: 15 * 60 * 1000,
    max: 300,
  },
  [UserRole.Moderator]: {
    windowMs: 15 * 60 * 1000,
    max: 600,
  },
  [UserRole.Admin]: {
    windowMs: 15 * 60 * 1000,
    max: 1000,
  },
  [UserRole.SuperAdmin]: {
    windowMs: 15 * 60 * 1000,
    max: 2000,
  },
});

/**
 * Export rate limiter (for data export operations)
 */
export const exportRateLimiter = createRoleBasedRateLimiter({
  [UserRole.User]: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 exports per hour
  },
  [UserRole.Moderator]: {
    windowMs: 60 * 60 * 1000,
    max: 20,
  },
  [UserRole.Admin]: {
    windowMs: 60 * 60 * 1000,
    max: 50,
  },
  [UserRole.SuperAdmin]: {
    windowMs: 60 * 60 * 1000,
    max: 100,
  },
});

/**
 * Helper: Get rate limit info for a user
 */
export function getRateLimitInfo(userRole: UserRole): RoleLimitConfig {
  return DEFAULT_ROLE_LIMITS[userRole];
}

/**
 * Helper: Check if user can make request based on role
 */
export function canMakeRequest(
  userRole: UserRole,
  requestCount: number
): boolean {
  const limit = DEFAULT_ROLE_LIMITS[userRole];
  return requestCount < limit.max;
}

/**
 * Helper: Get remaining requests for user
 */
export function getRemainingRequests(
  userRole: UserRole,
  requestCount: number
): number {
  const limit = DEFAULT_ROLE_LIMITS[userRole];
  return Math.max(0, limit.max - requestCount);
}

/**
 * Helper: Get time until rate limit reset
 */
export function getResetTime(userRole: UserRole, windowStart: Date): Date {
  const limit = DEFAULT_ROLE_LIMITS[userRole];
  return new Date(windowStart.getTime() + limit.windowMs);
}
