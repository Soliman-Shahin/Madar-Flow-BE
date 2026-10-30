import crypto from 'crypto';
import { Types } from 'mongoose';
import { BiometricCredential, BiometricPlatform } from '../models';
const hash = (value: string) =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex');
export class BiometricCredentialService {
  static async enroll(
    userId: string,
    deviceId: string,
    label: string,
    platform: BiometricPlatform
  ) {
    const credential = crypto.randomBytes(32).toString('hex');
    await BiometricCredential.findOneAndUpdate(
      { userId, deviceId },
      {
        $set: {
          credentialHash: hash(credential),
          label,
          platform,
          revokedAt: undefined,
          revokedReason: undefined,
          lastUsedAt: undefined,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    return credential;
  }
  static async findAndMarkUsed(deviceId: string, credential: string) {
    return BiometricCredential.findOneAndUpdate(
      {
        deviceId,
        credentialHash: hash(credential),
        revokedAt: { $exists: false },
      },
      { $set: { lastUsedAt: new Date() } },
      { returnDocument: 'after' }
    ).select('+credentialHash');
  }
  static revokeCurrent(userId: string, deviceId: string) {
    return BiometricCredential.updateOne(
      { userId, deviceId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: 'user_revoked' } }
    );
  }
  static revokeAllForUser(userId: string, reason: string) {
    return BiometricCredential.updateMany(
      { userId: new Types.ObjectId(userId), revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: reason } }
    );
  }
}
