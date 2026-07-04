# EMAIL-OUTBOUND-001: outbound-first email threads surface in the Pulse unified list

**Status:** Spec · **Priority:** P1 · **Date:** 2026-07-03 · **Owner:** Pulse / Email
Backend-only. One SQL change (the `email_by_contact` CTE in `getUnifiedTimelinePage`,
`backend/src/db/timelinesQueries.js`) + one backfill migration (155) + tests. NO route,
response-shape, frontend, or unread-model changes. Requirements: `Docs/requirements.md`
§EMAIL-OUTBOUND-001 (FR-1…FR-6, AC-1…AC-6, D1–D4 binding). Architecture:
`Docs/architecture.md` §EMAIL-OUTBOUND-001.

## Overview

A dispatcher-initiated email thread with no reply yet is fully linked in the data
(`email_messages.contact_id / timeline_id / on_timeline`, mig 129) and visible in the
contact's timeline detail — but the Pulse unified by-contact list never shows the contact,
because the list's `email_by_contact` CTE resolves contact→thread **only via inbound**
messages. Fix: make the CTE direction-agnostic with a two-leg `UNION ALL` (inbound leg
byte-identical, new outbound leg reads the persisted mig-129 link), plus migration 155 to
link historical outbound messages so pre-fix threads surface too (D1 parity).

## CTE contract (the ONLY behavioral change point)

`getUnifiedTimelinePage`, `backend/src/db/timelinesQueries.js` (~line 401). New shape,
normative:

```sql
email_by_contact AS (
    SELECT DISTINCT ON (contact_id)
           contact_id, email_thread_id, email_subject,
           last_message_at, last_message_direction, unread_count
    FROM (
        SELECT ce.contact_id, et.id AS email_thread_id, et.subject AS email_subject,
               et.last_message_at, et.last_message_direction, et.unread_count
        FROM email_messages em
        JOIN contact_emails ce ON ce.email_normalized = lower(trim(em.from_email))
        JOIN email_threads et ON et.id = em.thread_id
        WHERE em.company_id = $1 AND et.company_id = $1
          AND em.direction = 'inbound' AND em.from_email IS NOT NULL
        UNION ALL
        SELECT em.contact_id, et.id, et.subject,
               et.last_message_at, et.last_message_direction, et.unread_count
        FROM email_messages em
        JOIN email_threads et ON et.id = em.thread_id
        WHERE em.company_id = $1 AND et.company_id = $1
          AND em.direction = 'outbound' AND em.contact_id IS NOT NULL
          AND em.on_timeline = true
    ) legs
    ORDER BY contact_id, last_message_at DESC NULLS LAST, email_thread_id DESC
)
```

Binding rules:

1. **Inbound leg (leg 1) predicates are byte-identical to today:** join
   `ce.email_normalized = lower(trim(em.from_email))`, `em.direction = 'inbound'`,
   `em.from_email IS NOT NULL`, `em.company_id = $1 AND et.company_id = $1`. The mig 143
   functional index (`idx_email_messages_from_normalized ON email_messages
   (company_id, (lower(trim(from_email))))`) and the d56db8f search fix depend on exactly
   this text. Inbound coverage (text re-match over ALL history) must not change.
2. **Outbound leg (leg 2) reads ONLY the persisted mig-129 link:**
   `em.direction = 'outbound' AND em.contact_id IS NOT NULL AND em.on_timeline = true`,
   company-scoped `$1` on **both** `em` and `et`. It must NEVER touch
   `to_recipients_json` (per-row JSONB expansion in the hot query is banned).
3. **One thread per contact:** `DISTINCT ON (contact_id)` over the union with
   `ORDER BY contact_id, last_message_at DESC NULLS LAST, email_thread_id DESC`.
   The `email_thread_id DESC` tie-break is NEW and intentional: it makes
   equal-timestamp thread selection deterministic (today it is plan-dependent).
   Flag it in review as a non-semantic ordering fix, not a behavior change.
4. **Frozen output shape:** exactly the six columns/aliases `contact_id`,
   `email_thread_id`, `email_subject`, `last_message_at`, `last_message_direction`,
   `unread_count`. Everything outside the CTE is untouched: the join
   (`eml.contact_id = tl.contact_id`), the surfacing predicate
   (`eml.email_thread_id IS NOT NULL`), the search predicate alias
   (`eml.email_subject ILIKE …` — `eml.subject` does not exist and 500s), outer aliases
   (`email_last_message_at`, `email_last_message_direction`, `email_unread_count`),
   `GREATEST(latest_call.started_at, sms.last_message_at, eml.last_message_at)`
   ordering + `last_interaction_at`, `any_unread`, AR/unread tiers, orphan-shadow dedup
   (SQL before LIMIT), `total_count = COUNT(*) OVER()`.
5. A mixed thread (has both inbound and outbound messages) emits identical tuples from
   both legs — the thread-level fields come from `email_threads` either way, so
   `DISTINCT ON` dedup is harmless by construction.
6. Update the function-header comment (currently "Scope A … INBOUND", ~lines 321–324 and
   349–353) to describe both legs.

Alternatives are rejected by architecture (do not implement): single persisted-link
source for both directions (silently shrinks inbound coverage — history was never
back-linked); an OR-extended single leg (denies the planner both index paths).

## Behavior scenarios

All scenarios: company A = `$1` scope, dispatcher authenticated, list fetched via
`GET /api/calls/by-contact` (mount `authenticate, requireCompanyAccess`
[src/server.js:118] + router-level `requirePermission('reports.calls.view','pulse.view')`;
`companyId` strictly from `req.companyFilter.company_id`, else 401).

### S1 — CRM composer first email (email-only lead)

- **Preconditions:** contact C in company A with email only; zero calls, zero SMS, zero
  inbound email; no open tasks; `tl.has_unread=false`.
- **Steps:** dispatcher sends the first email from the Pulse composer
  (`emailTimelineService.sendForContact`) or the email-workspace composer. The send path
  already links: `findOrCreateTimelineByContact` resolves/creates C's timeline,
  `linkMessageToContact` stamps `contact_id/timeline_id/on_timeline=true`,
  `markThreadRead` zeroes `unread_count`. Then the client refetches the list.
- **Expected:** C's row IS on the page (leg 2 match → `eml.email_thread_id IS NOT NULL`
  surfaces it). `email_last_message_direction='outbound'` → route computes
  `last_interaction_type='email_outbound'` → MailCheck icon (shipped d455c52).
  Position = `GREATEST(...)` = the send time (`email_threads.last_message_at`).
  `any_unread=false` (unread_count=0). NOT in the Action-Required band: AR pin =
  `open_task.id IS NOT NULL` — sending email creates no task, so the row sorts in
  tier 2 (normal recency). `total` includes the row.
- **Side effects:** none new — the existing send path already published SSE and wrote
  the link; this feature only reads.

### S2 — Gmail-direct first email (push path)

- **Preconditions:** as S1, but the dispatcher writes to C from the shared Gmail mailbox
  directly; no CRM action.
- **Steps:** Pub/Sub push → `handlePush` → `linkOutboundMessage`: DRAFT guard passes
  (labelIds has no `DRAFT`), recipients extracted from `to` /`to_recipients_json`
  (TO only, lower/trim, deduped), `findEmailContact` per recipient — **first matching
  recipient wins**; timeline resolved via `findOrCreateTimelineByContact`; link stamped;
  `markThreadRead`; SSE-only, no unread.
- **Expected:** identical to S1 — same row, MailCheck, ordered by send time, not unread,
  not AR. No CRM interaction required.

### S3 — Reply arrives later (flip to inbound-latest, EMAIL-UNREAD-001 flow)

- **Preconditions:** S1 or S2 state (outbound-only thread surfaced).
- **Steps:** contact replies. Sync/push upserts the thread: `last_message_at` = reply
  time, `last_message_direction='inbound'`, `unread_count>0` (counted from Gmail
  `UNREAD` labels, `emailSyncService.js:131-132`). The inbound message also matches
  leg 1 (from_email text match); both legs now yield the same thread tuple → one row.
- **Expected:** the SAME row (no duplicate) re-orders to the reply time, icon flips to
  Mail (`last_interaction_type='email_inbound'`), `any_unread=true` → unread tier 1.
  Pulse mark-read (`POST /api/calls/timeline/:timelineId/mark-read`, also
  `/contact/:contactId/mark-read`) clears it — the route's email-clearing UPDATE finds
  the thread via its inbound-message join (the reply is inbound, so the join matches;
  no change needed there). After mark-read: `any_unread=false`, position unchanged.
- **Regression:** inbound-first threads behave byte-for-byte as today (leg 1 untouched).

### S4 — Mixed-channel contact (calls/SMS exist)

- **Preconditions:** contact C has prior calls and/or SMS (already surfaced), then
  receives a first-touch outbound email that is now the latest interaction.
- **Expected:** C's EXISTING row re-orders by the email time (`GREATEST` of
  call/SMS/email) and shows MailCheck (`last_interaction_type='email_outbound'`, strict
  `>` beats older call/SMS; on an exact tie the route keeps call > sms > email). NO
  duplicate row: the email attaches to the same timeline row via
  `eml.contact_id = tl.contact_id`, and `findOrCreateTimelineByContact` + the mig 029
  partial unique (`(contact_id) WHERE contact_id IS NOT NULL`) guarantee one timeline
  per contact. Page size and `total` unchanged (same row count).

### S5 — Two threads, one contact: newest thread wins regardless of direction

- **Preconditions:** contact C has thread T1 (older, inbound-matched) and thread T2
  (newer, dispatcher-initiated outbound-only).
- **Expected:** ONE row for C, reflecting T2: `email_thread_id = T2`,
  direction/subject/time from T2 (`DISTINCT ON` picks max `last_message_at` across BOTH
  legs). If T1 later gets the newest reply, the row flips back to T1. Equal
  `last_message_at` → higher `email_thread_id` wins (deterministic tie-break).
- Symmetric case (older outbound-only + newer inbound thread) must also pick the newer.

### S6 — Outbound to a NON-contact recipient

- **Steps:** dispatcher emails an address matching no contact in company A (workspace
  composer or Gmail-direct). `linkOutboundMessage` returns `{skipped:'no_contact'}`;
  the message row keeps `contact_id IS NULL, on_timeline=false`.
- **Expected:** nothing surfaces in the unified list (leg 2 predicates exclude it); the
  email stays workspace-only. No contact auto-creation. Migration 155 likewise never
  links it (no match). If the contact is created LATER, the historical message is not
  retro-linked by this feature (out of scope; only mig 155's one-shot links history).

### S7 — DRAFT saves never surface

- **Steps:** dispatcher creates/edits a Gmail draft addressed to a contact, any number
  of times.
- **Expected:** no list row, no timeline entry, ever. Guards (all upstream, unchanged):
  push path drops `labelIds ∋ 'DRAFT'` (`linkOutboundMessage` step (a)); poll/backfill
  path requires `message_id_header IS NOT NULL AND message_id_header <> ''` (a draft
  being composed has no Message-ID). Because a draft row is never linked
  (`contact_id IS NULL, on_timeline=false`), leg 2's predicates exclude it even though
  `direction='outbound'`. Sending the draft later ingests a SENT message that links
  normally (→ S1/S2).

### S8 — Historical outbound emails (pre-fix) surface after migration 155

- **Preconditions:** prod has outbound `email_messages` rows sent before this fix:
  `direction='outbound', contact_id IS NULL, on_timeline=false`, genuinely sent
  (Message-ID present), recipients matching contacts. Some of those contacts are
  email-only and have NO timeline row at all.
- **Steps:** apply migration 155 (below).
- **Expected:** on the next list fetch every such thread surfaces exactly as S1 —
  including for email-only contacts whose timeline the migration had to CREATE (the
  list roots on `timelines`; link-without-timeline would not surface). Rows order by
  their thread's `last_message_at`; direction/unread come from the thread as-is (a
  historical thread with a later unanswered reply correctly shows inbound + unread).
  Re-running the migration changes nothing (idempotent).

## Migration 155 contract — `155_backfill_outbound_email_links.sql`

House pattern (mig 144/154): one idempotent `DO $$` block, `RAISE NOTICE` count per
step, paired `rollback_155_backfill_outbound_email_links.sql`. Re-verify max migration
number = 154 immediately before creating (parallel branches). Backend is CommonJS; the
migration is pure SQL. It must be safe on empty data (all steps no-op, notices print 0).

**Step 1 — match set + recipient→contact resolution.**

- Candidate messages: `direction='outbound' AND contact_id IS NULL AND
  on_timeline = false AND message_id_header IS NOT NULL AND message_id_header <> ''`
  — the draft-safe discriminator canonized in `listUnlinkedOutboundForTimeline`
  (`backend/src/db/emailQueries.js:516-536`; quote the guard verbatim). This is also
  what makes a re-run a no-op: linked rows fail `contact_id IS NULL`.
- Recipients: `jsonb_array_elements(em.to_recipients_json) WITH ORDINALITY` (one-time
  expansion is acceptable in a migration, never in the hot query). Address =
  `lower(trim(elem->>'email'))`, skipping NULL/empty — the exact normalization
  `extractRecipientEmails`/`findEmailContact` apply. **TO only** — CC/BCC are never
  matched (mirrors `extractRecipientEmails`, which reads only `to`).
- Contact match mirrors `findEmailContact` (`emailQueries.js:424-438`): company-scoped
  `c.company_id = em.company_id`, `(lower(c.email) = addr OR ce.email_normalized = addr)`
  via `LEFT JOIN contact_emails ce`, tie-break `c.updated_at DESC NULLS LAST, c.id ASC`.
- One contact per message, **first matching recipient wins**:
  `DISTINCT ON (em.id) ORDER BY em.id, ord ASC, c.updated_at DESC NULLS LAST, c.id ASC`.

**Step 2 — timeline find-or-create: full SQL mirror of `findOrCreateTimelineByContact`
(`timelinesQueries.js:237-311`), NOT a bare INSERT.** For each matched contact:

- (a) reuse the existing contact-linked timeline (`WHERE contact_id = C AND
  company_id = A`);
- (b) else ADOPT the newest phone-digit-matching orphan: `contact_id IS NULL AND
  company_id = A AND regexp_replace(phone_e164,'[^0-9]','','g') IN (contact's primary /
  secondary digits)`, `ORDER BY updated_at DESC NULLS LAST`; adoption = `UPDATE
  timelines SET contact_id = C, phone_e164 = NULL, updated_at = now()` **plus re-point
  `UPDATE calls SET contact_id = C WHERE timeline_id = orphan AND contact_id IS NULL`**.
  A bare INSERT here would fork the person across two timelines and the orphan-shadow
  dedup would then hide their call history — the exact ORPHAN-TASK-REHOME-001 bug class.
  Corner (flagged): two matched contacts sharing one orphan → deterministic
  one-orphan-one-contact assignment via double `DISTINCT ON` (one per orphan, one per
  contact; stable ORDER BY), matching what JS iteration order does one-at-a-time today;
  the losing contact falls through to (c);
- (c) else `INSERT INTO timelines (contact_id, company_id) … ON CONFLICT (contact_id)
  WHERE contact_id IS NOT NULL DO NOTHING` + re-select the row. NB two deliberate
  deltas from the JS helper, both pinned here: the arbiter MUST carry the
  `WHERE contact_id IS NOT NULL` clause or Postgres cannot infer the mig 029 partial
  unique index; and `DO NOTHING` + re-select replaces the helper's
  `DO UPDATE SET updated_at = now() RETURNING *` (a JS single-round-trip convenience —
  the migration must not bump `updated_at` on untouched rows).
- Why create timelines at all (vs lazy): no read path lazily creates timelines and the
  list roots on `timelines` — skipping creation fails FR-5 for precisely the target
  case (Gmail-direct send to an email-only lead); only a FUTURE send would heal it.

**Step 3 — stamp links** (mirror of `linkMessageToContact`): `UPDATE email_messages SET
contact_id, timeline_id, on_timeline = true, updated_at = now()` for the matched set.
Explicitly NOT mirrored from the live path: no `markThreadRead` (retroactively zeroing
`unread_count` could erase legitimate unread state from a later inbound reply — unread
model unchanged, D2/FR-3), no SSE publish (pure SQL; the list is correct at next fetch).

**Step 4 — re-run the mig-144 open-task re-home sweep verbatim** (the `DO $$` UPDATE
from `144_rehome_orphan_open_tasks.sql`: `DISTINCT ON (o.id)` surviving-timeline pick,
`'[^0-9]'` digit idiom, open-task predicate). Step 2 can newly shadow orphans; the
project invariant since ORPHAN-TASK-REHOME-001 is that every canonical-timeline-creating
path sweeps (the JS helper does at `timelinesQueries.js:306-309`). Idempotent.

**Observability:** `RAISE NOTICE` with counts per step — messages linked N, orphans
adopted K, timelines created M, open tasks re-homed T (mig-144 logged-backfill pattern).
Record these from the prod-copy dry run in the PR.

**Rollback:** `rollback_155_…` is documented one-way — backfilled links are
indistinguishable from runtime links (same columns, same values); undo = PITR restore.
Same posture as `rollback_144`. The rollback file states this; it does not attempt to
NULL links.

## Edge cases

1. Company with no email at all → CTE yields zero rows; `LEFT JOIN … eml` gives NULLs;
   timelines surface only on other signals; empty page → `total = 0`. No error.
2. `email_threads.last_message_at IS NULL` → `NULLS LAST` inside the `DISTINCT ON`
   ordering: a NULL-timestamped thread is picked only when the contact has no
   timestamped thread; in the outer `ORDER BY`, `GREATEST(...)` ignores NULL channels
   (NULL only if call+SMS+email are all NULL → row sorts last within its tier).
3. Contact with multiple `contact_emails` rows: leg 1 may emit one tuple per
   matched address/message; leg 2 emits one tuple per linked outbound message —
   `DISTINCT ON (contact_id)` collapses all of it to one row. Leg 2 itself never joins
   `contact_emails` (reads persisted `contact_id`), so multi-email contacts add no
   fan-out there.
4. Many outbound messages in one thread → identical tuples → collapsed (rule 5 above).
5. Contact deleted → mig 129 FK `ON DELETE SET NULL` clears `em.contact_id` → the
   message leaves leg 2; no dangling list row.
6. Orphan (contactless) timelines never gain email signal: join is
   `eml.contact_id = tl.contact_id` and SQL `NULL = NULL` is not true. (Outbound email
   on orphan timelines is impossible by construction — links are contact-rooted.)
7. Search: a term matching only an outbound-first thread's subject must return the row
   (predicate `eml.email_subject ILIKE $n` — alias unchanged, FR-6).
8. Cross-tenant (AC-5): company B has a contact with the same address as company A's
   recipient → A's outbound thread never surfaces in B (both legs `em.company_id = $1
   AND et.company_id = $1`; migration matching is per-message
   `c.company_id = em.company_id`).
9. Pagination invariants hold: surfacing/dedup decided in SQL before `LIMIT`; a page is
   never shrunk post-query; `total_count` window count consistent; AR band pinning
   (open-task tier) unaffected by email direction.

## Error handling

- `GET /api/calls/by-contact` without company context → 401 `{error:'No company
  context'}` (existing; unchanged). Query failure → 500 `{error:'Failed to fetch calls
  by contact'}` (existing; unchanged). No new error codes.
- Migration 155 runs in the standard migration transaction; any failure aborts the whole
  block (no partial links). A partial-failure worry does not apply — re-run is safe.
- No new SSE events; no toasts; no frontend states.

## Component interaction (read path only — senders untouched)

- `PulsePage`/`usePulsePage` → `authedFetch GET /api/calls/by-contact?limit&offset&search`
  → `backend/src/routes/calls.js` → `timelinesQueries.getUnifiedTimelinePage` → SQL above.
- Writers (already shipped, protected): Pulse composer `sendForContact`; email-workspace
  composer; Gmail push → `ingestPushForCompany` → `linkOutboundMessage`. This feature
  adds no calls into them.

## API contract — explicitly NO changes

`GET /api/calls/by-contact` keeps its exact envelope
`{ conversations, leads_map, total, limit, offset }` and per-row shape. Frozen fields
the frontend keys off (d455c52): `last_interaction_at`, `last_interaction_type`
(`'call' | 'sms_inbound' | 'sms_outbound' | 'email_inbound' | 'email_outbound'` — the
Mail/MailCheck switch), `last_interaction_phone`, `email_thread_id`, `has_unread`
(= SQL `any_unread`), `tl_has_unread`, `sms_has_unread`, `sms_conversation_id`,
`timeline_id`, `tl_phone`, `is_action_required`, `action_required_reason`,
`action_required_set_at`, `snoozed_until`, `owner_user_id`, `has_open_task`,
`open_task_count`, `open_task{id,title,due_at,priority,kind,agent_output}`, plus the
`formatCall` spread and `contact` JSON. SQL-row aliases frozen likewise:
`email_subject`, `email_last_message_at`, `email_last_message_direction`,
`email_unread_count`, `last_interaction_at`, `any_unread`, `total_count`. No fields
added, removed, renamed, or retyped. Middleware chain and `req.companyFilter` sourcing
unchanged.

## Performance acceptance (AC-6 gate — blocking)

PULSE-PERF-001 methodology, mandatory before deploy. The local dev DB is NOT prod-like
for email (measured: 5 `email_messages` rows) — use a fresh prod `pg_dump` restore, or
read-only on prod from the app container.

1. `EXPLAIN (ANALYZE, BUFFERS)` of the EXACT production SQL from
   `getUnifiedTimelinePage` (real params: Boston Masters company UUID, `limit 50 /
   offset 0`) — four runs: before/after × plain/search-term.
2. Acceptance: `email_by_contact` evaluated ONCE (no per-timeline re-scan); no per-row
   Seq Scan over `email_messages`; leg 1 served by mig 143
   `idx_email_messages_from_normalized`; leg 2 served by the mig 129 partial index
   `idx_email_messages_contact_timeline (company_id, contact_id, gmail_internal_at)
   WHERE contact_id IS NOT NULL` (its partial condition + `company_id` prefix contain
   the driving predicate; `direction`/`on_timeline` are residual filters over the small
   linked set); page latency ≈ the current ~0.3s baseline.
3. Time the real function via a node one-liner in the app container (not just EXPLAIN).
4. **NO new index by default** (no speculative indexes). Escape hatch ONLY if the gate
   fails — pre-approved mig 156, predicate verbatim from leg 2:
   `CREATE INDEX … ON email_messages (company_id, contact_id, thread_id)
   WHERE direction = 'outbound' AND contact_id IS NOT NULL AND on_timeline = true`.
5. Mig 155 itself is EXPLAIN-exempt (one-time), but its per-step `RAISE NOTICE` counts
   from the prod-copy dry run go in the PR.

## Security / tenant isolation

- Every leg of the CTE carries `company_id = $1` on both `email_messages` and
  `email_threads` (the LIST-PAGINATION-001 SMS cross-tenant leak is the precedent; the
  real-DB cross-tenant scenario is a required test, not optional).
- Route company scope only from `req.companyFilter.company_id` (never client input);
  fails 401 when absent.
- Migration matching never crosses tenants: contact join is
  `c.company_id = em.company_id`; timeline reuse/adopt/create is company-scoped.

## Test plan

- `tests/listPaginationByContact.test.js` — extended; every existing assertion stays
  untouched (they pin the inbound leg + aliases). New SQL-text assertions: `UNION ALL`
  present; the three outbound predicates (`direction = 'outbound'`,
  `contact_id IS NOT NULL`, `on_timeline = true`); `$1` company scope on both legs (em
  AND et); `DISTINCT ON (contact_id)` + `ORDER BY contact_id, last_message_at DESC
  NULLS LAST, email_thread_id DESC`; `eml.email_subject` search alias intact; no
  `to_recipients_json` reference anywhere in the hot query.
- Unread invariant asserted, not assumed (FR-3/D2): outbound-first fixture rows carry
  `unread_count = 0` → `any_unread = false`; verified-by-reading code path stays: only
  `upsertThread` writes `unread_count` (from Gmail UNREAD labels), `linkOutboundMessage`
  clears it, Pulse mark-read clears it — no code path marks unread on send.
- Mocked jest validates SQL text ONLY (LIST-PAGINATION-001 lesson) → mandatory real-DB
  scenario run against a prod copy, documented in the PR: outbound-only /
  inbound+outbound mix / two-threads-newest-wins / no-match recipient / draft /
  cross-tenant. Plus mig 155 dry run: counts, idempotent second apply (all zeros),
  timeline-created case surfaces (S8).
- Jest in a worktree needs `--testPathIgnorePatterns "/node_modules/"`.

## Protected (must not change)

`emailTimelineService` (`linkOutboundMessage` recipient match / DRAFT guard / idempotent
re-link / SSE-only-no-unread, `sendForContact`, outbound `markThreadRead`);
`emailQueries.js`; `buildTimeline` + `GET /api/pulse/timeline/:contactId` (already
correct for outbound); `/email` workspace + push pipeline; unified-list invariants (AR
pinning, unread tier, `GREATEST` ordering, orphan-shadow dedup, search aliases, SMS
lateral scoping, `total_count`); migrations ≤ 154 and the mig 143 index;
`src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`; the unread model
(inbound-only growth; Pulse mark-read clearing).

## Non-goals / out of scope

- **No poller scheduling.** `ingestPolledForCompany` stays exported-but-unwired; after
  mig 155 a Gmail-push outage would again accumulate unlinked outbound rows with nothing
  draining them — flagged risk, separate owner decision.
- No frontend changes (icons/labels shipped in d455c52; behavior verified, not modified).
- No unread-model changes; the migration never touches `unread_count`.
- No contact auto-creation from unknown recipients; no CC/BCC matching changes; no
  surfacing of email on orphan (contactless) timelines; no email-workspace changes.
- Deploy to prod only with explicit owner consent (standing rule).
