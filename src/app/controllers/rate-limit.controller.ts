import { errorMessage, asError } from '../shared/errors';
import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/access.middleware';
import { getRateLimitInfo } from '../middleware/role-rate-limit.middleware';
import { sendSuccess, sendError } from '../shared/helper';
import logger from '../services/logger.service';

/**
 * Rate Limit Controller
 *
 * Provides information about rate limits for users
 */
class RateLimitController {
  /**
   * Get current user's rate limit info
   * GET /api/v1/rate-limits/me
   */
  async getMyRateLimits(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const userRole = authReq.user?.role;

      if (!userRole) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      const limitInfo = getRateLimitInfo(userRole);

      sendSuccess(
        res,
        {
          role: userRole,
          limits: {
            windowMs: limitInfo.windowMs,
            windowMinutes: Math.floor(limitInfo.windowMs / 60000),
            maxRequests: limitInfo.max,
            requestsPerMinute: Math.floor(
              limitInfo.max / (limitInfo.windowMs / 60000)
            ),
          },
          headers: {
            'X-RateLimit-Limit': limitInfo.max,
            'X-RateLimit-Window': limitInfo.windowMs,
          },
        },
        'Rate limit information retrieved successfully'
      );
    } catch (error: unknown) {
      logger.error('Error getting rate limits:', asError(error));
      sendError(res, 'Failed to retrieve rate limits', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get rate limit status for current user
   * GET /api/v1/rate-limits/status
   */
  async getRateLimitStatus(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const userRole = authReq.user?.role;

      if (!userRole) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      // Get rate limit headers from the request (set by rate limiter)
      const limit = req.get('X-RateLimit-Limit');
      const remaining = req.get('X-RateLimit-Remaining');
      const reset = req.get('X-RateLimit-Reset');

      const limitInfo = getRateLimitInfo(userRole);

      sendSuccess(
        res,
        {
          role: userRole,
          limit: limit ? parseInt(limit, 10) : limitInfo.max,
          remaining: remaining ? parseInt(remaining, 10) : null,
          reset: reset ? new Date(parseInt(reset, 10) * 1000) : null,
          windowMs: limitInfo.windowMs,
        },
        'Rate limit status retrieved successfully'
      );
    } catch (error: unknown) {
      logger.error('Error getting rate limit status:', asError(error));
      sendError(
        res,
        'Failed to retrieve rate limit status',
        500,
        'INTERNAL_ERROR'
      );
    }
  }
}

export const rateLimitController = new RateLimitController();
