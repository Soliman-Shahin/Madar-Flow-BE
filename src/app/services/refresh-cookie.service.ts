import { Request, Response } from 'express';

export const REFRESH_COOKIE_NAME = 'mf_refresh';
const REFRESH_COOKIE_PATHS = new Set(['/v1/user', '/api/v1/user']);

function refreshCookiePath(req: Request): string {
  const requested = req.get('x-auth-cookie-path') || '';
  return REFRESH_COOKIE_PATHS.has(requested) ? requested : '/v1/user';
}

export function usesHttpOnlyRefreshCookie(req: Request): boolean {
  return req.get('x-auth-transport') === 'cookie' ||
    typeof req.cookies?.[REFRESH_COOKIE_NAME] === 'string';
}

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const,
    path: refreshCookiePath(req),
    ...(req.get('x-auth-persistence') === 'persistent'
      ? { maxAge: refreshCookieLifetimeMs() }
      : {}),
  };
}

function refreshCookieLifetimeMs(): number {
  const configured = Number.parseInt(process.env.REFRESH_TOKEN_EXPIRY_DAYS || '10', 10);
  const days = Number.isFinite(configured) && configured > 0 ? configured : 10;
  return days * 24 * 60 * 60 * 1000;
}

export function setRefreshCookie(req: Request, res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, cookieOptions(req));
}

export function clearRefreshCookie(req: Request, res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions(req));
}
