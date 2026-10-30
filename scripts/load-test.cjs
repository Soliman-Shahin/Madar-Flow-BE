#!/usr/bin/env node
/**
 * Light load test for a Madar Flow backend. Dependency-free (Node 18+ fetch).
 *
 * It signs up N throw-away users, then each one repeats a realistic mix of
 * requests (plan, categories, add/list expenses, sync pull/push) for a fixed
 * time, and prints per-endpoint counts, error rates and latency percentiles.
 *
 * SAFETY
 *  - Aimed at a LOCAL or STAGING backend only. It creates real accounts and
 *    data. It refuses any host other than localhost unless --allow-remote.
 *  - Never run it against production. Production limits sign-ins to 5 per 15
 *    minutes per IP, so the script could not work there anyway.
 *
 * PREPARE (once, from Madar-Flow-BE):
 *   npm run build
 *   ENCRYPTION_KEY=<same key the backend runs with> node scripts/load-test.cjs
 *
 * OPTIONS
 *   --base <url>       API base, default http://localhost:3000/v1
 *   --users <n>        virtual users, default 20 (max 90: signup rate limit)
 *   --duration <sec>   test length after sign-up, default 30
 *   --p95 <ms>         fail if overall p95 latency exceeds this, default 1500
 *   --allow-remote     allow a non-localhost host (staging only)
 *
 * EXIT CODE  0 = within thresholds, 1 = error rate > 1% or p95 too high.
 * Expected "limited" answers (plan limits 403, rate limits 429) are counted
 * separately and are not errors.
 */
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const BASE = String(arg('base', 'http://localhost:3000/v1')).replace(/\/$/, '');
const USERS = Math.min(Math.max(parseInt(arg('users', '20'), 10) || 20, 1), 90);
const DURATION_MS = Math.max(parseInt(arg('duration', '30'), 10) || 30, 5) * 1000;
const P95_LIMIT = parseInt(arg('p95', '1500'), 10) || 1500;
const host = new URL(BASE).hostname;

if (!['localhost', '127.0.0.1', '::1'].includes(host) && !arg('allow-remote', false)) {
  console.error(`Refusing to load-test ${host}. Use a local backend, or pass --allow-remote for staging only.`);
  process.exit(2);
}
if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY must be set to the same value the backend uses (sign-up bodies are encrypted).');
  process.exit(2);
}

let encryptCryptoJS;
try {
  ({ encryptCryptoJS } = require(path.join(__dirname, '..', 'dist', 'app', 'shared', 'encryption-cryptojs-compat'))); // eslint-disable-line
} catch {
  console.error('Build the backend first (npm run build): dist/ is missing.');
  process.exit(2);
}

const PASSWORD = 'LoadTest-Password-42!';
const CONSENT = { termsAccepted: true, privacyAccepted: true, termsVersion: process.env.TERMS_VERSION, privacyVersion: process.env.PRIVACY_VERSION };
const stats = new Map(); // endpoint -> { ok, limited, errors, times[] }
const runId = Date.now().toString(36);

function record(name, status, ms) {
  const s = stats.get(name) || { ok: 0, limited: 0, errors: 0, times: [] };
  if (status >= 200 && status < 300) s.ok++;
  else if (status === 403 || status === 429 || status === 409) s.limited++;
  else s.errors++;
  s.times.push(ms);
  stats.set(name, s);
}

async function call(name, method, url, { token, body, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (ip) headers['X-Forwarded-For'] = ip;
  const t0 = performance.now();
  let status = 0;
  let json = null;
  try {
    const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    status = 0; // network failure counts as an error
  }
  record(name, status, performance.now() - t0);
  return { status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (n) => Math.floor(Math.random() * n);

async function signUp(i) {
  const email = `load-${runId}-${i}@loadtest.invalid`;
  // Consent versions come from the backend config when not overridden.
  let consent = CONSENT;
  if (!consent.termsVersion) {
    const cfg = require(path.join(__dirname, '..', 'dist', 'app', 'config', 'consent.config')).CONSENT_VERSIONS;
    consent = { ...CONSENT, termsVersion: cfg.terms, privacyVersion: cfg.privacy };
  }
  const res = await call('POST /user/signup', 'POST', '/user/signup', {
    ip: `10.99.${Math.floor(i / 250)}.${(i % 250) + 1}`,
    body: { data: encryptCryptoJS({ email, password: PASSWORD, ...consent }) },
  });
  const d = res.json && res.json.data;
  return d && d.accessToken ? { token: d.accessToken, categoryId: null, expenseCount: 0 } : null;
}

async function virtualUser(vu, deadline) {
  // Resolve one category to attach expenses to.
  const cats = await call('GET /categories/list', 'GET', '/categories/list', { token: vu.token });
  const payload = cats.json && cats.json.data;
  const list = (payload && (payload.data || payload.categories || payload)) || [];
  vu.categoryId = Array.isArray(list) && list[0] ? list[0]._id : null;

  while (performance.now() < deadline) {
    const roll = pick(100);
    if (roll < 20) await call('GET /plans/me', 'GET', '/plans/me', { token: vu.token });
    else if (roll < 35) await call('GET /categories/list', 'GET', '/categories/list', { token: vu.token });
    else if (roll < 55) await call('GET /expenses', 'GET', '/expenses', { token: vu.token });
    else if (roll < 75 && vu.categoryId) {
      await call('POST /expenses', 'POST', '/expenses', {
        token: vu.token,
        body: { description: 'load ' + vu.expenseCount++, amount: 1 + pick(500), category: vu.categoryId, date: new Date().toISOString() },
      });
    } else if (roll < 90) await call('GET /sync/pull', 'GET', '/sync/pull?limit=50', { token: vu.token });
    else {
      const id = `offline_load_${runId}_${Math.random().toString(36).slice(2)}`;
      await call('POST /sync/push', 'POST', '/sync/push', {
        token: vu.token,
        body: { entities: vu.categoryId ? [{ _id: id, _clientId: id, _entityType: 'expense', description: 'sync load', amount: 5, category: vu.categoryId, date: new Date().toISOString() }] : [] },
      });
    }
    await sleep(200 + pick(600)); // think time
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

(async () => {
  console.log(`Load test: ${USERS} users, ${DURATION_MS / 1000}s, ${BASE}`);
  const health = await fetch(BASE.replace(/\/v1$/, '') + '/health').catch(() => null);
  if (!health || !health.ok) {
    console.error('Backend not reachable (health check failed).');
    process.exit(2);
  }

  const users = (await Promise.all(Array.from({ length: USERS }, (_, i) => signUp(i)))).filter(Boolean);
  console.log(`Signed up ${users.length}/${USERS} users`);
  if (!users.length) process.exit(1);

  const started = performance.now();
  const deadline = started + DURATION_MS;
  await Promise.all(users.map((vu) => virtualUser(vu, deadline)));
  const seconds = (performance.now() - started) / 1000;

  let total = 0, errors = 0;
  const all = [];
  const rows = [];
  for (const [name, s] of [...stats].sort()) {
    const sorted = [...s.times].sort((a, b) => a - b);
    all.push(...s.times);
    const n = s.ok + s.limited + s.errors;
    total += n;
    errors += s.errors;
    rows.push([name, n, s.ok, s.limited, s.errors, pct(sorted, 50).toFixed(0), pct(sorted, 95).toFixed(0), pct(sorted, 99).toFixed(0)]);
  }
  console.log('\nendpoint'.padEnd(26) + 'reqs   ok  limited  errors  p50ms  p95ms  p99ms');
  for (const r of rows) {
    console.log(String(r[0]).padEnd(25) + [r[1], r[2], r[3], r[4], r[5], r[6], r[7]].map((v) => String(v).padStart(6)).join(' '));
  }
  all.sort((a, b) => a - b);
  const p95 = pct(all, 95);
  const errRate = total ? errors / total : 0;
  console.log(`\nTotal ${total} requests in ${seconds.toFixed(1)}s (${(total / seconds).toFixed(1)} req/s), error rate ${(errRate * 100).toFixed(2)}%, overall p95 ${p95.toFixed(0)} ms`);

  const failed = errRate > 0.01 || p95 > P95_LIMIT;
  console.log(failed ? 'RESULT: FAIL (error rate > 1% or p95 over limit)' : 'RESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
