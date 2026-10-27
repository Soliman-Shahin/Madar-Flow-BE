import mongoose from 'mongoose';
import { Plan, IPlan } from '../models/plan.model';
import { Subscription } from '../models/subscription.model';
import { User, UserDocument } from '../models/user.model';
import { Category } from '../models/category.model';
import { Expense } from '../models/expense.model';
import { roleService } from './role.service';
import {
  PlanSlug,
  PlanLimits,
  UserPlanContext,
  PLAN_WEIGHTS,
  AdminUpdateUserPlanBody,
} from '../types/plan.types';
import { Permission } from '../types/permissions.types';
import {
  PlanLimitError,
  PlanFeatureError,
  PlanExpiredError,
  NotFoundError,
  ConflictError,
} from '../shared/errors';
import logger from './logger.service';

// ─────────────────────────────────────────────────────────────────────────────
// Default plan configurations
// These are used to seed the database on first run.
// ─────────────────────────────────────────────────────────────────────────────

type PlanData = {
  name: string;
  slug: PlanSlug;
  description: string;
  price: number;
  currency: string;
  billingCycle: 'monthly' | 'yearly' | 'lifetime';
  limits: PlanLimits;
  features: Permission[];
  isActive: boolean;
  isPopular: boolean;
  order: number;
};

export const DEFAULT_PLANS: PlanData[] = [
  {
    name: 'Free',
    slug: PlanSlug.Free,
    description:
      'Get started with the essentials. Track your daily expenses for free.',
    price: 0,
    currency: 'USD',
    billingCycle: 'lifetime',
    limits: {
      maxCategories: 5,
      maxTransactionsPerMonth: 50,
      maxBackupFiles: 0,
      maxDevices: 1,
    },
    features: [
      Permission.CATEGORY_CREATE,
      Permission.CATEGORY_READ,
      Permission.CATEGORY_UPDATE,
      Permission.CATEGORY_DELETE,
      Permission.EXPENSE_CREATE,
      Permission.EXPENSE_READ,
      Permission.EXPENSE_UPDATE,
      Permission.EXPENSE_DELETE,
      Permission.REPORT_VIEW,
      Permission.PROFILE_UPDATE,
      Permission.PROFILE_AVATAR,
      Permission.SECURITY_BIOMETRIC,
    ],
    isActive: true,
    isPopular: false,
    order: 0,
  },
  {
    name: 'Pro',
    slug: PlanSlug.Pro,
    description:
      'Unlock advanced features for power users. Perfect for professionals.',
    price: 4.99,
    currency: 'USD',
    billingCycle: 'monthly',
    limits: {
      maxCategories: 20,
      maxTransactionsPerMonth: 500,
      maxBackupFiles: 10,
      maxDevices: 3,
    },
    features: [
      Permission.CATEGORY_CREATE,
      Permission.CATEGORY_READ,
      Permission.CATEGORY_UPDATE,
      Permission.CATEGORY_DELETE,
      Permission.EXPENSE_CREATE,
      Permission.EXPENSE_READ,
      Permission.EXPENSE_UPDATE,
      Permission.EXPENSE_DELETE,
      Permission.EXPENSE_EXPORT,
      Permission.REPORT_VIEW,
      Permission.REPORT_ADVANCED,
      Permission.BACKUP_LOCAL,
      Permission.BACKUP_GDRIVE,
      Permission.SYNC_MULTI_DEVICE,
      Permission.PROFILE_UPDATE,
      Permission.PROFILE_AVATAR,
      Permission.SECURITY_ADVANCED_ENCRYPTION,
      Permission.SECURITY_BIOMETRIC,
    ],
    isActive: true,
    isPopular: true,
    order: 1,
  },
  {
    name: 'Premium',
    slug: PlanSlug.Premium,
    description:
      'Get everything unlimited. The ultimate expense tracking experience.',
    price: 9.99,
    currency: 'USD',
    billingCycle: 'monthly',
    limits: {
      maxCategories: null,
      maxTransactionsPerMonth: null,
      maxBackupFiles: null,
      maxDevices: null,
    },
    features: [
      Permission.CATEGORY_CREATE,
      Permission.CATEGORY_READ,
      Permission.CATEGORY_UPDATE,
      Permission.CATEGORY_DELETE,
      Permission.EXPENSE_CREATE,
      Permission.EXPENSE_READ,
      Permission.EXPENSE_UPDATE,
      Permission.EXPENSE_DELETE,
      Permission.EXPENSE_EXPORT,
      Permission.REPORT_VIEW,
      Permission.REPORT_ADVANCED,
      Permission.BACKUP_LOCAL,
      Permission.BACKUP_GDRIVE,
      Permission.SYNC_MULTI_DEVICE,
      Permission.PROFILE_UPDATE,
      Permission.PROFILE_AVATAR,
      Permission.SUPPORT_PRIORITY,
      Permission.SECURITY_ADVANCED_ENCRYPTION,
      Permission.SECURITY_BIOMETRIC,
    ],
    isActive: true,
    isPopular: false,
    order: 2,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// PlanService
// ─────────────────────────────────────────────────────────────────────────────

export class PlanService {
  // ── Plan Lookup ────────────────────────────────────────────────────────────

  /**
   * Returns all active plans ordered for display.
   */
  async getActivePlans(): Promise<IPlan[]> {
    return Plan.find({ isActive: true }).sort({ order: 1 }).lean();
  }

  /**
   * Returns a single plan by its slug.
   */
  async getPlanBySlug(slug: PlanSlug): Promise<IPlan> {
    const plan = await Plan.findOne({ slug }).lean();
    if (!plan) throw new NotFoundError('Plan', slug);
    return plan;
  }

  /**
   * Returns all plans (including inactive) — for admin use.
   */
  async getAllPlans(): Promise<IPlan[]> {
    return Plan.find().sort({ order: 1 }).lean();
  }

  // ── User Plan Context ──────────────────────────────────────────────────────

  /**
   * Builds a `UserPlanContext` for a given user, merging plan permissions
   * with any custom per-user permissions set by a superadmin.
   *
   * This is the core function used by the plan middleware to attach
   * plan context to authenticated requests.
   */
  async getUserPlanContext(userId: string): Promise<UserPlanContext> {
    const user = await User.findById(userId)
      .select('plan planExpiresAt customPermissions role')
      .lean<UserDocument>();
    if (!user) throw new NotFoundError('User', userId);

    const plan = await this.getPlanBySlug(user.plan);
    const isExpired =
      user.planExpiresAt != null && new Date(user.planExpiresAt) < new Date();

    let rolePermissions: Permission[] = [];
    if (user.role) {
      const role = await roleService.getRoleBySlug(user.role);
      if (role) {
        rolePermissions = role.permissions;
      }
    }

    const permissions = Array.from(
      new Set([
        ...plan.features,
        ...(user.customPermissions || []),
        ...rolePermissions,
      ])
    );

    return {
      planSlug: plan.slug,
      permissions,
      limits: plan.limits,
      planExpiresAt: user.planExpiresAt || null,
      isExpired,
    };
  }

  /**
   * Returns detailed plan info + usage stats for the current user.
   */
  async getMyPlan(userId: string) {
    const user = await User.findById(userId)
      .select('plan planExpiresAt customPermissions')
      .lean<UserDocument>();
    if (!user) throw new NotFoundError('User', userId);

    const plan = await this.getPlanBySlug(user.plan);
    const context = await this.getUserPlanContext(userId);

    const categoriesCount = await Category.countDocuments({ userId });
    const transactionsThisMonth = await this.getTransactionsThisMonth(userId);

    const usage = {
      categories: {
        used: categoriesCount,
        limit: plan.limits.maxCategories,
        percentage: this.calculatePercentage(
          categoriesCount,
          plan.limits.maxCategories
        ),
      },
      transactionsThisMonth: {
        used: transactionsThisMonth,
        limit: plan.limits.maxTransactionsPerMonth,
        percentage: this.calculatePercentage(
          transactionsThisMonth,
          plan.limits.maxTransactionsPerMonth
        ),
      },
    };

    const subscriptionHistory = await Subscription.find({ user: userId })
      .populate('plan', 'name slug')
      .sort({ startDate: -1 })
      .limit(5)
      .lean();

    return {
      plan,
      context,
      usage,
      subscriptionHistory,
    };
  }

  // ── Limit Checks ───────────────────────────────────────────────────────────

  async checkCategoryLimit(
    userId: string,
    context: UserPlanContext
  ): Promise<void> {
    const { maxCategories } = context.limits;
    if (maxCategories === null) return;

    const count = await Category.countDocuments({ userId });
    if (count >= maxCategories) {
      throw new PlanLimitError(
        'categories',
        count,
        maxCategories,
        context.planSlug
      );
    }
  }

  async checkTransactionLimit(
    userId: string,
    context: UserPlanContext
  ): Promise<void> {
    const { maxTransactionsPerMonth } = context.limits;
    if (maxTransactionsPerMonth === null) return;

    const count = await this.getTransactionsThisMonth(userId);
    if (count >= maxTransactionsPerMonth) {
      throw new PlanLimitError(
        'transactions',
        count,
        maxTransactionsPerMonth,
        context.planSlug
      );
    }
  }

  private async getTransactionsThisMonth(userId: string): Promise<number> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    return Expense.countDocuments({
      userId,
      date: { $gte: startOfMonth, $lte: endOfMonth },
    });
  }

  private calculatePercentage(used: number, limit: number | null): number {
    if (limit === null) return 0;
    return Math.min(Math.round((used / limit) * 100), 100);
  }

  // ── Plan Upgrades ──────────────────────────────────────────────────────────

  async upgradePlan(userId: string, targetSlug: PlanSlug): Promise<void> {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User', userId);

    const currentPlan = await this.getPlanBySlug(user.plan);
    const targetPlan = await this.getPlanBySlug(targetSlug);

    if (PLAN_WEIGHTS[targetSlug] <= PLAN_WEIGHTS[user.plan]) {
      throw new ConflictError(
        'Cannot downgrade or switch to same plan via upgrade endpoint'
      );
    }

    user.plan = targetSlug;
    user.planExpiresAt = this.calculatePlanExpiry(targetPlan.billingCycle);
    await user.save();

    await Subscription.create({
      user: userId,
      plan: targetPlan._id,
      status: 'active',
      startDate: new Date(),
      endDate: user.planExpiresAt,
    });

    logger.info(
      `User ${userId} upgraded from ${currentPlan.slug} to ${targetSlug}`
    );
  }

  private calculatePlanExpiry(
    billingCycle: 'monthly' | 'yearly' | 'lifetime'
  ): Date | null {
    if (billingCycle === 'lifetime') return null;

    const now = new Date();
    if (billingCycle === 'monthly') {
      return new Date(now.setMonth(now.getMonth() + 1));
    }
    if (billingCycle === 'yearly') {
      return new Date(now.setFullYear(now.getFullYear() + 1));
    }
    return null;
  }

  // ── Admin: Update User Plan ────────────────────────────────────────────────

  async adminUpdateUserPlan(
    userId: string,
    body: AdminUpdateUserPlanBody
  ): Promise<void> {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User', userId);

    if (body.planSlug) {
      await this.getPlanBySlug(body.planSlug);
      user.plan = body.planSlug;
    }

    if (body.durationDays !== undefined) {
      const now = new Date();
      user.planExpiresAt = new Date(
        now.getTime() + body.durationDays * 24 * 60 * 60 * 1000
      );
    }

    await user.save();
    logger.info(`Admin updated plan for user ${userId}`);
  }

  // ── Usage Stats ────────────────────────────────────────────────────────────

  async getUserUsageStats(userId: string, context: UserPlanContext) {
    const categoriesCount = await Category.countDocuments({ userId });
    const transactionsThisMonth = await this.getTransactionsThisMonth(userId);

    return {
      categories: {
        used: categoriesCount,
        limit: context.limits.maxCategories,
        percentage: this.calculatePercentage(
          categoriesCount,
          context.limits.maxCategories
        ),
      },
      transactionsThisMonth: {
        used: transactionsThisMonth,
        limit: context.limits.maxTransactionsPerMonth,
        percentage: this.calculatePercentage(
          transactionsThisMonth,
          context.limits.maxTransactionsPerMonth
        ),
      },
    };
  }

  // ── Assign Plan (Admin) ────────────────────────────────────────────────────

  async assignPlan(
    userId: string,
    planSlug: PlanSlug,
    durationDays: number | null,
    paymentRef?: string,
    adminNote?: string
  ) {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User', userId);

    const plan = await this.getPlanBySlug(planSlug);

    if (user.plan === planSlug) {
      logger.debug('[SUBSCRIPTION-BE-TRACE][SAME-PLAN-NOOP]', {
        plan: planSlug,
      });
      return user;
    }

    user.plan = planSlug;
    const now = new Date();

    if (plan.billingCycle === 'lifetime' || durationDays === null) {
      user.planExpiresAt = null;
    } else {
      user.planExpiresAt = new Date(
        now.getTime() + durationDays * 24 * 60 * 60 * 1000
      );
    }

    await user.save();

    const activeBefore = await Subscription.countDocuments({
      user: userId,
      status: 'active',
    });
    await Subscription.updateMany(
      { user: userId, status: 'active' },
      { $set: { status: 'expired', endDate: now } }
    );

    await Subscription.create({
      user: userId,
      plan: plan._id,
      status: 'active',
      startDate: now,
      endDate: user.planExpiresAt,
      paymentRef,
      adminNote,
    });

    logger.debug('[SUBSCRIPTION-BE-TRACE][PLAN-TRANSITION]', {
      targetPlan: planSlug,
      activeBefore,
      historyCount: await Subscription.countDocuments({ user: userId }),
    });

    logger.info(`Assigned plan ${planSlug} to user ${userId}`);
    return user;
  }

  // ── Plan Distribution (Admin Stats) ────────────────────────────────────────

  async getPlanDistribution() {
    const distribution = await User.aggregate([
      { $match: { role: 'user', _isDeleted: { $ne: true } } },
      {
        $group: {
          _id: '$plan',
          count: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: 'plans',
          localField: '_id',
          foreignField: 'slug',
          as: 'planDetails',
        },
      },
      {
        $unwind: {
          path: '$planDetails',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          planSlug: '$_id',
          count: 1,
          planName: '$planDetails.name',
          _id: 0,
        },
      },
      {
        $sort: { count: -1 },
      },
    ]);

    return distribution;
  }

  // ── Seeding ────────────────────────────────────────────────────────────────

  /**
   * Seeds the default plans if they don't exist yet.
   * Should be called on application startup.
   */
  async seedDefaultPlans(): Promise<void> {
    for (const planData of DEFAULT_PLANS) {
      const exists = await Plan.findOne({ slug: planData.slug });
      if (!exists) {
        await Plan.create(planData);
        logger.info(`Seeded plan: ${planData.slug}`);
      }
    }
  }
}

export const planService = new PlanService();
