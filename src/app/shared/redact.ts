/**
 * Redacts credential-like values before they are persisted (audit logs) or returned.
 * Matching is by key name, case-insensitive, at any depth.
 */
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|api[-_]?key|private[-_]?key|otp|cookie)/i;
const REDACTED = '[REDACTED]';

export function redactSensitive<T>(value: T, depth = 0): T {
  if (value === null || value === undefined || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1)) as unknown as T;
  if (value instanceof Date || typeof value !== 'object') return value;
  // Mongoose ids and other non-plain objects are kept as they are.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) && child !== null && child !== undefined && child !== ''
      ? REDACTED
      : redactSensitive(child, depth + 1);
  }
  return out as T;
}
