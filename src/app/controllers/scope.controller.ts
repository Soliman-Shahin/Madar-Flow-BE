import { errorMessage, asError } from '../shared/errors';
import { Request, Response } from 'express';
import { scopeService } from '../services/scope.service';
import { PermissionScope } from '../types/permission-scopes.types';
import { sendSuccess, sendError } from '../shared/helper';
import { AuthenticatedRequest } from '../middleware/access.middleware';
import logger from '../services/logger.service';

/**
 * Scope Controller
 *
 * Handles HTTP requests for scope queries and management
 */
class ScopeController {
  /**
   * Get all available scopes with details
   * GET /api/v1/scopes
   */
  async getAllScopes(req: Request, res: Response): Promise<void> {
    try {
      const scopes = scopeService.getAllScopeDetails();
      sendSuccess(res, scopes, 'Scopes retrieved successfully');
    } catch (error: unknown) {
      logger.error('Error getting scopes:', asError(error));
      sendError(res, 'Failed to retrieve scopes', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get scopes by category
   * GET /api/v1/scopes/category/:category
   */
  async getScopesByCategory(req: Request, res: Response): Promise<void> {
    try {
      const rawCategory = req.params.category;
      const category = Array.isArray(rawCategory)
        ? rawCategory[0]
        : rawCategory;

      if (!['resource', 'admin', 'feature'].includes(category)) {
        return sendError(
          res,
          'Invalid category. Must be: resource, admin, or feature',
          400,
          'VALIDATION_ERROR'
        );
      }

      const scopes = scopeService.getScopesByCategory(
        category as 'resource' | 'admin' | 'feature'
      );

      sendSuccess(
        res,
        { category, scopes },
        `Scopes for category "${category}" retrieved successfully`
      );
    } catch (error: unknown) {
      logger.error('Error getting scopes by category:', asError(error));
      sendError(res, 'Failed to retrieve scopes', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get details for a specific scope
   * GET /api/v1/scopes/:scope
   */
  async getScopeDetails(req: Request, res: Response): Promise<void> {
    try {
      const rawScope = req.params.scope;
      const scope = Array.isArray(rawScope) ? rawScope[0] : rawScope;

      if (!Object.values(PermissionScope).includes(scope as PermissionScope)) {
        return sendError(res, 'Invalid scope', 400, 'VALIDATION_ERROR');
      }

      const details = scopeService.getScopeDetails(scope as PermissionScope);
      sendSuccess(res, details, 'Scope details retrieved successfully');
    } catch (error: unknown) {
      logger.error('Error getting scope details:', asError(error));
      sendError(res, 'Failed to retrieve scope details', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get current user's scopes
   * GET /api/v1/scopes/me
   */
  async getMyScopes(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user_id;

      if (!userId) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      const scopes = await scopeService.getUserScopes(userId);
      const scopeDetails = scopes.map((scope) =>
        scopeService.getScopeDetails(scope)
      );

      sendSuccess(
        res,
        { scopes, details: scopeDetails },
        'User scopes retrieved successfully'
      );
    } catch (error: unknown) {
      logger.error('Error getting user scopes:', asError(error));
      sendError(res, 'Failed to retrieve user scopes', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Check if current user has a specific scope
   * GET /api/v1/scopes/check/:scope
   */
  async checkScope(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user_id;
      const rawScope = req.params.scope;
      const scope = Array.isArray(rawScope) ? rawScope[0] : rawScope;

      if (!userId) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      if (!Object.values(PermissionScope).includes(scope as PermissionScope)) {
        return sendError(res, 'Invalid scope', 400, 'VALIDATION_ERROR');
      }

      const hasScope = await scopeService.userHasScope(
        userId,
        scope as PermissionScope
      );

      sendSuccess(
        res,
        { scope, hasScope },
        hasScope ? 'User has scope' : 'User does not have scope'
      );
    } catch (error: unknown) {
      logger.error('Error checking user scope:', asError(error));
      sendError(res, 'Failed to check user scope', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Get missing scopes for current user
   * POST /api/v1/scopes/missing
   * Body: { scopes: PermissionScope[] }
   */
  async getMissingScopes(req: Request, res: Response): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user_id;
      const { scopes } = req.body;

      if (!userId) {
        return sendError(res, 'Unauthorized', 401, 'AUTH_REQUIRED');
      }

      if (!Array.isArray(scopes) || scopes.length === 0) {
        return sendError(
          res,
          'scopes must be a non-empty array',
          400,
          'VALIDATION_ERROR'
        );
      }

      const missingScopes = await scopeService.getMissingScopes(userId, scopes);
      const missingScopeDetails = missingScopes.map((scope) =>
        scopeService.getScopeDetails(scope)
      );

      sendSuccess(
        res,
        {
          missingScopes,
          details: missingScopeDetails,
          suggestedPlan: scopeService.suggestPlanForScopes(missingScopes),
        },
        'Missing scopes retrieved successfully'
      );
    } catch (error: unknown) {
      logger.error('Error getting missing scopes:', asError(error));
      sendError(
        res,
        'Failed to retrieve missing scopes',
        500,
        'INTERNAL_ERROR'
      );
    }
  }

  /**
   * Expand a scope into permissions
   * GET /api/v1/scopes/:scope/expand
   */
  async expandScope(req: Request, res: Response): Promise<void> {
    try {
      const rawScope = req.params.scope;
      const scope = Array.isArray(rawScope) ? rawScope[0] : rawScope;

      if (!Object.values(PermissionScope).includes(scope as PermissionScope)) {
        return sendError(res, 'Invalid scope', 400, 'VALIDATION_ERROR');
      }

      const permissions = scopeService.expandScope(scope as PermissionScope);

      sendSuccess(
        res,
        { scope, permissions, count: permissions.length },
        'Scope expanded successfully'
      );
    } catch (error: unknown) {
      logger.error('Error expanding scope:', asError(error));
      sendError(res, 'Failed to expand scope', 500, 'INTERNAL_ERROR');
    }
  }
}

export const scopeController = new ScopeController();
