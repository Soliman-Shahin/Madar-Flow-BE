import { Types } from 'mongoose';
import { User } from '../models/user.model';
import { maskEmail } from '../shared/email';

export interface EmailCollision {
  /** Masked normalized address shared by several accounts. */
  email: string;
  accounts: Array<{
    id: string;
    signupType?: string;
    createdAt?: Date;
    hasSocialLogin: boolean;
  }>;
}

export interface EmailNormalizationReport {
  apply: boolean;
  totalUsers: number;
  /** Accounts whose stored e-mail is not already normalized. */
  needsNormalization: number;
  /** Accounts actually rewritten (0 in dry-run). */
  updated: number;
  /** Groups of accounts that differ only by case; never changed automatically. */
  collisions: EmailCollision[];
}

interface Group {
  _id: string;
  users: Array<{
    _id: Types.ObjectId;
    email: string;
    signupType?: string;
    socialId?: string;
    createdAt?: Date;
  }>;
}

/**
 * Lowercases and trims every stored e-mail that is not normalized yet.
 *
 * - Dry-run unless `apply` is true.
 * - Accounts whose normalized e-mail is shared with another account
 *   (case-only duplicates) are reported and left untouched: merging or
 *   renaming them is a manual decision.
 * - Each write is conditional on the e-mail still holding its original value,
 *   so the script is safe to re-run and safe against concurrent edits.
 */
export async function normalizeStoredEmails(
  apply: boolean
): Promise<EmailNormalizationReport> {
  const groups = await User.collection
    .aggregate<Group>([
      { $match: { email: { $type: 'string' } } },
      {
        $group: {
          _id: { $toLower: { $trim: { input: '$email' } } },
          users: {
            $push: {
              _id: '$_id',
              email: '$email',
              signupType: '$signupType',
              socialId: '$socialId',
              createdAt: '$createdAt',
            },
          },
        },
      },
    ])
    .toArray();

  const report: EmailNormalizationReport = {
    apply,
    totalUsers: 0,
    needsNormalization: 0,
    updated: 0,
    collisions: [],
  };

  for (const group of groups) {
    report.totalUsers += group.users.length;
    const pending = group.users.filter((u) => u.email !== group._id);
    report.needsNormalization += pending.length;

    if (group.users.length > 1) {
      report.collisions.push({
        email: maskEmail(group._id),
        accounts: group.users.map((u) => ({
          id: u._id.toString(),
          signupType: u.signupType,
          createdAt: u.createdAt,
          hasSocialLogin: !!u.socialId,
        })),
      });
      continue;
    }

    if (!apply || pending.length === 0) continue;
    const [user] = pending;
    const result = await User.collection.updateOne(
      { _id: user._id, email: user.email },
      { $set: { email: group._id } }
    );
    report.updated += result.modifiedCount;
  }

  return report;
}
