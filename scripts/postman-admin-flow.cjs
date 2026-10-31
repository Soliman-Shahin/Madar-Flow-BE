/**
 * Flows for the staff-only folders: Admin, Analytics (reports), Audit logs, Cache,
 * Scopes, Rate limits, Temporary permissions, Permission matrix, Roles, Admin app settings.
 * Seeded accounts are logged in per role (qa-moderator / qa-admin / qa-superadmin,
 * same QA password) and tokens are kept in accessToken / adminToken / superToken / modToken.
 */
module.exports = function build(h) {
  const { ok, success, post, get, del, put } = h;
  const body = 'const body = pm.response.json();';
  const JSON_H = { key: 'Content-Type', value: 'application/json' };
  const bearer = (v) => ({ header: [{ key: 'Authorization', value: `Bearer {{${v}}}` }, JSON_H], auth: { type: 'noauth' } });
  const patch = (name, path, raw, test) => { const r = post(name, path, raw, test); r.request.method = 'PATCH'; return r; };
  const as = (v, req) => { req.request.header = [...(req.request.header || []).filter((x) => x.key !== 'Authorization'), { key: 'Authorization', value: `Bearer {{${v}}}` }]; req.request.auth = { type: 'noauth' }; return req; };
  const forbidden = (name, method, path, role, raw) => {
    const r = method === 'GET' ? get(name, path, [], {}) : method === 'DELETE' ? del(name, path, []) : method === 'PUT' ? put(name, path, raw || '{}', []) : post(name, path, raw || '{}', []);
    r.test = ["pm.test('staff role below the requirement is forbidden (403)', () => pm.response.to.have.status(403));", "pm.test('403 uses an error envelope', () => pm.expect(pm.response.json().success).to.eql(false));"];
    return as(role, r);
  };
  const loginAs = (label, email, tokenVar) => post(`SETUP Login as ${label}`, '/user/login', `{"email":"${email}","password":"{{qaPassword}}"}`, [
    body, ok(), `pm.environment.set('${tokenVar}', body.data.accessToken);`,
    ...(tokenVar === 'adminToken' ? ["pm.environment.set('accessToken', body.data.accessToken);"] : []),
    ...(tokenVar === 'userToken' ? ["pm.environment.set('userId', body.data.user._id);"] : []),
  ], { auth: { type: 'noauth' }, header: [JSON_H, { key: 'X-CSRF-Token', value: '{{csrfToken}}' }] });
  const setupStaff = [
    get('SETUP Get CSRF token', '/user/csrf-token', [body, ok(), "pm.environment.set('csrfToken', body.csrfToken);"]),
    loginAs('moderator', 'qa-moderator@madarflow.test', 'modToken'),
    loginAs('admin', 'qa-admin@madarflow.test', 'adminToken'),
    loginAs('superadmin', 'qa-superadmin@madarflow.test', 'superToken'),
    loginAs('consumer', '{{qaEmail}}', 'userToken'),
  ];
  const noSecrets = "pm.test('response never contains password hashes, sessions or token hashes', () => { const t = JSON.stringify(body); ['\"password\"', '\"sessions\"', 'passwordResetTokenHash', 'accountDeletionTokenHash'].forEach((n) => pm.expect(t).to.not.include(n)); });";
  const isForbidden = "pm.test('consumer role is forbidden (403)', () => pm.response.to.have.status(403));";

  const flow = {
    // ---- Admin: users ----
    'POST /admin/users': {
      pre: ["pm.environment.set('newUserEmail', 'qa-created-' + Date.now() + '@madarflow.test');"],
      body: '{ "email": "{{newUserEmail}}", "password": "{{qaPassword}}", "role": "user", "username": "qa-created" }',
      test: [body, "pm.test('created (201)', () => pm.response.to.have.status(201));", success, noSecrets, "pm.environment.set('createdUserId', body.data._id);"],
    },
    'GET /admin/users': { test: [body, ok(), success, "pm.test('returns a page of users', () => pm.expect(JSON.stringify(body.data)).to.include('qa-'));", noSecrets] },
    'GET /admin/users/{id}': { urlVars: { '{{id}}': '{{createdUserId}}' }, test: [body, ok(), success, "pm.test('returns the user with stats', () => { pm.expect(body.data.email).to.eql(pm.environment.get('newUserEmail')); pm.expect(body.data.stats).to.include.keys('totalSpent', 'expenseCount'); });", noSecrets] },
    'PUT /admin/users/{id}': { urlVars: { '{{id}}': '{{createdUserId}}' }, test: [body, ok(), success, noSecrets] },
    'PUT /admin/users/{userId}/plan': { urlVars: { '{{userId}}': '{{createdUserId}}' }, test: [body, ok(), success, "pm.test('plan assigned with an expiry', () => { pm.expect(body.data.plan).to.eql('pro'); pm.expect(body.data.planExpiresAt).to.be.a('string'); });"] },
    'DELETE /admin/users/{id}': { urlVars: { '{{id}}': '{{createdUserId}}' }, test: [body, ok(), success, noSecrets] },
    'PUT /admin/users/{id}/restore': { urlVars: { '{{id}}': '{{createdUserId}}' }, test: [body, ok(), success, noSecrets] },

    // ---- Admin: categories ----
    'POST /admin/categories': { pre: ["pm.environment.set('adminCatTitle', 'QA admin cat ' + Date.now());"], body: '{ "title": "{{adminCatTitle}}", "icon": "cart-outline", "color": "#3366CC", "type": "outcome" }', test: [body, "pm.test('created (201)', () => pm.response.to.have.status(201));", success, "pm.environment.set('adminCategoryId', body.data._id);"] },
    'GET /admin/categories': { test: [body, ok(), success] },
    'GET /admin/categories/{id}': { urlVars: { '{{id}}': '{{adminCategoryId}}' }, test: [body, ok(), success, "pm.test('returns the category', () => pm.expect(body.data._id).to.eql(pm.environment.get('adminCategoryId')));"] },
    'PUT /admin/categories/{id}': { urlVars: { '{{id}}': '{{adminCategoryId}}' }, body: '{ "title": "{{adminCatTitle}} edited" }', test: [body, ok(), success, "pm.test('title updated', () => pm.expect(body.data.title).to.include('edited'));"] },
    'DELETE /admin/categories/{id}': { urlVars: { '{{id}}': '{{adminCategoryId}}' }, test: [body, ok(), success, "pm.test('admin-created categories are deletable (D-019)', () => pm.expect(body.data._isDeleted).to.eql(true));"] },
    'PUT /admin/categories/{id}/restore': { urlVars: { '{{id}}': '{{adminCategoryId}}' }, test: [body, ok(), success] },

    // ---- Admin: expenses (use an expense of the consumer created earlier) ----
    'GET /admin/expenses': { test: [body, ok(), success, "pm.test('lists expenses', () => pm.expect(JSON.stringify(body.data)).to.include('_id'));", "if (body.data && (body.data.expenses || body.data.data)) { const arr = body.data.expenses || body.data.data; if (arr.length) pm.environment.set('adminExpenseId', arr[0]._id); }"] },
    'GET /admin/expenses/{id}': { urlVars: { '{{id}}': '{{adminExpenseId}}' }, test: [body, ok(), success] },
    'DELETE /admin/expenses/{id}': { urlVars: { '{{id}}': '{{adminExpenseId}}' }, test: [body, ok(), success] },
    'PUT /admin/expenses/{id}/restore': { urlVars: { '{{id}}': '{{adminExpenseId}}' }, test: [body, ok(), success] },

    // ---- Admin: dashboards / read models ----
    'GET /admin/stats': { test: [body, ok(), success, "pm.test('stats payload', () => pm.expect(body.data).to.be.an('object'));"] },
    'GET /admin/health': { test: [body, ok(), success] },
    'GET /admin/health/jobs': { test: [body, ok(), success, "pm.test('lists the scheduled jobs with status and schedule', () => { pm.expect(body.data.jobs).to.be.an('array').that.is.not.empty; body.data.jobs.forEach((j) => pm.expect(j).to.include.keys('name', 'schedule', 'status')); });"] },
    'GET /admin/sync/operations': { test: [body, ok(), success] },
    'GET /admin/sync/trend': { test: [body, ok(), success, "pm.test('trend is a series', () => pm.expect(JSON.stringify(body.data)).to.match(/\\[/));"] },
    'GET /admin/sync/conflicts': { test: [body, ok(), success] },
    'GET /admin/plans': { test: [body, ok(), success] },
    'GET /admin/plans/distribution': { test: [body, ok(), success] },
    'POST /admin/plans': { body: '{ "name": "Duplicate Pro", "slug": "pro", "description": "dup", "price": 1, "currency": "EGP", "billingCycle": "monthly" }', test: ["pm.test('creating a plan with an existing slug is a client error, never 5xx', () => pm.expect(pm.response.code).to.be.within(400, 499));"] },
    'PUT /admin/plans/{id}': { pre: ["pm.execution.skipRequest();"], test: [] },
    'DELETE /admin/plans/{id}': { pre: ["pm.execution.skipRequest();"], test: [] },
    'GET /admin/analytics': { test: [body, ok(), success] },
    'GET /admin/analytics/engagement': { test: [body, ok(), success] },
    'GET /admin/analytics/funnel': { test: [body, ok(), success] },
    'GET /admin/analytics/subscriptions': { test: [body, ok(), success] },
    'GET /admin/analytics/records': { test: [body, ok(), success] },

    // ---- Analytics reports ----
    'GET /admin/analytics/reports': { test: [body, ok(), success] },
    'POST /admin/analytics/reports': { body: '{ "frequency": "weekly", "weekday": 1, "hour": 1, "timezone": "Africa/Cairo", "days": 7, "comparison": "previous", "language": "en" }', test: [body, "pm.test('report schedule accepted (200/201) or limited by verified e-mail', () => pm.expect(pm.response.code).to.be.oneOf([200, 201, 400, 409, 422]));", "if (body.data && body.data.id) pm.environment.set('reportId', body.data.id); else pm.environment.unset('reportId');"] },
    'PUT /admin/analytics/reports/{id}': { pre: ["if (!pm.environment.get('reportId')) { pm.execution.skipRequest(); }"], urlVars: { '{{id}}': '{{reportId}}' }, body: '{ "frequency": "weekly", "weekday": 2, "hour": 2, "timezone": "Africa/Cairo", "days": 7, "comparison": "previous", "language": "en" }', test: [body, ok(), success] },
    'PATCH /admin/analytics/reports/{id}/status': { pre: ["if (!pm.environment.get('reportId')) { pm.execution.skipRequest(); }"], urlVars: { '{{id}}': '{{reportId}}' }, test: [body, ok(), success] },
    'DELETE /admin/analytics/reports/{id}': { pre: ["if (!pm.environment.get('reportId')) { pm.execution.skipRequest(); }"], urlVars: { '{{id}}': '{{reportId}}' }, test: [body, ok(), success] },

    // ---- Audit logs ----
    'GET /audit-logs': { test: [body, ok(), success, "pm.test('no plaintext credentials in audit entries', () => { const t = JSON.stringify(body); pm.expect(t).to.not.include(pm.environment.get('qaPassword')); });"] },
    'GET /audit-logs/user/{userId}': { urlVars: { '{{userId}}': '{{createdUserId}}' }, test: [body, ok(), success] },
    'GET /audit-logs/security/recent': { test: [body, ok(), success] },
    'GET /audit-logs/stats': { pre: ["pm.environment.set('startDate', '2026-01-01'); pm.environment.set('endDate', '2026-12-31');"], test: [body, ok(), success] },
    'DELETE /audit-logs/cleanup': { pre: ["if (pm.environment.get('allowDestructive') !== 'true') { pm.execution.skipRequest(); }", "pm.environment.set('olderThanDays', '365');"], test: [body, ok(), success] },

    // ---- Cache ----
    'GET /cache/stats': { test: [body, ok(), success] },
    'GET /cache/user/{userId}/status': { urlVars: { '{{userId}}': '{{userId}}' }, test: [body, ok(), success] },
    'DELETE /cache/user/{userId}': { test: [body, ok(), success, "pm.test('invalidated', () => pm.expect(body.data.invalidated).to.eql(true));"] },
    'POST /cache/invalidate-users': { test: [body, ok(), success, "pm.test('count returned', () => pm.expect(body.data.count).to.be.a('number'));"] },
    'DELETE /cache/plan/{planSlug}': { pre: ["pm.environment.set('planSlug', 'free');"], test: [body, ok(), success] },
    'DELETE /cache/flush': { pre: ["if (pm.environment.get('allowDestructive') !== 'true') { pm.execution.skipRequest(); }"], test: [body, ok(), success] },
    'POST /cache/warmup': { test: [body, ok(), success, "pm.test('warmed up', () => pm.expect(body.data.warmedUp).to.eql(true));"] },

    // ---- Scopes / rate limits (authenticated users) ----
    'GET /scopes/me': { test: [body, ok(), success] },
    'GET /scopes/check/{scope}': { pre: ["pm.environment.set('scope', 'expenses:read');"], test: [body, ok(), success] },
    'POST /scopes/missing': { test: [body, ok(), success, "pm.test('missingScopes is an array', () => pm.expect(body.data.missingScopes).to.be.an('array'));"] },
    'GET /scopes': { test: [body, ok(), success, "pm.test('scopes list includes expenses:*', () => pm.expect(JSON.stringify(body.data)).to.include('expenses:*'));"] },
    'GET /scopes/category/{category}': { pre: ["pm.environment.set('category', 'resource');"], test: [body, ok(), success] },
    'GET /scopes/{scope}': { pre: ["pm.environment.set('scope', 'expenses:read');"], test: [body, ok(), success] },
    'GET /scopes/{scope}/expand': { pre: ["pm.environment.set('scope', 'expenses:*');"], test: [body, ok(), success] },
    'GET /rate-limits/me': { test: [body, ok(), success] },
    'GET /rate-limits/status': { test: [body, ok(), success] },

    // ---- Temporary permissions ----
    'GET /temporary-permissions/me': { test: [body, ok(), success] },
    'POST /temporary-permissions': { pre: ["pm.environment.set('tpStart', new Date().toISOString()); pm.environment.set('tpEnd', new Date(Date.now() + 86400000).toISOString());"], body: '{ "userId": "{{userId}}", "permission": "expense:export", "startDate": "{{tpStart}}", "endDate": "{{tpEnd}}", "reason": "QA flow" }', test: [body, "pm.test('created (201)', () => pm.response.to.have.status(201));", success, "pm.environment.set('tempPermId', body.data._id);"] },
    'GET /temporary-permissions/user/{userId}': { test: [body, ok(), success, "pm.test('lists the granted permission', () => pm.expect(JSON.stringify(body.data)).to.include(pm.environment.get('tempPermId')));"] },
    'GET /temporary-permissions/expiring-soon': { test: [body, ok(), success] },
    'GET /temporary-permissions/stats': { test: [body, ok(), success] },
    'PATCH /temporary-permissions/{id}/extend': { urlVars: { '{{id}}': '{{tempPermId}}' }, pre: ["pm.environment.set('tpNewEnd', new Date(Date.now() + 2 * 86400000).toISOString());"], body: '{ "newEndDate": "{{tpNewEnd}}", "reason": "QA extend" }', test: [body, ok(), success] },
    'DELETE /temporary-permissions/{id}': { urlVars: { '{{id}}': '{{tempPermId}}' }, body: '{ "reason": "QA cleanup" }', test: [body, ok(), success] },
    'POST /temporary-permissions/process-expired': { test: [body, ok(), success, "pm.test('processedCount numeric', () => pm.expect(body.data.processedCount).to.be.a('number'));"] },

    // ---- Permission matrix (read-only, Admin+) ----
    'GET /permissions/matrix': { test: [body, ok(), success] },
    'GET /permissions/summary': { test: [body, ok(), success] },
    'GET /permissions/visualization': { test: [body, ok(), success] },
    'GET /permissions/export': { test: [ok()] },
    'GET /permissions/compare/plans': { test: [body, ok(), success] },
    'GET /permissions/compare/roles': { pre: ["pm.environment.set('role1', 'user'); pm.environment.set('role2', 'admin');"], test: [body, ok(), success] },
    'GET /permissions/plan/{slug}': { pre: ["pm.environment.set('slug', 'free');"], test: [body, ok(), success] },
    'GET /permissions/role/{role}': { pre: ["pm.environment.set('role', 'moderator');"], test: [body, ok(), success] },

    // ---- Roles ----
    'GET /roles': { test: [body, ok(), success, "pm.test('roles list', () => pm.expect(JSON.stringify(body.data)).to.include('slug'));"] },
    'POST /roles': { pre: ["pm.environment.set('roleSlug', 'qa-role-' + Date.now());"], body: '{ "name": "QA role", "slug": "{{roleSlug}}", "description": "temporary", "permissions": [] }', test: [body, "pm.test('created (200 today)', () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));", success, "pm.environment.set('roleId', body.data._id);"] },
    'GET /roles/{id}': { urlVars: { '{{id}}': '{{roleId}}' }, test: [body, ok(), success, "pm.test('returns the role', () => pm.expect(body.data.slug).to.eql(pm.environment.get('roleSlug')));"] },
    'PUT /roles/{id}': { urlVars: { '{{id}}': '{{roleId}}' }, body: '{ "name": "QA role edited" }', test: [body, ok(), success] },
    'DELETE /roles/{id}': { urlVars: { '{{id}}': '{{roleId}}' }, test: [body, ok(), success] },

    // ---- Admin app settings ----
    'GET /admin/app-settings': { test: [body, ok(), success, "pm.test('exposes revision', () => pm.expect(body.data.revision).to.be.a('number'));", "pm.environment.set('settingsRevision', body.data.revision);"] },
    'PUT /admin/app-settings': { body: '{ "revision": {{settingsRevision}}, "maintenance": { "enabled": false } }', test: [body, ok(), success, "pm.test('revision advanced', () => pm.expect(body.data.revision).to.be.above(parseInt(pm.environment.get('settingsRevision'), 10)));"] },
  };

  // Which token each folder runs with (default adminToken). Superadmin-only calls are overridden per request.
  const tokenFor = {
    'POST /admin/plans': 'superToken', 'PUT /admin/plans/{id}': 'superToken', 'DELETE /admin/plans/{id}': 'superToken',
    'DELETE /audit-logs/cleanup': 'superToken', 'DELETE /cache/flush': 'superToken', 'POST /cache/warmup': 'superToken',
    'POST /temporary-permissions/process-expired': 'superToken', 'PUT /admin/app-settings': 'superToken',
    'GET /scopes/me': 'userToken', 'GET /scopes/check/{scope}': 'userToken', 'POST /scopes/missing': 'userToken',
    'GET /rate-limits/me': 'userToken', 'GET /rate-limits/status': 'userToken', 'GET /temporary-permissions/me': 'userToken',
  };
  for (const [k, v] of Object.entries(flow)) v.token = tokenFor[k] || 'adminToken';

  // Moderator-level routes run as the moderator to prove the lower bound.
  for (const k of ['GET /admin/stats', 'GET /admin/health', 'GET /admin/health/jobs', 'GET /admin/users', 'GET /admin/categories', 'GET /admin/expenses', 'GET /admin/sync/operations', 'GET /admin/sync/trend', 'GET /admin/sync/conflicts', 'GET /admin/analytics', 'GET /admin/analytics/engagement', 'GET /admin/analytics/funnel']) flow[k].token = 'modToken';

  const NEG = (role, label, method, path, raw) => forbidden(`NEGATIVE ${label} -> 403`, method, path, role, raw);
  const rbac = [
    NEG('userToken', 'Consumer cannot list admin users', 'GET', '/admin/users'),
    NEG('userToken', 'Consumer cannot read admin stats', 'GET', '/admin/stats'),
    NEG('modToken', 'Moderator cannot create users', 'POST', '/admin/users', '{"email":"x@madarflow.test","password":"x"}'),
    NEG('modToken', 'Moderator cannot assign plans', 'PUT', '/admin/users/{{userId}}/plan', '{"planSlug":"pro"}'),
    NEG('modToken', 'Moderator cannot read audit logs', 'GET', '/audit-logs'),
    NEG('modToken', 'Moderator cannot read cache stats', 'GET', '/cache/stats'),
    NEG('modToken', 'Moderator cannot read the permission matrix', 'GET', '/permissions/matrix'),
    NEG('modToken', 'Moderator cannot read admin app settings', 'GET', '/admin/app-settings'),
    NEG('modToken', 'Moderator cannot create roles (D-014)', 'POST', '/roles', '{"name":"QA role","slug":"qa-mod-role","permissions":[]}'),
    NEG('modToken', 'Moderator cannot update roles (D-014)', 'PUT', '/roles/507f1f77bcf86cd799439011', '{"name":"QA edit"}'),
    NEG('modToken', 'Moderator cannot delete roles (D-014)', 'DELETE', '/roles/507f1f77bcf86cd799439011'),
    NEG('adminToken', 'Admin cannot flag a role as system (D-021)', 'POST', '/roles', '{"name":"QA sys","slug":"qa-sys-role","permissions":[],"isSystem":true}'),
    NEG('adminToken', 'Admin cannot create plans (superadmin only)', 'POST', '/admin/plans', '{}'),
    NEG('adminToken', 'Admin cannot clean audit logs (superadmin only)', 'DELETE', '/audit-logs/cleanup?olderThanDays=365'),
    NEG('adminToken', 'Admin cannot flush the cache (superadmin only)', 'DELETE', '/cache/flush'),
    NEG('adminToken', 'Admin cannot update app settings (superadmin only)', 'PUT', '/admin/app-settings', '{"revision":1}'),
    NEG('userToken', 'Consumer cannot broadcast notifications', 'POST', '/notifications/broadcast', '{"title":"t","message":"m","type":"info","audience":"admins"}'),
  ];
  const settingsStale = put('NEGATIVE Stale app-settings revision -> 409', '/admin/app-settings', '{ "revision": {{staleRevision}}, "maintenance": { "enabled": false } }', [
    body, "pm.test('stale revision is rejected with 409', () => pm.response.to.have.status(409));", "pm.test('error code REVISION_CONFLICT', () => pm.expect(body.error.code).to.eql('REVISION_CONFLICT'));",
  ]);
  as('superToken', settingsStale);
  // Self-contained: read the current revision, bump it once, then send the now-stale one.
  settingsStale.pre = [
    "const base = pm.variables.replaceIn('{{baseUrl}}'); const hdr = { Authorization: 'Bearer ' + pm.environment.get('superToken'), 'Content-Type': 'application/json' };",
    "pm.sendRequest({ url: base + '/admin/app-settings', method: 'GET', header: hdr }, (e, r) => {",
    "  const rev = r.json().data.revision; pm.environment.set('staleRevision', rev);",
    "  pm.sendRequest({ url: base + '/admin/app-settings', method: 'PUT', header: hdr, body: { mode: 'raw', raw: JSON.stringify({ revision: rev, maintenance: { enabled: false } }) } }, () => {});",
    "});",
  ];
  const unknownUser = get('NEGATIVE Unknown user id -> 404', '/admin/users/507f1f77bcf86cd799439099', ["pm.test('404 not 500', () => pm.response.to.have.status(404));"]);
  as('adminToken', unknownUser);
  const malformed = get('NEGATIVE Malformed user id -> 400', '/admin/users/not-an-id', ["pm.test('400 not 500', () => pm.response.to.have.status(400));"]);
  as('adminToken', malformed);
  const unauth = get('NEGATIVE Admin routes require auth -> 401', '/admin/users', ["pm.test('401 without a token', () => pm.response.to.have.status(401));"], { auth: { type: 'noauth' } });

  return { flow, setupStaff, rbac: [...rbac, settingsStale, unknownUser, malformed, unauth] };
};
