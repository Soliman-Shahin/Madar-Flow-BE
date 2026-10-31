import { Router } from 'express';
import { scopeController } from '../controllers/scope.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import { requireAdmin } from '../middleware/admin.middleware';

const router = Router();

// All scope routes require authentication
router.use(verifyAccessToken);

// ==================== PUBLIC SCOPE QUERIES (Authenticated Users) ====================

/**
 * Get current user's scopes
 */
router.get('/me', scopeController.getMyScopes.bind(scopeController));

/**
 * Check if current user has a specific scope
 */
router.get('/check/:scope', scopeController.checkScope.bind(scopeController));

/**
 * Get missing scopes for current user
 * Body: { scopes: PermissionScope[] }
 */
router.post('/missing', scopeController.getMissingScopes.bind(scopeController));

// ==================== SCOPE INFORMATION (Admin+) ====================

/**
 * Get all available scopes with details
 */
router.get(
  '/',
  requireAdmin,
  scopeController.getAllScopes.bind(scopeController)
);

/**
 * Get scopes by category (resource, admin, feature)
 */
router.get(
  '/category/:category',
  requireAdmin,
  scopeController.getScopesByCategory.bind(scopeController)
);

/**
 * Get details for a specific scope
 */
router.get(
  '/:scope',
  requireAdmin,
  scopeController.getScopeDetails.bind(scopeController)
);

/**
 * Expand a scope into its constituent permissions
 */
router.get(
  '/:scope/expand',
  requireAdmin,
  scopeController.expandScope.bind(scopeController)
);

export default router;
