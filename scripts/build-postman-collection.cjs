const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'postman/openapi.json'), 'utf8'));
const { flow: authFlow, extraRequests: authExtra, order: authOrder } = require('./postman-auth-flow.cjs');
const authDestructive = new Set(['POST /user/me/delete']);
const destructiveSkip = ["if (pm.environment.get('allowDestructive') !== 'true') { pm.execution.skipRequest(); }"];
const { flow: crudFlow, extrasByFolder, orderByFolder, extraFolders } = require('./postman-crud-flow.cjs');
const itemKeys = new WeakMap();
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const folders = new Map();
const analyticsAssertions = {
  'POST /push/devices': [
    'const body = pm.response.json();',
    "pm.test('push token registration returns the success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
  ],
  'GET /user/sessions': [
    'const body = pm.response.json();',
    "pm.test('session list returns the authenticated user session envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); pm.expect(body.data.sessions).to.be.an('array'); });",
    "pm.test('session summaries expose accurate activity time without refresh credentials', () => { for (const session of body.data.sessions) { pm.expect(session).to.include.keys('id', 'platform', 'lastAuthenticatedAt', 'expiresAt', 'current'); pm.expect(Object.keys(session).some((key) => ['token', 'refreshToken', 'tokenHash'].includes(key))).to.eql(false); } });",
  ],
  'DELETE /user/sessions/others': [
    'const body = pm.response.json();',
    "pm.test('other-session revocation succeeds without ending this session', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); pm.expect(body.data.revoked).to.be.a('boolean'); });",
  ],
  'DELETE /user/sessions/{sessionId}': [
    'const body = pm.response.json();',
    "pm.test('single-session revocation returns a typed outcome', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); pm.expect(body.data.revoked).to.be.a('boolean'); });",
  ],
  'GET /user/csrf-token': [
    'const body = pm.response.json();',
    "pm.test('CSRF bootstrap returns a usable token', () => { pm.response.to.have.status(200); pm.expect(body.csrfToken).to.be.a('string').and.not.empty; });",
    "pm.environment.set('csrfToken', body.csrfToken);",
  ],
  'GET /admin/analytics/reports': [
    "const body = pm.response.json();",
    "pm.test('report schedule list returns an Admin success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('report schedule list exposes verified-recipient readiness and active capacity', () => { pm.expect(body.data.schedules).to.be.an('array'); pm.expect(body.data.emailVerified).to.be.a('boolean'); pm.expect(body.data.recipientEmail === null || typeof body.data.recipientEmail === 'string').to.eql(true); pm.expect(body.data.maxActiveSchedules).to.eql(5); });",
  ],
  'POST /admin/analytics/reports': [
    "const body = pm.response.json();",
    "pm.test('report schedule creation returns an Admin success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('new report schedule has an active next run and safe delivery state', () => { pm.expect(body.data.id).to.be.a('string'); pm.expect(body.data.active).to.eql(true); pm.expect(body.data.lastDeliveryStatus).to.eql('scheduled'); pm.expect(Date.parse(body.data.nextRunAt)).not.to.be.NaN; });",
  ],
  'PUT /admin/analytics/reports/{id}': [
    "const body = pm.response.json();",
    "pm.test('report schedule replacement returns an Admin success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('updated report schedule preserves ownership shape and next run', () => { pm.expect(body.data.id).to.be.a('string'); pm.expect(body.data.filters).to.include.keys('plan', 'type'); pm.expect(Date.parse(body.data.nextRunAt)).not.to.be.NaN; });",
  ],
  'PATCH /admin/analytics/reports/{id}/status': [
    "const body = pm.response.json();",
    "pm.test('report schedule status change returns an Admin success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('paused and active states agree with the delivery status', () => { pm.expect(body.data.active).to.be.a('boolean'); pm.expect(body.data.lastDeliveryStatus).to.eql(body.data.active ? 'scheduled' : 'paused'); });",
  ],
  'DELETE /admin/analytics/reports/{id}': [
    "const body = pm.response.json();",
    "pm.test('report schedule cancellation returns an Admin success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('successful cancellation returns a null data payload', () => { pm.expect(body.data).to.eql(null); });",
  ],
  'GET /admin/analytics': [
    "const body = pm.response.json();",
    "pm.test('analytics overview returns a success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('analytics overview exposes comparable metrics and drill-down series', () => { pm.expect(body.data.period.days).to.be.a('number'); pm.expect(body.data.metrics).to.include.keys('newUsers', 'recordingUsers', 'expenses'); pm.expect(body.data.series).to.be.an('array'); pm.expect(body.data.categories).to.be.an('array'); pm.expect(body.data.operations).to.include.keys('openConflicts', 'failedOperations'); });",
  ],
  'GET /admin/analytics/funnel': [
    "const body = pm.response.json();",
    "pm.test('activation funnel returns a success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('activation funnel preserves its four ordered stages', () => { pm.expect(body.data.stages).to.be.an('array').with.lengthOf(4); pm.expect(body.data.stages.map((stage) => stage.key)).to.eql(['registered', 'recorded', 'active', 'paying']); });",
  ],
  'GET /admin/analytics/engagement': [
    "const body = pm.response.json();",
    "pm.test('engagement analytics returns a success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('engagement analytics exposes coverage, comparison series, and cohorts', () => { pm.expect(body.data.coverage).to.include.keys('firstObservedAt', 'completeFrom', 'observedRecords', 'currentDays', 'previousDays'); pm.expect(body.data.metrics).to.include.keys('recordingUsers', 'records'); pm.expect(body.data.series).to.be.an('array'); pm.expect(body.data.cohorts).to.be.an('array'); });",
  ],
  'GET /admin/analytics/subscriptions': [
    "const body = pm.response.json();",
    "pm.test('subscription analytics returns a success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('subscription analytics exposes integrity metrics, expiry paging, and daily history', () => { pm.expect(body.data.horizon).to.be.oneOf([7, 30]); pm.expect(body.data.metrics).to.include.keys('retainedAccounts', 'paidTierAssignments', 'unexpiredAssignments', 'expiredAssignments', 'noExpiry', 'disabledAssignments', 'missingHistory', 'mismatchedHistory', 'duplicateCurrentHistory'); pm.expect(body.data.expiring).to.include.keys('rows', 'total', 'page', 'limit', 'until'); pm.expect(body.data.history).to.be.an('array'); });",
  ],
  'GET /admin/analytics/records': [
    "const body = pm.response.json();",
    "pm.test('analytics records returns a success envelope', () => { pm.response.to.have.status(200); pm.expect(body.success).to.eql(true); });",
    "pm.test('analytics records exposes bounded pagination and the selected range', () => { pm.expect(body.data.rows).to.be.an('array'); pm.expect(body.data.total).to.be.a('number'); pm.expect(body.data.page).to.be.a('number'); pm.expect(body.data.limit).to.eql(10); pm.expect(body.data.start).to.be.a('string'); pm.expect(body.data.endExclusive).to.be.a('string'); });",
  ],
};

function sample(schema = {}, name = 'value') {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'array') return [];
  if (schema.type === 'object' || schema.properties) {
    const value = {};
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if ((schema.required || []).includes(key)) value[key] = sample(child, key);
    }
    return value;
  }
  if (schema.format === 'password') return `{{${name}}}`;
  if (schema.format === 'email') return 'person@example.test';
  if (schema.format === 'date-time') return '2026-10-30T12:00:00.000Z';
  if (schema.format === 'date') return '2026-10-30';
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum || 1;
  if (schema.type === 'boolean') return true;
  return `{{${name}}}`;
}

function bodyExample(requestBody) {
  const content = requestBody?.content || {};
  const mime = Object.keys(content)[0];
  if (!mime) return undefined;
  const media = content[mime];
  let value = media.example ?? sample(media.schema, 'value');
  if (mime === 'multipart/form-data') return { mode: 'formdata', mime, value };
  if (mime === 'application/x-www-form-urlencoded') return { mode: 'urlencoded', mime, value };
  return { mode: 'raw', mime, value: JSON.stringify(value, null, 2) };
}

for (const [route, pathItem] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!verbs.has(method)) continue;
    const tag = operation.tags?.[0] || 'Other';
    if (!folders.has(tag)) folders.set(tag, []);
    const params = operation.parameters || [];
    const pathValue = route.replace(/\{([^}]+)\}/g, '{{$1}}');
    const query = params.filter((param) => param.in === 'query').map((param) => ({
      key: param.name,
      value: String(param.example ?? param.schema?.example ?? param.schema?.default ?? (param.schema?.enum?.[0] ?? `{{${param.name}}}`)),
      description: param.description || param.schema?.description || '',
      disabled: !param.required,
    }));
    const activeQuery = query.filter((item) => !item.disabled);
    const url = {
      raw: `{{baseUrl}}${pathValue}${activeQuery.length ? `?${activeQuery.map((item) => `${encodeURIComponent(item.key)}=${item.value}`).join('&')}` : ''}`,
      ...(query.length ? { query } : {}),
    };
    const body = bodyExample(operation.requestBody);
    const usesBearer = operation.security?.some((security) => security.bearerAuth) || false;
    const usesCookie = operation.security?.some((security) => security.cookieAuth) || false;
    const headers = body && body.mode !== 'formdata' ? [{ key: 'Content-Type', value: body.mime }] : [];
    if (['/user/login', '/user/signup', '/user/auth/google/exchange', '/user/refresh-token', '/user/logout'].includes(route)) {
      headers.push({ key: 'X-Auth-Transport', value: 'cookie' }, { key: 'X-Auth-Cookie-Path', value: '/v1/user' });
    }
    if (['/user/refresh-token', '/user/logout'].includes(route)) {
      headers.push({ key: 'X-CSRF-Token', value: '{{csrfToken}}' });
    }
    if (route.startsWith('/user/') && method !== 'get' && !headers.some((h) => h.key === 'X-CSRF-Token')) {
      headers.push({ key: 'X-CSRF-Token', value: '{{csrfToken}}' });
    }
    if (usesCookie) headers.push({ key: 'Cookie', value: 'refreshToken={{refreshToken}}' });
    const request = {
      method: method.toUpperCase(),
      header: headers,
      url,
      description: operation.description || operation.summary || '',
      ...(!usesBearer ? { auth: { type: 'noauth' } } : {}),
      ...(body ? { body: body.mode === 'formdata'
        ? { mode: 'formdata', formdata: Object.entries(body.value?.file ? body.value : { file: '{{file}}' }).map(([key, value]) => ({ key, type: 'file', src: value })) }
        : body.mode === 'urlencoded'
          ? { mode: 'urlencoded', urlencoded: Object.entries(body.value || {}).map(([key, value]) => ({ key, value: String(value) })) }
          : { mode: 'raw', raw: body.value, options: { raw: { language: 'json' } } } } : {}),
    };
    const key = `${method.toUpperCase()} ${route}`;
    const flowDef = authFlow[key] || crudFlow[key] || (authDestructive.has(key) ? { pre: destructiveSkip } : undefined);
    if (flowDef?.bodyEmail && request.body?.raw) request.body.raw = request.body.raw.replace(/"email": "[^"]*"/, `"email": "${flowDef.bodyEmail}"`);
    if (flowDef && request.body?.raw) request.body.raw = request.body.raw.replace('{{password}}', '{{qaPassword}}');
    if (flowDef?.body && request.body) request.body.raw = flowDef.body;
    if (flowDef?.token) { request.header = [...request.header.filter((x) => x.key !== 'Authorization'), { key: 'Authorization', value: `Bearer {{${flowDef.token}}}` }]; request.auth = { type: 'noauth' }; }
    if (flowDef?.urlVars) for (const [from, to] of Object.entries(flowDef.urlVars)) request.url.raw = request.url.raw.split(from).join(to);
    const testScript = analyticsAssertions[key] || flowDef?.test;
    const entry = {
      name: operation.summary || operation.operationId || key,
      request,
      ...((testScript || flowDef?.pre) ? { event: [...(flowDef?.pre ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: flowDef.pre } }] : []), ...(testScript ? [{ listen: 'test', script: { type: 'text/javascript', exec: testScript } }] : [])] } : {}),
    };
    folders.get(tag).push(entry);
    itemKeys.set(entry, key);
  }
}

// Newman cannot parse a raw-only URL (it resolves to an empty URL); add host/path parts like Postman exports.
function withUrlParts(url) {
  const raw = url.raw || '';
  if (!raw.startsWith('{{baseUrl}}') || url.host) return url;
  const [pathPart, queryPart] = raw.slice('{{baseUrl}}'.length).split('?');
  // Newman builds the request from the parsed parts, so a query only present in `raw` would be dropped.
  const query = url.query || (queryPart ? queryPart.split('&').map((pair) => { const i = pair.indexOf('='); return { key: decodeURIComponent(pair.slice(0, i < 0 ? pair.length : i)), value: i < 0 ? '' : pair.slice(i + 1) }; }) : undefined);
  return { ...url, host: ['{{baseUrl}}'], path: pathPart.split('/').filter(Boolean), ...(query ? { query } : {}) };
}

for (const extra of authExtra) folders.get('Authentication').push({ name: extra.name, request: extra.request, event: [{ listen: 'test', script: { type: 'text/javascript', exec: extra.test } }] });

{
  const a = folders.get('Authentication');
  const rank = (item) => { const k = `${item.request.method} ${item.request.url.raw.replace('{{baseUrl}}', '').replace('{{sessionId}}', '{sessionId}')}`; const i = authOrder.indexOf(k); return i < 0 ? authOrder.length - 1 - 0.5 : i; };
  a.sort((x, y) => rank(x) - rank(y));
  // NEGATIVE cases stay last, post-logout check after logout.
  const neg = a.filter((x) => /^NEGATIVE /.test(x.name)); a.splice(0, a.length, ...a.filter((x) => !/^NEGATIVE /.test(x.name)), ...neg.sort((x, y) => (/after logout/.test(x.name) ? -1 : 0) - (/after logout/.test(y.name) ? -1 : 0)));
}
for (const folderName of new Set([...Object.keys(extrasByFolder), ...Object.keys(orderByFolder)])) {
  const extras = extrasByFolder[folderName] || {};
  const list = folders.get(folderName);
  if (!list) continue;
  const toItem = (x) => ({ name: x.name, request: x.request, event: [{ listen: 'test', script: { type: 'text/javascript', exec: x.test } }] });
  const rank = (item) => { const i = orderByFolder[folderName].indexOf(itemKeys.get(item)); return i < 0 ? 999 : i; };
  const core = list.filter((x) => itemKeys.has(x)).sort((a, b) => rank(a) - rank(b));
  const last = core.pop();
  list.splice(0, list.length, ...(extras.first || []).map(toItem), ...core, ...(extras.mid || []).map(toItem), last, ...(extras.last || []).map(toItem));
}
for (const items of folders.values()) for (const item of items) item.request.url = withUrlParts(item.request.url);

const toFolderItem = (x) => ({ name: x.name, request: { ...x.request, url: withUrlParts(x.request.url) }, event: [...(x.pre ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: x.pre } }] : []), { listen: 'test', script: { type: 'text/javascript', exec: x.test } }] });
const staffOrder = ['Staff setup', 'Admin', 'Analytics', 'Admin app settings', 'Audit logs', 'Cache', 'Scopes', 'Rate limits', 'Temporary permissions', 'Permission matrix', 'Roles', 'Staff RBAC'];
// Consumer folders first (Authentication revokes other sessions), then staff setup + staff folders.
const allFolders = new Map([...folders, ['Staff setup', extraFolders['Staff setup'].map(toFolderItem)], ['Staff RBAC', extraFolders['Staff RBAC'].map(toFolderItem)]]);
const orderedFolders = new Map([...[...allFolders].filter(([name]) => !staffOrder.includes(name)), ...staffOrder.filter((name) => allFolders.has(name)).map((name) => [name, allFolders.get(name)])]);
const collection = {
  info: {
    name: 'Madar Flow REST API',
    description: 'Generated from postman/openapi.json. Local development base URL only. Review side effects and request/access notes before sending. Coverage markers distinguish reviewed inputs from route/access-only entries.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
  variable: [{ key: 'baseUrl', value: 'http://localhost:3000/v1', type: 'string' }],
  event: [{
    listen: 'prerequest',
    script: {
      id: '4507942e-0f93-4dd6-b7a5-b48671d51a11',
      type: 'text/javascript',
      exec: [
        'const resolvedUrl = pm.variables.replaceIn(pm.request.url.toString());',
        "if (!/^http:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?(\\/|$)/i.test(resolvedUrl)) {",
        "  throw new Error('Madar Flow requests are restricted to localhost or 127.0.0.1.');",
        '}',
      ],
    },
  }],
  item: [...orderedFolders.entries()].map(([name, item]) => ({ name, item })),
};
fs.writeFileSync(path.join(root, 'postman/collection.json'), JSON.stringify(collection, null, 2) + '\n');
const count = [...folders.values()].reduce((sum, items) => sum + items.length, 0);
console.log(JSON.stringify({ folders: folders.size, requests: count, output: 'postman/collection.json' }, null, 2));
