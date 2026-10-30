const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const spec = readJson('postman/openapi.json');
const collection = readJson('postman/collection.json');
const environment = readJson('postman/local-environment.json');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const operations = Object.entries(spec.paths).flatMap(([route, pathItem]) =>
  Object.entries(pathItem)
    .filter(([method]) => methods.has(method))
    .map(([method, operation]) => [`${method.toUpperCase()} ${route}`, operation])
);
const requests = [];
function collect(items) {
  for (const item of items || []) {
    if (item.request) requests.push(item);
    else collect(item.item);
  }
}
collect(collection.item);

assert.equal(spec.openapi, '3.0.3');
assert.equal(Object.keys(spec.paths).length, 118, 'mounted route paths changed');
assert.equal(operations.length, 139, 'mounted route operations changed');
assert.equal(requests.length, operations.length, 'collection request count differs from spec');

const routeKey = (request) => {
  const url = typeof request.url === 'string' ? request.url : request.url.raw;
  const pathname = url
    .replace(/^\{\{baseUrl\}\}/, '')
    .split('?')[0]
    .replace(/^\/v1(?=\/|$)/, '')
    .replace(/\{\{([^}]+)\}\}/g, '{$1}');
  return `${request.method.toUpperCase()} ${pathname || '/'}`;
};
const requestKeys = requests.map((item) => routeKey(item.request));
const expectedKeys = new Set(operations.map(([key]) => key));
assert.equal(new Set(requestKeys).size, requests.length, 'duplicate collection requests found');
for (const key of requestKeys) assert(expectedKeys.has(key), `collection request is not in OpenAPI: ${key}`);
for (const [key, operation] of operations) {
  assert(operation.responses && Object.keys(operation.responses).length, `response missing for ${key}`);
}

const analyticsContracts = {
  'GET /admin/analytics': 'AdminAnalyticsOverviewEnvelope',
  'GET /admin/analytics/funnel': 'AnalyticsFunnelEnvelope',
  'GET /admin/analytics/engagement': 'EngagementAnalyticsEnvelope',
  'GET /admin/analytics/subscriptions': 'SubscriptionAnalyticsEnvelope',
  'GET /admin/analytics/records': 'AnalyticsRecordsEnvelope',
};
for (const [key, schema] of Object.entries(analyticsContracts)) {
  const operation = operations.find(([operationKey]) => operationKey === key)?.[1];
  assert.equal(
    operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref,
    `#/components/schemas/${schema}`,
    `detailed analytics response schema missing for ${key}`
  );
}
const testedAnalytics = requests.filter((item) =>
  Object.keys(analyticsContracts).includes(routeKey(item.request))
);
assert.equal(testedAnalytics.length, Object.keys(analyticsContracts).length);
for (const item of testedAnalytics) {
  assert(
    item.event?.some((event) => event.listen === 'test' && event.script?.exec?.length >= 3),
    `reusable response assertions missing for ${routeKey(item.request)}`
  );
}

const refs = new Set();
function findRefs(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') refs.add(value.$ref);
  for (const child of Object.values(value)) findRefs(child);
}
findRefs(spec);
for (const ref of refs) {
  if (ref.startsWith('#/components/schemas/')) {
    const name = ref.slice('#/components/schemas/'.length);
    assert(spec.components.schemas[name], `unresolved schema reference: ${ref}`);
  }
}

assert.equal(collection.auth?.type, 'bearer');
assert.equal(collection.auth?.bearer?.[0]?.value, '{{accessToken}}');
assert(JSON.stringify(collection.event || []).includes('localhost'));
assert.equal(collection.item.length, 19, 'collection folder count changed');
const environmentValues = Object.fromEntries(environment.values.map((value) => [value.key, value]));
assert.equal(environmentValues.baseUrl?.value, 'http://localhost:3000/v1');
for (const key of ['accessToken', 'refreshToken']) {
  assert.equal(environmentValues[key]?.value, '', `${key} must remain blank in the export`);
  assert.equal(environmentValues[key]?.type, 'secret', `${key} must remain a secret variable`);
}
for (const file of ['postman/openapi.json', 'postman/collection.json', 'postman/local-environment.json']) {
  assert(!fs.readFileSync(path.join(root, file), 'utf8').includes('SecurePass123!'), `credential-like sample found in ${file}`);
}

console.log(JSON.stringify({ paths: Object.keys(spec.paths).length, operations: operations.length, requests: requests.length, analyticsSchemas: Object.keys(analyticsContracts).length, schemaRefs: refs.size }, null, 2));
