/* Build a source-indexed OpenAPI catalog for the Express route tree. */
const fs = require('node:fs');
const path = require('node:path');
require('ts-node/register');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const routeDir = path.join(root, 'src/app/routes');
const outputDir = path.join(root, 'postman');
const swagger = require('../src/app/config/swagger.config').swaggerSpec;

const mounts = {
  'user.route.ts': [{ variable: 'router', prefix: '/user', tag: 'Authentication' }],
  'category.route.ts': [{ variable: 'router', prefix: '/categories', tag: 'Categories' }],
  'expense.route.ts': [{ variable: 'router', prefix: '/expenses', tag: 'Expenses' }],
  'plan.route.ts': [{ variable: 'router', prefix: '/plans', tag: 'Plans' }],
  'app-settings.route.ts': [
    { variable: 'appSettingsPublicRoutes', prefix: '/app-settings', tag: 'App settings' },
    { variable: 'appSettingsAdminRoutes', prefix: '/admin/app-settings', tag: 'Admin app settings' },
  ],
  'sync.route.ts': [{ variable: 'router', prefix: '/sync', tag: 'Sync' }],
  'admin.route.ts': [{ variable: 'router', prefix: '/admin', tag: 'Admin' }],
  'audit-log.route.ts': [{ variable: 'router', prefix: '/audit-logs', tag: 'Audit logs' }],
  'cache.route.ts': [{ variable: 'router', prefix: '/cache', tag: 'Cache' }],
  'scope.route.ts': [{ variable: 'router', prefix: '/scopes', tag: 'Scopes' }],
  'rate-limit.route.ts': [{ variable: 'router', prefix: '/rate-limits', tag: 'Rate limits' }],
  'temporary-permission.route.ts': [{ variable: 'router', prefix: '/temporary-permissions', tag: 'Temporary permissions' }],
  'permission-matrix.route.ts': [{ variable: 'router', prefix: '/permissions', tag: 'Permission matrix' }],
  'role.routes.ts': [{ variable: 'router', prefix: '/roles', tag: 'Roles' }],
  'notification.route.ts': [{ variable: 'router', prefix: '/notifications', tag: 'Notifications' }],
  'push-device.route.ts': [{ variable: 'router', prefix: '/push', tag: 'Push devices' }],
  'health.route.ts': [{ variable: 'router', prefix: '/health', tag: 'Health' }],
};

const methodNames = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const routeOperations = [];

function commentFor(sourceText, node) {
  const comments = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) || [];
  const last = comments.at(-1);
  if (!last) return '';
  const raw = sourceText.slice(last.pos, last.end);
  return raw.replace(/^\/\*\*?|\*\/|^\s*\/\//gm, '').replace(/^\s*\* ?/gm, '').trim();
}

function routeSummary(method, route, handlerText) {
  const bound = [...handlerText.matchAll(/([A-Za-z_$][\w$]*)\.bind\(/g)].at(-1)?.[1];
  const plain = handlerText.match(/\b(login|signUp|refreshToken|logout|getMe|updateMe|deleteMe|uploadAvatar|requestPasswordReset|resetPassword|enrollBiometric|biometricSignIn|revokeCurrentBiometric|createExpense|deleteExpense|getExpenseById|getExpenses|getExpenseTotals|updateExpense|createCategory|deleteCategory|getCategories|getCategoryById|updateCategory|updateOrder)\b/)?.[1];
  const handler = bound || plain;
  if (handler) {
    const verb = {
      get: 'Get',
      list: 'List',
      create: 'Create',
      post: 'Submit',
      update: 'Update',
      delete: 'Delete',
      remove: 'Remove',
      restore: 'Restore',
      export: 'Export',
      invalidate: 'Invalidate',
      flush: 'Flush',
      warmUp: 'Warm up',
      processExpired: 'Process expired',
    };
    const words = handler.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return words.replace(/^(get|list|create|post|update|delete|remove|restore|export|invalidate|flush|warm up|process expired)\b/i,
      (match) => verb[match.replace(/\s/g, '').toLowerCase()] || match
    );
  }
  const noun = route.split('/').filter(Boolean).filter((part) => !part.startsWith(':')).at(-1) || 'resource';
  return `${method.toUpperCase()} ${noun.replace(/[-_]/g, ' ')}`;
}

function normalizePath(value) {
  const pathValue = value.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  if (!pathValue || pathValue === '/') return '/';
  return pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
}

function classifyAccess(globalMiddleware, localMiddleware) {
  const stack = [...globalMiddleware, ...localMiddleware].join(' ');
  const permissions = [...stack.matchAll(/Permission\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  let auth = 'public';
  if (/verifyAccessToken/.test(stack)) auth = 'bearer';
  else if (/verifySession/.test(stack)) auth = 'cookie';
  let role = '';
  if (/requireSuperAdmin/.test(stack)) role = 'SuperAdmin';
  else if (/requireAdmin/.test(stack) || /UserRole\.Admin/.test(stack)) role = 'Admin+';
  else if (/requireModerator/.test(stack)) role = 'Moderator+';
  else if (/requireRole\(/.test(stack)) role = 'Role-gated';
  else if (permissions.length) role = `Permission-gated: ${[...new Set(permissions)].join(', ')}`;
  return { auth, role, permissions: [...new Set(permissions)] };
}

function collectFile(fileName, mount) {
  const filePath = path.join(routeDir, fileName);
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const calls = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === mount.variable
    ) {
      const method = node.expression.name.text.toLowerCase();
      if (method === 'use') {
        calls.push({ kind: 'use', node, position: node.pos });
      } else if (methodNames.has(method) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        calls.push({ kind: 'route', node, method, path: node.arguments[0].text, position: node.pos });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  calls.sort((a, b) => a.position - b.position);
  const globalMiddleware = [];
  for (const call of calls) {
    if (call.kind === 'use') {
      const args = [...call.node.arguments];
      if (args[0] && ts.isStringLiteral(args[0])) continue;
      globalMiddleware.push(...args.map((arg) => arg.getText(source)));
      continue;
    }
    const args = [...call.node.arguments].slice(1);
    const localMiddleware = args.map((arg) => arg.getText(source));
    const access = classifyAccess(globalMiddleware, localMiddleware);
    const fullPath = normalizePath(`${mount.prefix}${call.path === '/' ? '' : call.path}`);
    const handlerText = args.map((arg) => arg.getText(source)).join(' ');
    const leading = commentFor(sourceText, call.node);
    const routeNotes = [...leading.matchAll(/@(?:desc|description|access|route)\s*([^\n]*)/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    routeOperations.push({
      file: fileName,
      method: call.method,
      path: fullPath,
      tag: mount.tag,
      summary: routeSummary(call.method, fullPath, handlerText),
      access,
      routeNotes,
      hasBody: ['post', 'put', 'patch'].includes(call.method),
    });
  }
}

const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
const integer = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const boolean = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const jsonRequest = (properties, required = [], example) => ({
  required: true,
  content: {
    'application/json': {
      schema: { type: 'object', required, properties },
      ...(example ? { example } : {}),
    },
  },
});
const requestContracts = {
  'POST /user/refresh-token': {
    body: jsonRequest({ refreshToken: string('Refresh token returned by signup/login/refresh.', { example: '{{refreshToken}}' }) }, ['refreshToken'], { refreshToken: '{{refreshToken}}' }),
  },
  'POST /user/logout': {
    body: jsonRequest({ refreshToken: string('Refresh token to revoke.', { example: '{{refreshToken}}' }) }, ['refreshToken'], { refreshToken: '{{refreshToken}}' }),
  },
  'POST /user/auth/google/exchange': {
    body: jsonRequest({ code: string('Single-use 64-character hexadecimal exchange code returned by the OAuth callback.', { pattern: '^[a-f0-9]{64}$', example: '{{googleExchangeCode}}' }) }, ['code'], { code: '{{googleExchangeCode}}' }),
  },
  'POST /user/password/forgot': {
    body: jsonRequest({ email: string('Account email. The response is intentionally generic.', { format: 'email', example: 'person@example.test' }) }, ['email'], { email: 'person@example.test' }),
  },
  'POST /user/password/reset': {
    body: jsonRequest({ token: string('Single-use reset token from the reset link.', { example: '{{passwordResetToken}}' }), password: string('New password; must pass the backend password-strength validator.', { format: 'password', example: '{{newPassword}}' }) }, ['token', 'password'], { token: '{{passwordResetToken}}', password: '{{newPassword}}' }),
  },
  'POST /user/biometric/signin': {
    body: jsonRequest({ deviceId: string('Registered biometric device identifier.', { example: '{{deviceId}}' }), credential: string('Biometric credential assertion.', { format: 'password', example: '{{biometricCredential}}' }) }, ['deviceId', 'credential'], { deviceId: '{{deviceId}}', credential: '{{biometricCredential}}' }),
  },
  'POST /user/biometric/enroll': {
    body: jsonRequest({ deviceId: string('Client-generated stable device identifier.', { maxLength: 128, example: '{{deviceId}}' }), label: string('Human-readable device label.', { maxLength: 100, example: 'My phone' }), platform: string('Mobile platform.', { enum: ['android', 'ios'], example: 'android' }) }, ['deviceId', 'label', 'platform'], { deviceId: '{{deviceId}}', label: 'My phone', platform: 'android' }),
  },
  'DELETE /user/biometric/current': {
    body: jsonRequest({ deviceId: string('Device identifier to revoke.', { example: '{{deviceId}}' }) }, ['deviceId'], { deviceId: '{{deviceId}}' }),
  },
  'POST /user/auth/google/native': {
    body: jsonRequest({ idToken: string('Google Sign-In ID token. Do not save a real token in a shared example.', { format: 'password', example: '{{googleIdToken}}' }), termsAccepted: boolean('Required when this flow creates a new account.', { example: true }), privacyAccepted: boolean('Required when this flow creates a new account.', { example: true }), termsVersion: string('Terms revision accepted for a new account.', { example: 'current' }), privacyVersion: string('Privacy revision accepted for a new account.', { example: 'current' }) }, ['idToken'], { idToken: '{{googleIdToken}}', termsAccepted: true, privacyAccepted: true, termsVersion: 'current', privacyVersion: 'current' }),
    note: 'If a new account is created, the backend requires the current legal-consent fields. Existing accounts do not need to resubmit consent.',
  },
  'PUT /user/me': {
    body: jsonRequest({ phone: string('Phone number.', { example: '+201000000000' }), salary: { oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'number' } } } }], description: 'Salary value or labeled salary entries.' }, currency: string('ISO currency code.', { example: 'EGP' }), username: string('Display username.', { example: 'sample-user' }), image: string('Profile image URL/value.', { example: 'https://example.test/avatar.png' }) }, [], { username: 'sample-user', currency: 'EGP' }),
  },
  'POST /user/me/delete': {
    body: jsonRequest({ password: string('Current account password.', { format: 'password', example: '{{currentPassword}}' }), confirmation: string('Explicit account-deletion confirmation phrase.', { example: '{{deletionConfirmation}}' }) }, ['password', 'confirmation'], { password: '{{currentPassword}}', confirmation: '{{deletionConfirmation}}' }),
    note: 'Destructive self-service account deletion. Do not run in a shared or production environment.',
  },
  'POST /user/me/avatar': {
    body: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary', description: 'One image file, maximum 5 MiB. The route accepts any multipart field name.' } } } } } },
  },
  'POST /categories/create': {
    body: jsonRequest({ title: string('Category display title.', { example: 'Groceries' }), icon: string('Icon identifier.', { example: 'cart-outline' }), color: string('Color value.', { example: '#3366CC' }), type: string('Income or expense classification.', { enum: ['income', 'outcome'], example: 'outcome' }), order: integer('Display order.', { example: 0 }) }, ['title', 'icon', 'color'], { title: 'Groceries', icon: 'cart-outline', color: '#3366CC', type: 'outcome' }),
  },
  'PUT /categories/update/{id}': {
    body: jsonRequest({ title: string('Category display title.'), icon: string('Icon identifier.'), color: string('Color value.'), type: string('Income or expense classification.', { enum: ['income', 'outcome'] }), order: integer('Display order.') }, [], { title: 'Groceries', icon: 'cart-outline', color: '#3366CC', type: 'outcome' }),
  },
  'PUT /categories/update-order': {
    body: jsonRequest({ categories: { type: 'array', description: 'Ordered categories accepted by CategoryService.updateOrder.', items: { type: 'object', properties: { id: { type: 'string' }, order: { type: 'integer' } } } } }, ['categories'], { categories: [{ id: '{{categoryId}}', order: 0 }] }),
  },
  'POST /expenses': {
    body: jsonRequest({ description: string('Record description.', { example: 'Weekly groceries' }), amount: { type: 'number', exclusiveMinimum: 0, example: 125.5 }, category: string('Category ObjectId.', { example: '{{categoryId}}' }), date: string('Record date/time.', { format: 'date-time', example: '2026-10-20T12:00:00.000Z' }) }, ['description', 'amount', 'category', 'date'], { description: 'Weekly groceries', amount: 125.5, category: '{{categoryId}}', date: '2026-10-20T12:00:00.000Z' }),
  },
  'PUT /expenses/{id}': {
    body: jsonRequest({ description: string('Record description.'), amount: { type: 'number', exclusiveMinimum: 0 }, category: string('Category ObjectId.'), date: string('Record date/time.', { format: 'date-time' }) }, ['description', 'amount', 'category', 'date'], { description: 'Updated description', amount: 125.5, category: '{{categoryId}}', date: '2026-10-20T12:00:00.000Z' }),
  },
  'POST /plans/upgrade': {
    body: jsonRequest({ planSlug: string('Plan to assign.', { enum: ['pro', 'premium'], example: 'pro' }), paymentRef: string('Optional payment reference saved for records; payment is not collected by this endpoint.', { example: 'local-test-reference' }) }, ['planSlug'], { planSlug: 'pro', paymentRef: 'local-test-reference' }),
    note: 'State-changing endpoint: the current implementation directly assigns the selected plan for 30 days; it does not invoke a payment gateway.',
  },
  'PUT /admin/app-settings': {
    body: jsonRequest({ revision: integer('Revision last loaded by the editor; 0 when no save exists.', { minimum: 0, example: 0 }), support: { type: ['object', 'null'], description: 'Optional replacement or reset for the support section.' }, legal: { type: ['object', 'null'], description: 'Optional replacement or reset for terms/privacy content.' }, faq: { type: ['array', 'null'], description: 'Localized FAQ entries.' }, maintenance: { type: ['object', 'null'], description: 'Maintenance notice settings.' }, versioning: { type: ['object', 'null'], description: 'Minimum/latest app versions and HTTPS store URL.' } }, ['revision'], { revision: 1, maintenance: { enabled: false } }),
    note: 'SuperAdmin only. Submitted sections replace their current section; null resets a section to built-in defaults. Strict schema rejects unknown keys.',
  },
  'POST /sync/push': {
    body: jsonRequest({ entities: { type: 'array', minItems: 0, items: { type: 'object', required: ['_entityType', '_id'], properties: { _entityType: string('Sync entity type.', { enum: ['expense', 'category', 'user'] }), _id: string('Client entity ID.') }, additionalProperties: true } } }, ['entities'], { entities: [{ _entityType: 'expense', _id: '{{clientEntityId}}' }] }),
  },
  'POST /sync/bulk': {
    body: jsonRequest({ entities: { type: 'array', items: { type: 'object', additionalProperties: true } } }, ['entities'], { entities: [] }),
  },
  'POST /sync/conflicts/resolve': {
    body: jsonRequest({ entityId: string('Conflicted entity identifier.'), entityType: string('Entity type.', { enum: ['expense', 'category', 'user'] }), resolution: string('Resolution strategy.', { enum: ['local', 'server', 'merge'] }), mergedData: { type: 'object', additionalProperties: true, description: 'Required by clients selecting merge; optional for other strategies.' } }, ['entityId', 'entityType', 'resolution'], { entityId: '{{clientEntityId}}', entityType: 'expense', resolution: 'server' }),
  },
  'PUT /sync/metadata': {
    body: jsonRequest({ lastSyncTime: string('Last completed sync time.', { format: 'date-time' }), totalEntities: integer('Non-negative entity count.', { minimum: 0 }), pendingCount: integer('Non-negative pending count.', { minimum: 0 }), conflictCount: integer('Non-negative conflict count.', { minimum: 0 }), errorCount: integer('Non-negative error count.', { minimum: 0 }), isOnline: boolean('Client connectivity state.'), isSyncing: boolean('Whether a sync is running.') }, [], { isOnline: true, isSyncing: false, totalEntities: 0 }),
  },
  'POST /admin/users': {
    body: jsonRequest({ email: string('New account email.', { format: 'email', example: 'new-user@example.test' }), password: string('Initial password.', { format: 'password', example: '{{initialPassword}}' }), role: string('Role allowed by the acting Admin role.', { example: 'user' }), username: string('Optional username.', { example: 'new-user' }) }, ['email', 'password'], { email: 'new-user@example.test', password: '{{initialPassword}}', role: 'user', username: 'new-user' }),
    note: 'The backend marks Admin-created user email addresses as verified.',
  },
  'PUT /admin/users/{id}': {
    body: jsonRequest({ role: string('Role, subject to actor/target role management checks.'), fullName: string('Full display name.'), phone: string('Phone number.'), currency: string('Currency code.'), username: string('Username.'), isActive: boolean('Account active flag.'), _isDeleted: boolean('Soft-delete flag.'), plan: string('Assigned plan slug.', { enum: ['free', 'pro', 'premium'] }), planExpiresAt: string('Plan expiry.', { format: 'date-time' }), planStartedAt: string('Plan start.', { format: 'date-time' }), customPermissions: { type: 'array', items: { type: 'string' } } }, [], { isActive: true }),
  },
  'PUT /admin/users/{userId}/plan': {
    body: jsonRequest({ planSlug: string('Plan to assign.', { enum: ['free', 'pro', 'premium'], example: 'pro' }), durationDays: integer('Optional duration in days; defaults to 30.', { minimum: 1, example: 30 }) }, ['planSlug'], { planSlug: 'pro', durationDays: 30 }),
  },
  'POST /admin/categories': {
    body: jsonRequest({ title: string('Category display title.', { example: 'Groceries' }), icon: string('Icon identifier.'), color: string('Color value.'), type: string('Category classification.', { enum: ['income', 'outcome'] }), isDefault: boolean('System default category flag.') }, ['title', 'icon', 'color'], { title: 'Groceries', icon: 'cart-outline', color: '#3366CC', type: 'outcome' }),
  },
  'PUT /admin/categories/{id}': {
    body: jsonRequest({ title: string('Category display title.'), icon: string('Icon identifier.'), color: string('Color value.'), type: string('Category classification.', { enum: ['income', 'outcome'] }), isActive: boolean('Whether category is active.') }, [], { title: 'Groceries' }),
  },
  'POST /admin/plans': {
    body: jsonRequest({ name: string('Display plan name.'), slug: string('Unique plan slug.', { enum: ['free', 'pro', 'premium'] }), description: string('Plan description.'), price: { type: 'number', minimum: 0 }, currency: string('ISO 4217 currency code.', { example: 'EGP' }), billingCycle: string('Billing cycle.', { enum: ['monthly', 'yearly', 'lifetime'] }), limits: { type: 'object', properties: { maxCategories: { type: ['integer', 'null'] }, maxTransactionsPerMonth: { type: ['integer', 'null'] }, maxBackupFiles: { type: ['integer', 'null'] }, maxDevices: { type: ['integer', 'null'] } } }, features: { type: 'array', items: { type: 'string' } }, isActive: boolean('Selectable/visible flag.'), isPopular: boolean('Pricing-page highlight flag.'), order: integer('Display order.') }, ['name', 'slug', 'description'], { name: 'Test Pro', slug: 'pro', description: 'Local example only', price: 0, currency: 'EGP', billingCycle: 'monthly' }),
  },
  'PUT /admin/plans/{id}': {
    body: jsonRequest({ name: string('Display plan name.'), description: string('Plan description.'), price: { type: 'number', minimum: 0 }, currency: string('ISO currency code.'), billingCycle: string('Billing cycle.', { enum: ['monthly', 'yearly', 'lifetime'] }), limits: { type: 'object', additionalProperties: true }, features: { type: 'array', items: { type: 'string' } }, isActive: boolean('Selectable/visible flag.'), isPopular: boolean('Pricing-page highlight flag.'), order: integer('Display order.') }, [], { description: 'Updated local example' }),
  },
  'POST /cache/invalidate-users': {
    body: jsonRequest({ userIds: { type: 'array', items: { type: 'string' }, description: 'User IDs whose permission/cache entries should be invalidated.' } }, ['userIds'], { userIds: ['{{userId}}'] }),
    note: 'Invalidates server-side cache entries; does not change persisted user data.',
  },
  'POST /cache/warmup': {
    body: jsonRequest({ userIds: { type: 'array', items: { type: 'string' }, description: 'User IDs to warm in cache.' } }, ['userIds'], { userIds: ['{{userId}}'] }),
    note: 'SuperAdmin-only operational action. Warms cache entries and may increase backend load.',
  },
  'POST /scopes/missing': {
    body: jsonRequest({ scopes: { type: 'array', items: { type: 'string' }, description: "Scope names to compare with the current user's scopes." } }, ['scopes'], { scopes: ['expenses:read'] }),
  },
  'POST /temporary-permissions': {
    body: jsonRequest({ userId: string('Target account ID.', { example: '{{userId}}' }), permission: string('Permission identifier defined by the backend.', { example: 'EXPENSE_READ' }), startDate: string('Start timestamp.', { format: 'date-time' }), endDate: string('End timestamp.', { format: 'date-time' }), reason: string('Reason for the temporary grant.'), metadata: { type: 'object', additionalProperties: true } }, ['userId', 'permission', 'startDate', 'endDate'], { userId: '{{userId}}', permission: 'EXPENSE_READ', startDate: '2026-10-30T00:00:00.000Z', endDate: '2026-10-31T00:00:00.000Z', reason: 'Local test' }),
  },
  'DELETE /temporary-permissions/{id}': {
    body: jsonRequest({ reason: string('Optional revocation reason.') }, [], { reason: 'Local test' }),
  },
  'PATCH /temporary-permissions/{id}/extend': {
    body: jsonRequest({ newEndDate: string('New expiry timestamp.', { format: 'date-time' }), reason: string('Optional reason.') }, ['newEndDate'], { newEndDate: '2026-11-01T00:00:00.000Z', reason: 'Local test' }),
  },
  'POST /roles': {
    body: jsonRequest({ name: string('Role display name.', { minLength: 2, maxLength: 50 }), slug: string('Lowercase letters, digits, hyphens.', { pattern: '^[a-z0-9-]+$', minLength: 2, maxLength: 50 }), description: string('Optional description.'), permissions: { type: 'array', items: { type: 'string' } }, isSystem: boolean('Optional system-role marker.') }, ['name', 'slug'], { name: 'Local role', slug: 'local-role', description: 'Example only', permissions: [] }),
  },
  'PUT /roles/{id}': {
    body: jsonRequest({ name: string('Role display name.', { minLength: 2, maxLength: 50 }), slug: string('Lowercase letters, digits, hyphens.', { pattern: '^[a-z0-9-]+$', minLength: 2, maxLength: 50 }), description: string('Optional description.'), permissions: { type: 'array', items: { type: 'string' } } }, [], { name: 'Local role' }),
  },
  'POST /notifications/broadcast': {
    body: jsonRequest({ title: string('Notification title.', { minLength: 1, maxLength: 160, example: 'Service update' }), message: string('Notification body.', { minLength: 1, maxLength: 1000, example: 'A local test message.' }), type: string('Visual notification type.', { enum: ['info', 'success', 'warn', 'error'], default: 'info' }), audience: string('Target audience.', { enum: ['all', 'admins', 'moderators'], default: 'all' }) }, ['title', 'message'], { title: 'Local test', message: 'Example only', type: 'info', audience: 'admins' }),
    note: 'Broadcasts a real notification to the selected audience. Do not run outside an isolated local/test environment.',
  },
  'PATCH /notifications/preferences': {
    body: jsonRequest({ sync: { type: 'object', properties: { inbox: boolean('Inbox channel.'), realtime: boolean('Realtime channel.'), push: boolean('Push channel.') } }, subscription: { type: 'object', properties: { inbox: boolean('Inbox channel.'), realtime: boolean('Realtime channel.'), push: boolean('Push channel.') } }, security: { type: 'object', properties: { inbox: boolean('Inbox channel.'), realtime: boolean('Realtime channel.'), push: boolean('Push channel.') } }, general: { type: 'object', properties: { inbox: boolean('Inbox channel.'), realtime: boolean('Realtime channel.'), push: boolean('Push channel.') } } }, [], { general: { inbox: true } }),
  },
  'POST /push/devices': {
    body: jsonRequest({ deviceId: string('Stable device ID.', { minLength: 1, maxLength: 128 }), token: string('FCM/APNs token. Never store a real device token in a shared example.', { minLength: 20, maxLength: 4096, example: '{{pushToken}}' }), platform: string('Mobile platform.', { enum: ['android', 'ios'] }), appVersion: string('Optional app version.', { maxLength: 64 }) }, ['deviceId', 'token', 'platform'], { deviceId: '{{deviceId}}', token: '{{pushToken}}', platform: 'android', appVersion: '0.0.0-local' }),
  },
};

const queryContracts = {
  'GET /user/google': [
    { name: 'consent', schema: string('Set the short-lived browser consent marker before Google OAuth when the value is 1.', { enum: ['1'] }) },
  ],
  'GET /categories/list': [
    { name: 'q', schema: string('Search category titles.') },
    { name: 'type', schema: string('Current category classification.', { enum: ['income', 'outcome'] }) },
    { name: 'page', schema: integer('Page number.', { minimum: 1, default: 1 }) },
    { name: 'limit', schema: integer('Page size.', { minimum: 1, default: 10 }) },
    { name: 'sort', schema: string('Sort field; prefix with - for descending.', { default: 'order' }) },
  ],
  'GET /expenses': [
    { name: 'search', schema: string('Record search text.') },
    { name: 'category', schema: string('Category ID.') },
    { name: 'categories', schema: string('Category ID filter; confirm delimiter from client usage.') },
    { name: 'type', schema: string('Record type.', { enum: ['income', 'outcome'] }) },
    { name: 'startDate', schema: string('Inclusive date/time bound.', { format: 'date-time' }) },
    { name: 'endDate', schema: string('Inclusive date/time bound.', { format: 'date-time' }) },
    { name: 'limit', schema: integer('Page size.', { minimum: 1 }) },
    { name: 'skip', schema: integer('Number of records to skip.', { minimum: 0 }) },
  ],
  'GET /expenses/totals': [
    { name: 'startDate', required: true, schema: string('Required period start date.') },
    { name: 'endDate', required: true, schema: string('Required period end date.') },
  ],
  'GET /notifications/list': [
    { name: 'limit', schema: integer('Maximum number of notifications.', { default: 50 }) },
    { name: 'offset', schema: integer('Number of rows to skip.', { minimum: 0, default: 0 }) },
  ],
  'GET /sync/pull': [
    { name: 'lastSyncTime', schema: string('Last sync timestamp.', { format: 'date-time' }) },
    { name: 'entityType', schema: string('Filter entity type.', { enum: ['expense', 'category', 'user'] }) },
    { name: 'limit', schema: integer('Maximum 100 rows.', { minimum: 1, maximum: 100 }) },
    { name: 'offset', schema: integer('Offset.', { minimum: 0 }) },
  ],
  'DELETE /sync/cleanup': [
    { name: 'olderThanDays', schema: integer('Age threshold in days.', { minimum: 1, maximum: 365 }) },
  ],
  'GET /temporary-permissions/expiring-soon': [
    { name: 'hours', schema: integer('Look-ahead window in hours.', { default: 24 }) },
  ],
  'GET /permissions/export': [
    { name: 'format', schema: string('Export format.', { enum: ['json', 'csv', 'markdown'], default: 'json' }) },
  ],
  'GET /permissions/compare/plans': [
    { name: 'plan1', required: true, schema: string('First plan slug.', { enum: ['free', 'pro', 'premium'] }) },
    { name: 'plan2', required: true, schema: string('Second plan slug.', { enum: ['free', 'pro', 'premium'] }) },
  ],
  'GET /permissions/compare/roles': [
    { name: 'role1', required: true, schema: string('First role name.') },
    { name: 'role2', required: true, schema: string('Second role name.') },
  ],
  'GET /admin/analytics': [
    { name: 'days', schema: string('Preset complete UTC day window.', { enum: ['7', '30', '90'] }) },
    { name: 'start', schema: string('Custom inclusive UTC date, paired with end.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'end', schema: string('Custom inclusive UTC date, paired with start.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'compare', schema: string('Comparison period.', { enum: ['previous', 'yearAgo'], default: 'previous' }) },
    { name: 'plan', schema: string('Current assigned plan; requires Admin.', { enum: ['free', 'pro', 'premium'] }) },
    { name: 'type', schema: string('Current category record type.', { enum: ['income', 'outcome'] }) },
  ],
  'GET /admin/analytics/engagement': [
    { name: 'days', schema: string('Preset complete UTC day window.', { enum: ['7', '30', '90'] }) },
    { name: 'start', schema: string('Custom inclusive UTC date, paired with end.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'end', schema: string('Custom inclusive UTC date, paired with start.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'compare', schema: string('Comparison period.', { enum: ['previous', 'yearAgo'], default: 'previous' }) },
    { name: 'plan', schema: string('Current assigned plan.', { enum: ['free', 'pro', 'premium'] }) },
  ],
  'GET /admin/analytics/funnel': [
    { name: 'days', schema: string('Preset complete UTC day window.', { enum: ['7', '30', '90'] }) },
    { name: 'start', schema: string('Custom inclusive UTC date, paired with end.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'end', schema: string('Custom inclusive UTC date, paired with start.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'compare', schema: string('Comparison period.', { enum: ['previous', 'yearAgo'], default: 'previous' }) },
  ],
  'GET /admin/analytics/subscriptions': [
    { name: 'days', schema: string('Preset complete UTC day window.', { enum: ['7', '30', '90'] }) },
    { name: 'start', schema: string('Custom inclusive UTC date, paired with end.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'end', schema: string('Custom inclusive UTC date, paired with start.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'compare', schema: string('Comparison period.', { enum: ['previous', 'yearAgo'], default: 'previous' }) },
  ],
  'GET /admin/analytics/records': [
    { name: 'days', schema: string('Preset complete UTC day window.', { enum: ['7', '30', '90'] }) },
    { name: 'start', schema: string('Custom inclusive UTC date, paired with end.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'end', schema: string('Custom inclusive UTC date, paired with start.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'compare', schema: string('Comparison period.', { enum: ['previous', 'yearAgo'], default: 'previous' }) },
    { name: 'plan', schema: string('Current assigned plan; requires Admin.', { enum: ['free', 'pro', 'premium'] }) },
    { name: 'type', schema: string('Current category record type.', { enum: ['income', 'outcome'] }) },
    { name: 'asOf', schema: string('Snapshot UTC date.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'kind', required: true, schema: string('Analytics metric.', { enum: ['newUsers', 'recordingUsers', 'expenses'] }) },
    { name: 'day', schema: string('Selected UTC day.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
    { name: 'page', schema: integer('Page number.', { minimum: 1, maximum: 9999, default: 1 }) },
  ],
  'GET /admin/users': [
    { name: 'page', schema: integer('Page number.', { default: 1 }) },
    { name: 'limit', schema: integer('Page size.', { default: 10 }) },
    { name: 'search', schema: string('Search users.') },
    { name: 'status', schema: string('Account state filter.', { enum: ['active', 'inactive', 'deleted'], default: 'active' }) },
    { name: 'sortField', schema: string('Sort field.', { default: 'createdAt' }) },
    { name: 'sortOrder', schema: integer('Sort direction value.', { default: -1 }) },
  ],
  'GET /admin/categories': [
    { name: 'page', schema: integer('Page number.', { default: 1 }) },
    { name: 'limit', schema: integer('Page size.', { default: 10 }) },
    { name: 'search', schema: string('Search category titles.') },
    { name: 'status', schema: string('Category state filter.', { enum: ['active', 'inactive', 'deleted'], default: 'active' }) },
    { name: 'sortField', schema: string('Sort field.', { default: 'createdAt' }) },
    { name: 'sortOrder', schema: integer('Sort direction value.', { default: -1 }) },
  ],
  'GET /admin/expenses': [
    { name: 'page', schema: integer('Page number.', { default: 1 }) },
    { name: 'limit', schema: integer('Page size.', { default: 10 }) },
    { name: 'search', schema: string('Search financial records.') },
    { name: 'status', schema: string('Record state filter.', { enum: ['active', 'deleted'], default: 'active' }) },
    { name: 'sortField', schema: string('Sort field.', { default: 'date' }) },
    { name: 'sortOrder', schema: integer('Sort direction value.', { default: -1 }) },
  ],
  'GET /audit-logs': [
    ...['actorId', 'targetUserId', 'action', 'severity', 'success', 'startDate', 'endDate', 'limit', 'skip', 'sortBy', 'sortOrder'].map((name) => ({
      name,
      schema: name === 'limit' || name === 'skip' ? integer('Audit log pagination value.') : string('Audit log filter.'),
    })),
  ],
  'GET /audit-logs/security/recent': [
    { name: 'limit', schema: integer('Maximum event count.', { default: 100 }) },
  ],
  'GET /audit-logs/stats': [
    { name: 'startDate', required: true, schema: string('Inclusive start date.', { format: 'date-time' }) },
    { name: 'endDate', required: true, schema: string('Inclusive end date.', { format: 'date-time' }) },
  ],
  'DELETE /audit-logs/cleanup': [
    { name: 'olderThanDays', required: true, schema: integer('Required retention threshold in days.', { minimum: 1 }) },
  ],
};

const standardEnvelopeRouteFiles = new Set([
  'admin.route.ts',
  'audit-log.route.ts',
  'cache.route.ts',
  'category.route.ts',
  'expense.route.ts',
  'plan.route.ts',
  'app-settings.route.ts',
  'sync.route.ts',
  'temporary-permission.route.ts',
  'scope.route.ts',
  'role.routes.ts',
  'push-device.route.ts',
  'rate-limit.route.ts',
]);
const standardEnvelopeOperations = new Set([
  'POST /user/signup',
  'POST /user/login',
  'POST /user/refresh-token',
  'POST /user/logout',
  'POST /user/password/forgot',
  'POST /user/password/reset',
  'POST /user/biometric/signin',
  'POST /user/biometric/enroll',
  'DELETE /user/biometric/current',
  'GET /user/access-token',
  'GET /user/me',
  'PUT /user/me',
  'POST /user/me/delete',
  'POST /user/me/avatar',
  'GET /notifications/list',
  'PATCH /notifications/all/read',
  'GET /notifications/preferences',
  'PATCH /notifications/preferences',
  'GET /notifications/{notificationId}',
  'PATCH /notifications/{notificationId}/read',
]);
const createdResponseOperations = new Set([
  'POST /categories/create',
  'POST /admin/users',
  'POST /admin/categories',
  'POST /admin/plans',
]);
const responseRef = (description, schema) => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
});
const explicitResponseContracts = {
  'GET /admin/analytics': {
    '200': responseRef('Dashboard analytics overview and comparison series.', 'AdminAnalyticsOverviewEnvelope'),
    '400': responseRef('Analytics range or filters are invalid.', 'ApiErrorEnvelope'),
    '401': responseRef('Authentication is required.', 'ApiErrorEnvelope'),
    '403': responseRef('Admin access is required for plan filtering.', 'ApiErrorEnvelope'),
    '500': responseRef('Analytics could not be loaded.', 'ApiErrorEnvelope'),
  },
  'GET /admin/analytics/funnel': {
    '200': responseRef('Registration to paid-plan activation funnel.', 'AnalyticsFunnelEnvelope'),
    '400': responseRef('Analytics range is invalid.', 'ApiErrorEnvelope'),
    '401': responseRef('Authentication is required.', 'ApiErrorEnvelope'),
    '403': responseRef('Moderator access is required.', 'ApiErrorEnvelope'),
    '500': responseRef('Activation funnel could not be loaded.', 'ApiErrorEnvelope'),
  },
  'GET /admin/analytics/engagement': {
    '200': responseRef('Recording activity, source coverage, and cohort retention.', 'EngagementAnalyticsEnvelope'),
    '400': responseRef('Analytics range or filters are invalid.', 'ApiErrorEnvelope'),
    '401': responseRef('Authentication is required.', 'ApiErrorEnvelope'),
    '403': responseRef('Moderator access is required.', 'ApiErrorEnvelope'),
    '500': responseRef('Engagement analytics could not be loaded.', 'ApiErrorEnvelope'),
  },
  'GET /admin/analytics/subscriptions': {
    '200': responseRef('Subscription integrity metrics, upcoming expirations, and daily history.', 'SubscriptionAnalyticsEnvelope'),
    '400': responseRef('Analytics range, plan, page, or horizon is invalid.', 'ApiErrorEnvelope'),
    '401': responseRef('Authentication is required.', 'ApiErrorEnvelope'),
    '403': responseRef('Admin access is required.', 'ApiErrorEnvelope'),
    '500': responseRef('Subscription analytics could not be loaded.', 'ApiErrorEnvelope'),
  },
  'GET /admin/analytics/records': {
    '200': responseRef('Paginated records for a dashboard metric and selected day.', 'AnalyticsRecordsEnvelope'),
    '400': responseRef('Analytics range, kind, day, anchor, or page is invalid.', 'ApiErrorEnvelope'),
    '401': responseRef('Authentication is required.', 'ApiErrorEnvelope'),
    '403': responseRef('Moderator access is required.', 'ApiErrorEnvelope'),
    '500': responseRef('Analytics records could not be loaded.', 'ApiErrorEnvelope'),
  },
  'GET /health': {
    '200': responseRef('Health process status.', 'BasicHealthResponse'),
    '503': responseRef('Health check could not complete.', 'BasicHealthFailure'),
  },
  'GET /health/detailed': {
    '200': responseRef('Detailed process, database, and memory status.', 'DetailedHealthResponse'),
    '503': responseRef('Detailed health reports an unhealthy dependency.', 'DetailedHealthResponse'),
    '500': responseRef('Health-check handler error.', 'ApiErrorEnvelope'),
  },
  'GET /health/ready': {
    '200': responseRef('Database is ready to serve requests.', 'ReadyResponse'),
    '503': responseRef('Database is not ready.', 'NotReadyResponse'),
  },
  'GET /health/live': {
    '200': responseRef('Process is alive.', 'AliveResponse'),
  },
  'GET /user/google': {
    '302': {
      description: 'Redirects the browser to Google OAuth. The Location header is determined by the configured OAuth client.',
      headers: { Location: { description: 'Google authorization URL.', schema: { type: 'string', format: 'uri' } } },
    },
    default: responseRef('OAuth strategy or configuration error.', 'ApiErrorEnvelope'),
  },
  'GET /user/auth/google/callback': {
    '302': {
      description: 'Redirects to the configured frontend. On success, the Location URL contains a temporary single-use exchange code; do not share or persist it.',
      headers: { Location: { description: 'Frontend callback or login URL.', schema: { type: 'string', format: 'uri' } } },
    },
    '401': { description: 'OAuth callback had no authenticated user.', content: { 'text/plain': { schema: { type: 'string' } } } },
  },
  'POST /notifications/broadcast': {
    '200': responseRef('Notification broadcast result.', 'NotificationBroadcastResponse'),
    'default': responseRef('Broadcast failure.', 'SimpleMessageError'),
  },
  'POST /user/auth/google/exchange': {
    '200': responseRef('Exchanged single-use code for an authenticated session.', 'GoogleExchangeResponse'),
    '400': responseRef('Exchange code is invalid, expired, or already consumed.', 'SimpleMessageError'),
  },
  'POST /user/auth/google/native': {
    '200': responseRef('Google native sign-in result.', 'GoogleNativeAuthResponse'),
    '400': responseRef('Invalid token or missing legal consent.', 'GoogleNativeAuthError'),
    '401': responseRef('Google account is not available.', 'SimpleMessageError'),
    '500': responseRef('Google token verification or authentication failed.', 'ApiErrorEnvelope'),
  },
  'GET /permissions/matrix': {
    '200': responseRef('Permission, plan, role, scope, and metadata matrix.', 'PermissionMatrixEnvelope'),
    '500': responseRef('Matrix generation failed.', 'PermissionMatrixErrorEnvelope'),
  },
  'GET /permissions/summary': {
    '200': responseRef('Counts and most/least common plan permissions.', 'PermissionSummaryEnvelope'),
    '500': responseRef('Permission summary generation failed.', 'PermissionMatrixErrorEnvelope'),
  },
  'GET /permissions/visualization': {
    '200': responseRef('Permission group, plan, role, and coverage chart data.', 'PermissionVisualizationEnvelope'),
    '500': responseRef('Visualization data generation failed.', 'PermissionMatrixErrorEnvelope'),
  },
  'GET /permissions/export': {
    '200': {
      description: 'Permission matrix export. The response media type and download filename depend on format.',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/PermissionMatrix' } },
        'text/csv': { schema: { type: 'string' } },
        'text/markdown': { schema: { type: 'string' } },
      },
    },
    '500': responseRef('Permission matrix export failed.', 'PermissionMatrixErrorEnvelope'),
  },
  'GET /permissions/compare/plans': {
    '200': responseRef('Common, unique, and shared permissions for the two plans.', 'PermissionComparisonEnvelope'),
    '400': responseRef('Both plan query parameters are required.', 'PermissionMatrixMessageError'),
    '500': responseRef('Plan comparison failed.', 'PermissionMatrixErrorEnvelope'),
  },
  'GET /permissions/compare/roles': {
    '200': responseRef('Common, unique, and shared permissions for the two roles.', 'PermissionComparisonEnvelope'),
    '400': responseRef('Both role query parameters are required.', 'PermissionMatrixMessageError'),
    '500': responseRef('Role comparison failed.', 'PermissionMatrixErrorEnvelope'),
  },
  'GET /permissions/plan/{slug}': {
    '200': responseRef('Plan details and its permission entries.', 'PlanPermissionDetailsEnvelope'),
    '404': responseRef('The selected plan does not exist.', 'PermissionMatrixMessageError'),
    '500': responseRef('Plan permission lookup failed.', 'PermissionMatrixErrorEnvelope'),
  },
  'GET /permissions/role/{role}': {
    '200': responseRef('Role details and its permission entries.', 'RolePermissionDetailsEnvelope'),
    '404': responseRef('The selected role does not exist.', 'PermissionMatrixMessageError'),
    '500': responseRef('Role permission lookup failed.', 'PermissionMatrixErrorEnvelope'),
  },
};

for (const [fileName, fileMounts] of Object.entries(mounts)) {
  for (const mount of fileMounts) collectFile(fileName, mount);
}

const spec = JSON.parse(JSON.stringify(swagger));
spec.openapi = '3.0.3';
spec.info.title = 'Madar Flow REST API';
spec.info.version = '2.0.0';
spec.info.description =
  'Source-indexed REST API catalog. All operations and access middleware are extracted from the Express route tree. Input coverage is marked per operation. Shared response envelopes and selected direct response payloads are derived from controllers. Dashboard analytics outputs are modeled from their services; envelope-only schemas leave other endpoint data open where its full shape has not been reviewed.';
spec.servers = [
  { url: 'http://localhost:3000/v1', description: 'Local development API (no requests are sent by catalog generation)' },
];
delete spec.security;
spec.paths = spec.paths || {};
spec.components = spec.components || {};
spec.components.schemas = {
  ...(spec.components.schemas || {}),
  ApiSuccessEnvelope: {
    type: 'object',
    required: ['success', 'data', 'message'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      data: { description: 'Endpoint-specific payload; detailed shape is documented per operation when available.' },
      message: { type: 'string' },
    },
    example: { success: true, data: {}, message: 'Success' },
  },
  AnalyticsPeriod: {
    type: 'object',
    required: ['days', 'timezone', 'start', 'endExclusive', 'generatedAt'],
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 366 },
      presetDays: { type: 'integer', enum: [7, 30, 90], nullable: true },
      comparison: { type: 'string', enum: ['previous', 'yearAgo'] },
      timezone: { type: 'string', enum: ['UTC'] },
      start: { type: 'string', format: 'date-time' },
      endExclusive: { type: 'string', format: 'date-time' },
      previousStart: { type: 'string', format: 'date-time' },
      previousEndExclusive: { type: 'string', format: 'date-time' },
      generatedAt: { type: 'string', format: 'date-time' },
    },
  },
  AnalyticsFilters: {
    type: 'object', required: ['plan'],
    properties: {
      plan: { type: 'string', enum: ['free', 'pro', 'premium'], nullable: true },
      type: { type: 'string', enum: ['income', 'outcome'], nullable: true },
    },
  },
  AnalyticsMetricComparison: {
    type: 'object', required: ['current', 'previous', 'changePercent'],
    properties: {
      current: { type: 'number' }, previous: { type: 'number' },
      changePercent: { type: 'number', nullable: true },
    },
  },
  AdminAnalyticsOverview: {
    type: 'object', required: ['period', 'scope', 'filters', 'totalUsers', 'metrics', 'series', 'categories', 'operations'],
    properties: {
      period: { $ref: '#/components/schemas/AnalyticsPeriod' },
      scope: { type: 'string', enum: ['retained-consumer-accounts'] },
      filters: { $ref: '#/components/schemas/AnalyticsFilters' },
      totalUsers: { type: 'integer', minimum: 0 },
      metrics: { type: 'object', required: ['newUsers', 'recordingUsers', 'expenses'], properties: {
        newUsers: { $ref: '#/components/schemas/AnalyticsMetricComparison' },
        recordingUsers: { $ref: '#/components/schemas/AnalyticsMetricComparison' },
        expenses: { $ref: '#/components/schemas/AnalyticsMetricComparison' },
      } },
      series: { type: 'array', items: { type: 'object', required: ['date', 'previousDate', 'current', 'previous'], properties: {
        date: { type: 'string', format: 'date' }, previousDate: { type: 'string', format: 'date' },
        current: { type: 'object', required: ['newUsers', 'expenses', 'recordingUsers'], properties: { newUsers: { type: 'integer', minimum: 0 }, expenses: { type: 'integer', minimum: 0 }, recordingUsers: { type: 'integer', minimum: 0 } } },
        previous: { type: 'object', required: ['newUsers', 'expenses', 'recordingUsers'], properties: { newUsers: { type: 'integer', minimum: 0 }, expenses: { type: 'integer', minimum: 0 }, recordingUsers: { type: 'integer', minimum: 0 } } },
      } } },
      categories: { type: 'array', items: { type: 'object', required: ['title', 'count', 'share'], properties: { title: { type: 'string', nullable: true }, count: { type: 'integer', minimum: 0 }, share: { type: 'number', minimum: 0, maximum: 100 } } } },
      operations: { type: 'object', required: ['openConflicts', 'failedOperations'], properties: {
        openConflicts: { type: 'object', required: ['count', 'affectedUsers', 'oldestAt'], properties: { count: { type: 'integer', minimum: 0 }, affectedUsers: { type: 'integer', minimum: 0 }, oldestAt: { type: 'string', format: 'date-time', nullable: true } } },
        failedOperations: { type: 'object', required: ['count', 'affectedUsers'], properties: { count: { type: 'integer', minimum: 0 }, affectedUsers: { type: 'integer', minimum: 0 } } },
      } },
    },
  },
  AnalyticsFunnel: {
    type: 'object', required: ['period', 'totals', 'stages'],
    properties: {
      period: { $ref: '#/components/schemas/AnalyticsPeriod' },
      totals: { type: 'object', required: ['registered', 'subscribed'], properties: { registered: { type: 'integer', minimum: 0 }, subscribed: { type: 'integer', minimum: 0 } } },
      stages: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'object', required: ['key', 'count', 'share', 'conversion'], properties: {
        key: { type: 'string', enum: ['registered', 'recorded', 'active', 'paying'] }, count: { type: 'integer', minimum: 0 },
        share: { type: 'number', minimum: 0, maximum: 100 }, conversion: { type: 'number', minimum: 0, maximum: 100, nullable: true },
      } } },
    },
  },
  EngagementAnalytics: {
    type: 'object', required: ['period', 'coverage', 'metrics', 'filters', 'series', 'cohorts'],
    properties: {
      period: { $ref: '#/components/schemas/AnalyticsPeriod' },
      coverage: { type: 'object', required: ['firstObservedAt', 'completeFrom', 'observedRecords', 'currentDays', 'previousDays'], properties: {
        firstObservedAt: { type: 'string', format: 'date-time', nullable: true }, completeFrom: { type: 'string', format: 'date-time', nullable: true },
        observedRecords: { type: 'integer', minimum: 0 }, currentDays: { type: 'integer', minimum: 0 }, previousDays: { type: 'integer', minimum: 0 },
      } },
      metrics: { type: 'object', required: ['recordingUsers', 'records'], properties: {
        recordingUsers: { type: 'object', required: ['current', 'previous'], properties: { current: { type: 'integer', minimum: 0, nullable: true }, previous: { type: 'integer', minimum: 0, nullable: true } } },
        records: { type: 'object', required: ['current', 'previous'], properties: { current: { type: 'integer', minimum: 0, nullable: true }, previous: { type: 'integer', minimum: 0, nullable: true } } },
      } },
      filters: { $ref: '#/components/schemas/AnalyticsFilters' },
      series: { type: 'array', items: { type: 'object', required: ['date', 'previousDate', 'current', 'previous'], properties: {
        date: { type: 'string', format: 'date' }, previousDate: { type: 'string', format: 'date' },
        current: { type: 'object', required: ['records', 'users'], properties: { records: { type: 'integer', minimum: 0 }, users: { type: 'integer', minimum: 0 } }, nullable: true },
        previous: { type: 'object', required: ['records', 'users'], properties: { records: { type: 'integer', minimum: 0 }, users: { type: 'integer', minimum: 0 } }, nullable: true },
      } } },
      cohorts: { type: 'array', items: { type: 'object', required: ['date', 'size', 'd1', 'd7', 'd30'], properties: {
        date: { type: 'string', format: 'date' }, size: { type: 'integer', minimum: 0 },
        d1: { $ref: '#/components/schemas/RetentionMetric' }, d7: { $ref: '#/components/schemas/RetentionMetric' }, d30: { $ref: '#/components/schemas/RetentionMetric' },
      } } },
    },
  },
  RetentionMetric: {
    type: 'object', required: ['eligible', 'returned', 'rate'],
    properties: { eligible: { type: 'integer', minimum: 0 }, returned: { type: 'integer', minimum: 0 }, rate: { type: 'number', minimum: 0, maximum: 100, nullable: true } },
  },
  SubscriptionAnalytics: {
    type: 'object', required: ['period', 'horizon', 'filters', 'metrics', 'expiring', 'history'],
    properties: {
      period: { $ref: '#/components/schemas/AnalyticsPeriod' }, horizon: { type: 'integer', enum: [7, 30] },
      filters: { type: 'object', required: ['plan'], properties: { plan: { type: 'string', enum: ['free', 'pro', 'premium'], nullable: true } } },
      metrics: { type: 'object', required: ['retainedAccounts', 'paidTierAssignments', 'unexpiredAssignments', 'expiredAssignments', 'noExpiry', 'disabledAssignments', 'missingHistory', 'mismatchedHistory', 'duplicateCurrentHistory'], properties: {
        retainedAccounts: { type: 'integer', minimum: 0 }, paidTierAssignments: { type: 'integer', minimum: 0 }, unexpiredAssignments: { type: 'integer', minimum: 0 }, expiredAssignments: { type: 'integer', minimum: 0 }, noExpiry: { type: 'integer', minimum: 0 }, disabledAssignments: { type: 'integer', minimum: 0 }, missingHistory: { type: 'integer', minimum: 0 }, mismatchedHistory: { type: 'integer', minimum: 0 }, duplicateCurrentHistory: { type: 'integer', minimum: 0 },
      } },
      expiring: { type: 'object', required: ['rows', 'total', 'page', 'limit', 'until'], properties: {
        rows: { type: 'array', items: { type: 'object', required: ['title', 'email', 'plan', 'planExpiresAt', 'isActive'], properties: { title: { type: 'string' }, email: { type: 'string', format: 'email' }, plan: { type: 'string', enum: ['pro', 'premium'] }, planExpiresAt: { type: 'string', format: 'date-time' }, isActive: { type: 'boolean' } } } },
        total: { type: 'integer', minimum: 0 }, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', enum: [10] }, until: { type: 'string', format: 'date-time' },
      } },
      history: { type: 'array', items: { type: 'object', required: ['date', 'records'], properties: { date: { type: 'string', format: 'date' }, records: { type: 'integer', minimum: 0 } } } },
    },
  },
  AnalyticsRecords: {
    type: 'object', required: ['rows', 'total', 'page', 'limit', 'start', 'endExclusive', 'filters'],
    properties: {
      rows: { type: 'array', items: { type: 'object', required: ['title', 'subtitle', 'createdAt'], properties: {
        title: { type: 'string', nullable: true }, subtitle: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, recordCount: { type: 'integer', minimum: 0 },
      } } },
      total: { type: 'integer', minimum: 0 }, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', enum: [10] },
      start: { type: 'string', format: 'date-time' }, endExclusive: { type: 'string', format: 'date-time' }, filters: { $ref: '#/components/schemas/AnalyticsFilters' },
    },
  },
  AdminAnalyticsOverviewEnvelope: { type: 'object', required: ['success', 'data', 'message'], properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/AdminAnalyticsOverview' }, message: { type: 'string' } } },
  AnalyticsFunnelEnvelope: { type: 'object', required: ['success', 'data', 'message'], properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/AnalyticsFunnel' }, message: { type: 'string' } } },
  EngagementAnalyticsEnvelope: { type: 'object', required: ['success', 'data', 'message'], properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/EngagementAnalytics' }, message: { type: 'string' } } },
  SubscriptionAnalyticsEnvelope: { type: 'object', required: ['success', 'data', 'message'], properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/SubscriptionAnalytics' }, message: { type: 'string' } } },
  AnalyticsRecordsEnvelope: { type: 'object', required: ['success', 'data', 'message'], properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/AnalyticsRecords' }, message: { type: 'string' } } },
  ApiErrorEnvelope: {
    type: 'object',
    required: ['success', 'error'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      error: {
        type: 'object',
        required: ['message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { description: 'Optional structured validation or domain error details.' },
        },
      },
    },
    example: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } },
  },
  SimpleMessageError: {
    type: 'object',
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
    },
  },
  BasicHealthResponse: {
    type: 'object',
    required: ['status', 'timestamp', 'uptime'],
    properties: {
      status: { type: 'string', enum: ['ok'] },
      timestamp: { type: 'string', format: 'date-time' },
      uptime: { type: 'integer', minimum: 0 },
    },
  },
  BasicHealthFailure: {
    type: 'object',
    required: ['status', 'message'],
    properties: { status: { type: 'string', enum: ['error'] }, message: { type: 'string' } },
  },
  HealthCheckResult: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['pass', 'fail', 'warn'] },
      message: { type: 'string' },
      responseTime: { type: 'number', minimum: 0 },
      details: { type: 'object', additionalProperties: true },
    },
  },
  DetailedHealthResponse: {
    type: 'object',
    required: ['status', 'timestamp', 'uptime', 'version', 'environment', 'checks'],
    properties: {
      status: { type: 'string', enum: ['healthy', 'unhealthy', 'degraded'] },
      timestamp: { type: 'string', format: 'date-time' },
      uptime: { type: 'integer', minimum: 0 },
      version: { type: 'string' },
      environment: { type: 'string' },
      checks: { type: 'object', required: ['database', 'memory'], properties: { database: { $ref: '#/components/schemas/HealthCheckResult' }, memory: { $ref: '#/components/schemas/HealthCheckResult' } } },
    },
  },
  ReadyResponse: {
    type: 'object', required: ['status', 'timestamp'],
    properties: { status: { type: 'string', enum: ['ready'] }, timestamp: { type: 'string', format: 'date-time' } },
  },
  NotReadyResponse: {
    type: 'object', required: ['status', 'reason', 'timestamp'],
    properties: { status: { type: 'string', enum: ['not ready'] }, reason: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' } },
  },
  AliveResponse: {
    type: 'object', required: ['status', 'timestamp', 'uptime'],
    properties: { status: { type: 'string', enum: ['alive'] }, timestamp: { type: 'string', format: 'date-time' }, uptime: { type: 'integer', minimum: 0 } },
  },
  NotificationBroadcastResponse: {
    type: 'object', required: ['success', 'message', 'notification'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      message: { type: 'string' },
      notification: {
        type: 'object', required: ['id', 'title', 'message', 'type', 'audience', 'createdAt', 'isRead'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' },
          type: { type: 'string', enum: ['info', 'success', 'warn', 'error'] },
          audience: { type: 'string', enum: ['all', 'admins', 'moderators'] },
          createdAt: { type: 'string', format: 'date-time' }, isRead: { type: 'boolean', enum: [false] },
        },
      },
    },
  },
  GoogleExchangeResponse: {
    type: 'object', required: ['success', 'data', 'message'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      data: { type: 'object', required: ['user', 'tokens'], properties: { user: { $ref: '#/components/schemas/User' }, tokens: { type: 'object', required: ['accessToken', 'refreshToken'], properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' } } } } },
      message: { type: 'string' },
    },
  },
  GoogleNativeAuthResponse: {
    type: 'object', required: ['success', 'data', 'message'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      data: { type: 'object', required: ['user', 'tokens'], properties: { user: { $ref: '#/components/schemas/User' }, tokens: { type: 'object', required: ['accessToken', 'refreshToken'], properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' } } } } },
      message: { type: 'string' },
    },
  },
  GoogleNativeAuthError: {
    oneOf: [{ $ref: '#/components/schemas/SimpleMessageError' }, { $ref: '#/components/schemas/ApiErrorEnvelope' }],
  },
  PermissionMatrixEntry: {
    type: 'object',
    required: ['permission', 'group', 'description', 'plans', 'roles', 'scopes'],
    properties: {
      permission: { type: 'string' },
      group: { type: 'string' },
      description: { type: 'string' },
      plans: { type: 'object', additionalProperties: { type: 'boolean' } },
      roles: { type: 'object', additionalProperties: { type: 'boolean' } },
      scopes: { type: 'array', items: { type: 'string' } },
    },
  },
  PermissionMatrixPlan: {
    type: 'object', required: ['slug', 'name', 'permissions'],
    properties: {
      slug: { type: 'string', enum: ['free', 'pro', 'premium'] },
      name: { type: 'string' },
      permissions: { type: 'array', items: { type: 'string' } },
    },
  },
  PermissionMatrixRole: {
    type: 'object', required: ['role', 'permissions'],
    properties: { role: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } },
  },
  PermissionMatrixScope: {
    type: 'object', required: ['scope', 'permissions'],
    properties: { scope: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } },
  },
  PermissionMatrixMetadata: {
    type: 'object', required: ['totalPermissions', 'totalPlans', 'totalRoles', 'totalScopes', 'generatedAt'],
    properties: {
      totalPermissions: { type: 'integer', minimum: 0 },
      totalPlans: { type: 'integer', minimum: 0 },
      totalRoles: { type: 'integer', minimum: 0 },
      totalScopes: { type: 'integer', minimum: 0 },
      generatedAt: { type: 'string', format: 'date-time' },
    },
  },
  PermissionMatrix: {
    type: 'object', required: ['permissions', 'plans', 'roles', 'scopes', 'metadata'],
    properties: {
      permissions: { type: 'array', items: { $ref: '#/components/schemas/PermissionMatrixEntry' } },
      plans: { type: 'array', items: { $ref: '#/components/schemas/PermissionMatrixPlan' } },
      roles: { type: 'array', items: { $ref: '#/components/schemas/PermissionMatrixRole' } },
      scopes: { type: 'array', items: { $ref: '#/components/schemas/PermissionMatrixScope' } },
      metadata: { $ref: '#/components/schemas/PermissionMatrixMetadata' },
    },
  },
  PermissionMatrixEnvelope: {
    type: 'object', required: ['success', 'data'],
    properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/PermissionMatrix' } },
  },
  PermissionMatrixSummary: {
    type: 'object',
    required: ['totalPermissions', 'totalPlans', 'totalRoles', 'totalScopes', 'permissionsByGroup', 'plans', 'roles', 'mostCommonPermissions', 'leastCommonPermissions', 'generatedAt'],
    properties: {
      totalPermissions: { type: 'integer', minimum: 0 }, totalPlans: { type: 'integer', minimum: 0 },
      totalRoles: { type: 'integer', minimum: 0 }, totalScopes: { type: 'integer', minimum: 0 },
      permissionsByGroup: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      plans: { type: 'array', items: { type: 'object', required: ['slug', 'name', 'permissionCount'], properties: { slug: { type: 'string' }, name: { type: 'string' }, permissionCount: { type: 'integer', minimum: 0 } } } },
      roles: { type: 'array', items: { type: 'object', required: ['role', 'permissionCount'], properties: { role: { type: 'string' }, permissionCount: { type: 'integer', minimum: 0 } } } },
      mostCommonPermissions: { type: 'array', items: { type: 'object', required: ['permission', 'planCount'], properties: { permission: { type: 'string' }, planCount: { type: 'integer', minimum: 0 } } } },
      leastCommonPermissions: { type: 'array', items: { type: 'object', required: ['permission', 'planCount'], properties: { permission: { type: 'string' }, planCount: { type: 'integer', minimum: 0 } } } },
      generatedAt: { type: 'string', format: 'date-time' },
    },
  },
  PermissionSummaryEnvelope: {
    type: 'object', required: ['success', 'data'],
    properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/PermissionMatrixSummary' } },
  },
  PermissionVisualization: {
    type: 'object', required: ['permissionsByGroup', 'permissionsByPlan', 'permissionsByRole', 'coverageMatrix', 'metadata'],
    properties: {
      permissionsByGroup: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      permissionsByPlan: { type: 'array', items: { type: 'object', required: ['plan', 'count', 'permissions'], properties: { plan: { type: 'string' }, count: { type: 'integer', minimum: 0 }, permissions: { type: 'array', items: { type: 'string' } } } } },
      permissionsByRole: { type: 'array', items: { type: 'object', required: ['role', 'count', 'permissions'], properties: { role: { type: 'string' }, count: { type: 'integer', minimum: 0 }, permissions: { type: 'array', items: { type: 'string' } } } } },
      coverageMatrix: { type: 'array', items: { type: 'object', required: ['plan', 'coverage'], properties: { plan: { type: 'string' }, coverage: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 100 } } } } },
      metadata: { $ref: '#/components/schemas/PermissionMatrixMetadata' },
    },
  },
  PermissionVisualizationEnvelope: {
    type: 'object', required: ['success', 'data'],
    properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/PermissionVisualization' } },
  },
  PermissionComparison: {
    type: 'object', required: ['entity1', 'entity2', 'type', 'permissions1', 'permissions2', 'common', 'onlyIn1', 'onlyIn2', 'similarity'],
    properties: {
      entity1: { type: 'string' }, entity2: { type: 'string' }, type: { type: 'string', enum: ['plan', 'role'] },
      permissions1: { type: 'array', items: { type: 'string' } }, permissions2: { type: 'array', items: { type: 'string' } },
      common: { type: 'array', items: { type: 'string' } }, onlyIn1: { type: 'array', items: { type: 'string' } },
      onlyIn2: { type: 'array', items: { type: 'string' } }, similarity: { type: 'number', minimum: 0, maximum: 100 },
    },
  },
  PermissionComparisonEnvelope: {
    type: 'object', required: ['success', 'data'],
    properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/PermissionComparison' } },
  },
  PlanPermissionDetailsEnvelope: {
    type: 'object', required: ['success', 'data'],
    properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['plan', 'permissions', 'count'], properties: { plan: { type: 'object', required: ['slug', 'name'], properties: { slug: { type: 'string' }, name: { type: 'string' } } }, permissions: { type: 'array', items: { $ref: '#/components/schemas/PermissionMatrixEntry' } }, count: { type: 'integer', minimum: 0 } } } },
  },
  RolePermissionDetailsEnvelope: {
    type: 'object', required: ['success', 'data'],
    properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['role', 'permissions', 'count'], properties: { role: { type: 'string' }, permissions: { type: 'array', items: { $ref: '#/components/schemas/PermissionMatrixEntry' } }, count: { type: 'integer', minimum: 0 } } } },
  },
  PermissionMatrixMessageError: {
    type: 'object', required: ['success', 'message'],
    properties: { success: { type: 'boolean', enum: [false] }, message: { type: 'string' } },
  },
  PermissionMatrixErrorEnvelope: {
    type: 'object', required: ['success', 'message', 'error'],
    properties: { success: { type: 'boolean', enum: [false] }, message: { type: 'string' }, error: { type: 'string' } },
  },
};

const verbs = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
let documentedCount = 0;
for (const operation of routeOperations) {
  const pathKey = operation.path;
  const existing = spec.paths[pathKey]?.[operation.method];
  const original = existing || {};
  if (existing?.summary && existing?.requestBody) documentedCount += 1;
  const pathParams = [...pathKey.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string', example: `{{${match[1]}}}` },
  }));
  const existingParams = original.parameters || [];
  const allParams = [
    ...existingParams,
    ...pathParams.filter((parameter) => !existingParams.some((item) => item.in === 'path' && item.name === parameter.name)),
  ];
  const accessLabel =
    operation.access.role ||
    (operation.access.permissions.length ? `Permissions: ${operation.access.permissions.join(', ')}` : '');
  const accessDescription =
    operation.access.auth === 'bearer'
      ? 'Bearer access token required.'
      : operation.access.auth === 'cookie'
        ? 'Authenticated session cookie required.'
        : 'No bearer authentication middleware is attached to this route.';
  const contract = requestContracts[`${operation.method.toUpperCase()} ${pathKey}`];
  const routeKey = `${operation.method.toUpperCase()} ${pathKey}`;
  const requestBody = contract?.body || original.requestBody;
  const customResponses = explicitResponseContracts[routeKey];
  const usesStandardEnvelope =
    standardEnvelopeRouteFiles.has(operation.file) || standardEnvelopeOperations.has(routeKey);
  let responses = original.responses && Object.keys(original.responses).length
    ? { ...original.responses }
    : {};
  let responseCoverage = 'not-yet-documented';
  if (customResponses) {
    responses = { ...responses, ...customResponses };
    responseCoverage = 'source-reviewed';
  } else if (usesStandardEnvelope) {
    let hasSuccess = false;
    for (const [status, response] of Object.entries(responses)) {
      if (/^2\d\d$/.test(status)) {
        hasSuccess = true;
        if (!response.content) {
          responses[status] = responseRef(response.description || 'Successful API response.', 'ApiSuccessEnvelope');
        }
      }
      if (status !== 'default' && /^(4|5)\d\d$/.test(status) && !response.content) {
        responses[status] = responseRef(response.description || 'API error response.', 'ApiErrorEnvelope');
      }
    }
    if (!hasSuccess) {
      const successStatus = createdResponseOperations.has(routeKey) ? '201' : '200';
      responses[successStatus] = responseRef(
        'Successful response uses the shared sendSuccess envelope. The endpoint-specific data payload is not fully modeled.',
        'ApiSuccessEnvelope'
      );
    }
    if (!responses.default) {
      responses.default = responseRef(
        'Errors returned through the shared sendError helper use this envelope.',
        'ApiErrorEnvelope'
      );
    }
    responseCoverage = 'shared-envelope';
  }
  if (!Object.keys(responses).length) {
    responses = {
      default: {
        description: 'Endpoint-specific success and error response schemas are not yet documented.',
      },
    };
  }
  const reviewedQuery = (queryContracts[`${operation.method.toUpperCase()} ${pathKey}`] || []).length > 0;
  const coverage = requestBody || reviewedQuery ? 'source-reviewed-input-schema' : 'route-and-access-only';
  const sourceDetails = [
    `Source route: ${operation.file}`,
    accessDescription,
    accessLabel ? `Required access: ${accessLabel}.` : '',
    operation.routeNotes.length ? `Route notes: ${operation.routeNotes.join(' · ')}.` : '',
    contract?.note || '',
    coverage === 'route-and-access-only'
      ? 'Request and response schemas are not fully described in the current API spec. This operation is cataloged from its route and middleware; confirm the controller/validator contract before sending a mutation.'
      : '',
  ].filter(Boolean).join('\n\n');
  const detail = [original.description, sourceDetails].filter(Boolean).join('\n\n');
  const operationObject = {
    ...original,
    operationId: original.operationId || `${operation.method}_${operation.file.replace(/\.route\.ts$|\.routes\.ts$/g, '').replace(/[^a-zA-Z0-9]+/g, '_')}_${pathKey.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'root'}`,
    tags: original.tags || [operation.tag],
    summary: original.summary || operation.summary,
    description: detail,
    parameters: [
      ...allParams,
      ...(queryContracts[`${operation.method.toUpperCase()} ${pathKey}`] || []).map((parameter) => ({
        in: 'query',
        ...parameter,
      })).filter((parameter) => !allParams.some((item) => item.in === parameter.in && item.name === parameter.name)),
    ].length
      ? [
          ...allParams,
          ...(queryContracts[`${operation.method.toUpperCase()} ${pathKey}`] || []).map((parameter) => ({ in: 'query', ...parameter }))
            .filter((parameter) => !allParams.some((item) => item.in === parameter.in && item.name === parameter.name)),
        ]
      : undefined,
    requestBody,
    security:
      operation.access.auth === 'bearer'
        ? [{ bearerAuth: [] }]
        : operation.access.auth === 'cookie'
          ? [{ cookieAuth: [] }]
          : [],
    responses,
    'x-contract-completeness': coverage,
    'x-required-access': accessLabel || (operation.access.auth === 'public' ? 'Public route' : 'Authenticated user'),
    'x-source-route': operation.file,
    ...(operation.hasBody ? { 'x-request-body-contract': contract?.body ? 'source-reviewed' : original.requestBody ? 'swagger-annotated' : 'not-yet-documented' } : {}),
    ...(reviewedQuery ? { 'x-query-contract': 'source-reviewed' } : {}),
    'x-response-contract-completeness': responseCoverage,
    ...(contract?.note ? { 'x-side-effect-note': contract.note } : {}),
  };
  if (!spec.paths[pathKey]) spec.paths[pathKey] = {};
  spec.paths[pathKey][operation.method] = operationObject;
  if (pathKey === '/health' || pathKey.startsWith('/health/')) {
    operationObject.servers = [
      { url: 'http://localhost:3000/v1' },
      { url: 'http://localhost:3000' },
    ];
  }
}

for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
  for (const key of Object.keys(pathItem)) {
    if (verbs.includes(key) && !pathItem[key].security) pathItem[key].security = [];
  }
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'openapi.json'), JSON.stringify(spec, null, 2) + '\n');
const endpointCount = Object.values(spec.paths).reduce(
  (sum, pathItem) => sum + Object.keys(pathItem).filter((verb) => verbs.includes(verb)).length,
  0
);
console.log(JSON.stringify({
  routeCount: routeOperations.length,
  openApiPaths: Object.keys(spec.paths).length,
  openApiOperations: endpointCount,
  operationsWithRequestBodySchemas: routeOperations.filter((operation) =>
    Boolean(requestContracts[`${operation.method.toUpperCase()} ${operation.path}`]?.body || spec.paths[operation.path]?.[operation.method]?.requestBody)
  ).length,
  operationsWithSourceReviewedInputContracts: Object.values(spec.paths).flatMap((item) => Object.values(item))
    .filter((operation) => operation['x-contract-completeness'] === 'source-reviewed-input-schema').length,
  operationsWithExistingSwaggerSchemas: documentedCount,
  operationsWithSourceReviewedResponseContracts: Object.values(spec.paths).flatMap((item) => Object.values(item))
    .filter((operation) => ['source-reviewed', 'shared-envelope'].includes(operation['x-response-contract-completeness'])).length,
  output: 'postman/openapi.json',
}, null, 2));

