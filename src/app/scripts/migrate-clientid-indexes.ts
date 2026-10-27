/**
 * Replace the legacy sparse `{user, _clientId}` unique indexes on expenses and
 * categories with partial ones (one-off, per database).
 *
 * Usage:
 *   npm run migrate:clientid-indexes                 # dry-run, no changes
 *   npm run migrate:clientid-indexes -- --apply      # bash
 *   npm run migrate:clientid-indexes '--' --apply    # PowerShell
 *
 * Deploy the code first: the app then creates the partial index next to the
 * legacy one on startup. This script verifies it (creating it if needed) and
 * only then drops the legacy index, so uniqueness is never interrupted.
 */
import { config } from 'dotenv';
import mongoose from 'mongoose';
import { connectToDB } from '../db';
import { migrateClientIdIndexes } from '../services/client-id-index-migration.service';

config();

async function main() {
  const apply = process.argv.includes('--apply');
  await connectToDB();
  const reports = await migrateClientIdIndexes(apply);

  console.log(
    `\n_clientId index migration ${apply ? '(APPLY)' : '(dry-run, no changes written)'}`
  );
  let failed = false;
  for (const r of reports) {
    console.log(`\n  ${r.collection}`);
    console.log(`    legacy sparse index:   ${r.legacyIndex ?? 'none'}`);
    console.log(`    partial index present: ${r.partialIndexPresent}`);
    console.log(`    duplicate client ids:  ${r.duplicateClientIds}`);
    console.log(
      `    actions:               ${r.actions.length ? r.actions.join(', ') : 'none (already migrated)'}`
    );
    if (r.error) {
      failed = true;
      console.log(`    ERROR:                 ${r.error}`);
    }
  }
  if (!apply && reports.some((r) => r.actions.length > 0))
    console.log('\nRe-run with --apply to make these changes.');

  await mongoose.disconnect();
  if (failed) process.exit(1);
}

main().catch(async (error) => {
  console.error('_clientId index migration failed:', error?.message ?? error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
