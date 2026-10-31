/**
 * Seed synthetic QA fixtures: one user per role and per plan, plus sample
 * categories and expenses for the free user.
 *
 * LOCAL ONLY. Refuses to run unless MONGO_URI points at localhost/127.0.0.1.
 *
 * Usage (password stays out of shell history and is never printed):
 *   MONGO_URI=mongodb://127.0.0.1:27017/madarflow_qa TEST_FIXTURES_PASSWORD='<strong>' npm run seed:test
 *
 * Accounts (e-mail domain is reserved `.test`):
 *   qa-user-free / qa-user-pro / qa-user-premium / qa-moderator / qa-admin / qa-superadmin @madarflow.test
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectToDB } from '../db';
import { User, UserRole } from '../models/user.model';
import { Category } from '../models/category.model';
import { Expense } from '../models/expense.model';
import { PlanSlug } from '../types/plan.types';
import { validatePassword } from '../services/password-validation.service';

const ACCOUNTS: Array<{ name: string; role: UserRole; plan: PlanSlug; currency?: string }> = [
  { name: 'qa-user-free', role: UserRole.User, plan: PlanSlug.Free, currency: 'EGP' },
  { name: 'qa-user-pro', role: UserRole.User, plan: PlanSlug.Pro, currency: 'EGP' },
  { name: 'qa-user-premium', role: UserRole.User, plan: PlanSlug.Premium, currency: 'EGP' },
  { name: 'qa-moderator', role: UserRole.Moderator, plan: PlanSlug.Free, currency: 'EGP' },
  { name: 'qa-admin', role: UserRole.Admin, plan: PlanSlug.Free, currency: 'EGP' },
  { name: 'qa-superadmin', role: UserRole.SuperAdmin, plan: PlanSlug.Free, currency: 'EGP' },
  // No currency on purpose: exercises the first-sign-in currency prompt.
  { name: 'qa-user-nocurrency', role: UserRole.User, plan: PlanSlug.Free },
];

function assertLocal(uri: string | undefined): void {
  if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri)) {
    console.error('Refusing to seed: MONGO_URI must be a localhost/127.0.0.1 MongoDB.');
    process.exit(1);
  }
}

async function main() {
  assertLocal(process.env.MONGO_URI);
  const password = process.env.TEST_FIXTURES_PASSWORD ?? '';
  if (!validatePassword(password).isValid) {
    console.error('TEST_FIXTURES_PASSWORD is missing or too weak.');
    process.exit(1);
  }

  await connectToDB();
  const hash = await bcrypt.hash(password, 10);
  console.log('[seed] connected, creating users');
  const users: Record<string, any> = {};

  for (const a of ACCOUNTS) {
    const email = `${a.name}@madarflow.test`;
    users[a.name] = await User.findOneAndUpdate(
      { email },
      {
        $set: { email, password: hash, role: a.role, plan: a.plan, isActive: true, emailVerified: true, sessions: [], ...(a.currency ? { currency: a.currency } : {}) },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  }

  console.log('[seed] users done');
  const owner = users['qa-user-free']._id;
  const defs = [
    { title: 'Food', icon: 'restaurant', color: '#E57373' },
    { title: 'Transport', icon: 'car', color: '#64B5F6' },
    { title: 'Salary', icon: 'cash', color: '#81C784' },
  ];
  const cats: any[] = [];
  for (const d of defs) {
    cats.push(
      await Category.findOneAndUpdate(
        { user: owner, title: d.title },
        { $set: { ...d, user: owner } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      )
    );
  }
  console.log('[seed] categories done');
  await Expense.deleteMany({ user: owner, description: /^QA sample/ });
  await Expense.insertMany(
    Array.from({ length: 12 }, (_, i) => ({
      description: `QA sample ${i + 1}`,
      amount: 10 + i * 5,
      category: cats[i % cats.length]._id,
      date: new Date(Date.now() - i * 86400000),
      user: owner,
    }))
  );

  console.log(`Seeded ${ACCOUNTS.length} QA accounts, ${cats.length} categories, 12 expenses.`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Seed failed:', (e as Error).message);
  process.exit(1);
});
