/**
 * Fields our middleware attaches to every request. Declaring them once removes the
 * `req.user_id` casts that bypassed type checking at the authentication boundary.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the access-token middleware after the session is verified. */
      user_id?: string;
      /** Session id (`sid`) of the verified access token. */
      sessionId?: string;
      /** Correlation id assigned by the request logger. */
      id?: string;
    }
  }
}

export {};
