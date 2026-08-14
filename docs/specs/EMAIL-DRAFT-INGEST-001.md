# EMAIL-DRAFT-INGEST-001 — Gmail draft autosaves must not become sent email

**Status:** Draft for team-lead review  
**Date:** 2026-08-14  
**Scope:** Backend polling, reversible historical classification, tests, and documentation. No frontend.

## Problem and confirmed diagnosis

Gmail `threads.get(format:'full')` returns `DRAFT` messages inside an otherwise eligible thread. The polling importer previously treated the mailbox address in `From` as sufficient evidence of an outbound send, persisted every autosave under its changing `provider_message_id`, and let those rows reach timelines. The observed progressively longer bodies are draft autosaves, not duplicate sends. This diagnosis is accepted and is not reopened here.

## Goals

1. Prevent a Gmail `DRAFT` from reaching persistence or thread aggregates through either polling backfill path.
2. Classify historical outbound rows by Gmail message existence: 404 is a candidate; 200 is retained; every other error is fail-closed.
3. Keep remediation reversible: mark rows with a boolean flag and exclude them from read projections. Never physically delete a message.
4. Provide a tenant-scoped, rate-limited CLI that defaults to dry-run and supports a bounded rollout.
5. Refresh the historical thread's cached last-message display fields when an artifact mark changes which message is newest.

## Non-goals

- No change to `emailTimelineService.js` or its existing push-path `DRAFT` guard.
- No change to frontend rendering or quote/body fallback code.
- No physical-delete mode, SQL, or preparation for one.
- No API route, permission, scheduler, or automatic production execution of the prune CLI.

## T1 — polling guard

`emailSyncService` applies two layers:

- Both lookback `gmail.users.threads.list` calls use `q: "after:<epoch> -in:draft"` to avoid draft-only search results.
- `importGmailThread` filters `labelIds.includes('DRAFT')` immediately after `threads.get`, before parsing participants, unread, attachments, last-message fields, message count, thread upsert, or message upsert.
- `backfillNormalized` repeats the per-message label check before normalization because `threads.get` can still return a draft inside a non-draft thread.
- `pullChangesNormalized` repeats the same check after each history-path `messages.get`, before normalization and before returning messages to the downstream timeline projection.

The message-level filter is authoritative; the Gmail search query is only an optimization.

## T2 — reversible historical classifier and CLI

Migration 260 adds:

```sql
email_messages.is_draft_artifact boolean NOT NULL DEFAULT false
```

The migration also adds a partial candidate-scan index over `(company_id, mailbox_id, id)` for unmarked outbound rows. The rollback drops the index and column. No existing row is marked by migration.

Run the classifier:

```bash
# default: read-only dry run, first 100 eligible outbound rows
node backend/src/cli/pruneIngestedEmailDrafts.js --company-id <uuid>

# bounded canary
node backend/src/cli/pruneIngestedEmailDrafts.js --company-id <uuid> --limit 25 --dry-run

# reversible flag application
node backend/src/cli/pruneIngestedEmailDrafts.js --company-id <uuid> --limit 25 --apply
```

`--company-id` is mandatory. V1 allows one Gmail mailbox per company; the CLI resolves that mailbox by the company, requires it to be connected, and every candidate/update query repeats both `company_id` and `mailbox_id`. Candidate order is ascending local message id, and `--limit` accepts 1–100000 (large enough for the stated 18,000-row mailbox while still rejecting accidental unbounded values).

For each row, the service calls `gmail.users.messages.get({userId:'me', id, format:'minimal'})`:

| Gmail result | Classification | Dry-run | Apply |
|---|---|---|---|
| 200 | exists / real send | report retained | no write |
| 404 | missing / draft artifact | report candidate | set `is_draft_artifact=true` |
| network/auth/other error | error, fail-closed | report error | no write |
| 429/5xx or Gmail rate-limit 403 | retryable | exponential backoff, then one of the outcomes above | same |

Requests are sequential with 100 ms pacing. Retryable calls get at most four attempts with 250/500/1000 ms backoff. For every `missing` candidate, including dry-run, the CLI logs `row_id`, `provider_message_id`, `gmail_internal_at`, and `length(body_text)`; it never selects or logs the body itself. `exists` and error rows do not get a candidate detail line. Already-marked rows leave the candidate set, so repeated `--apply` runs are idempotent.

Mark and unmark use the same company+mailbox-scoped transaction. After changing the flag, the transaction locks the owning thread and copies `last_message_at`, `last_message_direction`, `last_message_preview`, and `last_message_from` from the newest row in that thread where `is_draft_artifact=false`. If no visible row remains, all cached thread fields stay unchanged. `unread_count` is intentionally never touched: `email_messages` has no per-message unread value; a draft artifact is always outbound, while this counter represents inbound unread state.

## Read projection changes

Marked rows are excluded from:

- thread message lists and draft-only thread eligibility/search legs;
- inbound/outbound polling queues;
- contact and contactless timeline reads, including reverse-page variants;
- the unified Pulse email-by-contact and email-by-timeline list legs;
- Yelp conversation history/threading helpers and newest-contact-thread resolution;
- Inspector recent-communications email rows.

Existing `contact_id`, `timeline_id`, and `on_timeline` values are preserved. This is what keeps application reversible without guessing prior link state.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| polling worker: `importGmailThread` / normalized backfill | explicit scheduler/provider `companyId` plus resolved mailbox id | Gmail thread/message ids paired with company on DB upsert | N/A — internal worker, no route | connected-company worker ✓; remote role invocation ✗ | Gmail ids are natural external keys; DB uniqueness/upserts remain company-paired |
| CLI: `pruneIngestedEmailDrafts` | mandatory `--company-id`; mailbox resolved inside that company; SQL repeats company+mailbox | `provider_message_id` plus `(company_id, mailbox_id)` | N/A — offline operator command, not HTTP | shell operator ✓; CRM/API roles ✗ | removing either tenant boundary could mark another company's same provider id; real-PG T-blast covers it |
| email/timeline/Pulse read aggregates | existing caller company scope (`req.companyFilter.company_id` at route boundary) | company + contact/timeline/thread id | existing route permissions unchanged (`pulse.view`, email route permissions) | existing R-matrix unchanged; no new allow cell | a missing company predicate could expose another tenant's flagged or unflagged email; existing predicates are retained and the new filter is conjunctive |

There is no new HTTP route, so no new RBAC catalog permission or deny matrix is introduced. The CLI has no `req` and therefore takes `companyId` explicitly. T-own, T-foreign, T-blast, idempotency, and unchanged foreign-row byte snapshots are exercised against real PostgreSQL.

## Acceptance coverage

- [x] `threads.list` has `-in:draft` in both lookback list sites.
- [x] `importGmailThread` skips `DRAFT` before every thread aggregate and every upsert.
- [x] `backfillNormalized` excludes `DRAFT` before normalization.
- [x] `pullChangesNormalized` excludes a history-fetched `DRAFT` before normalization.
- [x] `[inbound, DRAFT, sent]` produces two message upserts and draft-free aggregate values.
- [x] Historical 404/200/network-error outcomes are candidate/retain/fail-closed respectively.
- [x] CLI is dry-run by default, supports `--apply` and `--limit`, paces requests, retries rate limits, and logs auditable metadata for each missing candidate without logging body text.
- [x] Apply is reversible and idempotent; no physical delete exists.
- [x] Candidate and update SQL are company+mailbox scoped.
- [x] Timeline/message/Pulse list projections exclude marked rows.
- [x] Mark/unmark transactionally refreshes all four cached last-message display fields; draft-only threads remain unchanged and `unread_count` is preserved.

## MCP parity

No direct ChatGPT connector parity change: `chatgptMcpReadService.getContactHistory` reads contact/domain-event/job/lead data and does not consume `emailQueries` timeline projections. The shared CRM/Pulse email projections do change and are covered above, but they are not currently read by the ChatGPT MCP connector.

## Verification

### Focused unit suites

Exact commands executed:

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/services/emailSyncService.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
```

Result: 1 suite / 19 tests passed. This includes the history-path `messages.get` DRAFT guard.

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/emailDraftPrune.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
```

Result: 1 suite / 8 tests passed. The dry-run contract proves that only a missing candidate gets the four safe audit fields and that supplied body PII is absent from every log line.

### Real PostgreSQL tenancy and projection suite

Exact command executed:

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/emailDraftPrune.db.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
```

Result: 1 suite / 4 tests passed. The suite applies migration 260 idempotently, creates two self-contained tenants, proves T-own/T-foreign/T-blast with a byte snapshot, verifies idempotency and candidate scope, and proves marked rows disappear from thread, contact-timeline, and unified Pulse projections. A mixed thread proves mark/unmark symmetry for all four cached display fields and byte-for-byte preservation of `unread_count`; a draft-only thread proves the cache remains unchanged when no visible message remains. Teardown removes all fixture rows.

### Sibling regression sweep

Exact command executed:

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/contactEmailMerge.test.js tests/contactMergeConflicts.test.js tests/contactsPulseTenantIsolation.test.js tests/emailDueMailboxes.test.js tests/emailHtmlRenderPlumbing.test.js tests/emailMailboxMultitenancy.test.js tests/emailMimeAlternative.test.js tests/emailTimelineInbound.test.js tests/emailTimelineOutbound.test.js tests/listPaginationByContact.test.js tests/mailAgentService.test.js tests/mailProvider.test.js tests/marketplaceLeadgenSplit.test.js tests/orphanTaskRehome.test.js tests/outboundLeadCallWebhook.test.js tests/outboundLeadCallWorker.test.js tests/partsCallService.test.js tests/pulseListProviderScope.test.js tests/pulseReadEmail.test.js tests/routes/email.test.js tests/services/emailMailboxService.test.js tests/services/marketplaceService.test.js tests/tasksEmit.test.js tests/yelpAgentSendLink.test.js tests/yelpConvoIntercept.test.js tests/yelpLeadHook.test.js tests/yelpTimelineDedup.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"
```

Result: 27 suites / 478 tests passed. The command required local ephemeral-port permission for route harnesses; no external network was used.

The team lead independently ran the broader `(email|mail|timeline|pulse|inspector)` selection: 537 tests passed and 15 failed across six suites. A `cp` + clean-checkout comparison proved all six failures are baseline: `inspectorTenancy.db`, `pulseTaskProviderScope.db`, `yelpTimelinePulse.db`, `yelpTimelineResolve.db`, `yelpTimelineCleanup.db`, and `jobEmailSot.contract`. None was changed under this task.

### Sabotage controls

1. **S-DRAFT-UPSERT (required minimum):** replaced the early filtered message array in `importGmailThread` with raw `gmailThread.messages`. Running the focused sync command produced 1 failed / 17 passed; the named test failed with `Expected upsertMessage calls: 2, Received: 3`. Restored the exact filter; 18/18 passed.
2. **S-TENANT-MARK:** replaced the update's `(company_id, mailbox_id, provider_message_id)` predicate with an effectively provider-id-only predicate while retaining typed dummy parameters. The real-PG suite failed: T-foreign returned and marked tenant B's row, and tenant B's candidate list became empty. Restored the exact scoped predicate; 2/2 passed.
3. **S-THREAD-CACHE (FIX-3):** changed the post-flag guard from `if (latest)` to `if (false && latest)`, disabling the cached-thread UPDATE without changing the flag mutation. The real-PG suite failed specifically in `mark/unmark refreshes all four cached last-message fields and preserves unread_count`: after mark, the cache still pointed at the later draft. Restoring the guard returned the suite to 4/4.

## Risks and rollout

- Run production dry-run with a small `--limit` first and inspect `errors` before apply. A non-zero error count never marks those rows.
- `--limit` bounds rows scanned, not only 404 candidates. Because 200 rows are intentionally not mutated, repeating the same limit rechecks the same leading window; increase the limit for each wider rollout stage (for example 25 → 250 → 3000).
- Migration and read filters should deploy before any `--apply`, otherwise old application instances do not know the flag.
- The Gmail-404 premise is intentionally operator-audited rather than assumed: review missing-candidate ids, timestamps, and body lengths in dry-run, then inspect bodies separately with tenant-scoped SQL before `--apply`.
- Thread `message_count`, participants, attachment state, and subject are outside this remediation. The four user-visible last-message fields are refreshed; `unread_count` is preserved by explicit decision because it cannot be reconstructed from message rows.
