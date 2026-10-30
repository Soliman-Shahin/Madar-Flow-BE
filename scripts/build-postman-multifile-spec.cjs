const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'postman/openapi.json'), 'utf8'));
const target = path.join(root, 'postman/spec');
const pathsDir = path.join(target, 'paths');
fs.mkdirSync(pathsDir, { recursive: true });
for (const entry of fs.readdirSync(pathsDir)) fs.rmSync(path.join(pathsDir, entry), { recursive: true, force: true });

function escapePointer(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
function relocateComponentRefs(value) {
  if (Array.isArray(value)) return value.map(relocateComponentRefs);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = typeof child === 'string' && child.startsWith('#/components/')
        ? `../openapi.json${child}`
        : relocateComponentRefs(child);
    }
    return result;
  }
  return value;
}
function slug(routeFile) {
  return routeFile.replace(/\.(route|routes)\.ts$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

const groups = new Map();
for (const [route, item] of Object.entries(source.paths)) {
  const firstOperation = Object.values(item).find((value) => value && typeof value === 'object' && value['x-source-route']);
  const routeFile = firstOperation?.['x-source-route'] || 'other.route.ts';
  const file = `paths/${slug(routeFile)}.json`;
  if (!groups.has(file)) groups.set(file, {});
  groups.get(file)[route] = relocateComponentRefs(item);
}

const rootSpec = { ...source, paths: {} };
const splitGroups = [];
const maxChunkBytes = 35000;
for (const [file, entries] of groups) {
  const routeEntries = Object.entries(entries);
  let chunk = {};
  let chunkIndex = 1;
  for (const [route, item] of routeEntries) {
    chunk[route] = item;
    if (Buffer.byteLength(JSON.stringify(chunk)) > maxChunkBytes && Object.keys(chunk).length > 1) {
      delete chunk[route];
      splitGroups.push([file.replace(/\.json$/, `-${chunkIndex}.json`), chunk]);
      chunkIndex += 1;
      chunk = { [route]: item };
    }
  }
  if (Object.keys(chunk).length) {
    const outputFile = chunkIndex === 1
      ? file
      : file.replace(/\.json$/, `-${chunkIndex}.json`);
    splitGroups.push([outputFile, chunk]);
  }
}

for (const [file, entries] of splitGroups) {
  const doc = JSON.stringify(entries, null, 2) + '\n';
  fs.writeFileSync(path.join(target, file), doc);
  for (const route of Object.keys(entries)) {
    rootSpec.paths[route] = { $ref: `./${file}#/${escapePointer(route)}` };
  }
}
fs.writeFileSync(path.join(target, 'openapi.json'), JSON.stringify(rootSpec, null, 2) + '\n');
const sizes = splitGroups.map(([file]) => ({ file, bytes: fs.statSync(path.join(target, file)).size }));
console.log(JSON.stringify({ rootBytes: fs.statSync(path.join(target, 'openapi.json')).size, pathFiles: sizes.length, pathItems: Object.keys(rootSpec.paths).length, chunkTargetBytes: maxChunkBytes, largestPathFileBytes: Math.max(...sizes.map((entry) => entry.bytes)), files: sizes }, null, 2));
