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

/**
 * True when a parsed JSON value nests deeper than `max` levels. Iterative on purpose: a recursive
 * walk (including mongo-sanitize's) overflows the stack on a hostile payload and turns into a 500.
 */
export function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (node === null || typeof node !== 'object') continue;
    if (depth > max) return true;
    for (const child of Object.values(node as Record<string, unknown>)) stack.push([child, depth + 1]);
  }
  return false;
}
