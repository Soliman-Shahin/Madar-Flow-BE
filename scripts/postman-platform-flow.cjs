/**
 * Flows for Sync, Notifications, Plans, Push devices, App settings and Health.
 * `h` carries the request/assertion helpers defined in postman-crud-flow.cjs.
 * Consumer folders authenticate themselves first (h.setupAuth).
 */
module.exports = function build(h) {
  const { ok, success, post, get, del, put, setupAuth } = h;
  const patch = (name, path, raw, test) => { const r = post(name, path, raw, test); r.request.method = 'PATCH'; return r; };
  const noauth = { auth: { type: 'noauth' } };
  const body = 'const body = pm.response.json();';

  const flow = {
    // ---- Sync ----
    'GET /sync/metadata': { test: [body, ok(), success, "pm.test('metadata counters are numeric', () => { ['pendingCount', 'conflictCount', 'errorCount', 'totalEntities'].forEach((k) => pm.expect(body.data[k]).to.be.a('number')); });"] },
    'POST /sync/push': {
      pre: ["pm.environment.set('syncOpId', 'pm-op-' + Date.now());"],
      body: '{ "entities": [ { "_operationId": "{{syncOpId}}", "_operationType": "CREATE", "_entityType": "category", "_id": "offline-{{syncOpId}}", "title": "PM sync {{syncOpId}}", "icon": "folder", "color": "#123456", "type": "outcome", "order": 0 } ] }',
      test: [body, ok(), success, "pm.test('one operation processed, none conflicted or failed', () => { pm.expect(body.data.success).to.eql(true); pm.expect(body.data.processed).to.eql(1); pm.expect(body.data.conflicts).to.have.lengthOf(0); pm.expect(body.data.errors).to.have.lengthOf(0); });", "pm.test('a receipt is returned per operation', () => pm.expect(body.data.receipts).to.have.property(pm.environment.get('syncOpId')));"],
    },
    'GET /sync/pull': { test: [body, ok(), success, "pm.test('pull returns entities with paging fields', () => { pm.expect(body.data.entities).to.be.an('array'); pm.expect(body.data.hasMore).to.be.a('boolean'); pm.expect(body.data.totalCount).to.be.a('number'); });", "pm.test('the pushed category is visible to the same user', () => pm.expect(body.data.entities.some((e) => e._entityType === 'category' && String(e.title).includes(pm.environment.get('syncOpId')))).to.eql(true));"] },
    'GET /sync/conflicts': { test: [body, ok(), success, "pm.test('conflicts is an array', () => pm.expect(body.data).to.be.an('array'));"] },
    'GET /sync/status': { test: [body, ok(), success, "pm.test('status exposes counters', () => { pm.expect(body.data).to.include.keys('isOnline', 'pendingCount', 'conflictCount', 'errorCount'); });"] },
    'POST /sync/bulk': { test: [body, ok(), success, "pm.test('empty bulk returns an empty result list', () => pm.expect(body.data.results).to.be.an('array'));"] },
    'POST /sync/force-sync': { test: [body, ok(), success, "pm.test('reports entity counts', () => { pm.expect(body.data.entities).to.be.a('number'); pm.expect(body.data.totalCount).to.be.a('number'); });"] },
    'POST /sync/conflicts/resolve': { test: ["pm.test('resolving an unknown conflict is a client error, never 5xx', () => pm.expect(pm.response.code).to.be.within(400, 499));"] },
    'PUT /sync/metadata': { test: [body, ok(), success] },
    'DELETE /sync/cleanup': { pre: ["if (pm.environment.get('allowDestructive') !== 'true') { pm.execution.skipRequest(); }"], test: [body, ok(), success] },

    // ---- Notifications ----
    'GET /notifications/list': { test: [body, ok(), success, "pm.test('inbox envelope', () => { pm.expect(body.data.data).to.be.an('array'); pm.expect(body.data.total).to.be.a('number'); pm.expect(body.data.unreadCount).to.be.a('number'); pm.expect(body.data.hasMore).to.be.a('boolean'); });", "if (body.data.data.length) pm.environment.set('notificationId', body.data.data[0].id); else pm.environment.unset('notificationId');"] },
    'GET /notifications/preferences': { test: [body, ok(), success, "pm.test('all four categories present', () => pm.expect(body.data.categories).to.include.keys('sync', 'subscription', 'security', 'general'));"] },
    'PATCH /notifications/preferences': { test: [body, ok(), success, "pm.test('mandatory categories stay on', () => { pm.expect(JSON.stringify(body.data.categories.security)).to.not.match(/false/); pm.expect(JSON.stringify(body.data.categories.general)).to.include('true'); });"] },
    'PATCH /notifications/all/read': { test: [body, ok(), success, "pm.test('returns a numeric updatedCount', () => pm.expect(body.data.updatedCount).to.be.a('number'));"] },
    'GET /notifications/{notificationId}': { pre: ["if (!pm.environment.get('notificationId')) { pm.execution.skipRequest(); }"], test: [body, ok(), success] },
    'PATCH /notifications/{notificationId}/read': { pre: ["if (!pm.environment.get('notificationId')) { pm.execution.skipRequest(); }"], test: [body, ok(), success] },
    'POST /notifications/broadcast': { test: ["pm.test('a consumer cannot broadcast (403)', () => pm.response.to.have.status(403));", "pm.test('403 names the required roles without leaking data', () => { const b = pm.response.json(); pm.expect(b.success).to.eql(false); pm.expect(b.error.code).to.be.a('string'); });"] },

    // ---- Plans ----
    'GET /plans': { test: [body, ok(), success, "pm.test('lists free, pro and premium', () => { const s = body.data.map((p) => p.slug); pm.expect(s).to.include.members(['free', 'pro', 'premium']); });", "pm.test('prices are non-negative', () => body.data.forEach((p) => pm.expect(p.price).to.be.at.least(0)));"] },
    'GET /plans/me': { test: [body, ok(), success, "pm.test('seeded free user is on the free plan with limits and usage', () => { pm.expect(body.data.context.planSlug).to.eql('free'); pm.expect(body.data.usage).to.include.keys('categories', 'transactionsThisMonth'); pm.expect(body.data.upgradeAvailable).to.be.a('boolean'); });"] },
    'POST /plans/upgrade': { test: ["pm.test('self-service upgrade is refused (403)', () => pm.response.to.have.status(403));", "pm.test('refusal is explicit', () => pm.expect(pm.response.json().error.code).to.eql('UPGRADE_NOT_AVAILABLE'));"] },

    // ---- Push devices ----
    'POST /push/devices': { pre: ["pm.environment.set('pushDeviceId', 'qa-device-' + Date.now());"], body: '{ "deviceId": "{{pushDeviceId}}", "token": "qa-fake-token-{{pushDeviceId}}-0000000000", "platform": "android", "appVersion": "0.0.0-local" }', test: [body, ok(), success, "pm.test('device registered active', () => { pm.expect(body.data.active).to.eql(true); pm.expect(body.data.platform).to.eql('android'); });", "pm.test('response never echoes the token', () => pm.expect(JSON.stringify(body)).to.not.include('qa-fake-token'));"] },
    'DELETE /push/devices/{deviceId}': { urlVars: { '{{deviceId}}': '{{pushDeviceId}}' }, test: [body, ok(), success, "pm.test('device found and deactivated', () => { pm.expect(body.data.found).to.eql(true); pm.expect(body.data.active).to.eql(false); });"] },

    // ---- App settings / Health (public) ----
    'GET /app-settings': { test: [body, ok(), success, "pm.test('exposes a revision', () => pm.expect(body.data.revision).to.be.a('number'));", "pm.test('public cache header present', () => pm.expect(pm.response.headers.get('Cache-Control') || '').to.include('max-age'));"] },
    'GET /health': { test: ["pm.test('liveness ok', () => pm.response.to.have.status(200));"] },
    'GET /health/detailed': { test: ["pm.test('public summary answers 200', () => pm.response.to.have.status(200));", "pm.test('summary carries only status and timestamp (no version/environment/memory)', () => { const b = pm.response.json(); pm.expect(Object.keys(b).sort()).to.eql(['status', 'timestamp']); });"] },
    'GET /health/diagnostics': { test: ["pm.test('a consumer token is forbidden (staff only)', () => pm.response.to.have.status(403));", "pm.test('no diagnostics leak to a consumer', () => pm.expect(JSON.stringify(pm.response.json())).to.not.match(/version|environment|memory/i));"] },
    'GET /health/ready': { test: ["pm.test('ready', () => pm.response.to.have.status(200));"] },
    'GET /health/live': { test: ["pm.test('live', () => pm.response.to.have.status(200));"] },
  };

  const authOnly = (extra = {}) => ({ first: [...setupAuth], ...extra });
  const extrasByFolder = {
    Sync: authOnly({
      last: [
        post('NEGATIVE Push with malformed entities -> 400', '/sync/push', '{"entities":"nope"}', ["pm.test('rejected with 400', () => pm.response.to.have.status(400));"]),
        post('NEGATIVE Replaying a push is idempotent (no duplicate)', '/sync/push', '{ "entities": [ { "_operationId": "{{syncOpId}}", "_operationType": "CREATE", "_entityType": "category", "_id": "offline-{{syncOpId}}", "title": "PM sync {{syncOpId}}", "icon": "folder", "color": "#123456", "type": "outcome", "order": 0 } ] }', [body, "pm.test('replay creates nothing new', () => pm.expect(body.data.processed).to.eql(0));"]),
        del('NEGATIVE Cleanup with invalid days -> 400', '/sync/cleanup?olderThanDays=0', ["pm.test('validation rejects 0 days', () => pm.response.to.have.status(400));"]),
        get('NEGATIVE Sync requires auth -> 401', '/sync/status', ["pm.test('401 without a token', () => pm.response.to.have.status(401));"], noauth),
      ],
    }),
    Notifications: authOnly({
      last: [get('NEGATIVE Inbox requires auth -> 401', '/notifications/list', ["pm.test('401 without a token', () => pm.response.to.have.status(401));"], noauth),
        get('NEGATIVE Unknown notification id -> 4xx', '/notifications/000000000000000000000000', ["pm.test('client error, never 5xx', () => pm.expect(pm.response.code).to.be.within(400, 499));"])],
    }),
    Plans: authOnly({ last: [get('NEGATIVE Plan usage requires auth -> 401', '/plans/me', ["pm.test('401 without a token', () => pm.response.to.have.status(401));"], noauth)] }),
    Health: authOnly({
      last: [get('NEGATIVE Diagnostics require auth -> 401', '/health/diagnostics', ["pm.test('anonymous request is rejected (defect D-010 fixed)', () => pm.response.to.have.status(401));", "pm.test('response carries no version/environment', () => pm.expect(JSON.stringify(pm.response.json())).to.not.match(/version|environment|memory/i));"], noauth)],
    }),
    'Push devices': authOnly({
      last: [post('NEGATIVE Register device without token -> 400', '/push/devices', '{"deviceId":"x","platform":"android"}', ["pm.test('validation error, never 5xx', () => pm.expect(pm.response.code).to.be.within(400, 499));"]),
        post('NEGATIVE Register device with unknown platform -> 400', '/push/devices', '{"deviceId":"x","token":"abcdefghij0123456789","platform":"toaster"}', ["pm.test('validation error, never 5xx', () => pm.expect(pm.response.code).to.be.within(400, 499));"])],
    }),
  };

  const orderByFolder = {
    Sync: ['GET /sync/metadata', 'PUT /sync/metadata', 'POST /sync/push', 'GET /sync/pull', 'GET /sync/conflicts', 'POST /sync/conflicts/resolve', 'GET /sync/status', 'POST /sync/bulk', 'POST /sync/force-sync', 'DELETE /sync/cleanup'],
    Notifications: ['GET /notifications/list', 'GET /notifications/preferences', 'PATCH /notifications/preferences', 'GET /notifications/{notificationId}', 'PATCH /notifications/{notificationId}/read', 'PATCH /notifications/all/read', 'POST /notifications/broadcast'],
    Plans: ['GET /plans', 'GET /plans/me', 'POST /plans/upgrade'],
    'Push devices': ['POST /push/devices', 'DELETE /push/devices/{deviceId}'],
    Health: ['GET /health', 'GET /health/detailed', 'GET /health/diagnostics', 'GET /health/ready', 'GET /health/live'],
  };

  return { flow, extrasByFolder, orderByFolder };
};
