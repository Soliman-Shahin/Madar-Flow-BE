import { describe, it, expect, jest } from '@jest/globals';
import { verifySession } from '../middleware/auth.middleware';

function run(headers: Record<string, string>) {
  const req: any = { header: (n: string) => headers[n] };
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
  const next = jest.fn();
  return verifySession(req, res, next as any).then(() => ({ res, next }));
}

describe('verifySession (legacy header session)', () => {
  it('rejects missing headers with a generic 401 and never leaks internals', async () => {
    const { res, next } = await run({});
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INVALID');
    expect(JSON.stringify(res.body)).not.toMatch(/data|argument|Buffer|undefined/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a malformed user id without a cast-error message', async () => {
    const { res } = await run({ 'refresh-token': 'x', _id: 'not-an-object-id' });
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/cast|ObjectId/i);
  });

  it('rejects an unknown session with the generic message', async () => {
    const { res } = await run({ 'refresh-token': 'x', _id: '507f1f77bcf86cd799439011' });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired session');
  });
});
