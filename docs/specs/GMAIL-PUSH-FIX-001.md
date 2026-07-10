# GMAIL-PUSH-FIX-001 — Restore real-time Gmail push ingest — Functional Spec

Source of truth: `Docs/requirements.md › GMAIL-PUSH-FIX-001` (R1–R3 / N1–N3) and `Docs/architecture.md › GMAIL-PUSH-FIX-001` (FIX#1 Design A, FIX#2 predicate, FIX#3 log). This spec turns that locked design into testable behavior. It **does not restate** the push/poll/link pipeline — see `Docs/specs/EMAIL-TIMELINE-001.md` §2 (push endpoint, fast-ack + verify), §3 (inbound link + idempotency), §4 (poll reconciliation), §5 (outbound), and the AC-12 seam.

## Overview

Push is wired end-to-end but ingests almost nothing: a single inbound email is never pulled by the push and waits for the fallback poll (measured 571s). Three backend-only bug fixes make a single email pull → hydrate → link onto the timeline within seconds. **No migration, no GCP/Pub/Sub/OIDC/DNS change, no frontend.** The push route (`emailPush.js` verify + fast-ack 200), the AC-12 seam, `syncIncrementalHistory` checkpoint advance, 404→backfill self-heal, company_id scoping, and outbound send-time linking are all preserved.

## The three fixes

- **FIX#1 (`GmailProvider.handlePushNotification`, `backend/src/services/mail/GmailProvider.js`):** return `cursor: null` instead of the push notification's `historyId`. Gmail's pushed `historyId` is the point *after* the triggering change, so `history.list(startHistoryId=<pushId>)` is empty for a single email. `cursor:null` makes `pullChangesNormalized(companyId, null)` fall back to the poll-maintained `mailbox.history_id` checkpoint, so the email is inside the walked window. `cursor:null` is already a legal return today (emitted when `historyId==null`) → no interface break. Add JSDoc explaining the Gmail semantics. Inbound/outbound routing in `ingestPushNotification` is unchanged.
- **FIX#2 (`listDueMailboxes`, `backend/src/db/emailQueries.js`):** replace the overlap predicate so cadence is measured off the last **finish** (honors `EMAIL_SYNC_INTERVAL_MS`, default 5 min) and re-entry is blocked **only** for a genuinely in-flight sync (started with no newer finish), with the 10-min bound kept **only** as a stuck-sync escape hatch. Feeds **only** the inbox-sync scheduler (`emailSyncService.runSchedulerTick`); the timeline link-poll (`server.js` → `listConnectedMailboxes` → `ingestPolledForCompany`) does not use this query and is unaffected.
- **FIX#3 (`ingestPushNotification`, `backend/src/services/email/emailTimelineService.js`):** emit exactly one success log line before the `{handled:true,…}` return (e.g. `[EmailPush] push handled: company=… processed=… linked=… skipped=…`). A working push was previously invisible in logs (caused a false diagnosis 2026-07-06).

## Scenarios

- **S1 — push, single new email → ingested + linked ≤~15s (THE success criterion).** Pub/Sub push arrives for a connected mailbox. Route verifies + fast-acks 200, async `ingestPushNotification` runs. `handlePushNotification` → `{companyId, cursor:null}` → `pullChanges(companyId, null)` → `pullChangesNormalized` walks from `mailbox.history_id`, imports+hydrates the thread into the inbox, returns the message normalized → `linkInboundMessage` links it (contact match, unread, live `message.added` SSE) → timeline bubble appears in seconds. The push does not advance the checkpoint (FIX#2's poll advances `mailbox.history_id` each ~5 min); re-reading the same window is idempotent.
- **S2 — burst.** Several inbounds (one push per event, or one push covering many) all resolve to the same window; each normalized message is linked; counts roll into `processed/linked/skipped`. A re-delivered push re-walks the same window but relink is a no-op `UPDATE` on the unique `(company_id, provider_message_id)` (079) → no duplicate rows, no double unread.
- **S3 — unknown / foreign mailbox → fast-ack no-op.** `emailAddress` resolves to no connected mailbox (or `message.data` missing / bad base64) → `handlePushNotification` returns `null` → `ingestPushNotification` returns `{handled:false}` → route already fast-acked 200; nothing linked; **no success log** (only the handled path logs). Never throws to Pub/Sub.
- **S4 — 404 history-gap on push → backfill self-heal.** `mailbox.history_id` is too old/invalid → `pullChangesNormalized` catches the Gmail 404, runs the existing bounded backfill, returns the backfilled messages normalized → linked onto the timeline. `cursor:null` unchanged; self-heal path identical to the poll's.
- **S5 — push handled log line fires.** On any `{handled:true}` return, exactly one success line is emitted with `company` + `processed/linked/skipped`. Absent on `{handled:false}` (S3) and on the `catch` error path.

## `listDueMailboxes` due / not-due matrix

Exact predicate (`$1` = cadence minutes = `EMAIL_SYNC_INTERVAL_MS/60000`, default 5):

```sql
WHERE m.status = 'connected'
  AND (s.last_sync_finished_at IS NULL
       OR s.last_sync_finished_at < now() - ($1 || ' minutes')::interval)          -- cadence off last FINISH
  AND (s.last_sync_started_at IS NULL
       OR (s.last_sync_finished_at IS NOT NULL
           AND s.last_sync_finished_at >= s.last_sync_started_at)                   -- last sync already finished
       OR s.last_sync_started_at < now() - interval '10 minutes')                   -- stuck-sync escape hatch
```

Due ⇔ `status='connected'` AND cadence-clause AND overlap-clause, where cadence = *never finished OR last finish older than `$1` min*, overlap = *never started OR last sync already finished (`finished ≥ started`) OR started >10 min ago*.

| Case | `email_sync_state` shape | Result | Why |
|---|---|---|---|
| never-synced | no row / `started=NULL, finished=NULL` | **DUE** | first-ever sync must run (both clauses true on NULLs) |
| idle-elapsed | `finished` set, `finished < now-$1`, `finished ≥ started` | **DUE** | cadence elapsed since last finish → the core fix; honors `EMAIL_SYNC_INTERVAL_MS` |
| idle-fresh | `finished` set, `finished ≥ now-$1` | **NOT DUE** | cadence window not yet elapsed → throttled by *finish*, not start |
| in-flight | `started` recent (<10 min), `finished IS NULL` or `finished < started` | **NOT DUE** | genuine overlap — don't re-enter a running sync |
| stuck >10min | `started > 10 min ago`, never finished (or `finished < started`) | **DUE** | escape hatch — a wedged sync is retried, never blocked forever |
| crashed-first-run | `started` set once (<10 min ago), `finished` never set | **NOT DUE** (until 10-min escape) | indistinguishable from a slow first run; self-heals via the stuck escape within 10 min |

## Success criterion (N1)

A single inbound email is **ingested AND linked within ~15s** of the Gmail push (target: seconds), replacing the 571s poll wait. The poll remains a correctness backstop only.

## Preserved invariants (N2 / N3)

`verifyPush` (token + OIDC audience) unchanged; fast-ack 200 + safe-fail (never throw to Pub/Sub); idempotent ingestion (no double-post under redelivery); 404 history-gap self-heal; outbound sends linked at send time; AC-12 seam (`emailTimelineService` must not import `emailSyncService`/`emailService`/`emailMailboxService`/`googleapis`); backend `jest` green; standalone `/email` inbox and EMAIL-TIMELINE-001 send/sync/OAuth unchanged beyond the checkpoint-cursor fix. `EMAIL_SYNC_INTERVAL_MS` is **not** changed. The mail-agent / MAIL-LOCAL-LLM email-triage classifier is untouched.

## Edge cases the Implementer / Tester must handle

1. **Push does not advance the checkpoint (Design A trade-off).** Between poll ticks every push re-reads the same window from `mailbox.history_id`. Verify this is idempotent (relink no-op) and that FIX#2's poll advances `mailbox.history_id` so the window floor keeps moving — no unbounded re-walk.
2. **`crashed-first-run` blocks the poll for up to 10 min.** A first sync that starts and never finishes wedges only the poll backstop for that mailbox for ≤10 min (bounded by the escape hatch). Push (FIX#1) is independent of `listDueMailboxes`, so real-time ingest still works meanwhile. Accepted per design; flag if a test asserts sub-10-min poll recovery for this case.
3. **Existing test encodes the bug — `tests/mailProvider.test.js` TC-ET-040** pins `cursor:'777'`; update to `cursor:null`. TC-ET-037 (AC-12 seam, P0) must stay green — FIX#1 keeps push routed through `provider.pullChanges`, not a direct `emailSyncService` import. Add `listDueMailboxes` cases: idle-elapsed DUE, idle-fresh NOT DUE, in-flight blocked, stuck>10min escape.
4. **S3 must emit no success log** — assert the log line is present only on `{handled:true}` (S1/S2/S4) and absent on `{handled:false}` (foreign/undecodable push).
