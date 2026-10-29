import { Router } from 'express';
import { appSettingsController } from '../controllers/app-settings.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import {
  requireAdmin,
  requireSuperAdmin,
} from '../middleware/admin.middleware';

/** GET /v1/app-settings — public, no authentication. */
export const appSettingsPublicRoutes = Router();
appSettingsPublicRoutes.get(
  '/',
  appSettingsController.getPublic.bind(appSettingsController)
);

/**
 * /v1/admin/app-settings
 * - GET: Admin and above can read the full document.
 * - PUT: SuperAdmin only (this content is shown to every user, including the
 *   legal documents).
 */
export const appSettingsAdminRoutes = Router();
appSettingsAdminRoutes.use(verifyAccessToken);
appSettingsAdminRoutes.get(
  '/',
  requireAdmin,
  appSettingsController.getForAdmin.bind(appSettingsController)
);
appSettingsAdminRoutes.put(
  '/',
  requireSuperAdmin,
  appSettingsController.update.bind(appSettingsController)
);
