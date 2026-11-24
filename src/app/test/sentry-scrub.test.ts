import { scrubEvent, scrubText } from '../shared/sentry-scrub';

describe('sentry scrubbing', () => {
  it('redacts Mongo duplicate-key values (they quote the e-mail)', () => {
    const msg =
      'E11000 duplicate key error collection: madarflow.users index: email_1 dup key: { email: "jane@example.com" }';
    const out = scrubText(msg);
    expect(out).not.toContain('jane@example.com');
    expect(out).toContain('dup key: [redacted]');
  });

  it('redacts CastError values', () => {
    const out = scrubText(
      'Cast to ObjectId failed for value "secret-input-123" (type string) at path "_id"'
    );
    expect(out).not.toContain('secret-input-123');
  });

  it('redacts e-mails, bearer tokens, JWTs and long tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz';
    const out = scrubText(
      `user a.b+c@mail.co failed; Authorization: Bearer abc.def-ghi; jwt ${jwt}; key ${'k'.repeat(40)}`
    );
    expect(out).not.toMatch(/@mail\.co/);
    expect(out).not.toContain('abc.def-ghi');
    expect(out).not.toContain('eyJhbGci');
    expect(out).not.toContain('kkkkkkkkkkkkkkkkkkkk');
  });

  it('strips query strings from URLs', () => {
    expect(scrubText('GET /v1/reset?token=abc123 failed')).not.toContain('abc123');
  });

  it('keeps ordinary diagnostics readable', () => {
    expect(scrubText('Cannot read properties of undefined (reading "name")')).toBe(
      'Cannot read properties of undefined (reading "name")'
    );
  });

  it('scrubs a whole event: exception text, url, breadcrumbs, extra, user, request body', () => {
    const event = scrubEvent({
      message: 'boom for jane@example.com',
      exception: { values: [{ value: 'dup key: { email: "x@y.zz" }' }] },
      request: {
        url: 'https://flow-api.orbit-madar.com/v1/x?token=SECRET',
        data: { password: 'p' },
        headers: { authorization: 'Bearer t' },
        cookies: { sid: 's' },
        query_string: 'token=SECRET',
      },
      breadcrumbs: [{ message: 'login jane@example.com' }],
      extra: { amount: 100 },
      user: { email: 'jane@example.com' },
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain('jane@example.com');
    expect(json).not.toContain('x@y.zz');
    expect(json).not.toContain('SECRET');
    expect(event.request?.url).toBe('https://flow-api.orbit-madar.com/v1/x');
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.user).toBeUndefined();
  });
});
