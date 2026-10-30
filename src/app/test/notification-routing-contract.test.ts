import fs from 'fs';
import path from 'path';

describe('notification routing contract', () => {
  // Normalize line endings so the multi-line assertions also hold on Windows
  // checkouts where git converts LF to CRLF (core.autocrlf).
  const routeSource = fs
    .readFileSync(
      path.join(process.cwd(), 'src/app/routes/notification.route.ts'),
      'utf8'
    )
    .replace(/\r\n/g, '\n');

  it('registers the static list route before the dynamic detail route', () => {
    expect(routeSource.indexOf("router.get('/list'")).toBeGreaterThan(-1);
    expect(routeSource.indexOf("router.get('/list'")).toBeLessThan(
      routeSource.indexOf("'/:notificationId'")
    );
  });

  it('validates dynamic notification IDs before controller lookup', () => {
    expect(routeSource).toContain('Invalid notification ID');
    expect(routeSource).toContain('notificationId))');
  });

  it('keeps mark-all-read as an authenticated static route', () => {
    expect(routeSource).toContain(
      "router.patch('/all/read', verifyAccessToken"
    );
    expect(routeSource).toContain('markAllNotificationsRead');
  });

  it('keeps preference reads and writes owner-authenticated and strictly validated', () => {
    expect(routeSource).toContain(
      "router.get('/preferences', verifyAccessToken, getNotificationPreferences)"
    );
    expect(routeSource).toContain("router.patch(\n  '/preferences',\n  verifyAccessToken");
    expect(routeSource).toContain('validateRequestWithZod(notificationPreferencePatchSchema)');
    expect(routeSource).toContain('updateNotificationPreferences');
  });
});
