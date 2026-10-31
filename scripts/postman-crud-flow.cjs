/**
 * Executable flows for the Categories and Expenses folders (consumer CRUD).
 * Each folder is self-contained: it sets up what it needs and cleans up after.
 * Needs the Authentication folder to have run first (accessToken), plus
 * qaEmail2/qaPassword2 (another seeded user) for the cross-user isolation checks.
 */
const ok = (status = 200) => `pm.test('status is ${status}', () => pm.response.to.have.status(${status}));`;
const success = "pm.test('success envelope', () => pm.expect(body.success).to.eql(true));";
const post = (name, path, raw, test, extra = {}) => ({
  name,
  request: {
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    url: { raw: `{{baseUrl}}${path}` },
    ...(raw ? { body: { mode: 'raw', raw, options: { raw: { language: 'json' } } } } : {}),
    ...extra,
  },
  test,
});
const put = (name, path, raw, test, extra = {}) => { const r = post(name, path, raw, test, extra); r.request.method = 'PUT'; return r; };
const get = (name, path, test, extra = {}) => ({ name, request: { method: 'GET', header: [], url: { raw: `{{baseUrl}}${path}` }, ...extra }, test });
const del = (name, path, test) => ({ name, request: { method: 'DELETE', header: [], url: { raw: `{{baseUrl}}${path}` } }, test });
const otherUser = { header: [{ key: 'Authorization', value: 'Bearer {{accessToken2}}' }], auth: { type: 'noauth' } };

const flow = {
  // ---- Categories ----
  'POST /categories/create': {
    pre: ["pm.environment.set('catTitle', 'PM Cat ' + Date.now());"],
    body: '{ "title": "{{catTitle}}", "icon": "cart-outline", "color": "#3366CC", "type": "outcome" }',
    test: [
      'const body = pm.response.json();', ok(201), success,
      "pm.test('returns the created category owned by the caller', () => { pm.expect(body.data._id).to.be.a('string'); pm.expect(body.data.title).to.eql(pm.environment.get('catTitle')); pm.expect(body.data.type).to.eql('outcome'); });",
      "pm.environment.set('categoryId', body.data._id);",
    ],
  },
  'GET /categories/list': {
    test: ['const body = pm.response.json();', ok(), success,
      "pm.test('list contains the created category and a total', () => { pm.expect(body.data.data).to.be.an('array'); pm.expect(body.data.total).to.be.a('number'); pm.expect(body.data.data.map((c) => c._id)).to.include(pm.environment.get('categoryId')); });"],
  },
  'GET /categories/{id}': {
    urlVars: { '{{id}}': '{{categoryId}}' },
    test: ['const body = pm.response.json();', ok(), success,
      "pm.test('returns the requested category', () => pm.expect(body.data._id).to.eql(pm.environment.get('categoryId')));"],
  },
  'PUT /categories/update/{id}': {
    urlVars: { '{{id}}': '{{categoryId}}' },
    body: '{ "title": "{{catTitle}} edited", "icon": "cart-outline", "color": "#112233", "type": "outcome" }',
    test: ['const body = pm.response.json();', ok(), success,
      "pm.test('update is persisted in the response', () => { pm.expect(body.data.title).to.eql(pm.environment.get('catTitle') + ' edited'); pm.expect(body.data.color).to.eql('#112233'); });"],
  },
  'PUT /categories/update-order': {
    test: ['const body = pm.response.json();', ok(), success],
  },
  'DELETE /categories/delete/{id}': {
    urlVars: { '{{id}}': '{{categoryId}}' },
    test: ['const body = pm.response.json();', ok(), success],
  },

  // ---- Expenses ----
  'POST /expenses': {
    pre: ["pm.environment.set('expDesc', 'PM expense ' + Date.now());"],
    body: '{ "description": "{{expDesc}}", "amount": 125.5, "category": "{{categoryId}}", "date": "2026-10-20T12:00:00.000Z" }',
    test: ['const body = pm.response.json();', "pm.test('created (201)', () => pm.response.to.have.status(201));", success,
      "pm.test('stores amount, category and ownership', () => { pm.expect(body.data.amount).to.eql(125.5); pm.expect(body.data.category).to.eql(pm.environment.get('categoryId')); pm.expect(body.data.user).to.be.a('string'); });",
      "pm.environment.set('expenseId', body.data._id);"],
  },
  'GET /expenses': {
    test: ['const body = pm.response.json();', ok(), success,
      "pm.test('default list (no paging params) returns a plain array - differs from the paginated envelope, see defect D-008', () => pm.expect(body.data).to.be.an('array'));",
      "pm.test('every expense belongs to the caller', () => { const uid = pm.environment.get('userId'); body.data.forEach((e) => pm.expect(e.user).to.eql(uid)); });"],
  },
  'GET /expenses/totals': {
    pre: ["pm.environment.set('startDate', '2026-10-01'); pm.environment.set('endDate', '2026-10-31');"],
    test: ['const body = pm.response.json();', ok(), success,
      "pm.test('totals are non-negative numbers', () => { pm.expect(body.data.income).to.be.a('number').and.at.least(0); pm.expect(body.data.expenses).to.be.a('number').and.at.least(0); });"],
  },
  'GET /expenses/{id}': {
    urlVars: { '{{id}}': '{{expenseId}}' },
    test: ['const body = pm.response.json();', ok(), success,
      "pm.test('returns the requested expense', () => pm.expect(body.data._id).to.eql(pm.environment.get('expenseId')));"],
  },
  'PUT /expenses/{id}': {
    urlVars: { '{{id}}': '{{expenseId}}' },
    body: '{ "description": "{{expDesc}} edited", "amount": 99.25, "category": "{{categoryId}}", "date": "2026-10-20T12:00:00.000Z" }',
    test: ['const body = pm.response.json();', ok(), success,
      "pm.test('update is reflected', () => { pm.expect(body.data.amount).to.eql(99.25); pm.expect(body.data.description).to.eql(pm.environment.get('expDesc') + ' edited'); });"],
  },
  'DELETE /expenses/{id}': {
    urlVars: { '{{id}}': '{{expenseId}}' },
    test: ['const body = pm.response.json();', ok(), success],
  },
};

const secondLogin = post('SETUP Login as second user', '/user/login', '{"email":"{{qaEmail2}}","password":"{{qaPassword2}}"}', [
  'const body = pm.response.json();', ok(), "pm.environment.set('accessToken2', body.data.accessToken);",
], { auth: { type: 'noauth' }, header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-CSRF-Token', value: '{{csrfToken}}' }] });

// Every consumer folder authenticates itself (Authentication ends with a logout that revokes the token).
const setupAuth = [
  get('SETUP Get CSRF token', '/user/csrf-token', ['const body = pm.response.json();', ok(), "pm.environment.set('csrfToken', body.csrfToken);"]),
  post('SETUP Login as primary user', '/user/login', '{"email":"{{qaEmail}}","password":"{{qaPassword}}"}', [
    'const body = pm.response.json();', ok(), "pm.environment.set('accessToken', body.data.accessToken);",
  ], { auth: { type: 'noauth' }, header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-CSRF-Token', value: '{{csrfToken}}' }] }),
];

const extrasByFolder = {
  Categories: {
    first: [...setupAuth],
    last: [
      get('NEGATIVE Deleted category is gone -> 404', '/categories/{{categoryId}}', ["pm.test('404 after delete', () => pm.response.to.have.status(404));"]),
      get('NEGATIVE Categories require auth -> 401', '/categories/list', ["pm.test('401 without a token', () => pm.response.to.have.status(401));"], { auth: { type: 'noauth' } }),
      post('NEGATIVE Create category with empty title -> 400', '/categories/create', '{"title":"","icon":"x","color":"#000000","type":"outcome"}', ["pm.test('validation error, never 5xx', () => pm.expect(pm.response.code).to.be.within(400, 499));"]),
    ],
  },
  Expenses: {
    first: [
      ...setupAuth,
      post('SETUP Create category for expenses', '/categories/create', '{"title":"PM exp cat {{$timestamp}}","icon":"cart-outline","color":"#3366CC","type":"outcome"}', [
        'const body = pm.response.json();', ok(201), "pm.environment.set('categoryId', body.data._id);",
      ]),
    ],
    mid: [secondLogin,
      get('NEGATIVE Other user cannot read my expense (IDOR) -> 403/404', '/expenses/{{expenseId}}', ["pm.test('not accessible to another user', () => pm.expect(pm.response.code).to.be.oneOf([403, 404]));"], otherUser),
      put('NEGATIVE Other user cannot edit my expense (IDOR)', '/expenses/{{expenseId}}', '{"description":"hijack","amount":1,"category":"{{categoryId}}","date":"2026-10-20T12:00:00.000Z"}', ["pm.test('edit rejected for another user', () => pm.expect(pm.response.code).to.be.oneOf([403, 404]));"], otherUser),
    ],
    last: [
      get('NEGATIVE Deleted expense is gone -> 404', '/expenses/{{expenseId}}', ["pm.test('404 after delete', () => pm.response.to.have.status(404));"]),
      post('NEGATIVE Negative amount -> 400', '/expenses', '{"description":"neg","amount":-5,"category":"{{categoryId}}","date":"2026-10-20T12:00:00.000Z"}', ["pm.test('validation rejects negative amounts', () => pm.response.to.have.status(400));"]),
      post('NEGATIVE Missing description -> 400', '/expenses', '{"amount":5,"category":"{{categoryId}}","date":"2026-10-20T12:00:00.000Z"}', ["pm.test('validation rejects missing description', () => pm.response.to.have.status(400));"]),
      get('NEGATIVE Expenses require auth -> 401', '/expenses', ["pm.test('401 without a token', () => pm.response.to.have.status(401));"], { auth: { type: 'noauth' } }),
      del('CLEANUP Delete expense category', '/categories/delete/{{categoryId}}', ["pm.test('cleanup ok', () => pm.expect(pm.response.code).to.be.oneOf([200, 204, 404]));"]),
    ],
  },
};

const orderByFolder = {
  Categories: ['POST /categories/create', 'GET /categories/list', 'GET /categories/{id}', 'PUT /categories/update/{id}', 'PUT /categories/update-order', 'DELETE /categories/delete/{id}'],
  Expenses: ['POST /expenses', 'GET /expenses', 'GET /expenses/totals', 'GET /expenses/{id}', 'PUT /expenses/{id}', 'DELETE /expenses/{id}'],
};

// Merge the platform flows (Sync, Notifications, Plans, Push devices, public endpoints).
const platform = require('./postman-platform-flow.cjs')({ ok, success, post, get, del, put, setupAuth });
Object.assign(flow, platform.flow);
Object.assign(extrasByFolder, platform.extrasByFolder);
Object.assign(orderByFolder, platform.orderByFolder);

// Staff-only folders (Admin, Audit logs, Cache, Scopes, Roles, ...).
const admin = require('./postman-admin-flow.cjs')({ ok, success, post, get, del, put });
Object.assign(flow, admin.flow);
Object.assign(orderByFolder, {
  Admin: ['GET /admin/stats', 'GET /admin/health', 'GET /admin/health/jobs', 'POST /admin/users', 'GET /admin/users', 'GET /admin/users/{id}', 'PUT /admin/users/{id}', 'PUT /admin/users/{userId}/plan', 'DELETE /admin/users/{id}', 'PUT /admin/users/{id}/restore', 'POST /admin/categories', 'GET /admin/categories', 'GET /admin/categories/{id}', 'PUT /admin/categories/{id}', 'DELETE /admin/categories/{id}', 'PUT /admin/categories/{id}/restore', 'GET /admin/expenses', 'GET /admin/expenses/{id}', 'DELETE /admin/expenses/{id}', 'PUT /admin/expenses/{id}/restore', 'GET /admin/sync/operations', 'GET /admin/sync/trend', 'GET /admin/sync/conflicts', 'GET /admin/plans', 'GET /admin/plans/distribution', 'POST /admin/plans', 'PUT /admin/plans/{id}', 'DELETE /admin/plans/{id}', 'GET /admin/analytics', 'GET /admin/analytics/engagement', 'GET /admin/analytics/funnel', 'GET /admin/analytics/subscriptions', 'GET /admin/analytics/records'],
  Analytics: ['GET /admin/analytics/reports', 'POST /admin/analytics/reports', 'PUT /admin/analytics/reports/{id}', 'PATCH /admin/analytics/reports/{id}/status', 'DELETE /admin/analytics/reports/{id}'],
  'Temporary permissions': ['GET /temporary-permissions/me', 'POST /temporary-permissions', 'GET /temporary-permissions/user/{userId}', 'GET /temporary-permissions/expiring-soon', 'GET /temporary-permissions/stats', 'PATCH /temporary-permissions/{id}/extend', 'DELETE /temporary-permissions/{id}', 'POST /temporary-permissions/process-expired'],
  Roles: ['GET /roles', 'POST /roles', 'GET /roles/{id}', 'PUT /roles/{id}', 'DELETE /roles/{id}'],
  'Admin app settings': ['GET /admin/app-settings', 'PUT /admin/app-settings'],
});
const extraFolders = { 'Staff setup': admin.setupStaff, 'Staff RBAC': admin.rbac };

module.exports = { flow, extrasByFolder, orderByFolder, extraFolders };
