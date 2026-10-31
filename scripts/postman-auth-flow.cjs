/**
 * Executable assertions + variable chaining for the Authentication folder.
 * Consumed by build-postman-collection.cjs. Needs two environment variables
 * (kept blank in the checked-in environment, supplied by the QA runner):
 *   qaEmail, qaPassword  -> a seeded consumer account (see npm run seed:test)
 */
const envelopeOk = "pm.test('status is 200', () => pm.response.to.have.status(200)); pm.test('success envelope', () => pm.expect(body.success).to.eql(true));";

const flow = {
  'POST /user/signup': {
    pre: ["pm.environment.set('signupEmail', 'qa-' + Date.now() + '@madarflow.test');"],
    bodyEmail: '{{signupEmail}}',
    test: [
      'const body = pm.response.json();',
      "pm.test('signup creates the account (201 or 200)', () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));",
      "pm.test('signup never returns password material', () => pm.expect(JSON.stringify(body)).to.not.match(/password|passwordHash/i));",
    ],
  },
  'POST /user/login': {
    bodyEmail: '{{qaEmail}}',
    test: [
      'const body = pm.response.json();',
      envelopeOk,
      "pm.test('returns an access token and a sanitized user', () => { pm.expect(body.data.accessToken).to.be.a('string').and.not.empty; pm.expect(body.data.user).to.include.keys('_id', 'email', 'role', 'plan'); pm.expect(body.data.user).to.not.have.any.keys('password', 'sessions'); });",
      "pm.environment.set('accessToken', body.data.accessToken);",
      "pm.environment.set('userId', body.data.user._id);",
      "if (body.data.refreshToken) pm.environment.set('refreshToken', body.data.refreshToken);",
    ],
  },
  'POST /user/refresh-token': {
    test: [
      'const body = pm.response.json();',
      envelopeOk,
      "pm.test('issues a fresh access token', () => pm.expect(body.data.accessToken).to.be.a('string').and.not.empty);",
      "pm.environment.set('accessToken', body.data.accessToken);",
    ],
  },
  'POST /user/logout': {
    test: [
      'const body = pm.response.json();',
      envelopeOk,
    ],
  },
  'GET /user/access-token': {
    test: [
      "pm.test('legacy header endpoint rejects a cookie/bearer-only client with a generic 401', () => pm.response.to.have.status(401));",
      "pm.test('error does not leak internals', () => { const b = pm.response.json(); pm.expect(b.error.code).to.eql('SESSION_INVALID'); pm.expect(JSON.stringify(b)).to.not.match(/argument|Buffer|undefined/i); });",
    ],
  },
  'GET /user/csrf-token': {
    test: [
      'const body = pm.response.json();',
      "pm.test('status is 200', () => pm.response.to.have.status(200));",
      "pm.test('returns a CSRF token', () => pm.expect(body.csrfToken).to.be.a('string').and.not.empty);",
      "pm.environment.set('csrfToken', body.csrfToken);",
    ],
  },
  'GET /user/me': {
    test: [
      'const body = pm.response.json();',
      envelopeOk,
      "pm.test('returns the logged-in user without secrets', () => { pm.expect(body.data.email).to.eql(pm.environment.get('qaEmail').toLowerCase()); pm.expect(body.data).to.not.have.any.keys('password', 'sessions'); });",
    ],
  },
  'GET /user/sessions': {
    test: [
      'const body = pm.response.json();',
      envelopeOk,
      "pm.test('lists sessions as an array with one current', () => { pm.expect(body.data.sessions).to.be.an('array').that.is.not.empty; pm.expect(body.data.sessions.some((s) => s.current)).to.eql(true); });",
      "const other = body.data.sessions.find((s) => !s.current); pm.environment.set('sessionId', other ? other.id : 'nonexistent-session-id');",
    ],
  },
};

// Negative cases appended to the end of the Authentication folder.
const extraRequests = [
  {
    name: 'NEGATIVE Login with wrong password -> 401',
    request: {
      method: 'POST',
      auth: { type: 'noauth' },
      header: [{ key: 'Content-Type', value: 'application/json' }],
      url: { raw: '{{baseUrl}}/user/login' },
      body: { mode: 'raw', raw: '{"email":"{{qaEmail}}","password":"Wrong-Pass-1!"}', options: { raw: { language: 'json' } } },
    },
    test: [
      "pm.test('rejected with 401', () => pm.response.to.have.status(401));",
      "pm.test('error envelope with code, no token', () => { const b = pm.response.json(); pm.expect(b.success).to.eql(false); pm.expect(b.error.code).to.eql('INVALID_CREDENTIALS'); pm.expect(JSON.stringify(b)).to.not.include('accessToken'); });",
    ],
  },
  {
    name: 'NEGATIVE Get me without token -> 401',
    request: { method: 'GET', auth: { type: 'noauth' }, header: [], url: { raw: '{{baseUrl}}/user/me' } },
    test: [
      "pm.test('rejected with 401', () => pm.response.to.have.status(401));",
      "pm.test('error code present', () => pm.expect(pm.response.json().error.code).to.be.a('string'));",
    ],
  },
  {
    name: 'NEGATIVE Get me after logout -> 401',
    request: { method: 'GET', header: [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }], auth: { type: 'noauth' }, url: { raw: '{{baseUrl}}/user/me' } },
    test: [
      "pm.test('revoked session cannot reach protected routes', () => pm.response.to.have.status(401));",
    ],
  },
  {
    name: 'NEGATIVE Signup with weak password -> 4xx',
    request: {
      method: 'POST',
      auth: { type: 'noauth' },
      header: [{ key: 'Content-Type', value: 'application/json' }],
      url: { raw: '{{baseUrl}}/user/signup' },
      body: { mode: 'raw', raw: '{"email":"weak-{{$timestamp}}@madarflow.test","password":"123"}', options: { raw: { language: 'json' } } },
    },
    test: [
      "pm.test('rejected with a client error, never 5xx', () => pm.expect(pm.response.code).to.be.within(400, 499));",
    ],
  },
];

// Deliberate execution order for the Authentication folder (logout comes late, it revokes the session).
const order = [
  'GET /user/csrf-token', 'POST /user/signup', 'POST /user/login', 'GET /user/me', 'GET /user/sessions',
  'GET /user/access-token', 'PUT /user/me', 'POST /user/refresh-token', 'DELETE /user/sessions/others',
  'DELETE /user/sessions/{sessionId}', 'POST /user/biometric/enroll', 'DELETE /user/biometric/current',
  'POST /user/me/avatar', 'POST /user/me/delete', 'POST /user/logout',
];

module.exports = { flow, extraRequests, order };
