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
