import { validateEncryptionKey } from './encryption-config';

describe('encryption key configuration', () => {
  it('rejects missing and clearly weak values without exposing them', () => {
    for (const value of [
      undefined,
      '',
      'short',
      'x'.repeat(32),
      'change-me-' + 'x'.repeat(24),
    ]) {
      expect(() => validateEncryptionKey(value)).toThrow(/ENCRYPTION_KEY/);
      try {
        validateEncryptionKey(value);
      } catch (error) {
        if (value) expect(String(error)).not.toContain(value);
      }
    }
  });

  it('accepts non-placeholder passphrase material without requiring hex', () => {
    const value = 'synthetic test passphrase with enough length';
    expect(validateEncryptionKey(value)).toBe(value);
  });
});
