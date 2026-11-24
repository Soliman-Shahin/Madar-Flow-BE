#!/usr/bin/env node
/**
 * Restores a backup made by scripts/backup-db.cjs.
 *
 * Safety: it refuses to write into a collection that already has documents, and the
 * target database name is required, so a restore can never silently overwrite live data.
 *
 * Usage:
 *   MONGO_URI=<target server> node scripts/restore-db.cjs --from <backup folder> --db <target db name>
 *
 * Restore test:  point MONGO_URI at a throwaway server (mongodb-memory-server) and use any --db.
 * Real recovery: restore into a NEW database name, check it, then point the app at it.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function restoreCollection(db, dir, name, expected) {
  const coll = db.collection(name);
  if ((await coll.estimatedDocumentCount()) > 0) {
    throw new Error(`Target collection "${name}" is not empty - refusing to overwrite`);
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dir, `${name}.ndjson.gz`)).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  const hash = crypto.createHash('sha256');
  let batch = [];
  let count = 0;
  for await (const line of rl) {
    if (!line) continue;
    hash.update(line + '\n');
    batch.push(EJSON.parse(line, { relaxed: false }));
    if (batch.length === 1000) {
      await coll.insertMany(batch, { ordered: false });
      count += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await coll.insertMany(batch, { ordered: false });
    count += batch.length;
  }
  const indexes = JSON.parse(fs.readFileSync(path.join(dir, `${name}.indexes.json`), 'utf8'));
  for (const { key, name: idxName, v, ns, ...opts } of indexes) {
    if (idxName === '_id_') continue;
    await coll.createIndex(key, { name: idxName, ...opts });
  }
  const checksumOk = hash.digest('hex') === expected.sha256;
  return { count, checksumOk };
}

async function main() {
  const uri = process.env.MONGO_URI;
  const from = arg('from');
  const dbName = arg('db');
  if (!uri || !from || !dbName) {
    throw new Error('Need MONGO_URI env, --from <backup folder> and --db <target database name>');
  }
  const dir = path.resolve(from);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db(dbName);
    console.log(`Restoring backup of "${manifest.database}" (${manifest.createdAt}) into "${dbName}"`);
    let bad = 0;
    for (const [name, info] of Object.entries(manifest.collections)) {
      const r = await restoreCollection(db, dir, name, info);
      const ok = r.count === info.count && r.checksumOk;
      if (!ok) bad++;
      console.log(`  ${name}: ${r.count}/${info.count} docs ${ok ? 'OK' : 'MISMATCH'}`);
    }
    console.log(bad ? `RESTORE FINISHED WITH ${bad} MISMATCH(ES)` : 'RESTORE VERIFIED: all counts and checksums match');
    if (bad) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('RESTORE FAILED:', err.message);
  process.exit(1);
});
