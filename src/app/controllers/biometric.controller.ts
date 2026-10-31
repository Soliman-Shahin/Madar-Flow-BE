import { Response } from 'express';
import { sendError, sendSuccess } from '../shared/helper';
import { AuthenticatedRequest } from '../middleware/access.middleware';
import { User } from '../models';
import { BiometricCredentialService } from '../services/biometric-credential.service';
import { sendUserAndTokens } from '../shared/helper/send-user-and-token';
import { auditLogService } from '../services/audit-log.service';
import { AuditAction, AuditSeverity } from '../models/audit-log.model';
const failure = 'Biometric authentication failed';
const audit = async (
  req: AuthenticatedRequest,
  action: AuditAction,
  targetUserId?: string,
  success = true
) => {
  try {
    await auditLogService.log({
      req,
      action,
      targetUserId,
      success,
      severity: success ? AuditSeverity.INFO : AuditSeverity.WARNING,
      metadata: {
        deviceId:
          typeof req.body?.deviceId === 'string'
            ? req.body.deviceId
            : undefined,
      },
    });
  } catch {
    /* audit failure must not expose credentials or break auth */
  }
};
export const enrollBiometric = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  if (!req.user_id)
    return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
  const user = await User.findOne({
    _id: req.user_id,
    _isDeleted: { $ne: true },
    isActive: { $ne: false },
  });
  if (!user)
    return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
  const { deviceId, label, platform } = req.body;
  const credential = await BiometricCredentialService.enroll(
    req.user_id,
    deviceId,
    label,
    platform
  );
  await audit(req, AuditAction.BIOMETRIC_ENROLLED, req.user_id);
  return sendSuccess(
    res,
    { credential, deviceId, label, platform },
    'Biometric sign-in enrolled',
    201
  );
};
export const biometricSignIn = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const record = await BiometricCredentialService.findAndMarkUsed(
      req.body.deviceId,
      req.body.credential
    );
    if (!record) {
      await audit(req, AuditAction.BIOMETRIC_SIGNIN_FAILED, undefined, false);
      return sendError(res, failure, 401, 'BIOMETRIC_AUTH_FAILED');
    }
    const user = await User.findOne({
      _id: record.userId,
      _isDeleted: { $ne: true },
      isActive: { $ne: false },
    });
    if (!user) {
      await audit(req, AuditAction.BIOMETRIC_SIGNIN_FAILED, undefined, false);
      return sendError(res, failure, 401, 'BIOMETRIC_AUTH_FAILED');
    }
    await audit(req, AuditAction.BIOMETRIC_SIGNIN, user._id.toString());
    return sendUserAndTokens(res, user);
  } catch {
    await audit(req, AuditAction.BIOMETRIC_SIGNIN_FAILED, undefined, false);
    return sendError(res, failure, 401, 'BIOMETRIC_AUTH_FAILED');
  }
};
export const revokeCurrentBiometric = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  if (!req.user_id)
    return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
  await BiometricCredentialService.revokeCurrent(
    req.user_id,
    req.body.deviceId
  );
  await audit(req, AuditAction.BIOMETRIC_REVOKED, req.user_id);
  return sendSuccess(res, {}, 'Biometric sign-in revoked');
};
