/**
 * Create or promote an admin user for the Admin dashboard.
 *
 * Usage (password from the environment keeps it out of shell history):
 *   SEED_ADMIN_PASSWORD='<strong password>' npm run seed:admin -- admin@yourdomain.com
 *
 * PowerShell:
 *   $env:SEED_ADMIN_PASSWORD='<strong password>'; npm run seed:admin '--' admin@yourdomain.com; Remove-Item Env:SEED_ADMIN_PASSWORD
 *
 * There is no default e-mail or password. The password must pass the same
 * strength rules as signup and is never printed. Updating an existing user
 * resets its password and revokes all of its sessions.
 */
import { config } from 'dotenv';
import bcrypt from 'bcryptjs';
import { connectToDB } from '../db';
import { User, UserRole } from '../models/user.model';
import { PlanSlug } from '../types/plan.types';
import logger from '../services/logger.service';
import { validatePassword } from '../services/password-validation.service';
import { maskEmail, normalizeEmail } from '../shared/email';

config();

const SALT_ROUNDS = 12;

async function seedAdmin() {
  const email = normalizeEmail(process.argv[2]);
  const password = process.env.SEED_ADMIN_PASSWORD ?? '';

  if (!email || !email.includes('@')) {
    logger.error('Usage: SEED_ADMIN_PASSWORD=... npm run seed:admin -- <admin e-mail>');
    process.exit(1);
  }
  const strength = validatePassword(password);
  if (!password || !strength.isValid) {
    logger.error(
      'SEED_ADMIN_PASSWORD is missing or too weak. It must meet the signup password rules.'
    );
    process.exit(1);
  }

  try {
    await connectToDB();
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const existing = await User.findOne({ email });

    if (existing) {
      existing.role = UserRole.Admin;
      existing.isActive = true;
      existing.password = hashedPassword;
      existing.sessions = [];
      existing.image = undefined;
      await existing.save();
      logger.info(`Promoted/updated admin user ${maskEmail(email)}; existing sessions revoked`);
    } else {
      await User.create({
        email,
        password: hashedPassword,
        role: UserRole.Admin,
        isActive: true,
        plan: PlanSlug.Free,
        customPermissions: [],
        sessions: [],
      });
      logger.info(`Created admin user ${maskEmail(email)}`);
    }
    process.exit(0);
  } catch (error) {
    logger.error('Failed to seed admin user:', error as Error);
    process.exit(1);
  }
}

seedAdmin();
