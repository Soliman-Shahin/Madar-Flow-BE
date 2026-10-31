import crypto from 'crypto';
import { NextFunction, Response } from 'express';
import { User, UserDocument } from '../models';
import { CustomRequest } from '../types/custom-request';
import mongoose from 'mongoose';
import { sendError } from '../shared/helper';

export const verifySession = async (
  req: CustomRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const refreshToken = req.header('refresh-token');
    const _id = req.header('_id');
    // Reject malformed credentials up front so internal errors (hashing/cast) never reach the client.
    if (!refreshToken || !_id || !mongoose.isValidObjectId(_id)) {
      return sendError(res, 'Missing or invalid session credentials', 401, 'SESSION_INVALID');
    }
    const user: UserDocument | null = await User.findByIdAndToken(
      _id,
      refreshToken
    );

    if (!user) {
      throw new Error(
        'User not found. Make sure that the refresh token and user id are correct'
      );
    }

    req.user_id = _id;
    req.userObject = user;
    req.refreshToken = refreshToken;

    const isSessionValid = user.sessions.some(
      (session: any) =>
        session.token ===
          crypto.createHash('sha256').update(refreshToken).digest('hex') &&
        !User.hasRefreshTokenExpired(session.expiresAt)
    );

    if (isSessionValid) {
      req.sessionId = user.sessions.find(
        (session: any) =>
          session.token ===
            crypto.createHash('sha256').update(refreshToken).digest('hex') &&
          !User.hasRefreshTokenExpired(session.expiresAt)
      )?.sessionId;
      next();
    } else {
      throw new Error('Refresh token has expired or the session is invalid');
    }
  } catch {
    sendError(res, 'Invalid or expired session', 401, 'SESSION_INVALID');
  }
};
