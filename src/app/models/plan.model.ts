import { Schema, model, Document } from 'mongoose';
import { PlanSlug, PlanLimits } from '../types/plan.types';
import { Permission } from '../types/permissions.types';

/**
 * Plan Model
 *
 * Defines available subscription plans with their limits and included permissions.
 * Plans are seeded once and can be updated by superadmin via the admin panel.
 */
export interface IPlan extends Document {
  /** Human-readable display name (e.g., "Pro Plan") */
  name: string;
  /** Unique machine-readable identifier */
  slug: PlanSlug;
  /** Short description shown in the upgrade screen */
  description: string;
  /** Price in the specified currency (0 for free plans) */
  price: number;
  /** ISO 4217 currency code (e.g., "USD", "EGP") */
  currency: string;
  /** Billing cycle for this plan tier */
  billingCycle: 'monthly' | 'yearly' | 'lifetime';
  /** Hard usage limits enforced server-side for this plan */
  limits: PlanLimits;
  /** List of permissions included in this plan */
  features: Permission[];
  /** Whether this plan is visible and selectable by users */
  isActive: boolean;
  /** Mark the most popular plan for UI highlight */
  isPopular: boolean;
  /** Display order in pricing tables (ascending) */
  order: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const PlanSchema = new Schema<IPlan>(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      enum: Object.values(PlanSlug),
      required: true,
      unique: true,
    },
    description: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: 'USD', trim: true },
    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly', 'lifetime'],
      default: 'monthly',
    },
    limits: {
      maxCategories: { type: Number, default: null }, // null = unlimited
      maxTransactionsPerMonth: { type: Number, default: null },
      maxBackupFiles: { type: Number, default: null },
      maxDevices: { type: Number, default: null },
    },
    features: {
      type: [String],
      enum: Object.values(Permission),
      default: [],
    },
    isActive: { type: Boolean, default: true },
    isPopular: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Index for ordering in UI
PlanSchema.index({ order: 1, isActive: 1 });

const Plan = model<IPlan>('Plan', PlanSchema);
export { Plan };
