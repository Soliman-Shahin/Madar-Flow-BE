import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  verifyAccessToken,
  AuthenticatedRequest,
} from '../middleware/access.middleware';
import { attachPlanContext } from '../middleware/plan.middleware';
import { PlanRequest } from '../middleware/permission.middleware';
import { validateRequestWithZod } from '../middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';
import { sendError, sendSuccess } from '../shared/helper';
import {
  receiptScanService,
  scanLimitFor,
} from '../services/receipt-extract.service';
import logger from '../utils/logger';

const router = Router();

// The cost of a scan is real even on a free model: one photo every few seconds
// is plenty for a person at a till.
const scanRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 6,
  message: 'Too many receipt scans, please wait a moment',
});

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const extractSchema = z.object({
  image: z
    .string()
    .regex(
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/,
      'Invalid image'
    )
    .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64),
  locale: z.enum(['en', 'ar']).optional(),
});

router.use(verifyAccessToken, attachPlanContext);

// POST /v1/receipts/extract  { image: "data:image/jpeg;base64,..." }
// 501 when no reader is configured, 429 when the plan's monthly allowance is
// used up. In both cases the app reads the receipt on the device instead.
router.post(
  '/extract',
  scanRateLimiter,
  validateRequestWithZod(extractSchema),
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).user_id as string;
    const ctx = (req as PlanRequest).planContext;
    if (!receiptScanService.available) {
      return sendError(
        res,
        'Online receipt reading is not available',
        501,
        'RECEIPT_AI_UNAVAILABLE'
      );
    }
    const limit = scanLimitFor(ctx?.limits, ctx?.planSlug ?? 'free');
    if (!(await receiptScanService.reserve(userId, limit))) {
      return sendError(
        res,
        'Monthly receipt scan allowance used up',
        429,
        'RECEIPT_SCAN_LIMIT'
      );
    }
    try {
      const { image, locale } = req.body as z.infer<typeof extractSchema>;
      const [, mime, base64] = /^data:(image\/[a-z]+);base64,(.*)$/.exec(
        image
      )!;
      const data = await receiptScanService.extract(
        { mime, base64 },
        locale ?? 'en'
      );
      return sendSuccess(res, data, 'Receipt read');
    } catch (err) {
      await receiptScanService.release(userId).catch(() => undefined);
      // the image is never logged; only that a read failed
      logger.warn('receipt extraction failed', {
        message: (err as Error)?.message,
      });
      return sendError(
        res,
        'Could not read the receipt',
        502,
        'RECEIPT_AI_FAILED'
      );
    }
  }
);

// GET /v1/receipts/usage -> { used, limit }
router.get('/usage', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user_id as string;
  const ctx = (req as PlanRequest).planContext;
  const limit = scanLimitFor(ctx?.limits, ctx?.planSlug ?? 'free');
  return sendSuccess(
    res,
    {
      used: await receiptScanService.used(userId),
      limit,
      available: receiptScanService.available,
    },
    'Receipt usage'
  );
});

export default router;
