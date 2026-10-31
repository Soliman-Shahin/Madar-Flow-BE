const MIN_ENCRYPTION_KEY_LENGTH = 32;

/** Validate passphrase material before PBKDF2 derives the AES key. */
export function validateEncryptionKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('ENCRYPTION_KEY must be configured for production.');
  }
  const normalized = key.trim();
  if (normalized.length < MIN_ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must contain at least ${MIN_ENCRYPTION_KEY_LENGTH} characters for production.`
    );
  }
  if (
    /^(.)\1+$/.test(normalized) ||
    /^(change[-_ ]?me|your[-_ ]|placeholder)/i.test(normalized)
  ) {
    throw new Error(
      'ENCRYPTION_KEY must not use a placeholder or trivial value.'
    );
  }
  return normalized;
}
