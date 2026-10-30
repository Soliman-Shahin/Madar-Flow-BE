# Load testing

`scripts/load-test.cjs` is a dependency-free load test (Node 18+). It signs up
throw-away users and runs a realistic mix of requests (plan, categories,
add/list expenses, sync pull/push) for a fixed time, then prints per-endpoint
counts, errors and p50/p95/p99 latency. Exit code 1 means more than 1% errors
or an overall p95 above `--p95` (default 1500 ms).

**Local or staging only.** It creates real accounts and data and refuses any
host other than localhost unless `--allow-remote` is passed. Never point it at
production (production also limits sign-ins to 5 per 15 minutes per IP).

```bash
npm run build
ENCRYPTION_KEY=<the key the backend runs with> \
  node scripts/load-test.cjs --base http://localhost:3000/v1 --users 20 --duration 30
```

Sign-up bodies are encrypted, so the script needs the backend's
`ENCRYPTION_KEY` and the compiled `dist/`. Up to 90 users per run (sign-up
rate limit). "limited" answers (plan limit 403, rate limit 429) are expected
and are not errors.

Reference run (isolated backend with in-memory MongoDB, 30 users, 40 s):
about 57 req/s, 0% errors, overall p95 83 ms. Sign-up takes ~2.4 s under 30
concurrent sign-ups because password hashing is CPU-bound.

The end-to-end journeys (sign-up, sign-in, spending, two-device sync,
conflicts, account isolation, plan limits) live in
`src/app/test/e2e-critical-paths.test.ts` and run with the normal test suite.
