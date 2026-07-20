# AGENT-CALL-WINDOW-001 — shared outbound-agent call-window guard

**Date:** 2026-07-19
**Status:** Implemented; owner-approved architecture
**Scope:** Outbound Lead Caller and Outbound Parts Caller

## Problem

The two outbound robots used different schedule sources. The lead caller used
company Dispatch settings while the parts finish-visit caller used the first
Telephony user group's inbound routing hours. A retry could also be initialized
through a different path from the first attempt. This made outbound behavior
inconsistent and coupled the parts robot to an inbound-only table.

Production also contained duplicate `user_group_hours` rows for every weekday:
canonical short names (`Mon`…`Sun`) and stale full names
(`Monday`…`Sunday`) with conflicting hours.

## Owner decisions

1. Each marketplace robot owns its own nullable schedule override. `NULL` means
   **Same as company settings**.
2. One backend guard owns schedule resolution for all outbound robots.
3. Off-time attempts are carried to the nearest allowed start. They are never
   dropped and never dialed through.
4. A schedule deferral does **not** consume an attempt. Retry/backoff semantics
   remain robot-specific.
5. Resolver failure is conservative: 08:00–18:00 Monday–Friday in
   `America/New_York`; the dial path never receives the exception.
6. Canonical inbound weekday storage is the short set `Mon`…`Sun`.
7. The parts robot is a dedicated marketplace app:
   `outbound-parts-caller`.

## No-op inbound migration decision

Keeping short weekdays is the only behavior-preserving cleanup:

- Active Telephony UI writer:
  `frontend/src/pages/telephony/UserGroupsPage.tsx` constructs its seven rows as
  `Mon`…`Sun`.
- Active API writers:
  `backend/src/routes/userGroups.js` auto-provision, create, and update paths
  write short names. They now also normalize a defensively supplied full name.
- Inbound reader:
  `backend/src/services/groupRouting.js` formats the current weekday with
  `weekday: 'short'`. Before migration, the short row therefore determined live
  inbound behavior.
- The only full-name UI fixture found is the inactive mock
  `ScheduleDetailPage`; it is not the Telephony hours writer.

Migration 189 deletes **only** `Monday`…`Sunday`, retains every short row and its
values, and adds a short-name CHECK. Thus the configured live schedule remains
open weekends 07:00–17:00 and Thursday until 21:00 where those are the short-row
values. Whether those hours express owner intent is a post-deploy UI decision,
not a migration inference.

During rolling deploys, the reader accepts both forms but orders canonical
short rows first. The API response normalizes/deduplicates them for the UI. This
preserves the same winner before, during, and after cleanup.

## Architecture

### Shared guard

`backend/src/services/agentCallWindowService.js` exposes:

```js
nextAllowedAt(companyId, agentKey, now)
```

It returns the same `Date` object when the instant is allowed, otherwise the
nearest later window start. The resolver:

1. Loads the selected agent's company-scoped settings row.
2. Loads company Dispatch settings for days, hours, and timezone.
3. Uses a complete custom override when selected; otherwise sanitizes the
   company schedule with the former lead-caller semantics.
4. Calculates local weekdays and boundaries with `Intl.DateTimeFormat`, including
   timezone/DST conversion and weekend wrap.
5. On any unknown agent, query error, corrupt override, or resolver exception,
   uses the conservative sanitized fallback. It never throws into dialing.

Supported keys:

| Agent key | Settings source |
|---|---|
| `outbound-lead-caller` | `outbound_lead_call_settings` |
| `outbound-parts-caller` | `outbound_call_settings` |

A deferral emits exactly one PII-free decision line:

```text
[callWindow] deferred agent=<key> until=<ISO timestamp>
```

No company, contact, phone, lead, job, or attempt identifier is logged.

### Dial initialization coverage

| Robot | Initialization seam | Guard behavior |
|---|---|---|
| Lead | `onLeadCreated` first enqueue | Initial `scheduled_at` is guarded |
| Lead | `processLeadAttempt` claim | Same row returns to `pending` when deferred |
| Lead | `scheduleLeadRetryOrExhaust` | Lead ladder runs first; result is guarded |
| Parts | `startRobotCall` first enqueue | Initial `scheduled_at` is guarded |
| Parts | `outboundCallWorker.processAttempt` claim | Same row returns to `pending` when deferred |
| Parts | Worker placement-failure retry | Parts ladder runs first; result is guarded |
| Parts | VAPI end-report retry | Parts ladder runs first; result is guarded |

The guard is checked again at claim time even if a row was scheduled earlier,
so a schedule change made while a call is queued takes effect before dialing.

### Attempt-count decision

`attempt_no` continues to count real entries in a retry chain:

- Initial enqueue remains `attempt_no = 1` even when its `scheduled_at` moves.
- Claim-time off-hours carry updates the same row to `pending`; it does not insert
  a new row and does not update `attempt_no`.
- Once an actual placement/result fails, the existing robot-specific retry logic
  marks that attempt terminal and inserts `attempt_no + 1`.
- Applying the guard to that retry's proposed time does not create another rung.

The lead cadence remains immediate/+30m/+2h. The parts cadence remains
immediate/+2h/next-business-morning. Group hours no longer participate in either
outbound robot and remain inbound-routing-only.

## Persistence and APIs

Migration `189_agent_call_windows.sql` adds to both settings tables:

- `calling_window_mode TEXT NULL`
- `custom_start_time TEXT NULL`
- `custom_end_time TEXT NULL`
- `calling_window_work_days JSONB NULL`

`NULL` mode and fields are the canonical inherited state. `custom` requires a
same-day HH:MM range and a nonempty subset of weekday numbers 0–6. Existing lead
`office_hours` rows become `NULL`; existing lead custom windows receive all seven
days because that was their prior meaning. Legacy lead `always` rows remain
readable and writable for behavior preservation but are not offered by the new
UI. The parts table supports only inherit/custom.

Lead settings remain under `/api/outbound-lead-caller/settings`. Parts schedule
settings use the standard connected-app surface:

```text
GET /api/marketplace/apps/outbound-parts-caller/settings
PUT /api/marketplace/apps/outbound-parts-caller/settings
```

The parts handler persists only window columns, leaving its retry settings
untouched, and writes the standard PII-free `settings_updated` marketplace event.

## Marketplace and UI

Migration `190_seed_outbound_parts_caller_marketplace_app.sql` publishes the
dedicated `outbound-parts-caller` app in the `ai` category, which places it in
the settings-aligned **Communication and AI** catalog. It includes both required
description layers:

- user-facing short and long descriptions;
- `metadata.assistant` with `what_it_does`, `prerequisites`, `setup_steps`,
  `outcome`, `recommend_when`, and `gotchas`.

Its `metadata.setup_path` points to
`/settings/integrations/outbound-parts-caller`. The seed is replayed by
`ensureMarketplaceSchema` after the lead caller seed. Connecting the app exposes
its settings; no new credential is provisioned and no top-level Settings group
is added.

Both app pages reuse `AgentCallWindowFields`, copied from the Rely settings
inherit/custom prior art:

- **Same as company settings** / **Custom schedule** radio pair;
- floating-label time fields;
- checkbox weekday grid;
- canonical Settings section/card rhythm.

## Tenancy & Roles

| Surface/read | Company source and SQL scope | Required role/authority | Foreign behavior |
|---|---|---|---|
| Lead settings GET/PUT | `req.companyFilter.company_id`; every settings, leads, attempts, and install query has `company_id = $1` | `tenant.integrations.manage` via existing mount | Middleware deny; no foreign read/write |
| Parts marketplace settings GET/PUT | `req.companyFilter.company_id`; installation lookup and settings upsert both receive that company | `tenant.integrations.manage` via existing marketplace mount | Foreign/uninstalled app is 404; unchanged |
| Lead worker/guard | `company_id` from the claimed attempt/event payload already resolved by company-scoped producer | Worker system authority | No request/body-selected company |
| Parts worker/guard | `company_id` from claimed attempt/job; job reload remains company-scoped | Worker system authority | No request/body-selected company |
| Telephony hours writers | `req.companyFilter.company_id`; group ownership checked before child-row replacement | `tenant.telephony.manage` | Foreign group is 404 and unchanged |
| Inbound hours reader | Group resolved from tenant-owned inbound DID/flow; migration changes no group ownership | Inbound system authority | Existing routing isolation unchanged |

Settings rows are keyed by `company_id`. No natural identifier is used without
company scope. No PII is added to logs or marketplace event payloads.

## Migrations and rollback

- `189_agent_call_windows.sql`: settings columns/constraints plus weekday
  cleanup/check. Idempotent double-apply.
- `rollback_189_agent_call_windows.sql`: removes new schema and constraints and
  restores the former lead mode shape. It intentionally does not reconstruct
  conflicting stale full-name hours; their values cannot be safely inferred.
- `190_seed_outbound_parts_caller_marketplace_app.sql`: idempotent app upsert.
- `rollback_190_seed_outbound_parts_caller_marketplace_app.sql`: removes the app
  after the operational rollback removes its RESTRICT-linked installation rows.

The migration number was rechecked against both the worktree and
`origin/master` immediately before creation: 188 was the maximum; 189 was free.

## Named sabotage minimum

| Invariant | Minimum detector that must turn red if removed |
|---|---|
| Inherit resolves company days/hours/tz | `SAB-CW-INHERIT` |
| Agent override wins | `SAB-CW-OVERRIDE` |
| Weekend wraps to nearest next start | `SAB-CW-WEEKEND` |
| Timezone/DST is wall-clock-correct | `SAB-CW-TZ` |
| Resolver never fails open/throws | `SAB-CW-FAIL-CLOSED` |
| Deferral log contains no tenant/PII | `SAB-CW-PII-LOG` |
| Lead claim defers same attempt/no dial | `SAB-CW-LEAD-DEFER` |
| Lead first attempt is guarded | `SAB-CW-LEAD-INIT` |
| Parts claim defers same attempt/no dial | `SAB-CW-PARTS-DEFER` |
| Parts first attempt is guarded | `SAB-CW-PARTS-INIT` |
| Short weekday behavior does not flip | `SAB-CW-INBOUND-NO-FLIP` |
| Migration double-apply keeps short values | `SAB-CW-MIGRATION-NO-FLIP` |
| Parts settings stay tenant-scoped | `SAB-CW-PARTS-TENANT`, `SAB-CW-PARTS-API-TENANT` |
| UI uses shared inherit/custom canon | `SAB-CW-UI-PATTERN` |

## Verification

Run from the worktree root using the main repository Jest binary:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules \
  ../../../node_modules/jest/bin/jest.js \
  --config ./package.json --testPathIgnorePatterns /node_modules/ \
  --runInBand --forceExit --runTestsByPath \
  tests/agentCallWindowService.test.js \
  tests/outboundCallSettingsService.test.js \
  tests/outboundLeadCallSettings.test.js \
  tests/outboundLeadCallRoutes.test.js \
  tests/outboundLeadCallWindow.test.js \
  tests/outboundLeadCallEligibility.test.js \
  tests/outboundLeadCallWorker.test.js \
  tests/outboundLeadCallWebhook.test.js \
  tests/partsCallService.test.js \
  tests/outboundCallWorker.test.js \
  tests/vapiCallStatusWebhook.test.js \
  tests/services/groupRouting.test.js \
  tests/agentCallWindowMigration.test.js
```

The real-PostgreSQL migration gate is run separately so its prerequisite,
double-apply, inbound regression, CHECK rejection, and double-rollback are
reported independently:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules \
  ../../../node_modules/jest/bin/jest.js \
  --config ./package.json --testPathIgnorePatterns /node_modules/ \
  --runInBand --forceExit --runTestsByPath \
  tests/agentCallWindowMigration.db.test.js
```

```bash
cd frontend && npm run build
cd frontend && npm test
```

Final results on 2026-07-19:

- backend feature gate: 13 suites, 314 tests passed;
- real-PostgreSQL migration gate: 1 suite, 1 test passed;
- marketplace regression gate: 7 suites, 88 tests passed;
- frontend Vitest: 41 files, 233 tests passed;
- frontend production build: passed (3,529 modules transformed; existing chunk
  warnings only);
- changed-backend `node --check`: passed;
- `git diff --check`: passed.

Jest required `--forceExit` because the existing test bootstrap retained an
open handle after completed suites; no watcher or server was left running.

## Risks and deployment notes

1. Apply migration 189 before deploying code that selects the new columns.
2. Apply/replay seed 190 before expecting the parts app tile/settings page.
3. The weekday cleanup deliberately exposes the already-effective inbound
   schedule in the UI. Owner should review weekends and Thursday after deploy
   and edit them there if business intent differs.
4. A conservative fallback can delay calls if schedule storage is unavailable;
   that is the chosen safe failure posture.
5. No VAPI assistant prompt/tool change is required by this feature.
