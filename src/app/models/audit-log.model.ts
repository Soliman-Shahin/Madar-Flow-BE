import { Schema, model, Document } from 'mongoose';
import { UserRole } from './user.model';

/**
 * Audit Log Actions
 *
 * Tracks all security-sensitive operations in the system
 */
export enum AuditAction {
  // User Management
  USER_CREATED = 'user:created',
  USER_UPDATED = 'user:updated',
  USER_DELETED = 'user:deleted',
  USER_RESTORED = 'user:restored',
  USER_LOGIN = 'user:login',
  USER_LOGOUT = 'user:logout',
  USER_LOGIN_FAILED = 'user:login_failed',

  // Role Management
  ROLE_CHANGED = 'role:changed',
  ROLE_ASSIGNED = 'role:assigned',

  // Permission Management
  PERMISSION_GRANTED = 'permission:granted',
  PERMISSION_REVOKED = 'permission:revoked',
  CUSTOM_PERMISSION_ADDED = 'custom_permission:added',
  CUSTOM_PERMISSION_REMOVED = 'custom_permission:removed',
  PERMISSION_GRANT_TEMPORARY = 'permission:grant_temporary',
  PERMISSION_REVOKE_TEMPORARY = 'permission:revoke_temporary',
  PERMISSION_EXPIRE_TEMPORARY = 'permission:expire_temporary',
  PERMISSION_EXTEND_TEMPORARY = 'permission:extend_temporary',

  // Plan Management
  PLAN_CREATED = 'plan:created',
  PLAN_UPDATED = 'plan:updated',
  PLAN_DELETED = 'plan:deleted',
  PLAN_ASSIGNED = 'plan:assigned',
  PLAN_UPGRADED = 'plan:upgraded',
  PLAN_DOWNGRADED = 'plan:downgraded',
  PLAN_EXPIRED = 'plan:expired',

  // App content (dashboard-managed settings)
  APP_SETTINGS_UPDATED = 'app_settings:updated',

  // Resource Management
  EXPENSE_CREATED = 'expense:created',
  EXPENSE_UPDATED = 'expense:updated',
  EXPENSE_DELETED = 'expense:deleted',
  EXPENSE_RESTORED = 'expense:restored',
  CATEGORY_CREATED = 'category:created',
  CATEGORY_UPDATED = 'category:updated',
  CATEGORY_DELETED = 'category:deleted',
  CATEGORY_RESTORED = 'category:restored',

  // Security Events
  PASSWORD_CHANGED = 'password:changed',
  PASSWORD_RESET_REQUESTED = 'password:reset_requested',
  PASSWORD_RESET_COMPLETED = 'password:reset_completed',
  EMAIL_VERIFIED = 'email:verified',
  TWO_FACTOR_ENABLED = 'two_factor:enabled',
  TWO_FACTOR_DISABLED = 'two_factor:disabled',
  BIOMETRIC_ENROLLED = 'biometric:enrolled',
  BIOMETRIC_SIGNIN = 'biometric:signin',
  BIOMETRIC_SIGNIN_FAILED = 'biometric:signin_failed',
  BIOMETRIC_REVOKED = 'biometric:revoked',
  BIOMETRIC_RESET_REVOKED = 'biometric:reset_revoked',

  // Access Control
  ACCESS_DENIED = 'access:denied',
  PERMISSION_DENIED = 'permission:denied',
  RATE_LIMIT_EXCEEDED = 'rate_limit:exceeded',
}

/**
 * Audit Log Severity Levels
 */
export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * Audit Log Document Interface
 */
export interface IAuditLog extends Document {
  /** User who performed the action (null for system actions) */
  actorId?: string;
  /** Role of the actor at the time of action */
  actorRole?: UserRole;
  /** Email of the actor (for quick reference) */
  actorEmail?: string;

  /** The action that was performed */
  action: AuditAction;
  /** Severity level of the action */
  severity: AuditSeverity;

  /** Target user ID (if action affects a specific user) */
  targetUserId?: string;
  /** Target user role (if applicable) */
  targetRole?: UserRole;
  /** Target resource type (expense, category, plan, etc.) */
  targetResourceType?: string;
  /** Target resource ID */
  targetResourceId?: string;

  /** Detailed changes made (before/after values) */
  changes?: Record<string, any>;
  /** Additional metadata about the action */
  metadata?: Record<string, any>;

  /** IP address of the request */
  ipAddress?: string;
  /** User agent string */
  userAgent?: string;
  /** Request path */
  requestPath?: string;
  /** HTTP method */
  requestMethod?: string;

  /** Whether the action was successful */
  success: boolean;
  /** Error message if action failed */
  errorMessage?: string;

  /** Timestamp of the action */
  timestamp: Date;

  /** TTL for automatic deletion (optional) */
  expiresAt?: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: String, index: true },
    actorRole: { type: String, enum: Object.values(UserRole) },
    actorEmail: { type: String },

    action: {
      type: String,
      enum: Object.values(AuditAction),
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: Object.values(AuditSeverity),
      default: AuditSeverity.INFO,
      index: true,
    },

    targetUserId: { type: String, index: true },
    targetRole: { type: String, enum: Object.values(UserRole) },
    targetResourceType: { type: String, index: true },
    targetResourceId: { type: String, index: true },

    changes: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },

    ipAddress: { type: String },
    userAgent: { type: String },
    requestPath: { type: String },
    requestMethod: { type: String },

    success: { type: Boolean, default: true, index: true },
    errorMessage: { type: String },

    timestamp: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, index: true },
  },
  {
    timestamps: false, // We use our own timestamp field
    collection: 'audit_logs',
  }
);

// Compound indexes for common queries
AuditLogSchema.index({ actorId: 1, timestamp: -1 });
AuditLogSchema.index({ targetUserId: 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });
AuditLogSchema.index({ severity: 1, timestamp: -1 });
AuditLogSchema.index({ success: 1, timestamp: -1 });

// TTL index for automatic deletion of old logs (optional)
// Uncomment to enable automatic deletion after 90 days
// AuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AuditLog = model<IAuditLog>('AuditLog', AuditLogSchema);
export { AuditLog };
