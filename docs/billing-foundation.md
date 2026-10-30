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

Provider code (for example a Google Play notification handler) must:

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

## Not included yet

- The provider adapter and webhook route (needs the provider's verification keys).
- Server-side purchase-token verification and restore-purchases.
- A grace period / account-hold state.
