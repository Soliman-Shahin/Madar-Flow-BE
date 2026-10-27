# Dashboard analytics, phase 1

Implemented locally on `feat/dashboard-analytics` in Backend and Admin, 2026-10-27. Local commits are used for review. No push, merge, deployment, remote database change, or provider configuration change was performed.

## Product and composition

The overview supports an operator deciding whether usage is growing and which sync conditions need review. It retains the approved blue Modern Financial OS identity, existing shell, roles, notification connection, plan access and system-health navigation.

Three compositions were considered: extending the operational journal; a uniform KPI/card grid; and a temporal workspace with selectable numerical columns and a supporting operational rail. The temporal workspace was selected because a period comparison is now the main task. Value Spine transfers through aligned figures and explicit context; the old journal composition does not prescribe the new layout.

The dominant region contains a shared 7/30/90-day selector, three selectable metrics, a daily comparison plot, exact day inspection, an accessible data table, and paginated underlying records. The supporting rail separates present sync state from historical period metrics. Category-name counts and assigned plans are secondary. Tonal surfaces, the existing Inter/IBM Plex Sans Arabic families, tabular figures, logical CSS properties, restrained blue and semantic warning/success colors preserve the product identity. The chart remains chronologically left to right in either language. Narrow layouts move operational context below analysis.

The chart, record dialog and operational context are scoped OnPush components. Geometry and locale formatters are cached. The dashboard styles now fit the existing per-component warning budget without increasing that budget. No packages were installed or upgraded.

## Definitions

- Scope: existing consumer accounts (`role: user`, `_isDeleted != true`), including disabled accounts. Staff, deleted accounts, orphaned records and deleted financial records are excluded. Historical results reflect retained data and can change after deletion or delayed sync.
- Financial records: documents in the existing `Expense` collection. They include income and expenses, so the UI uses **financial records**, not an implied sum of spending.
- Date basis: the stored `createdAt`, not the transaction's entered `date`. Existing sync creation can preserve a client-supplied creation timestamp. These metrics therefore do **not** establish server receipt time, app opens, sessions, DAU/MAU, activation or retention.
- Period: the last 7, 30 or 90 **complete UTC days**, ending at today's UTC midnight, with an immediately preceding equal comparison window. Today is excluded. UTC is explicit in controls, dates and the record dialog.
- New accounts: retained consumer accounts with a creation timestamp in the period.
- Recording users: distinct owners of retained financial records created in the period. Do not sum daily unique-user counts to obtain a period total.
- Financial-record count: retained financial records created in the period.
- Change: `(current - previous) / previous * 100`, rounded to one decimal. A zero previous value yields `null`, including 0 vs 0, and is displayed as no baseline.
- Unresolved conflicts: all `SyncConflict` records with absent/null `resolvedAt` for retained consumers. `ConflictResolution` is history and is not an open-conflict source.
- Operations in error: all retained consumers' `SyncOperation` documents currently marked `error`. This includes historical attempts; it is not a failure rate or a count of distinct unresolved business incidents. Affected accounts are distinct within each metric. Counts are not limited to a preview page.
- Category distribution: retained financial-record count grouped by the category's current title; matching names are combined. Missing category references have an explicit unavailable label. The top five may not sum to 100%. No historical category-name snapshot is implied.
- Plans: current assigned slugs for the same retained-consumer scope, including disabled accounts. An assignment does not prove payment or an active subscription; plan counts are independent of the selected time range.
- No monetary totals or revenue: existing records lack an independent historical currency snapshot. This phase does not add a payment ledger or infer revenue from plan assignments.

## API

Both new GET routes live under `/v1/admin`, behind the existing session-bound `verifyAccessToken` and `requireModerator` middleware. The standard success/error envelope is unchanged; Admin's existing `ApiService` unwraps `data`.

`GET /v1/admin/analytics?days=30`

- `days` is one of `7`, `30`, `90`, default `30`. Duplicate/structured/unknown query parameters are rejected with 400 `INVALID_ANALYTICS_QUERY`.
- Returns `period` (days, UTC, start, endExclusive, previousStart, generatedAt), `scope`, `totalUsers`, period `metrics`, zero-filled daily `series`, top `categories`, and the independent current `operations` snapshot.
- Each period metric contains current/previous values and nullable changePercent. Each series entry pairs current/previous dates and the three counts at matching ordinal positions.

`GET /v1/admin/analytics/records?kind=expenses&days=30&asOf=2026-10-27&page=1`

- `kind`: `expenses`, `recordingUsers`, or `newUsers`. Optional `day`: valid `YYYY-MM-DD` inside the selected period. Optional `asOf`: valid UTC end-exclusive date no later than today's UTC midnight. The Admin passes the overview's end-exclusive date to preserve the window across midnight.
- `page`: integer 1–9999, default 1; fixed limit 10. Returns whitelisted rows, total, page, limit, start and endExclusive. A recording-user row includes its record count and latest stored record creation timestamp. Account rows never return passwords or sessions.
- Shared scope predicates ensure drill-down totals reconcile with overview metrics at a stable database state. Separate requests are not an immutable snapshot; the UI explains changes after loading.
- Unknown/malformed/out-of-period filters return 400; ordinary consumers return 403; absent/invalid sessions return 401. Query objects are not passed directly to MongoDB.

Existing `/admin/stats` retains its real four-field payload; unused fabricated trends/chart fields were removed after checking Admin/Mobile callers. Existing `/admin/plans/distribution` retains its payload shape and now filters to retained consumer accounts. No consumer API caller was changed.

## Query support

Schema indexes were added for `Expense(createdAt, _isDeleted)`, `User(role, createdAt)`, `SyncOperation(status, user)` and `SyncConflict(resolvedAt, detectedAt)`. They are source declarations only; no remote index operation was run. Verify normal index creation when the reviewed Backend is eventually deployed. Distinct counts group by owner instead of building unbounded owner-ID arrays. Category IDs are grouped before title lookup. Owner lookups project only identity fields needed by the protected record view.

## Verification

- Backend and Admin builds pass. Admin retains unrelated existing initial-bundle and other-screen stylesheet warnings; the new dashboard components have no stylesheet budget warning.
- Ten focused Backend tests pass with real disposable MongoDB: UTC boundaries/empty periods, zero baselines, retained scopes, distinct users, category counts, pagination and projection, complete conflict counts, invalid dates, cross-midnight anchors, plan scope and authenticated HTTP/query boundaries.
- The full Backend run returned **268/269 tests passing**. `sync receipt contract / concurrent stale reclaim has one dispatch winner and no extra attempt` observed attemptCount 4 instead of 3 once. Its full 13-test suite passed on a focused rerun. An untouched HEAD snapshot also passed that suite and three isolated repetitions. The concurrency failure is intermittent and was not fixed or hidden by changing sync behavior.
- Rendered browser matrix: English/Arabic × light/dark × 1440/1024/390px (12 combinations), plus Arabic narrow loading, empty, failed, partial-health and restricted-permission states (5). No horizontal page overflow, unresolved analytics translation keys or uncaught page errors were observed.
- Additional interactions passed: failed refresh retains explicitly stale data; rapid period changes keep the newest result; drill-down preserves days/asOf; Escape closes and restores focus; record retry recovers; language changes update OnPush content; localized dialog close works; Arabic record details reflow at 390px.
- Browser evidence uses isolated synthetic API fixtures, blocked real API/socket traffic and a fresh browser context. Backend tests use actual local aggregation and authorization. No deployed integration or real account data was used. Review screenshots and machine-readable browser reports were kept outside repositories in the workspace's `.tmp/dashboard-review/` directory.
- Windows sandboxing prevented local WiredTiger operations and browser loopback access; these checks ran outside that sandbox against local disposable fixtures. Existing Mongoose duplicate-index/deprecation and cache-timer warnings remain unrelated.

## Rendered visual acceptance

Verdict: **PASS for this implementation**, following refinement of small-screen chart labels, slider weight, heading specificity and dialog visibility handling. This is an agent review of rendered evidence, not a new human Golden Reference approval.

| Criterion | Score / 5 | Rendered evidence |
| --- | --- | --- |
| Product identity | 4 | Existing blue/slate identity and navigation remain coherent with the analytical field. |
| First-three-second hierarchy | 4 | A 22.4px desktop heading, aligned metric figures and the dominant timeline precede operational detail. |
| Typography | 4 | Existing Arabic/Latin families, tabular figures and enlarged narrow-screen axis labels preserve hierarchy. |
| Composition | 4 | One temporal surface and a supporting rail; the rail reflows below analysis at intermediate widths. |
| Data and numerical hierarchy | 5 | Selected/current/previous values, exact paired dates and count-based category shares are explicit. |
| Financial character | 4 | Financial-record counts remain distinct from money and revenue; definitions explain historical limitations. |
| Surface sophistication | 4 | Tonal separation distinguishes analytical, operational and supporting areas without uniform card repetition. |
| Color discipline | 4 | Blue identifies interaction; warning identifies sync attention; success is confined to known healthy state. |
| Information density | 4 | Secondary explanations remain subordinate; full methodology and daily tables are disclosed on demand. |
| Interaction clarity | 4 | Metric selection, exact day inspection, paginated records, retry, Escape and focus restoration were exercised. |
| Dark mode | 4 | The final Arabic dark preview retains distinct surface levels and legible figures/lines. |
| Light mode | 4 | The light preview uses white analytical space on a quieter canvas with the same hierarchy. |
| RTL quality | 4 | Arabic entry and supporting rail reverse deliberately; chronological charts remain LTR and mixed values are isolated. |
| Responsive resilience | 4 | 1440/1024/390px views and the Arabic narrow record dialog reflow without horizontal page overflow. |
| Generic-AI resistance | 4 | Task-driven metric selection and a temporal field replace decorative metrics, fabricated trends and repeated card containers. |

Average: **4.07/5**. No material issue remained in the rendered matrix. Separate final checks confirmed modal background scroll lock, focus trapping, localized close labels, reduced-motion dialog configuration and exact selected-day announcements. Backend regression limitations remain reported above and are not converted into a blanket test-suite pass.

## Boundaries for later phases

Activation, retention/cohorts, app sessions and conversion funnels require a separately defined event contract and offline-aware collection. Revenue requires verified payments and lifecycle data. Historical monetary aggregation requires trustworthy per-record currency semantics. Those are not fabricated from these counts and are not part of phase 1.

Merge/deploy Backend and Admin as a coordinated feature: publish the reviewed Backend endpoint before a frontend that depends on it. The implementation is kept on the feature branch for review before merging.
