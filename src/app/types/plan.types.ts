/**
 * Plan & Subscription Types
 *
 * Core type definitions for the subscription plan system.
 * These interfaces are shared across models, services, controllers, and middleware.
 */

import { Permission } from './permissions.types';

// ==================== Plan Slugs ====================

/**
 * Available subscription plan identifiers.
 * Order matters: free < pro < premium (used for comparison logic).
 */
export enum PlanSlug {
  Free = 'free',
  Pro = 'pro',
  Premium = 'premium',
}

/**
 * Numeric weight for each plan — used to compare plan levels.
 * Higher number = higher plan tier.
 */
export const PLAN_WEIGHTS: Record<PlanSlug, number> = {
  [PlanSlug.Free]: 0,
  [PlanSlug.Pro]: 1,
  [PlanSlug.Premium]: 2,
};

/** A reference price in one currency. */
export interface PlanPrice {
  /** ISO 4217 code, upper case (for example "USD", "EGP") */
  currency: string;
  amount: number;
}

// ==================== Plan Limits ====================

/**
 * Hard limits enforced per plan.
 * Use `null` to denote "unlimited".
 */
export interface PlanLimits {
  /** Maximum number of custom categories the user can create */
  maxCategories: number | null;
  /** Maximum number of transactions (expenses) the user can create per calendar month */
  maxTransactionsPerMonth: number | null;
  /** Maximum number of active backup files */
  maxBackupFiles: number | null;
  /** Maximum number of concurrent logged-in devices */
  maxDevices: number | null;
}

// ==================== Plan Limit Check ====================

/**
 * Result returned when checking whether a user has exceeded a plan limit.
 */
export interface PlanLimitCheckResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** The name of the limit that was checked */
  limitType: keyof PlanLimits;
  /** Current usage count */
  currentCount: number;
  /** The maximum allowed (null = unlimited) */
  maxAllowed: number | null;
  /** The user's current plan slug */
  planSlug: PlanSlug;
}

// ==================== Plan Definition ====================

/**
 * Full plan definition as returned by the API (from `plan.model.ts`).
 */
export interface IPlanDefinition {
  _id: string;
  name: string;
  slug: PlanSlug;
  description: string;
  price: number;
  currency: string;
  billingCycle: 'monthly' | 'yearly' | 'lifetime';
  prices: PlanPrice[];
  productIds: string[];
  limits: PlanLimits;
  features: Permission[];
  isActive: boolean;
  isPopular: boolean;
  order: number;
  createdAt?: Date;
  updatedAt?: Date;
}

// ==================== Subscription ====================

export type SubscriptionStatus = 'active' | 'expired' | 'cancelled' | 'trial';

/**
 * User subscription record as returned by the API.
 */
export interface ISubscriptionDefinition {
  _id: string;
  user: string;
  plan: IPlanDefinition | string;
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date | null;
  cancelledAt?: Date;
  trialEndsAt?: Date;
  paymentMethod?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ==================== User Plan Context ====================

/**
 * Enriched user plan context — attached to authenticated requests.
 * Provides fast permission and limit checks without additional DB queries.
 */
export interface UserPlanContext {
  planSlug: PlanSlug;
  permissions: Permission[];
  limits: PlanLimits;
  planExpiresAt: Date | null;
  isExpired: boolean;
}

// ==================== API Request Body Types ====================

export interface UpgradePlanBody {
  planSlug: PlanSlug;
  /** Optional payment reference for record-keeping */
  paymentRef?: string;
}

export interface AdminUpdateUserPlanBody {
  planSlug: PlanSlug;
  /** Duration in days (default: 30 for monthly) */
  durationDays?: number;
}
