import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { sendError } from '../shared/helper';
import logger from '../utils/logger';
import { User, UserRole } from '../models';

// Use ACCESS_TOKEN_SECRET from .env (must match token generation)
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;

if (!ACCESS_TOKEN_SECRET) {
  throw new Error('ACCESS_TOKEN_SECRET is required in environment variables');
}

// Export the interface so other files can use it
export interface AuthenticatedRequest extends Request {
  user_id?: string;
  sessionId?: string;
  user?: { _id: string; email?: string; role?: UserRole };
}

export const verifyAccessToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Missing or invalid Authorization header');
      return sendError(
        res,
        'Missing or invalid Authorization header',
        401,
        'AUTH_MISSING_OR_INVALID_HEADER'
      );
    }
    const token = authHeader.split(' ')[1];

    if (!token) {
      logger.warn('No token provided');
      return sendError(res, 'No token provided', 401, 'AUTH_NO_TOKEN');
    }

    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET) as any;

    if (
      typeof payload._id !== 'string' ||
      !payload._id ||
      typeof payload.sid !== 'string' ||
      !payload.sid
    ) {
      logger.error('Invalid token payload - missing _id');
      return sendError(
        res,
        'Invalid or expired access token',
        401,
        'AUTH_INVALID_TOKEN'
      );
    }

    // Check database to ensure user is not deactivated or deleted
    const userDoc = await User.findById(payload._id)
      .select('isActive _isDeleted role sessions')
      .lean();

    if (!userDoc) {
      logger.error('Token valid but user not found in database');
      return sendError(res, 'User not found', 401, 'AUTH_USER_NOT_FOUND');
    }

    if (userDoc._isDeleted || userDoc.isActive === false) {
      logger.error(`Access denied for inactive/deleted user: ${payload._id}`);
      return sendError(
        res,
        'Account is inactive or deleted',
        401,
        'AUTH_USER_INACTIVE'
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const sessionIsValid = userDoc.sessions?.some(
      (session) => session.sessionId === payload.sid && session.expiresAt > now
    );
    if (!sessionIsValid) {
      return sendError(
        res,
        'Invalid or expired access token',
        401,
        'AUTH_INVALID_TOKEN'
      );
    }

    // Attach user id and user object to request for downstream use
    authReq.user_id = payload._id;
    authReq.sessionId = payload.sid;
    authReq.user = {
      _id: payload._id,
      email: payload.email,
      role: userDoc.role as UserRole,
    };

    logger.debug('JWT verified successfully for user:', payload._id);

    next();
  } catch (err: unknown) {
    const error = err as Error;
    logger.error('JWT verification failed:', error.message);
    return sendError(
      res,
      'Invalid or expired access token',
      401,
      'AUTH_INVALID_TOKEN'
    );
  }
};
