import { Schema, model, Document, Model } from 'mongoose';
import _ from 'lodash';
import crypto from 'crypto';
import { config } from 'dotenv';
import { PlanSlug } from '../types/plan.types';
import { Permission } from '../types/permissions.types';
config();

/**
 * User roles in ascending order of privilege:
 *   user < moderator < admin < superadmin
 *
 * - user       : regular app user (access controlled by subscription plan)
 * - moderator  : read-only access to the admin dashboard
 * - admin      : full admin dashboard access (cannot manage plans or other admins)
 * - superadmin : unrestricted access including plan and admin management
 */
export enum UserRole {
  User = 'user',
  Moderator = 'moderator',
  Admin = 'admin',
  SuperAdmin = 'superadmin',
}

/**
 * Numeric weight for each role — higher = more privileged.
 * Used by requireRole() middleware for range-based checks.
 */
export const ROLE_WEIGHTS: Record<UserRole, number> = {
  [UserRole.User]: 0,
  [UserRole.Moderator]: 1,
  [UserRole.Admin]: 2,
  [UserRole.SuperAdmin]: 3,
};

/**
 * Checks if the actor has permission to manage (edit/delete) the target role.
 */
export function canManageTargetRole(
  actorRole: UserRole,
  targetRole: UserRole
): boolean {
  const actorWeight = ROLE_WEIGHTS[actorRole] ?? 0;
  const targetWeight = ROLE_WEIGHTS[targetRole] ?? 0;

  // Actor must have at least Admin privileges
  if (actorWeight < ROLE_WEIGHTS[UserRole.Admin]) {
    return false;
  }

  // SuperAdmin can manage anyone
  if (actorWeight >= ROLE_WEIGHTS[UserRole.SuperAdmin]) {
    return true;
  }

  // Admin can manage anyone EXCEPT SuperAdmin
  return targetWeight < ROLE_WEIGHTS[UserRole.SuperAdmin];
}

/**
 * Checks if the actor has permission to assign a specific role.
 */
export function canAssignRole(
  actorRole: UserRole,
  roleToAssign: UserRole
): boolean {
  const actorWeight = ROLE_WEIGHTS[actorRole] ?? 0;
  const assignWeight = ROLE_WEIGHTS[roleToAssign] ?? 0;

  // Actor must have at least Admin privileges
  if (actorWeight < ROLE_WEIGHTS[UserRole.Admin]) {
    return false;
  }

  // SuperAdmin can assign any role
  if (actorWeight >= ROLE_WEIGHTS[UserRole.SuperAdmin]) {
    return true;
  }

  // Admin can assign roles up to Admin (not SuperAdmin)
  return assignWeight <= ROLE_WEIGHTS[UserRole.Admin];
}

enum SignupType {
  Normal = 'normal',
  Facebook = 'facebook',
  Google = 'google',
}

const TOKEN_SETTINGS = {
  EXPIRATION_TIME: '1h',
  ALGORITHM: 'HS256' as const,
  LENGTH: 64,
};

// Validate that ACCESS_TOKEN_SECRET is set
const jwtSecret = process.env.ACCESS_TOKEN_SECRET;
if (!jwtSecret) {
  throw new Error(
    'ACCESS_TOKEN_SECRET is required in environment variables. Please set it in your .env file.'
  );
}

interface IUserSession {
  sessionId?: string;
  token: string;
  expiresAt: number;
}

interface UserDocument extends Document {
  userId?: string;
  socialId?: string;
  signupType: SignupType;
  email: string;
  password: string;
  username?: string;
  image?: string;
  // Optional profile fields
  fullName?: string;
  phone?: string;
  salary?: Array<{ label: string; amount: number }>;
  currency?: string;
  emailVerified?: boolean;
  termsAcceptedAt?: Date;
  termsVersion?: string;
  privacyAcceptedAt?: Date;
  privacyVersion?: string;
  role: string;
  sessions: IUserSession[];
  passwordResetTokenHash?: string;
  passwordResetExpiresAt?: Date;
  passwordResetRequestedAt?: Date;
  accountDeletionTokenHash?: string;
  accountDeletionExpiresAt?: Date;
  isActive?: boolean;
  _isDeleted?: boolean;
  // ── Subscription / Plan ────────────────────────────────────────────────────
  /** The user's current subscription plan slug */
  plan: PlanSlug;
  /** When the current paid plan expires (null = free plan / lifetime) */
  planExpiresAt?: Date | null;
  /** When the current plan started */
  planStartedAt?: Date | null;
  /** Optional per-user permission overrides (additive on top of plan defaults) */
  customPermissions: Permission[];
  // ──────────────────────────────────────────────────────────────────────────
  createSession(): Promise<string>;
  generateAccessAuthToken(): Promise<string>;
  createRefreshToken(): Promise<string>;
}

interface IUserModel extends Model<UserDocument> {
  findByIdAndToken(id: string, token: string): Promise<UserDocument | null>;
  hasRefreshTokenExpired(expiresAt: number): boolean;
}

// Define the user schema
const UserSchema = new Schema<UserDocument>(
  {
    userId: String,
    socialId: String,
    signupType: {
      type: String,
      enum: Object.values(SignupType),
      default: SignupType.Normal,
    },
    email: {
      type: String,
      required: true,
      minlength: 1,
      trim: true,
      // Stored lowercase so the unique index is effectively case-insensitive.
      // Existing mixed-case rows: see scripts/normalize-emails.ts.
      lowercase: true,
      unique: true,
    },
    password: {
      type: String,
      // Only require password for normal signups
      required: function (this: UserDocument) {
        return this.signupType === SignupType.Normal;
      },
      minlength: 8,
    },
    username: String,
    image: String,
    fullName: String,
    phone: String,
    salary: [
      new Schema(
        {
          label: { type: String, required: true, trim: true },
          amount: { type: Number, required: true, min: 0 },
        },
        { _id: false }
      ),
    ],
    currency: String,
    emailVerified: { type: Boolean, default: false },
    termsAcceptedAt: Date,
    termsVersion: String,
    privacyAcceptedAt: Date,
    privacyVersion: String,
    role: {
      type: String,
      default: UserRole.User,
    },
    sessions: [
      {
        sessionId: { type: String },
        token: { type: String, required: true },
        expiresAt: { type: Number, required: true },
      },
    ],
    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },
    passwordResetRequestedAt: { type: Date, select: false },
    accountDeletionTokenHash: { type: String, select: false },
    accountDeletionExpiresAt: { type: Date, select: false },
    isActive: { type: Boolean, default: true },
    _isDeleted: { type: Boolean, default: false },
    // ── Subscription / Plan Fields ─────────────────────────────────────────
    plan: {
      type: String,
      enum: Object.values(PlanSlug),
      default: PlanSlug.Free,
    },
    planExpiresAt: { type: Date, default: null },
    planStartedAt: { type: Date, default: null },
    /** Per-user permission additions (set by superadmin only) */
    customPermissions: {
      type: [String],
      default: [],
    },
    // ──────────────────────────────────────────────────────────────────────
  },
  { timestamps: true }
);

// *** Indexes for performance ***
// Index on socialId for OAuth lookups
UserSchema.index({ socialId: 1 }, { sparse: true });
// Compound index for session token lookups
UserSchema.index({ _id: 1, 'sessions.token': 1 });
// Index for plan-based queries (e.g., find all pro users)
UserSchema.index({ plan: 1 });
// Index for finding users whose plans have expired
UserSchema.index({ planExpiresAt: 1 }, { sparse: true });
// Index for role-based queries
UserSchema.index({ role: 1 });

// *** Instance methods ***
UserSchema.methods.toJSON = function () {
  const user = this;
  const userObject = user.toObject();

  // return the document except the password and sessions (these shouldn't be made available)
  return _.omit(userObject, ['password', 'sessions']);
};

UserSchema.methods.generateAccessAuthToken = async function (
  this: UserDocument
): Promise<string> {
  const { UserService } = await import('../services/user.service');
  const sessionId = this.sessions[this.sessions.length - 1]?.sessionId;
  if (!sessionId) throw new Error('No session identity available');
  return UserService.generateAccessToken(this, sessionId);
};

UserSchema.methods.createRefreshToken = async function (): Promise<string> {
  const buf = crypto.randomBytes(TOKEN_SETTINGS.LENGTH);
  return buf.toString('hex');
};

UserSchema.methods.createSession = async function (
  this: UserDocument
): Promise<string> {
  const refreshToken = await this.createRefreshToken();
  const { UserService } = await import('../services/user.service');
  await UserService.addRefreshToken(this, refreshToken);
  return refreshToken;
};

/* MODEL METHODS (static methods) */
// UserSchema.statics.getJWTSecret = () => jwtSecret;

UserSchema.statics.findByIdAndToken = async function (
  id: string,
  token: string
): Promise<UserDocument | null> {
  return this.findOne({
    _id: id,
    'sessions.token': crypto.createHash('sha256').update(token).digest('hex'),
    _isDeleted: { $ne: true },
    isActive: { $ne: false },
  });
};

UserSchema.statics.hasRefreshTokenExpired = function (
  expiresAt: number
): boolean {
  return Math.floor(Date.now() / 1000) >= expiresAt;
};

// Create the user model using generics
const User = model<UserDocument, IUserModel>('User', UserSchema);
export { User, UserDocument };
