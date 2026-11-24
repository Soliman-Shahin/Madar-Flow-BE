/**
 * Text scrubbing for error reports leaving the server (Sentry). Exception messages are free text
 * and routinely embed user data: Mongo duplicate-key errors quote the e-mail, CastError quotes the
 * submitted value, libraries echo URLs with tokens. Everything here is redaction, never enrichment.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g;
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;
const DUP_KEY = /dup key:\s*\{[^}]*\}/gi;
const CAST_VALUE = /(for value\s+)("[^"]*"|'[^']*'|\S+)/gi;
const URL_QUERY = /\?[^\s"'#)]*/g;

export function scrubText(input: string): string {
  return input
    .replace(DUP_KEY, 'dup key: [redacted]')
    .replace(CAST_VALUE, '$1[redacted]')
    .replace(BEARER, 'Bearer [token]')
    .replace(JWT, '[token]')
    .replace(EMAIL, '[email]')
    .replace(URL_QUERY, '')
    .replace(LONG_TOKEN, '[token]');
}

interface ScrubbableEvent {
  message?: string;
  logentry?: { message?: string; params?: unknown };
  exception?: { values?: Array<{ value?: string }> };
  request?: {
    url?: string;
    data?: unknown;
    cookies?: unknown;
    headers?: unknown;
    query_string?: unknown;
  };
  breadcrumbs?: unknown;
  extra?: unknown;
  user?: unknown;
}

/** Mutates and returns the event with every free-text field scrubbed and bulky context removed. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  if (event.logentry) {
    if (typeof event.logentry.message === 'string') {
      event.logentry.message = scrubText(event.logentry.message);
    }
    delete event.logentry.params;
  }
  for (const v of event.exception?.values ?? []) {
    if (typeof v.value === 'string') v.value = scrubText(v.value);
  }
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    if (typeof event.request.url === 'string') {
      event.request.url = event.request.url.replace(/[?#].*$/, '');
    }
  }
  delete event.breadcrumbs;
  delete event.extra;
  delete event.user;
  return event;
}
