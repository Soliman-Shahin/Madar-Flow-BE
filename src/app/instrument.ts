/**
 * Sentry error monitoring. MUST be the first import of the process entry point
 * (server.ts) so the SDK can instrument Express/HTTP/Mongo before they load.
 *
 * Enabled only when SENTRY_DSN is set (production/staging); local runs and tests send nothing.
 * Errors only: no tracing, no profiling, no session data.
 *
 * Privacy: this is a finance app. Request bodies, cookies, auth headers, query strings and
 * user identity are stripped before anything leaves the server.
 */
import { config } from 'dotenv';
import * as Sentry from '@sentry/node';

config();

const dsn = process.env.SENTRY_DSN?.trim();

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    // SDK v11 collects headers, cookies, bodies and query params by default: switch it all off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    tracesSampleRate: 0,
    beforeSend(event, hint) {
      // Expected client errors (validation, auth, 404...) are not incidents: don't spend quota on them.
      const original = hint?.originalException as
        | { statusCode?: unknown; status?: unknown }
        | undefined;
      const status = Number(original?.statusCode ?? original?.status);
      if (Number.isFinite(status) && status >= 400 && status < 500) return null;

      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
      }
      delete event.user;
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      // HTTP breadcrumbs can carry URLs with tokens/ids; keep the category only.
      if (breadcrumb.category === 'http' || breadcrumb.category === 'fetch') {
        return { ...breadcrumb, data: undefined };
      }
      return breadcrumb;
    },
  });
}
