import { Request, Response, NextFunction } from 'express';
import csrf from 'csurf';

/**
 * CSRF Protection Middleware
 *
 * Protects against Cross-Site Request Forgery attacks for session-based routes.
 * API routes using Bearer tokens are exempt as they have built-in CSRF protection.
 *
 * IMPORTANT: This middleware should NOT be applied to:
 * - OAuth callback routes (/auth/google/callback, /auth/facebook/callback)
 * - API routes using JWT Bearer tokens
 * - Mobile app endpoints
 */

// Create CSRF protection middleware
const csrfCookiePath = (req: Request) =>
  req.get('x-auth-cookie-path') === '/api/v1/user' ? '/api/v1' : '/v1';

const runCsrfProtection = (req: Request, res: Response, next: NextFunction) =>
  csrf({
    cookie: {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: csrfCookiePath(req),
    },
  })(req, res, next);

/**
 * Conditional CSRF middleware
 * Only applies CSRF protection to routes that need it
 */
export const conditionalCsrfProtection = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Refresh cookies are ambient credentials, so their rotation and revocation
  // must use a CSRF token even though native clients keep the explicit-body flow.
  const refreshPaths = ['/v1/user/refresh-token', '/v1/user/logout'];
  const usesRefreshCookie =
    typeof req.cookies?.mf_refresh === 'string' ||
    (req.get('x-auth-transport') === 'cookie' && refreshPaths.includes(req.path));
  if (usesRefreshCookie && refreshPaths.includes(req.path)) {
    return runCsrfProtection(req, res, next);
  }

  // Skip CSRF for API routes using explicit Bearer credentials.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return next();
  }

  // Skip CSRF for OAuth callbacks
  const exemptPaths = [
    '/v1/user/auth/google/callback',
    '/v1/user/auth/facebook/callback',
    '/v1/user/auth/google/native',
    '/v1/user/auth/google/exchange',
    '/v1/user/google',
    '/v1/user/facebook',
    '/v1/user/login',
    // Email sign-up returns tokens in the body (no session cookie), like login.
    '/v1/user/signup',
    '/v1/user/verify-otp',
    '/v1/user/resend-otp',
    '/v1/user/password/forgot',
    '/v1/user/password/reset',
    '/v1/user/biometric/signin',
    '/v1/user/refresh-token',
    '/api-docs',
  ];

  if (!usesRefreshCookie && exemptPaths.some((path) => req.path.includes(path))) {
    return next();
  }

  // Skip CSRF for GET, HEAD, OPTIONS (safe methods)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Apply CSRF protection for other routes
  runCsrfProtection(req, res, next);
};

/**
 * CSRF Token endpoint
 * Provides CSRF token to clients that need it
 */
export const getCsrfToken = (req: Request, res: Response) => {
  res.json({
    csrfToken: (req as any).csrfToken?.() || null,
  });
};

export const issueCsrfToken = (req: Request, res: Response, next: NextFunction) =>
  runCsrfProtection(req, res, (error?: unknown) => {
    if (error) return next(error);
    return res.json({ csrfToken: (req as any).csrfToken() });
  });

export default {
  conditionalCsrfProtection,
  getCsrfToken,
};
