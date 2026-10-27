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
