export const MAX_SEARCH_LENGTH = 100;

/**
 * Turns user search input into a literal, length-capped pattern for a
 * MongoDB `$regex`. Regex metacharacters are escaped so input cannot inject
 * patterns (including catastrophic-backtracking ones). Returns null when there
 * is nothing to search for; non-string input (e.g. `?search=a&search=b`) is
 * ignored.
 */
export function safeSearchPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_SEARCH_LENGTH);
  if (!trimmed) return null;
  return trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SORT_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET_SORT_FIELDS = /password|session|token|hash|secret|salary/i;

/**
 * Client-supplied sort keys must never reach `.sort()` unchecked: `$`-operators crash the query
 * (500) and sorting by a secret field (password hash, session tokens) leaks its ordering.
 * With `allowed`, only listed fields pass; without it, only plain identifiers that do not look
 * secret. Anything else falls back to the default sort.
 */
export function safeSortField(raw: unknown, fallback: string, allowed?: readonly string[]): string {
  if (typeof raw !== 'string' || !SORT_FIELD_PATTERN.test(raw) || SECRET_SORT_FIELDS.test(raw)) {
    return fallback;
  }
  if (allowed && !allowed.includes(raw)) return fallback;
  return raw;
}
