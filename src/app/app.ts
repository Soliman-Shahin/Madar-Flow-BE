import logger from './services/logger.service';
import express from 'express';
import passport from 'passport';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.config';
import { BRAND } from './config/brand.config';
import { conditionalCsrfProtection } from './middleware/csrf.middleware';
import routes from './routes';
import healthRoutes from './routes/health.route';
import accountPageRoutes from './routes/account-page.route';
import { enhancedErrorHandler } from './middleware/error-handler-enhanced';
// Import sync middleware to apply them to the correct routes only
import {
  trackSyncOperation,
  handleSyncError,
  validateSyncData,
  rateLimitSync,
  addSyncHeaders,
} from './middleware/sync.middleware';

import { corsOptions } from './config/corsConfig';
import './config/passport-config';
import dotenv from 'dotenv';
import { advancedEncryptionMiddleware } from './middleware/encryption-advanced.middleware';
import mongoSanitize from 'express-mongo-sanitize';
import { requestLogger } from './middleware/request-logger.middleware';

dotenv.config();
function configureExpressApp(): express.Application {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';

  // Needed for secure cookies when behind a proxy (Railway/Render/Heroku)
  app.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: false,
    })
  );

  // Enable gzip compression for all responses
  app.use(compression());

  // Request/Response logging
  app.use(requestLogger);

  app.use(passport.initialize());

  // Public HTML account pages (Google Play account-deletion URL). Mounted
  // before CORS/CSRF/encryption; see routes/account-page.route.ts.
  app.use('/account', accountPageRoutes);

  app.use(cors(corsOptions));
  app.options(/^.*$/, cors(corsOptions));

  // Add COOP headers to allow OAuth popup communication
  app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    next();
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use(cookieParser());

  // Sanitize data to prevent NoSQL injection
  // Note: Using direct sanitize() call instead of middleware because req.query
  // is a read-only getter in this Express version and the middleware crashes trying to reassign it.
  app.use((req: any, _res: any, next: any) => {
    if (req.body) mongoSanitize.sanitize(req.body);
    if (req.params) mongoSanitize.sanitize(req.params);
    next();
  });

  // Encryption Middleware (supports both full payload and field-level encryption)
  app.use(advancedEncryptionMiddleware);

  // Sync middleware is scoped to /v1/sync/* routes only (see routes/index.ts)

  // API Documentation (Swagger UI)
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: `${BRAND.productName} API Docs`,
    })
  );

  // CSRF Protection (conditional - skips Bearer token routes and OAuth)
  app.use(conditionalCsrfProtection);

  // Add health routes outside of /v1 and inside /v1 just in case
  app.use('/health', healthRoutes);
  app.use('/v1/health', healthRoutes);

  app.use('/v1', routes);
  app.use(handleSyncError);

  // 404 Handler
  app.use((req, res, next) => {
    res.status(404).json({ success: false, message: 'Endpoint not found' });
  });

  app.use(enhancedErrorHandler);

  return app;
}

export { configureExpressApp };
