import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { verifyAccessToken, AuthenticatedRequest } from '../middleware/access.middleware';
import { attachPlanContext } from '../middleware/plan.middleware';
import { PlanRequest } from '../middleware/permission.middleware';
import { validateRequestWithZod } from '../middleware';
import { Asset } from '../models/asset.model';
import { sendError, sendSuccess } from '../shared/helper';
import { assetSchema, clientIdParam } from '../validations/asset.validation';
import { assetLimitFor } from '../services/asset-limit';
import { marketPriceService } from '../services/market-price.service';
import logger from '../utils/logger';

const router = Router();
router.use(verifyAccessToken, attachPlanContext);

const userOf = (req: Request) => (req as AuthenticatedRequest).user_id as string;

const dto = (a: any) => ({
  clientId: a.clientId,
  _id: String(a._id),
  type: a.type,
  name: a.name,
  status: a.status,
  purchasedAt: a.purchasedAt,
  cost: { amount: a.costAmount, currency: a.costCurrency },
  details: a.details ?? {},
  note: a.note ?? null,
  soldAt: a.soldAt ?? null,
  saleAmount: a.saleAmount ?? null,
  isDeleted: !!a.isDeleted,
  updatedAt: a.clientUpdatedAt,
});

// GET /v1/vault/assets — everything this person saved, deletions included so
// their other devices can remove them too.
router.get('/assets', async (req: Request, res: Response) => {
  const rows = await Asset.find({ user: userOf(req) }).sort({ purchasedAt: -1 }).limit(1000).lean();
  return sendSuccess(res, rows.map(dto), 'Assets');
});

// PUT /v1/vault/assets/:clientId — create or update (safe to retry).
router.put(
  '/assets/:clientId',
  validateRequestWithZod(assetSchema),
  async (req: Request, res: Response) => {
    const id = clientIdParam.safeParse(req.params.clientId);
    if (!id.success) return sendError(res, 'Invalid id', 400, 'VALIDATION_ERROR');
    const user = userOf(req);
    // the validator checks the request; parse again for the coerced dates
    const parsed = assetSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'Invalid asset', 400, 'VALIDATION_ERROR');
    const body: z.infer<typeof assetSchema> = parsed.data;
    const existing = await Asset.findOne({ user, clientId: id.data });

    if (!existing) {
      const ctx = (req as PlanRequest).planContext;
      const limit = assetLimitFor(ctx?.limits, ctx?.planSlug ?? 'free');
      if (limit !== null) {
        const used = await Asset.countDocuments({ user, isDeleted: { $ne: true } });
        if (used >= limit) {
          return sendError(res, 'Plan limit reached: vault items', 403, 'PLAN_LIMIT_EXCEEDED', {
            limitType: 'assets',
            currentCount: used,
            maxAllowed: limit,
            planSlug: ctx?.planSlug ?? 'free',
          });
        }
      }
    } else if (existing.clientUpdatedAt > body.updatedAt) {
      // the copy on the server is newer: keep it and tell the phone
      return sendSuccess(res, dto(existing), 'Server copy is newer');
    }

    const fields = {
      type: body.type,
      name: body.name,
      status: body.status,
      purchasedAt: body.purchasedAt,
      costAmount: body.cost.amount,
      costCurrency: body.cost.currency,
      details: body.details,
      note: body.note,
      soldAt: body.soldAt,
      saleAmount: body.saleAmount,
      isDeleted: false,
      clientUpdatedAt: body.updatedAt,
    };
    try {
      const saved = await Asset.findOneAndUpdate(
        { user, clientId: id.data },
        { $set: fields, $setOnInsert: { user, clientId: id.data } },
        { upsert: true, returnDocument: 'after', runValidators: true }
      ).lean();
      return sendSuccess(res, dto(saved), 'Saved');
    } catch (e) {
      logger.warn('vault save failed', { message: (e as Error)?.message });
      return sendError(res, 'Could not save', 500, 'VAULT_SAVE_FAILED');
    }
  }
);

// DELETE /v1/vault/assets/:clientId — soft delete.
router.delete('/assets/:clientId', async (req: Request, res: Response) => {
  const id = clientIdParam.safeParse(req.params.clientId);
  if (!id.success) return sendError(res, 'Invalid id', 400, 'VALIDATION_ERROR');
  await Asset.updateOne(
    { user: userOf(req), clientId: id.data },
    { $set: { isDeleted: true, clientUpdatedAt: new Date() } }
  );
  return sendSuccess(res, {}, 'Removed');
});

// GET /v1/vault/usage -> { used, limit }
router.get('/usage', async (req: Request, res: Response) => {
  const ctx = (req as PlanRequest).planContext;
  const used = await Asset.countDocuments({ user: userOf(req), isDeleted: { $ne: true } });
  return sendSuccess(
    res,
    { used, limit: assetLimitFor(ctx?.limits, ctx?.planSlug ?? 'free') },
    'Vault usage'
  );
});

// GET /v1/vault/prices — gold and exchange rates (indicative, free sources).
router.get('/prices', async (_req: Request, res: Response) => {
  try {
    return sendSuccess(res, await marketPriceService.get(), 'Prices');
  } catch (e) {
    logger.warn('market prices unavailable', { message: (e as Error)?.message });
    return sendError(res, 'Prices are not available right now', 503, 'PRICES_UNAVAILABLE');
  }
});

export default router;
