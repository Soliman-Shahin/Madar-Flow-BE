import logger from '../services/logger.service';
import { Request, Response, NextFunction } from 'express';
import { sendError } from '../shared/helper';

/**
 * Brute Force Protection Middleware
 *
 * Features:
 * - Track failed login attempts
 * - Progressive delays (exponential backoff)
 * - Account lockout after threshold
 * - IP-based and account-based tracking
 * - Automatic unlock after cooldown period
 */

interface FailedAttempt {
  count: number;
  firstAttemptTime: number;
  lastAttemptTime: number;
  lockedUntil?: number;
}

interface BruteForceConfig {
  maxFailedAttempts: number; // Max failed attempts before lockout
  lockoutDurationMs: number; // How long to lock the account
  windowMs: number; // Time window to track attempts
  progressiveDelay: boolean; // Enable progressive delays
}

const defaultConfig: BruteForceConfig = {
  maxFailedAttempts: 5,
  lockoutDurationMs: 15 * 60 * 1000, // 15 minutes
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Disable artificial delays locally — they caused 15s+ waits and client timeouts
  progressiveDelay: process.env.NODE_ENV === 'production',
};

class BruteForceProtection {
  private ipAttempts: Map<string, FailedAttempt> = new Map();
  private emailAttempts: Map<string, FailedAttempt> = new Map();
  private config: BruteForceConfig;
  private cleanupInterval: NodeJS.Timeout;

  constructor(config?: Partial<BruteForceConfig>) {
    this.config = { ...defaultConfig, ...config };

    // Cleanup old entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  private cleanup() {
    const now = Date.now();
    const windowEnd = now - this.config.windowMs;

    // Cleanup IP attempts
    for (const [ip, attempt] of this.ipAttempts.entries()) {
      if (
        attempt.lastAttemptTime < windowEnd &&
        (!attempt.lockedUntil || attempt.lockedUntil < now)
      ) {
        this.ipAttempts.delete(ip);
      }
    }

    // Cleanup email attempts
    for (const [email, attempt] of this.emailAttempts.entries()) {
      if (
        attempt.lastAttemptTime < windowEnd &&
        (!attempt.lockedUntil || attempt.lockedUntil < now)
      ) {
        this.emailAttempts.delete(email);
      }
    }
  }

  private getIp(req: Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  private getAttempt(
    key: string,
    store: Map<string, FailedAttempt>
  ): FailedAttempt {
    const now = Date.now();
    let attempt = store.get(key);

    if (!attempt || now - attempt.firstAttemptTime > this.config.windowMs) {
      attempt = {
        count: 0,
        firstAttemptTime: now,
        lastAttemptTime: now,
      };
      store.set(key, attempt);
    }

    return attempt;
  }

  private calculateDelay(attemptCount: number): number {
    if (!this.config.progressiveDelay) return 0;

    // Progressive delay: 1s, 2s, 4s, 8s, 16s...
    const baseDelay = 1000; // 1 second
    const maxDelay = 10000; // Keep below typical client timeout (15s)
    const delay = Math.min(baseDelay * Math.pow(2, attemptCount - 1), maxDelay);

    return delay;
  }

  /**
   * Check if request should be blocked before authentication
   */
  public checkBeforeAuth() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const ip = this.getIp(req);
      // Runs before schema validation, so the value may be an object or array (operator
      // injection attempt); only strings are tracked, the validator rejects the rest.
      const rawEmail = req.body?.email;
      const email =
        typeof rawEmail === 'string' ? rawEmail.toLowerCase() : undefined;
      const now = Date.now();

      // Check IP-based lockout
      const ipAttempt = this.getAttempt(ip, this.ipAttempts);
      if (ipAttempt.lockedUntil && ipAttempt.lockedUntil > now) {
        const remainingTime = Math.ceil((ipAttempt.lockedUntil - now) / 1000);
        return sendError(
          res,
          `Too many failed attempts. Account locked. Try again in ${remainingTime} seconds`,
          429,
          'ACCOUNT_LOCKED',
          { remainingTime, type: 'ip' }
        );
      }

      // Check email-based lockout
      if (email) {
        const emailAttempt = this.getAttempt(email, this.emailAttempts);
        if (emailAttempt.lockedUntil && emailAttempt.lockedUntil <= now) {
          emailAttempt.count = 0;
          delete emailAttempt.lockedUntil;
        }
        if (emailAttempt.lockedUntil && emailAttempt.lockedUntil > now) {
          const remainingTime = Math.ceil(
            (emailAttempt.lockedUntil - now) / 1000
          );
          return sendError(
            res,
            `Too many failed login attempts for this account. Try again in ${remainingTime} seconds`,
            429,
            'ACCOUNT_LOCKED',
            { remainingTime, type: 'email' }
          );
        }
      }

      next();
    };
  }

  /**
   * Record failed authentication attempt
   */
  public recordFailedAttempt(email: string, ip: string) {
    const now = Date.now();

    // Record IP attempt
    const ipAttempt = this.getAttempt(ip, this.ipAttempts);
    ipAttempt.count++;
    ipAttempt.lastAttemptTime = now;

    if (ipAttempt.count >= this.config.maxFailedAttempts) {
      ipAttempt.lockedUntil = now + this.config.lockoutDurationMs;
      logger.warn(
        `🔒 IP ${ip} locked due to ${ipAttempt.count} failed attempts`
      );
    }

    // Record email attempt
    if (email) {
      const emailNormalized = email.toLowerCase();
      const emailAttempt = this.getAttempt(emailNormalized, this.emailAttempts);
      emailAttempt.count++;
      emailAttempt.lastAttemptTime = now;

      if (emailAttempt.count >= this.config.maxFailedAttempts) {
        emailAttempt.lockedUntil = now + this.config.lockoutDurationMs;
        logger.warn(
          `🔒 Email ${emailNormalized} locked due to ${emailAttempt.count} failed attempts`
        );
      }
    }
  }

  /**
   * Reset attempts on successful login
   */
  public resetAttempts(email: string, ip: string) {
    if (email) {
      this.emailAttempts.delete(email.toLowerCase());
    }
    this.ipAttempts.delete(ip);
  }

  /**
   * Get current attempt counts (for monitoring)
   */
  public getAttemptInfo(email?: string, ip?: string) {
    const info: any = {};

    if (ip) {
      info.ip = this.ipAttempts.get(ip) || { count: 0 };
    }

    if (email) {
      info.email = this.emailAttempts.get(email.toLowerCase()) || { count: 0 };
    }

    return info;
  }

  public destroy() {
    clearInterval(this.cleanupInterval);
  }
}

// Singleton instance
const bruteForceProtection = new BruteForceProtection();

/**
 * Middleware to check before authentication
 */
export const checkBruteForce = bruteForceProtection.checkBeforeAuth();

/**
 * Helper to record failed attempt (use in login controller)
 */
export function recordFailedLogin(email: string, ip: string) {
  bruteForceProtection.recordFailedAttempt(email, ip);
}

/**
 * Helper to reset attempts on successful login
 */
export function resetLoginAttempts(email: string, ip: string) {
  bruteForceProtection.resetAttempts(email, ip);
}

/**
 * Get attempt information
 */
export function getLoginAttempts(email?: string, ip?: string) {
  return bruteForceProtection.getAttemptInfo(email, ip);
}

export default bruteForceProtection;
