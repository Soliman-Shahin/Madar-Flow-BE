#!/usr/bin/env node
/**
 * Logical backup of every collection in the database named by MONGO_URI.
 * No mongodump needed. Output (one folder per run):
 *   <out>/<UTC timestamp>/<collection>.ndjson.gz   Extended-JSON, one document per line
 *   <out>/<UTC timestamp>/<collection>.indexes.json
 *   <out>/<UTC timestamp>/manifest.json             counts + checksums, used to verify
 *
 * Usage (production):
 *   railway run -- node scripts/backup-db.cjs --out "C:\Users\you\Backups\Madar-Flow" [--keep 14]
 *
 * The backup contains personal data and password hashes. Keep it outside the repo
 * on an encrypted disk, and never commit it. The connection string is never printed.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { once } = require('events');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');

// The backup holds personal data and password hashes: everything we create is owner-only.
// (On Windows the mode bits are advisory; access then follows the profile folder's ACL.)
process.umask(0o077);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function dumpCollection(coll, dir) {
  const file = path.join(dir, `${coll.collectionName}.ndjson.gz`);
  const gzip = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(file, { mode: 0o600 });
  gzip.pipe(out);
  const hash = crypto.createHash('sha256');
  let count = 0;
  for await (const doc of coll.find({}, { sort: { _id: 1 } })) {
    const line = EJSON.stringify(doc, { relaxed: false }) + '\n';
    hash.update(line);
    if (!gzip.write(line)) await once(gzip, 'drain');
    count++;
  }
  gzip.end();
  await once(out, 'finish');
  const indexes = await coll.indexes();
  fs.writeFileSync(
    path.join(dir, `${coll.collectionName}.indexes.json`),
    JSON.stringify(indexes, null, 2),
    { mode: 0o600 }
  );
  return { count, sha256: hash.digest('hex'), bytes: fs.statSync(file).size };
}

function pruneOld(root, keep) {
  const runs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}T\d{6}Z$/.test(d.name))
    .map((d) => d.name)
    .sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - keep))) {
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
    console.log(`pruned old backup ${old}`);
  }
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const root = path.resolve(arg('out', './backups'));
  const keep = Number(arg('keep', '14'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(root, stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(root, 0o700);
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort: not every filesystem supports POSIX modes */
  }

  const client = await MongoClient.connect(uri);
  try {
    const db = client.db();
    const host = new URL(uri.replace(/^mongodb(\+srv)?:/, 'https:')).host;
    console.log(`Backing up database "${db.databaseName}" on ${host} -> ${dir}`);

    const manifest = {
      database: db.databaseName,
      host,
      createdAt: new Date().toISOString(),
      collections: {},
    };
    const collections = await db.listCollections({ type: 'collection' }).toArray();
    for (const { name } of collections) {
      if (name.startsWith('system.')) continue;
      manifest.collections[name] = await dumpCollection(db.collection(name), dir);
      console.log(`  ${name}: ${manifest.collections[name].count} docs`);
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });

    // Verify: compare what we wrote against a fresh count from the database.
    let drift = 0;
    for (const [name, info] of Object.entries(manifest.collections)) {
      const now = await db.collection(name).estimatedDocumentCount();
      if (now !== info.count) drift++;
    }
    const total = Object.values(manifest.collections).reduce((n, c) => n + c.count, 0);
    console.log(
      `Done: ${Object.keys(manifest.collections).length} collections, ${total} documents.` +
        (drift ? ` (${drift} collection(s) changed while the backup ran - normal on a live DB)` : '')
    );
  } finally {
    await client.close();
  }
  if (keep > 0) pruneOld(root, keep);
}

main().catch((err) => {
  console.error('BACKUP FAILED:', err.message);
  process.exit(1);
});
