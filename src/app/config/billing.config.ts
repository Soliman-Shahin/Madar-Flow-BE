/**
 * Billing switches.
 *
 * Self-service upgrades grant a paid plan with no payment verification, so they
 * are OFF unless explicitly enabled (local development / staging testing).
 * Production stays closed until a real payment provider is wired in; until then
 * plans are assigned by an admin (Admin dashboard) or by verified billing events
 * (see BillingService).
 */
export function selfServiceUpgradeEnabled(): boolean {
  return process.env.ALLOW_SELF_SERVICE_UPGRADE === 'true';
}

/**
 * The exact value RevenueCat sends in the `Authorization` header of each
 * webhook request (configured in the RevenueCat dashboard). Use the form
 * `Bearer <long random secret>`. Unset means the webhook is closed.
 */
export function revenueCatWebhookAuth(): string | null {
  const value = process.env.REVENUECAT_WEBHOOK_AUTH?.trim();
  return value ? value : null;
}

/** RevenueCat secret API key (server only) used to re-check a subscriber. */
export function revenueCatSecretKey(): string | null {
  const value = process.env.REVENUECAT_SECRET_API_KEY?.trim();
  return value ? value : null;
}

/** RevenueCat public SDK key for Android. Public by design; the app needs it. */
export function revenueCatAndroidPublicKey(): string | null {
  const value = process.env.REVENUECAT_ANDROID_PUBLIC_KEY?.trim();
  return value ? value : null;
}

/** True when in-app purchases can really be completed and recorded. */
export function storePurchasesAvailable(): boolean {
  return Boolean(revenueCatWebhookAuth() && revenueCatAndroidPublicKey());
}

/**
 * Sandbox purchases (Google Play license testers) are free test purchases.
 * They are accepted outside production, and in production only when
 * REVENUECAT_ACCEPT_SANDBOX=true (for example during closed testing).
 */
export function acceptSandboxPurchases(): boolean {
  return (
    process.env.NODE_ENV !== 'production' ||
    process.env.REVENUECAT_ACCEPT_SANDBOX === 'true'
  );
}

/**
 * Admin "test event" endpoint: lets a super admin simulate the purchase
 * lifecycle without a store. Never available in production.
 */
export function billingTestModeEnabled(): boolean {
  return (
    process.env.BILLING_TEST_MODE === 'true' &&
    process.env.NODE_ENV !== 'production'
  );
}
