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
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  },
});

/**
 * Conditional CSRF middleware
 * Only applies CSRF protection to routes that need it
 */
export const conditionalCsrfProtection = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Skip CSRF for API routes with Bearer token
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
    // Logout authenticates using an explicit body credential, never ambient cookies.
    '/v1/user/logout',
    '/api-docs',
  ];

  if (exemptPaths.some((path) => req.path.includes(path))) {
    return next();
  }

  // Skip CSRF for GET, HEAD, OPTIONS (safe methods)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Apply CSRF protection for other routes
  csrfProtection(req, res, next);
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

export default {
  conditionalCsrfProtection,
  getCsrfToken,
};
