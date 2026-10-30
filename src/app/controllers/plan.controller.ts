import { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendError } from '../shared/helper';
import { planService } from '../services/plan.service';
import { Plan } from '../models/plan.model';
import { Subscription } from '../models/subscription.model';
import { AuthenticatedRequest } from '../middleware/access.middleware';
import { PlanRequest } from '../middleware/permission.middleware';
import {
  PlanSlug,
  AdminUpdateUserPlanBody,
  UpgradePlanBody,
} from '../types/plan.types';
import { NotFoundError, BadRequestError } from '../shared/errors';
import logger from '../services/logger.service';
import { permissionCacheService } from '../services/permission-cache.service';

/**
 * Plan Controller
 *
 * Handles:
 * - Public plan listing (GET /v1/plans)
 * - User's own plan context and usage (GET /v1/user/plan)
 * - User self-upgrade (POST /v1/user/plan/upgrade) — admin grants for now
 * - Admin plan management (via admin routes)
 */
export class PlanController {
  // ─────────────────────────────────────────── Public / User Routes ──────────

  /**
   * GET /v1/plans
   * Returns all active plans for display in the upgrade screen.
   * Public endpoint — no auth required.
   */
  async getActivePlans(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const plans = await planService.getActivePlans();
      sendSuccess(res, plans, 'Plans retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /v1/user/plan
   * Returns the authenticated user's current plan, permissions, limits, and usage.
   * Requires: verifyAccessToken + attachPlanContext
   */
  async getMyPlan(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const planReq = req as PlanRequest;
      const userId = planReq.user_id!;

      if (!planReq.planContext) {
        sendError(res, 'Plan context not initialized', 500, 'INTERNAL_ERROR');
        return;
      }

      // Fetch plan document for display details (price, description, etc.)
      const planDoc = await Plan.findOne({
        slug: planReq.planContext.planSlug,
      }).lean();

      // Usage stats
      const usageStats = await planService.getUserUsageStats(
        userId,
        planReq.planContext
      );

      // Subscription history (latest first)
      const subscriptions = await Subscription.find({ user: userId })
        .sort({ startDate: -1 })
        .limit(5)
        .populate('plan', 'name slug price currency billingCycle')
        .lean();

      logger.debug('[SUBSCRIPTION-BE-TRACE][HISTORY]', {
        count: subscriptions.length,
        entries: subscriptions.map((entry: any) => ({
          id: entry._id,
          plan: entry.plan?.slug,
          status: entry.status,
          start: entry.startDate,
          end: entry.endDate,
        })),
      });

      sendSuccess(
        res,
        {
          plan: planDoc,
          context: planReq.planContext,
          usage: usageStats,
          subscriptionHistory: subscriptions,
        },
        'Plan details retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /v1/user/plan/upgrade
   * Allows a user to request a plan upgrade.
   * In the current implementation (no payment gateway), the upgrade is granted
   * directly by the system for a 30-day period.
   *
   * Body: { planSlug: 'pro' | 'premium', paymentRef?: string }
   */
  async upgradePlan(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user_id!;
      const { planSlug, paymentRef } = req.body as UpgradePlanBody;

      if (!planSlug || !Object.values(PlanSlug).includes(planSlug)) {
        sendError(res, 'Invalid plan slug', 400, 'VALIDATION_ERROR');
        return;
      }

      if (planSlug === PlanSlug.Free) {
        sendError(
          res,
          'You cannot upgrade to the Free plan. To downgrade, contact support.',
          400,
          'VALIDATION_ERROR'
        );
        return;
      }

      const updatedUser = await planService.assignPlan(
        userId,
        planSlug,
        30, // 30-day duration (monthly billing cycle)
        paymentRef
      );

      permissionCacheService.invalidateUser(userId);
      logger.debug('[SUBSCRIPTION-BE-TRACE][UPGRADE-CACHE-INVALIDATED]', {
        targetPlan: planSlug,
      });
      const refreshed = await planService.getMyPlan(userId);
      logger.debug('[SUBSCRIPTION-BE-TRACE][UPGRADE-RESULT]', {
        plan: refreshed.plan?.slug,
        subscriptionId: refreshed.subscriptionHistory?.[0]?._id,
        historyCount: refreshed.subscriptionHistory?.length ?? 0,
      });

      logger.info(`User ${userId} upgraded to plan: ${planSlug}`);
      sendSuccess(
        res,
        {
          plan: refreshed.plan,
          context: refreshed.context,
          usage: refreshed.usage,
          subscriptionHistory: refreshed.subscriptionHistory,
          planExpiresAt: updatedUser.planExpiresAt,
          planStartedAt: updatedUser.planStartedAt,
        },
        `Successfully upgraded to the ${planSlug} plan!`
      );
    } catch (error) {
      next(error);
    }
  }

  // ─────────────────────────────────────────── Admin Routes ──────────────────

  /**
   * GET /v1/admin/plans
   * Returns all plans (including inactive) for admin management.
   */
  async getAllPlans(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const plans = await planService.getAllPlans();
      sendSuccess(res, plans, 'All plans retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /v1/admin/plans
   * Creates a new plan. SuperAdmin only.
   */
  async createPlan(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const plan = await Plan.create(req.body);
      logger.info(`Admin created plan: ${plan.slug}`);
      sendSuccess(res, plan, 'Plan created successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /v1/admin/plans/:id
   * Updates a plan's details, limits, or features. SuperAdmin only.
   */
  async updatePlan(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const plan = await Plan.findByIdAndUpdate(req.params.id, req.body, {
        returnDocument: 'after',
        runValidators: true,
      });
      if (!plan) throw new NotFoundError('Plan', req.params.id as string);
      logger.info(`Admin updated plan: ${plan.slug}`);
      sendSuccess(res, plan, 'Plan updated successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /v1/admin/plans/:id
   * Soft-disables a plan (sets isActive = false). SuperAdmin only.
   * Does not delete existing subscriptions.
   */
  async deactivatePlan(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const plan = await Plan.findByIdAndUpdate(
        req.params.id,
        { isActive: false },
        { returnDocument: 'after' }
      );
      if (!plan) throw new NotFoundError('Plan', req.params.id as string);
      logger.info(`Admin deactivated plan: ${plan.slug}`);
      sendSuccess(res, plan, 'Plan deactivated successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /v1/admin/users/:userId/plan
   * Admin manually assigns a plan to a user.
   *
   * Body: { planSlug: PlanSlug, durationDays?: number }
   */
  async adminAssignUserPlan(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.params.userId as string;
      const { planSlug, durationDays } = req.body as AdminUpdateUserPlanBody;
      const adminId = (req as AuthenticatedRequest).user_id;

      if (!planSlug || !Object.values(PlanSlug).includes(planSlug)) {
        sendError(res, 'Invalid plan slug', 400, 'VALIDATION_ERROR');
        return;
      }

      const updatedUser = await planService.assignPlan(
        userId,
        planSlug,
        planSlug === PlanSlug.Free ? null : (durationDays ?? 30),
        undefined,
        `Manually assigned by admin ${adminId}`
      );

      logger.info(
        `Admin ${adminId} assigned plan ${planSlug} to user ${userId} for ${durationDays ?? 30} days`
      );
      sendSuccess(
        res,
        {
          userId,
          plan: updatedUser.plan,
          planExpiresAt: updatedUser.planExpiresAt,
          planStartedAt: updatedUser.planStartedAt,
        },
        `Plan ${planSlug} assigned to user successfully`
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /v1/admin/plans/distribution
   * Returns user count per plan for dashboard statistics.
   */
  async getPlanDistribution(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const distribution = await planService.getPlanDistribution();
      sendSuccess(
        res,
        distribution,
        'Plan distribution retrieved successfully'
      );
    } catch (error) {
      next(error);
    }
  }
}

export const planController = new PlanController();
export default planController;
