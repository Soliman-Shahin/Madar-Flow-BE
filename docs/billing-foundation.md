# Billing foundation

The app launches free. Plans exist (Free, Pro, Premium) and gate features such as
data export, but no payment provider is connected yet. This document describes
what is in place and what a future provider integration must do.

## Today

- **Self-service upgrades are closed.** `POST /v1/plans/upgrade` grants a paid
  plan with no payment check, so it returns `403 UPGRADE_NOT_AVAILABLE` unless
  `ALLOW_SELF_SERVICE_UPGRADE=true` (exact string). Use that only for local
  development or staging. Never set it in production.
- `GET /v1/plans/me` includes `upgradeAvailable` (boolean) so the app can hide
  the upgrade button instead of failing on tap.
- Plans are still assigned by an admin (Admin dashboard) — that path is unchanged.

## When a payment provider is added

Provider code (such as the RevenueCat webhook) must:

1. **Authenticate** the incoming request itself (signature / Pub/Sub token).
   Nothing in this repository accepts unauthenticated billing traffic.
2. Normalize the notification into a `BillingEvent` and call
   `billingService.applyEvent(event)`.

`BillingService` guarantees:

| Concern | Behaviour |
| --- | --- |
| Replays | `(provider, eventId)` is unique; a repeat returns `{ applied:false, reason:'duplicate' }` |
| Out-of-order delivery | an event older than one already processed for the user returns `reason:'stale'` |
| `purchased` / `renewed` | sets `user.plan` + `planExpiresAt`; one active subscription, extended on renewal |
| `cancelled` | access continues until the paid period ends |
| `expired` / `refunded` | downgrades to Free immediately |
| Admin grants | provider events never touch a plan the provider did not create (`reason:'not_managed'`) |
| Failures | if applying throws, the event record is removed so the provider's retry can succeed |

The permission cache is invalidated after every applied event.

## Google Play via RevenueCat

Android purchases use Google Play Billing through RevenueCat. The app buys with
the RevenueCat SDK; RevenueCat calls this API and `BillingService` records it.

### Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/billing/revenuecat/webhook` | `Authorization` header equals `REVENUECAT_WEBHOOK_AUTH` (constant-time compare) | Purchase lifecycle events |
| `POST /v1/billing/sync` | signed-in user, 10 requests / 15 min | "Restore purchases": re-checks RevenueCat; only ever grants |
| `POST /v1/admin/billing/test-event` | super admin, `BILLING_TEST_MODE=true`, never in production | Rehearse the lifecycle without a store |

Set the webhook header value in RevenueCat as `Bearer <long random secret>`.
The `Bearer` form is required: it lets the request pass the global CSRF guard
without adding any exemption. With no secret configured the webhook returns 503.

### Event mapping

| RevenueCat | Billing event |
| --- | --- |
| `INITIAL_PURCHASE`, `PRODUCT_CHANGE` (uses `new_product_id`) | `purchased` |
| `RENEWAL`, `UNCANCELLATION`, `SUBSCRIPTION_EXTENDED`, `REFUND_REVERSED` | `renewed` |
| `CANCELLATION` (any reason except `CUSTOMER_SUPPORT`) | `cancelled` (access until period end) |
| `CANCELLATION` with `cancel_reason=CUSTOMER_SUPPORT` (refund) | `refunded` |
| `EXPIRATION` | `expired` |
| `TEST`, `BILLING_ISSUE`, `TRANSFER`, `SUBSCRIPTION_PAUSED`, others | acknowledged, no effect |

Unknown products, unknown/anonymous `app_user_id` values and renewals whose
period already ended are acknowledged (HTTP 200) and ignored so RevenueCat does
not retry them. A processing failure returns 5xx so RevenueCat retries.

### Catalog (managed in the Admin dashboard)

Each plan has `productIds` (store subscription ids that grant it, for example
`pro_monthly`, `pro_yearly`; a Play id with a base-plan suffix such as
`pro_monthly:monthly` matches on the part before `:`) and `prices`
(reference price per currency, used on the web and as a fallback). A product id
can belong to only one plan. **The price a store charges is set in Play Console
(and App Store Connect), not here**; the app shows the store's own price.

### Configuration

| Variable | Meaning |
| --- | --- |
| `REVENUECAT_WEBHOOK_AUTH` | Header value RevenueCat sends (`Bearer ...`) |
| `REVENUECAT_SECRET_API_KEY` | Server key for `/billing/sync` |
| `REVENUECAT_ANDROID_PUBLIC_KEY` | Public SDK key, returned to the app by `GET /plans/me` (`billing.androidPublicKey`) |
| `REVENUECAT_ACCEPT_SANDBOX` | `true` accepts license-tester purchases in production (closed testing) |
| `BILLING_TEST_MODE` | `true` enables the admin test-event endpoint (ignored in production) |

`upgradeAvailable` becomes true when the webhook secret **and** the Android
public key are both set (or the staging-only self-service flag is on).
Sandbox purchases are always accepted outside production; in production they
are ignored unless `REVENUECAT_ACCEPT_SANDBOX=true`.

## Not included yet

- iOS (App Store) and web products. The mapping is store-agnostic, so adding
  them is a catalog entry plus RevenueCat configuration.
- A grace period / account-hold state (`BILLING_ISSUE` is acknowledged only).
- Revoking access from `/billing/sync` (by design only webhooks end access).
