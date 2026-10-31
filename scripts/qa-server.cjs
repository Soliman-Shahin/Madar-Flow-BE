/**
 * Local QA server: in-memory MongoDB + throwaway secrets + the real Express app.
 * Never reads credentials: every external-service variable is forced empty so
 * dotenv (which does not override existing variables) cannot pull them from .env.
 *
 *   node scripts/qa-server.cjs            # port 3100 (QA_PORT to override)
 *
 * Seeds roles, plans and QA fixtures (password printed NOWHERE; read it from
 * the QA_PASSWORD env var or the default shown in the log is NOT used).
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const rand = (n = 48) => crypto.randomBytes(n).toString('hex');

(async () => {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('madarflow_qa').replace(/\/?\?.*$/, '');
  const port = process.env.QA_PORT || '3100';
  const qaPassword = process.env.QA_PASSWORD || `Qa!${rand(6)}Aa1`;

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: port,
    MONGO_URI: uri.endsWith('/madarflow_qa') ? uri : `${uri.replace(/\/$/, '')}/madarflow_qa`,
    ACCESS_TOKEN_SECRET: rand(),
    REFRESH_TOKEN_SECRET: rand(),
    JWT_SECRET: rand(),
    ENCRYPTION_KEY: rand(),
    ALLOWED_ORIGINS: `http://localhost:${port}`,
    // Force-disable external services (empty string blocks dotenv from filling them).
    RESEND_API_KEY: '',
    RESEND_FROM_EMAIL: '',
    FIREBASE_PROJECT_ID: '',
    FIREBASE_PRIVATE_KEY: '',
    FIREBASE_CLIENT_EMAIL: '',
    GOOGLE_CLIENT_ID: 'qa-dummy-client-id',
    GOOGLE_CALLBACK_URL: `http://localhost:${port}/v1/user/google/callback`,
    GOOGLE_CLIENT_SECRET: 'qa-dummy-secret',
    REDIS_URL: '',
    REVENUECAT_WEBHOOK_AUTH: '',
    REVENUECAT_SECRET_API_KEY: '',
    TEST_FIXTURES_PASSWORD: qaPassword,
  };

  // Seeds occasionally hang on the in-memory MongoDB (defect D-005): time-box each one and retry.
  const run = (script) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = spawnSync('npx', ['ts-node', script], { env, cwd: path.join(__dirname, '..'), shell: true, stdio: 'inherit', timeout: 45000 });
      if (r.status === 0) return;
      console.log(`[qa-server] ${script} attempt ${attempt} failed (${r.signal || r.status}); retrying`);
    }
    console.log(`[qa-server] ${script} did not complete; continuing`);
  };

  // Fixtures first: seeding users after roles/plans currently hangs (see QA notes).
  run('src/app/scripts/seed-test-fixtures.ts');
  run('src/app/scripts/seed-roles.ts');
  run('src/app/scripts/seed-plans.ts');

  console.log(`[qa-server] starting on http://localhost:${port}/v1 (in-memory DB)`);
  const server = spawn('npx', ['ts-node', 'src/app/server.ts'], {
    env,
    cwd: path.join(__dirname, '..'),
    shell: true,
    stdio: 'inherit',
  });
  const stop = async () => {
    server.kill();
    await mongo.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
