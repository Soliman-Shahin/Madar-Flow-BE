import { Request, Response } from 'express';
import { omit } from 'lodash';
import { UserDocument } from '../../models';
import { sendSuccess } from './api-response';
import { UserService } from '../../services/user.service';
import { clientPlatform, describeDevice } from '../../utils/device.util';

// Helper function for sending user and tokens
const sendUserAndTokens = async (
  res: Response,
  user: UserDocument,
  authenticationMethod: 'biometric' = 'biometric',
  req?: Request
) => {
  // Without the request the session falls back to "web", which is wrong for
  // a phone that signed in with its fingerprint.
  const tokens = await UserService.createAuthenticatedSession(
    user,
    authenticationMethod,
    req ? clientPlatform(req) : 'web',
    req ? describeDevice(req) : undefined
  );
  const userResponse = {
    user: omit(user.toJSON(), ['password', 'sessions']),
    tokens,
  };
  sendSuccess(res, userResponse, 'Authentication successful');
};

export { sendUserAndTokens };
