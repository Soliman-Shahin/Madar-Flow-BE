# Analytics explorer — filters, recording return and subscriptions

Local implementation, 2026-10-29, on `feat/analytics-explorer` in Admin and Backend. Phase 1 was committed as Admin `c9a6d43` / Backend `91ac776` and subsequently merged by the owner. The completed analytics work is committed locally on the feature branches; no push, merge, deployment or remote configuration change was performed.

## Behavior

- Record type and current assigned plan are applied on the server to financial-record counts, distinct recording users, category breakdowns and their paginated drill-downs. The complete UTC period and previous-period comparison remain unchanged.
- New-account counts and retained-account inventory use the period/current-plan scope; financial-record type does not filter account creation. The UI states this explicitly.
- Plan selection represents the user's **current** assigned plan, including when viewing earlier activity. Category type is its current income/expense classification. Neither filter reconstructs historical entitlements/classification.
- Sync attention, health, assigned-plan distribution and the owner's security-event panel remain global snapshots. An analytical filter must not hide operational signals.
- Filters are stored in the dashboard URL alongside existing period/metric/day behavior. Back/forward restores the selection. Changing a segment closes stale drill-downs and removes their day parameter. Requests use cancellation and one fetch per selection; existing automatic refresh and keyboard shortcuts are retained.
- Empty filtered segments have a no-matches explanation distinct from an empty system or failed request. A failed refresh retains its explicitly stale snapshot and disables analytical export.

## API and access

`GET /v1/admin/analytics` and `/v1/admin/analytics/records` accept optional `plan=free|pro|premium` and `type=income|outcome`. Both return the applied `filters`. Plan validation now follows the actual `PlanSlug` enum rather than accepting unsupported catalog identifiers.

The existing Admin role requirement on plan filtering is retained. A Moderator can query record types but receives 403 when querying a plan, including on drill-down. UI controls also require the existing plan permission and minimum Admin role. Unfiltered analytics still use the existing Moderator boundary. No authorization controls were weakened.

## Exports

The new **daily data** CSV contains every day in the chosen 7/30/90-day window, not merely the visible page of a record list. Each row contains paired UTC dates, exact selected/previous metric counts, the selected metric, plan/type labels, timezone and snapshot timestamp. Account-count exports mark record type as inapplicable. Daily distinct-user rows must not be summed to reconstruct the period's distinct-user total.

CSV is generated from the successfully loaded, currently authorized selected metric; no extra API calls or private raw rows are fetched. Labels and filenames distinguish this export from the owner's **current record page** CSV. Both downloads use a shared spreadsheet-safe cell encoder (formula-prefix neutralization, quote escaping), UTF-8 BOM and delayed object-URL cleanup. The existing record-page export remains a page export.

## Verification

- Admin and Backend builds pass with the existing unrelated bundle/other-screen stylesheet warnings. The new controls fit the current component stylesheet budget.
- 13 focused Backend tests pass. Added cases reconcile plan+type metrics, categories and drill-down totals, verify orphaned-category behavior under type filtering, keep global sync signals visible, test empty segments, reject malformed/unsupported filters and enforce plan-filter access for both endpoints.
- Eight rendered combinations pass: English/Arabic × light/dark × 1440/390px. No page overflow, unresolved analytics translation keys or uncaught page errors were observed. The controls retain the established blue identity, numerical hierarchy and narrow-layout priority; rendered review passes for this bounded extension.
- Browser checks verify three total overview requests for initial load plus two filter changes, exact 30-row paired-date CSV downloads with segment labels/UTC/BOM, filter propagation to record drill-down, browser back/forward, reset, no-matches state and inapplicable record type on account exports.
- A separate encoder check covers formula prefixes (including leading whitespace/control characters), embedded quotes, exact numeric values and paired dates.
- Browser evidence uses synthetic API fixtures and blocks real API/socket traffic. Tests use disposable local MongoDB. Deployed integration remains unverified. Evidence is kept outside repositories under `.tmp/dashboard-review/phase2-*`.

## Scope preservation

The owner's uncommitted audit-log module, dashboard auto-refresh/URL/keyboard support, metric definitions, daily-movement highlights, record-page export, system-health work and other changes were preserved. This phase adds segment controls and a full-period daily export around those changes. The additional phases below provide recording-return and subscription lifecycle analysis; monetary revenue still requires verified payment evidence.

## Recording and return — phase 3

The Admin route `/dashboard/analytics/engagement` uses `GET /v1/admin/analytics/engagement?days=7|30|90` (default 30, authenticated Moderator+). Unknown, duplicate, structured and unsupported query values return 400. Success uses the standard `{ success: true, data, message }` envelope. No Mobile changes or app-open/session tracking are included.

The critical activity is **creation of a financial record observed by the server**. New `Expense.save()` creations (including sync) receive an immutable internal `_serverRecordedAt`, overwriting a supplied client value. Existing records are not backfilled when edited. Known creation paths were traced through expense service and sync service. Ordinary queries, object/JSON serialization, sync pull and the consumer's type-filtered aggregation omit this field. No existing consumer response shape is expanded. Date-first and owner-first observation indexes support the daily and cohort queries; no migration or historical timestamp inference occurs.

The response contains:

- `period`: `days`, `start`, `endExclusive`, `timezone: UTC`, `generatedAt`.
- `coverage`: nullable `firstObservedAt` and `completeFrom`, `observedRecords` across retained records, and `currentDays` / `previousDays` within the selected paired periods.
- `metrics.recordingUsers` and `metrics.records`: `{current, previous}`, each number or null. Users are distinct across the entire covered portion, not a sum of daily users. No growth percentage compares unequal coverage.
- `series`: exactly `days` rows of `{date, previousDate, current, previous}`. Each side is `{users, records}` or null.
- `cohorts`: signup-day rows `{date, size, d1, d7, d30}`, where each return cell is `{eligible, returned, rate}` and `rate` is a percentage or null.

Coverage is conservatively inferred from the earliest retained server observation, beginning at the next UTC midnight. The first partial day and earlier days are **unknown/null**, including when no observations exist. Covered days with no retained records are 0. The current partial UTC day is excluded. This does not reconstruct deployment history or periods when a version without observation support was running. Deletions can move the inferred coverage boundary and restate historical counts; coverage is not a permanent telemetry ledger.

Signup day is D0; D1/D7/D30 return means at least one observed record on that exact UTC calendar day. Only signup cohorts inside the selected period and on fully covered days are included. A cell becomes eligible only after its entire target day ends. Multiple records count once; an immature cell is null, never 0%. A 7/30-day signup window will naturally have no mature D30 cells; choose 90 days to view older cohorts. Retained consumer accounts include disabled accounts and exclude staff/deleted/orphaned owners. Deleted financial records are excluded. Offline records uploaded later count when first stored on the server, not when the user entered them locally.

## Subscription lifecycle — phase 4

The Admin route `/dashboard/analytics/subscriptions` uses `GET /v1/admin/analytics/subscriptions?days=7|30|90&horizon=7|30&page=1` (defaults 30/7/1, authenticated Admin+). Moderator receives 403. Page accepts positive integer strings up to 9999. Unknown or malformed inputs return 400. No entitlement, renewal, billing, audit or permission rules are changed.

The response contains the same `period`, `horizon`, `metrics`, `expiring` and `history`:

- Current profile `user.plan` / `planExpiresAt` is the source for **assignments**, not subscription entitlements or payments. `paidTierAssignments` counts Pro/Premium profiles, not paying customers. `retainedAccounts` includes Free; other assignment counts concern Pro/Premium only.
- `expiredAssignments`: expiry is less than or equal to the request timestamp. `unexpiredAssignments`: the remaining assigned profiles, including `noExpiry` (null/missing expiry). These two counts partition `paidTierAssignments`. `disabledAssignments` is an included subset, not an extra total.
- `expiring`: `{rows,total,page,limit:10,until}` selects a future expiry strictly after now through the inclusive rolling 7/30-day horizon. Stable ordering uses expiry then account ID. Rows expose only account ID, display title/email, assigned tier, expiry and enabled state. User-detail links retain the existing user permission boundary.
- `missingHistory`: assigned Pro/Premium accounts with no subscription records at all. `mismatchedHistory`: the latest **currently valid** active/trial record references a different or missing plan than the account assignment. Future/cancelled/expired records do not hide a current discrepancy. `duplicateCurrentHistory`: accounts with more than one current valid active/trial history. Start must be at/before now; end and trial-end bounds are exclusive. These are review flags and never auto-correct records.
- `history`: exactly `days` `{date,records}` rows, zero filled by subscription `startDate` over complete UTC days. Includes manual/free/cancelled records if their start is in the window, excludes staff/deleted/orphan owners. This is neither purchases nor renewals, conversion, churn, money, MRR or ARR. A start-date index supports this query.

Changing the history period changes historical starts, not live assignment totals. The horizon controls upcoming expirations. The two insight pages preserve the selected period in navigation/query state, distinguish failed loads from empty data, retain explicitly stale snapshots after refresh failures, cancel superseded requests and reset pagination after scope changes. A failed pagination request restores the displayed snapshot's page; a page lost after live data changes is clamped and refetched.

## Final local acceptance — 2026-10-29

- Final Admin and Backend builds pass. Admin required a retry with public Google Fonts network access after sandbox font DNS failed. Existing unrelated bundle and other-screen stylesheet warnings remain; the added components fit stylesheet budgets.
- All **23 focused analytics tests** pass: 13 overview/filter tests plus 10 recording/subscription contract tests. Cases include server-time override/immutability/no legacy backfill/hidden payloads, real sync CREATE retry and pull, sparse coverage/null versus zero, deduplicated users, exact UTC D1/D7/D30 maturity, disabled/deleted/staff scopes, expiry boundaries, missing expiry, current versus future subscription histories, stable pagination and HTTP role/query validation.
- The broader regression run passed **284/285 tests** (34/35 suites) before the final added sync-observation assertion. The existing `sync-receipt-contract` concurrent stale-reclaim assertion again returned attemptCount 4 instead of 3, including on a focused rerun. This is the same previously documented failure; its implementation/test is untouched. Final focused analytics checks remain green. Existing timer/Mongoose warnings remain outside this task.
- Insight UI matrix: English/Arabic × light/dark × 1440/390px for both routes, plus empty/no-observation, initial error and loading states. Browser fixtures are synthetic, real API/socket traffic is blocked. Checks cover no viewport overflow, resolved translations, directional layout, period request count, daily tables, immature cohorts, pagination/horizon reset, stale snapshots and Moderator navigation/route boundaries. CSV/filter/history phase-2 evidence remains separate.
- Rendered review found and corrected RTL return-count ambiguity, a missing breadcrumb translation, and the expiry selector's accessible label. Native controls/tables/scroll regions retain keyboard access and reduced-motion behavior. Blue quantitative heat cells always include readable rates and numerator/denominator text; color is not the sole encoding.
- Visual critic verdict: **PASS for this extension**, not a new Golden Reference. Scores out of 5: identity 4, first-view hierarchy 4, typography 4, composition 4, numerical hierarchy 4, financial character 4, surfaces 4, color discipline 4, density 4, interaction clarity 4, dark 4, light 4, RTL 4, responsive 4, generic-AI resistance 4. Visible evidence: shared blue/tonal grammar, one numerical spine, textual cohort matrix, chronological expiry rows, readable narrow stacks and equally composed theme/direction variants.
- Evidence/scripts remain outside repositories under `.tmp/dashboard-review/insights-*` and `phase2-*`. No deployment, production data test, remote service mutation, push or merge was performed for these new phases. Real deployed integration and future accumulated observation data remain unverified.

## Custom periods and shared comparison context — phase 5

The overview, engagement and subscription endpoints accept one of two mutually exclusive period shapes:

- `days=7|30|90` for a preset window.
- `start=YYYY-MM-DD&end=YYYY-MM-DD` for an inclusive custom UTC-date window.

`compare=previous|yearAgo` is optional and defaults to `previous`. Custom ranges contain 1–366 complete UTC days, cannot include the current/future UTC day and reject invalid calendar dates. `previous` uses the immediately adjacent same-length range. `yearAgo` uses the same number of days ending exactly one UTC calendar year before the selected range's exclusive end. Responses expose `days`, nullable `presetDays`, `comparison`, `start`, `endExclusive`, `previousStart` and `previousEndExclusive`; the two compared ranges therefore always contain the same number of days.

Supplying `days` together with `start`/`end`, supplying only one custom bound, unknown query keys or unsupported comparison values returns 400. Records drill-down accepts the same period shape. The existing preset `asOf` snapshot anchor remains supported; custom ranges are resolved from their explicit bounds.

The shared URL state preserves the period, comparison and applicable segment filters across Overview, Recording & return and Subscriptions. Overview and engagement support current assigned `plan=free|pro|premium` and current category `type=income|outcome`. Subscriptions supports current assigned plan only and rejects `type`; the Admin client deliberately omits type from that request. Snapshot metrics remain explicitly separate from historical-period metrics where documented.

The Admin period workbench validates ranges before requesting the API, reports complete-UTC-day semantics, prevents duplicate requests on apply and keeps browser back/forward/shareable URLs deterministic. Rendered verification covers English/Arabic, light/dark and 1440/390px with no viewport overflow; a cross-page browser check verifies period/filter propagation and confirms invalid ranges never reach the API.
