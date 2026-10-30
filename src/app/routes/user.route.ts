import { Request, RequestHandler, Response, Router } from 'express';
import crypto from 'crypto';
import passport from 'passport';
import { GoogleOAuthExchange, User } from '../models';
import https from 'https';
import { sendSuccess } from '../shared/helper';
import logger from '../utils/logger';
import {
  login,
  signUp,
  userAccessToken,
  refreshToken,
  logout,
  getMe,
  updateMe,
  deleteMe,
  uploadAvatar,
  requestPasswordReset,
  resetPassword,
  enrollBiometric,
  biometricSignIn,
  revokeCurrentBiometric,
} from '../controllers';
import { UserService } from '../services/user.service';
import {
  setRefreshCookie,
  usesHttpOnlyRefreshCookie,
} from '../services/refresh-cookie.service';
import { issueCsrfToken } from '../middleware/csrf.middleware';
import { AuthenticatedRequest, verifyAccessToken } from '../middleware/access.middleware';
import { validateRequestWithZod, verifySession } from '../middleware';
import { loginSchema, signUpSchema } from '../validations/user.validation';
import multer from 'multer';
import {
  strictAuthRateLimiter,
  biometricAuthRateLimiter,
} from '../middleware/rate-limit.middleware';
import {
  biometricEnrollSchema,
  biometricSignInSchema,
  biometricRevokeSchema,
} from '../validations/biometric.validation';
import { checkBruteForce } from '../middleware/brute-force.middleware';
import {
  assertNewAccountConsent,
  consentFields,
} from '../config/consent.config';
import {
  GOOGLE_OAUTH_EXCHANGE_PURPOSE,
  GOOGLE_OAUTH_EXCHANGE_TTL_SECONDS,
} from '../models/google-oauth-exchange.model';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/**
 * @swagger
 * /user/signup:
 *   post:
 *     tags:
 *       - Authentication
 *     summary: Register a new user
 *     description: Create a new user account with email and password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - termsAccepted
 *               - privacyAccepted
 *               - termsVersion
 *               - privacyVersion
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *               termsAccepted:
 *                 type: boolean
 *                 enum: [true]
 *               privacyAccepted:
 *                 type: boolean
 *                 enum: [true]
 *               termsVersion:
 *                 type: string
 *               privacyVersion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Signup successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   required: [user, accessToken, refreshToken]
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: User already exists
 */
// Routes for local authentication with rate limiting and brute force protection
router.post(
  '/signup',
  strictAuthRateLimiter,
  checkBruteForce,
  validateRequestWithZod(signUpSchema),
  signUp
);

/**
 * @swagger
 * /user/login:
 *   post:
 *     tags:
 *       - Authentication
 *     summary: Login user
 *     description: Authenticate user with email and password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: '{{password}}'
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                 message:
 *                   type: string
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many login attempts
 */
router.post(
  '/login',
  strictAuthRateLimiter,
  checkBruteForce,
  validateRequestWithZod(loginSchema),
  login
);
router.post('/refresh-token', strictAuthRateLimiter, refreshToken);
router.post('/logout', strictAuthRateLimiter, logout);
router.get('/csrf-token', issueCsrfToken);
router.get('/sessions', verifyAccessToken, async (req: Request, res: Response) => {
  const auth = req as AuthenticatedRequest;
  const user = await User.findById(auth.user_id).select('sessions').lean();
  const now = Math.floor(Date.now() / 1000);
  const sessions = (user?.sessions || [])
    .filter((session: any) => session.expiresAt > now)
    .map((session: any) => ({
      id: session.sessionId,
      platform: session.platform || 'web',
      createdAt: session.createdAt || null,
      lastAuthenticatedAt: session.lastAuthenticatedAt || session.createdAt || null,
      expiresAt: session.expiresAt,
      current: session.sessionId === auth.sessionId,
    }));
  return res.json({ success: true, data: { sessions } });
});
router.delete('/sessions/others', verifyAccessToken, async (req: Request, res: Response) => {
  const auth = req as AuthenticatedRequest;
  const result = await User.updateOne(
    { _id: auth.user_id },
    { $pull: { sessions: { sessionId: { $ne: auth.sessionId } } } }
  );
  return res.json({ success: true, data: { revoked: result.modifiedCount > 0 } });
});
router.delete('/sessions/:sessionId', verifyAccessToken, async (req: Request, res: Response) => {
  const auth = req as AuthenticatedRequest;
  if (!req.params.sessionId || req.params.sessionId === auth.sessionId) {
    return res.status(400).json({ success: false, message: 'Current session must use logout' });
  }
  const result = await User.updateOne(
    { _id: auth.user_id },
    { $pull: { sessions: { sessionId: req.params.sessionId } } }
  );
  return res.json({ success: true, data: { revoked: result.modifiedCount > 0 } });
});
router.post(
  '/auth/google/exchange',
  strictAuthRateLimiter,
  async (req: Request, res: Response) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!/^[a-f0-9]{64}$/.test(code)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid or expired exchange code' });
    }

    const exchange = await GoogleOAuthExchange.findOneAndUpdate(
      {
        codeHash: crypto.createHash('sha256').update(code).digest('hex'),
        purpose: GOOGLE_OAUTH_EXCHANGE_PURPOSE,
        consumedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { consumedAt: new Date() } },
      { new: true }
    );

    if (!exchange) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid or expired exchange code' });
    }

    const user = await User.findOne({
      _id: exchange.userId,
      _isDeleted: { $ne: true },
      isActive: { $ne: false },
    });
    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid or expired exchange code' });
    }

    const { refreshToken, accessToken } =
      await UserService.createAuthenticatedSession(user, 'google_web');
    const { password, sessions, image, ...userWithoutSecrets } = user.toJSON();
    const safeUser = {
      ...userWithoutSecrets,
      ...(typeof image === 'string' && !image.startsWith('data:')
        ? { image }
        : {}),
    };

    const cookieAuth = usesHttpOnlyRefreshCookie(req);
    if (cookieAuth) setRefreshCookie(req, res, refreshToken);

    return res.status(200).json({
      success: true,
      data: {
        user: safeUser,
        tokens: cookieAuth ? { accessToken } : { accessToken, refreshToken },
      },
      message: 'Authentication successful',
    });
  }
);
router.post('/password/forgot', strictAuthRateLimiter, requestPasswordReset);
router.post('/password/reset', strictAuthRateLimiter, resetPassword);
router.post(
  '/biometric/signin',
  biometricAuthRateLimiter,
  validateRequestWithZod(biometricSignInSchema),
  biometricSignIn as RequestHandler
);
router.post(
  '/biometric/enroll',
  verifyAccessToken,
  validateRequestWithZod(biometricEnrollSchema),
  enrollBiometric as RequestHandler
);
router.delete(
  '/biometric/current',
  verifyAccessToken,
  validateRequestWithZod(biometricRevokeSchema),
  revokeCurrentBiometric as RequestHandler
);

// Native Google Sign-In (Android/iOS) using idToken from Capacitor plugin
router.post('/auth/google/native', async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken || typeof idToken !== 'string') {
      logger.error('[Google Native] Missing or invalid idToken');
      return res.status(400).json({ message: 'idToken is required' });
    }

    // Verify idToken with Google tokeninfo (with fetch fallback)
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(
      idToken
    )}`;
    const fetchFn: any = (globalThis as any).fetch;
    let info: any;
    try {
      if (typeof fetchFn === 'function') {
        const resp = await fetchFn(url);
        if (!resp.ok) {
          logger.warn('[google/native] tokeninfo resp not ok', resp.status);
          return res.status(401).json({ message: 'Invalid Google idToken' });
        }
        info = await resp.json();
      } else {
        // Fallback using https
        info = await new Promise((resolve, reject) => {
          https
            .get(url, (r) => {
              let data = '';
              r.on('data', (chunk) => (data += chunk));
              r.on('end', () => {
                try {
                  const json = JSON.parse(data);
                  if ((r.statusCode || 0) >= 200 && (r.statusCode || 0) < 300) {
                    resolve(json);
                  } else {
                    logger.warn(
                      '[google/native] https tokeninfo bad status',
                      r.statusCode
                    );
                    reject(new Error('Invalid Google idToken'));
                  }
                } catch (e) {
                  reject(e);
                }
              });
            })
            .on('error', reject);
        });
      }
    } catch (e) {
      logger.error('Google token verification unavailable');
      return res.status(500).json({ message: 'Token verification failed' });
    }

    // Optional audience check if env is set
    const expectedAud = process.env.GOOGLE_WEB_CLIENT_ID;
    if (expectedAud && info?.aud !== expectedAud) {
      logger.warn('[google/native] audience mismatch', {
        aud: info?.aud,
        expectedAud,
      });
      return res.status(401).json({ message: 'Invalid token audience' });
    }

    const sub = info?.sub as string | undefined;
    const email = info?.email as string | undefined;
    const emailVerified =
      info?.email_verified === 'true' || info?.email_verified === true;
    const name = (info?.name as string) || undefined;
    const picture = (info?.picture as string) || undefined;

    if (!sub || !email) {
      logger.warn('[google/native] missing fields', {
        hasSub: !!sub,
        hasEmail: !!email,
      });
      return res.status(400).json({ message: 'Missing Google profile fields' });
    }

    // Find or create user by socialId, then by (case-insensitive) email
    let user =
      (await User.findOne({ socialId: sub })) ??
      (await UserService.findByEmail(email));
    if (!user) {
      try {
        assertNewAccountConsent(req.body);
      } catch (error: any) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: { message: error.message, code: error.code },
        });
      }
      user = new (User as any)({
        signupType: 'google',
        socialId: sub,
        email,
        username: name,
        image: picture,
        emailVerified,
        ...consentFields(),
      });
      await (user as any).save();
    } else {
      // Update profile data if changed
      let mutated = false;
      if (!user.socialId) {
        (user as any).socialId = sub;
        mutated = true;
      }
      if (name && user.username !== name) {
        (user as any).username = name;
        mutated = true;
      }
      if (picture && user.image !== picture) {
        (user as any).image = picture;
        mutated = true;
      }
      if (emailVerified !== undefined && user.emailVerified !== emailVerified) {
        (user as any).emailVerified = emailVerified;
        mutated = true;
      }
      if (mutated) await (user as any).save();
    }

    if (!user || user._isDeleted || user.isActive === false)
      return res.status(401).json({ message: 'Account unavailable' });
    const clientPlatform = req.get('x-client-platform');
    const platform = clientPlatform === 'ios' ? 'ios' : 'android';
    const { refreshToken, accessToken } =
      await UserService.createAuthenticatedSession(
        user,
        'google_native',
        platform
      );

    const rawUser = (user as any).toJSON ? (user as any).toJSON() : user;
    const { password, sessions, ...safeUser } = rawUser;

    return sendSuccess(
      res,
      {
        user: safeUser,
        tokens: { accessToken, refreshToken },
      },
      'Authentication successful'
    );
  } catch (err: unknown) {
    const error = err as Error;
    logger.error('Google authentication failed');

    return res.status(500).json({
      success: false,
      error: {
        message: 'Authentication processing error',
        details: error.message,
      },
    });
  }
});
router.get(
  '/access-token',
  verifySession as unknown as RequestHandler,
  userAccessToken as unknown as RequestHandler
);

// Current user profile
router.get(
  '/me',
  verifyAccessToken as unknown as RequestHandler,
  getMe as unknown as RequestHandler
);
router.put(
  '/me',
  verifyAccessToken as unknown as RequestHandler,
  updateMe as unknown as RequestHandler
);

// Permanent self-service account deletion (Google Play requirement).
// POST rather than DELETE so the request body survives proxies.
router.post(
  '/me/delete',
  strictAuthRateLimiter,
  verifyAccessToken as unknown as RequestHandler,
  deleteMe as unknown as RequestHandler
);

// Avatar upload
router.post(
  '/me/avatar',
  verifyAccessToken as unknown as RequestHandler,
  upload.any() as unknown as RequestHandler,
  uploadAvatar as unknown as RequestHandler
);

router.get(
  '/google',
  (req: Request, res: Response, next) => {
    if (req.query.consent === '1')
      res.cookie('ew_google_consent', '1', {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000,
      });
    next();
  },
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
  })
);

router.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/', session: false }),
  async (req: Request, res: Response) => {
    try {
      // Passport attaches the authenticated user to req.user
      let user: any = (req as any).user;
      if (!user) {
        return res.status(401).send('Authentication failed');
      }

      if (user.pendingGoogleProfile) {
        if (req.cookies?.ew_google_consent !== '1') {
          return res.redirect(
            `${process.env.FRONTEND_URL || 'http://localhost:4400'}/auth/signup?error=consent_required`
          );
        }
        const profile = user.pendingGoogleProfile;
        const created = new User({ ...profile, ...consentFields() });
        await created.save();
        user = created;
        (req as any).user = user;
        res.clearCookie('ew_google_consent');
      }
      const code = crypto.randomBytes(32).toString('hex');
      await GoogleOAuthExchange.create({
        codeHash: crypto.createHash('sha256').update(code).digest('hex'),
        userId: user._id,
        purpose: GOOGLE_OAUTH_EXCHANGE_PURPOSE,
        expiresAt: new Date(
          Date.now() + GOOGLE_OAUTH_EXCHANGE_TTL_SECONDS * 1000
        ),
      });

      // Redirect to frontend with payload in URL
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4400';
      const redirectUrl = `${frontendUrl}/auth/callback?code=${encodeURIComponent(code)}`;

      return res.redirect(redirectUrl);
    } catch (err) {
      logger.error('Google OAuth callback failed');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4400';
      return res.redirect(`${frontendUrl}/auth/login?error=oauth_failed`);
    }
  }
);

export default router;
