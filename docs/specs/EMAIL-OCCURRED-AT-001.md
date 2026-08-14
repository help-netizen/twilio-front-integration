# EMAIL-OCCURRED-AT-001 — canonical email event time and company-time display

Status: implementation draft, not deployed. The team lead owns final wording.

## Problem and decision

An outbound Gmail message can carry a `Date`/`internalDate` whose wall-clock digits
come from Boston while the device labels them `+0500`. The provider timestamp is
then nine hours early even though polling observes the message within seconds.
Ingestion delay is not the signal to repair; the discrepancy between provider time
and the live observation is.

`email_messages.occurred_at TIMESTAMPTZ NOT NULL` is the one stored absolute event
instant used for ordering, pagination, aggregates, thread caches, projections, and
display. `gmail_internal_at` remains unchanged as raw provider evidence. No third
timestamp convention is permitted.

Migration number 261 was verified against `origin/master` on 2026-08-14; 260 is
the highest occupied migration there.

## Ingestion contract

`importGmailThread` receives an explicit ingestion mode and one observation instant
for the whole fetched thread.

| path | direction / condition | stored `occurred_at` |
|---|---|---|
| live polling / incremental hydration | inbound | `gmail_internal_at ?? observedAt` |
| live polling / incremental hydration | outbound and `abs(observedAt - gmail_internal_at) <= 10 minutes` | `gmail_internal_at` |
| live polling / incremental hydration | outbound and discrepancy `> 10 minutes` | `observedAt` |
| live polling / incremental hydration | outbound, provider time absent | `observedAt` |
| initial lookback / history-gap backfill (`runInitialBackfill`, therefore `backfillNormalized`) | every message | `gmail_internal_at` |

The backfill branch intentionally does not substitute import time: importing an old
mailbox at today's `now()` would corrupt its history. Gmail full-message resources
are expected to provide `internalDate`; absence on the backfill path fails the new
NOT NULL contract instead of silently inventing a second fallback.

`upsertMessage` inserts `occurred_at` on first observation and does not overwrite it
on provider-id conflict. After a thread hydration, the visible-message cache is
refreshed from stored `occurred_at`; a later full-thread rewalk therefore cannot
re-observe an already stored old outbound message as new.

## Migration 261

Existing rows are backfilled in this exact CASE order:

1. `gmail_internal_at IS NULL` → `created_at`.
2. inbound with provider time → `gmail_internal_at`.
3. outbound with `created_at - gmail_internal_at <= 10 minutes` → `gmail_internal_at`.
4. outbound with lag `> 10 minutes AND <= 24 hours` → `created_at`.
5. outbound with lag `> 24 hours` → `gmail_internal_at`.

The column is added as `TIMESTAMPTZ NOT NULL DEFAULT now()` before the branch
backfill. The default deliberately remains permanently: production migrations run
before the new application container starts, so the old five-minute poller can
continue inserting rows without `occurred_at` during that deployment window. For
that live old-code path, observation-time `now()` is the correct safe value; the
new initial-backfill path always supplies provider time explicitly. Because the
default initially populates old rows, the migration's CASE updates all existing
rows rather than filtering on `occurred_at IS NULL`.

The migration creates the symmetric indexes
`idx_email_messages_thread_occurred`, `idx_email_messages_contact_occurred`, and
`idx_email_messages_timeline_occurred`, and recomputes
`email_threads.last_message_at = MAX(visible email_messages.occurred_at)` with both
thread and company predicates. The UPDATE is guarded by a company-scoped
`WHERE EXISTS`: a thread with no visible messages keeps its prior cache byte for
byte. The rollback has the same guard. `unread_count` is not written.

### Local-copy post-migration counters

The available `albusto_prodcopy` was an older 10,328-row local snapshot and lacked
the already-shipped prerequisite migration 260. The first 261 attempt failed
atomically on the missing `is_draft_artifact` column and left no `occurred_at`
column. After applying local 260 and then 261, the exact counters were:

| branch | rows |
|---|---:|
| `gmail_internal_at IS NULL` → `created_at` | 0 |
| inbound → provider time | 9,658 |
| outbound `<= 10 minutes` → provider time | 153 |
| outbound `> 10 minutes AND <= 24 hours` → `created_at` | 442 |
| outbound `> 24 hours` → provider time | 75 |
| total | 10,328 |

Post-checks: `occurred_at` nullable = `NO`; null values = 0; all three indexes
exist; thread-cache mismatches against visible `MAX(occurred_at)` = 0. These are
local-snapshot figures, not a replacement for the production measurements in the
task brief. Nothing was run against production.

## Consumers moved to the canonical column

- Email workspace thread messages, timeline contact/timeline reads, reverse-page
  cursors and tuple ordering, unlinked inbound/outbound scans, newest-thread lookup,
  and Yelp conversation history.
- `email_threads.last_message_at` migration recompute, live hydration refresh, and
  `markDraftArtifact`/unmark cache refresh. The old outbound-created-at CASE is
  removed.
- Unified timeline email aggregate, Inspector recent communications, reply-read
  newer-inbound guard, Mail Secretary ordering and activation gate.
- Pulse/shared email projection (`sent_at`), Yelp transcript and quote attribution,
  verification/backfill scripts.
- Raw `gmail_internal_at` selections remain only where provider evidence/logging or
  threading diagnostics still need the raw value; no ordering or event-time
  projection derives from it.

The protected push service `emailTimelineService.js` and its DRAFT guard were not
modified.

## Company-time display

`frontend/src/lib/companyTime.ts` is the single display formatter. Its hook reads
the existing `company.timezone` from `AuthProvider`, the same source previously
used by `PulseTimeline.tsx` and `EmailListItem.tsx`. Empty timezone values resolve
to `America/New_York`. Date-only `YYYY-MM-DD` values are materialized at company
noon so they do not shift to the preceding day.

Every previously unzoned native date/time locale call found under `frontend/src`
now uses the helper or carries an existing explicit `timeZone`. Text, field order,
and layout are unchanged. Super-admin rows that represent another company format
with that row's company timezone; the moderation query therefore adds
`company_timezone` to its existing company join.

`companyTimeRatchet.test.ts` scans non-test TypeScript/TSX sources. It rejects every
new unzoned `toLocaleDateString`/`toLocaleTimeString` and every unledgered unzoned
`toLocaleString`. The exact exception ledger contains only known number/currency
formatters.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| Gmail poll / incremental hydration | explicit worker `companyId` plus company-resolved `mailboxId` | provider thread/message id paired with `company_id`; cache refresh repeats company+mailbox+thread | N/A — internal worker | connected-company worker ✓; direct CRM role invocation ✗ | provider natural ids are not tenant-unique; removing company/mailbox predicates could overwrite or aggregate a foreign tenant |
| Initial/history-gap backfill | explicit `companyId` and resolved mailbox | same company-paired provider ids | N/A — internal worker | connected-company worker ✓; direct CRM role invocation ✗ | applying live `now()` here would corrupt all imported history; cross-tenant keys remain company-paired |
| `GET /api/email/threads*` | mount-level `authenticate, requireCompanyAccess`; `req.companyFilter?.company_id` | company + thread id | `messages.view_internal` | existing allow matrix ✓; every role lacking permission ✗ | thread-id access repeats `AND company_id`; foreign id returns 404 |
| Pulse timeline email pages / unified aggregate | mount-level tenant middleware; route `companyFilter`; query `company_id` | company + contact/timeline id | `pulse.view` | existing Pulse allow matrix ✓; every deny cell ✗ | a missing aggregate predicate could blend tenants; every email leg retains `company_id = $1` |
| Inspector / Mail Secretary / reply-read internal reads | caller-supplied company from authenticated or worker context | company + contact/timeline/message id | existing feature permissions unchanged | no new allow cell; existing R-matrices unchanged | every changed SQL query retains its existing company predicate |
| migration thread-cache recompute | row-owned `email_threads.company_id` repeated in correlated message query | company + globally identified thread | N/A — schema migration | migration operator ✓; API roles ✗ | missing company correlation could aggregate a forged cross-tenant thread relation; explicit predicate prevents it |
| company-time frontend projection | authenticated `AuthProvider.company.timezone`; target-company timezone on platform rows | current or row company | no new permission | anyone already allowed to view the row ✓; otherwise ✗ | display only; no data fetch or write authority added |

No new HTTP route or permission is introduced. The real-PostgreSQL suite covers
T-own, T-foreign, T-blast, strict foreign-row snapshot equality, and unchanged
`unread_count`. Existing route R-matrix tests remain the authority for HTTP denies.

## MCP parity

No readable ChatGPT connector email projection changes: `chatgptMcpReadService.js`
does not return email messages or their time; `getContactHistory` returns only
domain events, jobs, and leads. If email is exposed later, its contract must use
`occurred_at`.

## Verification

### Migration number

```bash
git ls-tree -r --name-only origin/master backend/db/migrations | sed -n 's#.*\/\([0-9][0-9][0-9]\)_.*#\1#p' | sort -n | tail -5
```

Result: `256 257 258 259 260`; new number = 261.

### Canonical-time unit and sibling suites

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/services/emailSyncService.test.js tests/emailTimelineSentAt.test.js tests/emailHtmlRenderPlumbing.test.js tests/emailTimelineItem.test.js tests/emailTimelineInbound.test.js tests/emailTimelineOutbound.test.js tests/mailAgentService.test.js tests/yelpConvoHistory.test.js tests/yelpReplyFormat.test.js tests/yelpConvoAgentLoop.test.js tests/yelpLeadHandler.test.js tests/yelpAgentSendLink.test.js tests/pulseTimelinePageRoute.test.js tests/marketplaceRatingsService.test.js tests/platformAppReviews.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
```

Result: 15 suites / 279 tests passed.

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/yelpSendsBackfill.dry.test.js tests/emailDraftPrune.test.js tests/pulseReadEmail.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
```

Result: 3 suites / 18 tests passed.

### Real PostgreSQL contract

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/emailOccurredAt.db.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
```

Result: 1 suite / 6 tests passed. It proves all five migration branches, the
permanent NOT NULL `now()` default for an old-code insert, byte-identical cache
preservation for a draft-only thread through both forward migration and rollback,
reply strictly later than its `in_reply_to_header` parent, chronological thread
reads, cache refresh from `occurred_at`, unchanged `unread_count`, and
T-own/T-foreign/T-blast isolation.

### Company-time formatter and ratchet

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npx vitest --run src/lib/companyTime.test.ts src/lib/companyTimeRatchet.test.ts
```

Result: 2 files / 5 tests passed. The same instant renders identically with the
process/browser timezone set to UTC+5 and America/New_York; date-only values and
the empty-timezone fallback are covered; the source ratchet is green.

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

Result: passed (`tsc -b` and Vite production build); only the repository's existing
CSS import/chunk-size/dynamic-import warnings were emitted.

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm test
```

Result: 81 files passed / 5 failed; 471 tests passed / 7 failed. The failures are
pre-existing current-branch contract/ratchet drift in `settingsNav`,
`settingsRouteCompleteness`, `typeScale`, `ScheduleHeaderContract`, and
`IntegrationsPage`; none asserts company time or a file behavior changed by this
feature. They were not weakened or repaired under this task. The team lead
independently restored `frontend/src` from an `origin/master` tar backup and
confirmed the same five files and seven tests fail with this feature diff absent.

### Additional local-DB sibling sweep

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/emailOccurredAt.db.test.js tests/emailDraftPrune.db.test.js tests/pulseReadEmail.db.test.js tests/contactMergeLossless.db.test.js tests/marketplaceRatings.db.test.js tests/yelpSendsBackfill.db.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
```

Result: feature suites `emailOccurredAt` 4/4 and `emailDraftPrune` passed;
`pulseReadEmail` passed by its explicit SKIPPED-NEEDS-DB path. Three unrelated
local-schema/fixture prerequisites failed: default Yelp company absent,
contact-FK inventory has four newer attribution tables, and ratings expects two
constraints absent from this local schema. No adjacent schema/test was changed.

### Named sabotage controls

1. **S-OCCURRED-LIVE-SKEW:** changed the `> 10 minutes` live outbound branch from
   `observedAt` to `gmail_internal_at`. Running the focused sync command below gave
   1 failed / 21 passed: the nine-hour-skew test received `06:40:27Z` instead of
   `15:40:33Z` and failed before the reply-order assertion. Restored the branch;
   22/22 passed.

   ```bash
   unset NODE_USE_SYSTEM_CA
   DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/services/emailSyncService.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
   ```

2. **S-COMPANY-TIMEZONE:** removed `timeZone: resolvedTimeZone` from the shared
   `Intl.DateTimeFormat`. The formatter suite failed 2/3: the UTC+5 browser rendered
   `Aug 14, 9:20 PM` while the company browser rendered `Aug 14, 12:20 PM`, and the
   New York fallback rendered `4:20 PM` rather than `12:20 PM`. Restored the option;
   the formatter plus ratchet command returned 5/5.

   ```bash
   cd frontend && env -u NODE_USE_SYSTEM_CA npx vitest --run src/lib/companyTime.test.ts
   ```

3. **S-DRAFT-ONLY-CACHE:** removed the forward migration's company-scoped
   `WHERE EXISTS` visible-message guard. The real-PostgreSQL suite failed exactly
   the draft-only preservation test: expected the prior
   `2026-08-14 11:40:33.123456-04` bytes, received `NULL`; 5/6 tests still passed.
   Restored the guard and reran the exact real-PostgreSQL command above: 6/6 passed.

## Risks and rollout

- Migration 261 depends on 260 because the thread-cache recompute excludes
  `is_draft_artifact`; deploy in numeric order. The local-copy atomic failure proved
  this prerequisite fails loudly rather than partially applying.
- The permanent `DEFAULT now()` is required for the migration-before-container
  deployment window. Removing it reintroduces NOT NULL failures in the old poller.
- Forward and rollback cache rebuilds intentionally leave draft-only threads
  unchanged; they have no visible message from which a replacement time can be
  derived.
- The live ten-minute rule deliberately trusts observation for any large absolute
  discrepancy, including a provider timestamp far in the future. It does not mutate
  the raw provider value.
- The initial-backfill NOT NULL contract assumes Gmail full resources always carry
  `internalDate`. This is preferable to substituting import time and silently
  corrupting historical order.
- Migration updates and cache recomputation touch every email row/thread. Production
  rollout should inspect lock/runtime on the actual row count and verify branch
  counts and cache mismatch count immediately afterward.
- `albusto_prodcopy` was intentionally advanced through local 260 and 261 for this
  verification; production remains untouched.
