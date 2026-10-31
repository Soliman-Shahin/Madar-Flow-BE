import { asError } from '../shared/errors';
import logger from '../services/logger.service';
import { Request, Response, NextFunction } from 'express';
import {
  encryptAdvanced,
  decryptAdvanced,
  encryptFieldsDeep,
  decryptFieldsDeep,
} from '../shared/encryption-advanced';
import {
  decryptCryptoJS,
  isCryptoJSFormat,
} from '../shared/encryption-cryptojs-compat';
import { sendError } from '../shared/helper';

/**
 * Enhanced Encryption Middleware with Selective Encryption
 *
 * Features:
 * - Selective encryption based on configuration
 * - Smart detection of encrypted payloads
 * - Support for nested encryption
 * - Performance optimized
 */

interface EncryptionOptions {
  // Paths to exclude from encryption (e.g., health checks, public endpoints)
  excludePaths?: string[];
  // Paths to force encryption (overrides other rules)
  includePaths?: string[];
  // Whether to encrypt all responses by default
  encryptByDefault?: boolean;
  // Maximum payload size to encrypt (in bytes)
  maxPayloadSize?: number;
}

const defaultOptions: EncryptionOptions = {
  excludePaths: ['/health', '/v1/health', '/favicon.ico'],
  includePaths: [
    '/v1/user/login',
    '/v1/user/signup',
    '/v1/user/refresh-token',
    '/v1/user/logout',
    '/v1/user/me',
    '/v1/user/auth/google/native',
    '/v1/user/auth/facebook/native',
    '/v1/expenses',
    '/v1/categories',
  ],
  encryptByDefault: false,
  maxPayloadSize: 10 * 1024 * 1024, // 10MB
};

/**
 * Check if path should be encrypted
 */
function shouldEncryptPath(path: string, options: EncryptionOptions): boolean {
  // Check excluded paths first
  if (options.excludePaths?.some((p) => path.startsWith(p))) {
    return false;
  }

  // Check included paths
  if (options.includePaths?.some((p) => path.startsWith(p))) {
    return true;
  }

  // Use default behavior
  return options.encryptByDefault || false;
}

/**
 * Check if data is already encrypted (our format: iv:authTag:data)
 */
function isAlreadyEncrypted(data: any): boolean {
  if (typeof data === 'string') {
    const parts = data.split(':');
    return parts.length === 3;
  }
  if (data && typeof data === 'object' && data.encrypted === true) {
    return true;
  }
  return false;
}

/**
 * Create encryption middleware with custom options
 */
const SENSITIVE_FIELDS = ['id', '_id'];

/**
 * Create encryption middleware with custom options
 */
export function createEncryptionMiddleware(customOptions?: EncryptionOptions) {
  const options = { ...defaultOptions, ...customOptions };

  return (req: Request, res: Response, next: NextFunction) => {
    const shouldEncrypt = shouldEncryptPath(req.path, options);

    // Skip encryption for this path
    if (!shouldEncrypt) {
      return next();
    }

    // ============================================
    // DECRYPT INCOMING REQUEST BODY
    // ============================================
    if (req.body && typeof req.body === 'object') {
      try {
        // Check if Frontend sent full payload encryption: { data: "encrypted_string" }
        if (
          req.body.data &&
          typeof req.body.data === 'string' &&
          !req.body.email &&
          !req.body.password
        ) {
          // Full payload encryption from Frontend (CryptoJS format)
          try {
            // Check if it's CryptoJS format (from Frontend)
            if (isCryptoJSFormat(req.body.data)) {
              const decrypted = decryptCryptoJS(req.body.data);
              if (decrypted) {
                req.body = decrypted;
              }
            } else {
              // Try AES-256-GCM format (advanced encryption)
              const decrypted = decryptAdvanced(req.body.data);
              if (decrypted) {
                req.body =
                  typeof decrypted === 'string'
                    ? JSON.parse(decrypted)
                    : decrypted;
              }
            }
          } catch (decryptError: unknown) {
            logger.warn('Request decryption failed');

            // Fall through to field-level decryption
          }
        } else {
          // Field-level encryption (original behavior)
          req.body = decryptFieldsDeep(req.body, SENSITIVE_FIELDS);
        }
      } catch (error) {
        // Continue with original body if decryption fails
      }
    }

    // Classification observes the result of the authoritative decryption above.
    // It must never infer failure from the wire format before decryption runs.
    if (Array.isArray(req.body?.entities)) {
      req.body.entities = req.body.entities.map(
        (entity: any, index: number) => {
          const topLevelEncrypted = isAlreadyEncrypted(entity._id);
          const categoryObject =
            entity.category && typeof entity.category === 'object'
              ? entity.category
              : null;
          const nestedEncrypted = isAlreadyEncrypted(categoryObject?._id);
          const topLevelFailed = topLevelEncrypted;
          const nestedFailed = nestedEncrypted;
          return topLevelFailed || nestedFailed
            ? {
                ...entity,
                _syncError: topLevelFailed
                  ? 'TOP_LEVEL_ID_DECRYPT_FAILED'
                  : 'NESTED_CATEGORY_ID_DECRYPT_FAILED',
              }
            : entity;
        }
      );
    }

    // ============================================
    // ENCRYPT OUTGOING RESPONSE BODY (Field Level)
    // ============================================
    const originalJson = res.json.bind(res);

    res.json = function (body: any): Response {
      // TEMPORARILY DISABLED - Response encryption off for debugging

      return originalJson(body);

      /* Original encryption code - commented out for debugging
      // Skip encryption for errors
      if (!body) {
        return originalJson(body);
      }

      // Check payload size
      const bodySize = JSON.stringify(body).length;
      if (options.maxPayloadSize && bodySize > options.maxPayloadSize) {
        logger.warn(
          `⚠️  Payload too large for encryption (${bodySize} bytes), skipping`
        );
        return originalJson(body);
      }

      try {
        // Recursively encrypt sensitive fields
        const encryptedBody = encryptFieldsDeep(body, SENSITIVE_FIELDS);
        return originalJson(encryptedBody);
      } catch (error) {
        logger.error("❌ Response field encryption error:", asError(error));
        // Fall back to unencrypted response
        return originalJson(body);
      }
      */
    };

    next();
  };
}

/**
 * Default encryption middleware (backward compatible)
 */
export const advancedEncryptionMiddleware = createEncryptionMiddleware();

/**
 * Middleware factory for specific routes
 * Usage: router.use(encryptRoute())
 */
export function encryptRoute() {
  return createEncryptionMiddleware({
    encryptByDefault: true,
    excludePaths: [],
  });
}

/**
 * Disable encryption for specific route
 * Usage: router.use(noEncryption())
 */
export function noEncryption() {
  return (_req: Request, _res: Response, next: NextFunction) => {
    next();
  };
}

export default advancedEncryptionMiddleware;
