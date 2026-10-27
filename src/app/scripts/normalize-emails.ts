/**
 * Normalize stored user e-mails to lowercase (one-off migration).
 *
 * Usage:
 *   npm run migrate:emails              # dry-run: report only, no writes
 *   npm run migrate:emails -- --apply   # rewrite non-colliding e-mails
 *
 * Uses MONGO_URI from the environment. Take a database backup before --apply.
 * Accounts that differ only by case are listed as collisions and never
 * changed; resolve them manually, then re-run until no collisions remain.
 */
import { config } from 'dotenv';
import mongoose from 'mongoose';
import { connectToDB } from '../db';
import { normalizeStoredEmails } from '../services/email-normalization.service';

config();

async function main() {
  const apply = process.argv.includes('--apply');
  await connectToDB();
  const report = await normalizeStoredEmails(apply);

  console.log(`\nE-mail normalization ${apply ? '(APPLY)' : '(dry-run, no changes written)'}`);
  console.log(`  Users scanned:            ${report.totalUsers}`);
  console.log(`  Not yet normalized:       ${report.needsNormalization}`);
  console.log(`  Updated:                  ${report.updated}`);
  console.log(`  Case-only collisions:     ${report.collisions.length}`);
  for (const collision of report.collisions) {
    console.log(`\n  ${collision.email}`);
    for (const account of collision.accounts)
      console.log(
        `    - ${account.id}  signup=${account.signupType ?? '?'}  google=${account.hasSocialLogin}  created=${account.createdAt?.toISOString?.() ?? '?'}`
      );
  }
  if (!apply && report.needsNormalization > 0)
    console.log('\nRe-run with --apply to write the changes.');
  if (report.collisions.length > 0)
    console.log('\nCollisions need a manual decision (merge or rename); they block nothing else.');

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('E-mail normalization failed:', error?.message ?? error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
