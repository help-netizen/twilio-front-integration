# Тест-кейсы: EMAIL-OUTBOUND-001 — outbound-first email threads in the Pulse unified list

**Source spec:** `Docs/specs/EMAIL-OUTBOUND-001.md` (scenarios S1–S8, CTE rules 1–6, edge cases 1–9, migration 155 contract). Requirements: `Docs/requirements.md` §EMAIL-OUTBOUND-001 (FR-1…FR-6, AC-1…AC-6). Backend-only: the ONLY change points are the `email_by_contact` CTE in `getUnifiedTimelinePage` (`backend/src/db/timelinesQueries.js` ~line 401) and migration `backend/db/migrations/155_backfill_outbound_email_links.sql` (+ rollback file).

**House lesson (LIST-PAGINATION-001, binding):** mocked jest validates the SQL **string** only. Every behavior claim below therefore has a real-DB integration case; the unit section pins text, the integration section pins behavior against real Postgres, the performance section gates the plan on a prod copy (PULSE-PERF-001 methodology).

**Jest gotcha:** in a worktree run with `--testPathIgnorePatterns "/node_modules/"`.

---

## Покрытие / Coverage

- Всего тест-кейсов: **39**
- **P0: 19** | **P1: 12** | **P2: 7** | **P3: 1**
- Unit (jest, mocked db): **10** | Integration (real local DB / prod copy, node scripts): **22** | Performance: **4** | Security: **3** (SEC01/02 real-DB, SEC03 jest)
- E2E: 0 (no frontend change; icons shipped in d455c52 — behavior verified through the API contract)

---

## Shared fixtures & harness

Used by the Integration section (no mocks anywhere in it; Gmail API is never called — `linkOutboundMessage` consumes an already-normalized message object, so the push boundary is simulated at the function argument, not at HTTP).

- **DB:** real local Postgres via `DATABASE_URL` (default `postgresql://localhost/twilio_calls`). Migration cases run mig 155 via `psql -f backend/db/migrations/155_backfill_outbound_email_links.sql` and capture `RAISE NOTICE` output. Correctness runs on local DB are fine; **performance runs only on a fresh prod `pg_dump` restore** (local dev DB has ~5 `email_messages` rows — disqualified by spec).
- **Script:** one seed+assert+cleanup node script per the house style of `scripts/test-dedup.js`; suggested `scripts/verify-email-outbound-001.js`, sections S1…S8 selectable by CLI arg. Route-level assertions mount the REAL `backend/src/routes/calls.js` in an express app with a stub auth middleware injecting `req.user` / `req.authz` (`pulse.view`) / `req.companyFilter = {company_id}` — same harness shape as the jest route layer, but with the real `db/connection` (unmocked). Results recorded in the PR (spec Test plan).
- **Companies:** A = `…000a`, B = `…000b` (both inserted into `companies`).
- **Contact C (email-only):** company A, `email='lead@example.com'`, matching `contact_emails` row (`email_normalized='lead@example.com'`), no phone activity.
- **Outbound-linked message (post-fix shape, as the send paths write it):** `email_messages(direction='outbound', company_id=A, thread_id=T, contact_id=C, timeline_id=TL, on_timeline=true, message_id_header='<x@mail>', to_recipients_json=[{"email":"lead@example.com"}])` + `email_threads T(company_id=A, subject, last_message_at, last_message_direction='outbound', unread_count=0)` + `timelines TL(contact_id=C, company_id=A, has_unread=false)`.
- **Historical unlinked message (pre-fix shape, mig-155 candidate):** same but `contact_id=NULL, timeline_id=NULL, on_timeline=false` (and for the email-only-contact case: NO timeline row at all).
- **Cleanup:** every script deletes its seeded rows (companies cascade) so re-runs are clean.

---

## 1. Unit — jest, mocked db (`tests/listPaginationByContact.test.js`, extend in place)

All cases extend the existing describe blocks; the db mock stays `jest.mock('../backend/src/db/connection')`, assertions read `db.query.mock.calls[0]` = `[sql, params]` (house style already in the file).

### TC-EO-U01: Existing suite stays green and UNTOUCHED (inbound leg + invariants pin)
- **Приоритет:** P0
- **Тип:** Unit (regression)
- **Связанный сценарий:** CTE rule 1; S3 regression clause; AC-3; Protected list
- **Предусловия:** the CTE rewrite is applied; NOT ONE existing assertion in `tests/listPaginationByContact.test.js` is edited, deleted, or loosened.
- **Шаги:** run the full existing file against the rewritten query.
- **Ожидаемый результат:** all pre-existing tests pass verbatim. They pin: `tl.company_id = $1` + param, SMS lateral scoping, `em.company_id = $1` / `et.company_id = $1` / `em.direction = 'inbound'` / `ce.email_normalized = lower(trim(em.from_email))` (the byte-identical inbound leg), `GREATEST(latest_call.started_at, sms.last_message_at, eml.last_message_at)`, unread rollup, `COUNT(*) OVER()`, 3 ORDER-BY bands + `tl.id DESC` tiebreak, `LIMIT $2 OFFSET $3`, surfacing WHERE incl. `open_task.id IS NOT NULL` + `eml.email_thread_id IS NOT NULL`, orphan-shadow dedup NOT EXISTS, AR-signal consistency, search `eml.email_subject ILIKE` / never `eml.subject`, and the whole route layer (envelope, order preservation, 401/403). Any edit to an existing assertion = FAIL of this case.
- **Файл для теста:** `tests/listPaginationByContact.test.js`

### TC-EO-U02: UNION ALL present; outbound leg carries the three exact predicates
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** CTE rules 2; FR-1
- **Входные данные:** `run()` with `{limit:50, offset:0, companyId: COMPANY_A}`.
- **Ожидаемый результат:** emitted SQL contains, inside the `email_by_contact` CTE (slice the SQL between `WITH email_by_contact AS` and the closing of the CTE / first top-level `SELECT`): the token `UNION ALL`; and the outbound-leg predicates exactly `em.direction = 'outbound'`, `em.contact_id IS NOT NULL`, `em.on_timeline = true`. Also the leg joins `email_threads et ON et.id = em.thread_id` (thread fields come from `et`, not from `em`).
- **Файл для теста:** `tests/listPaginationByContact.test.js` (describe `getUnifiedTimelinePage — SQL shape`)

### TC-EO-U03: `$1` company scope on BOTH tables in BOTH legs (occurrence-counted)
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** CTE rule 2; AC-5; Security §
- **Ожидаемый результат:** within the CTE slice, `em.company_id = $1` occurs **≥ 2 times** and `et.company_id = $1` occurs **≥ 2 times** (one per leg; regex match-count, comments stripped with the existing `--[^\n]*` scrub). `params[0] === companyId`; the company UUID never appears interpolated in the SQL text (existing U01 assertion re-used).
- **Файл для теста:** `tests/listPaginationByContact.test.js`

### TC-EO-U04: Hot query NEVER references recipient JSON
- **Приоритет:** P0
- **Тип:** Unit (negative)
- **Связанный сценарий:** CTE rule 2 ban; requirements constraint "per-row JSONB expansion banned"
- **Ожидаемый результат:** the ENTIRE emitted SQL (plain variant AND search variant) contains neither `to_recipients_json` nor `jsonb_array_elements`. Assert on both `run()` and `run({search:'x'})` outputs.
- **Файл для теста:** `tests/listPaginationByContact.test.js`

### TC-EO-U05: `DISTINCT ON (contact_id)` + deterministic ORDER incl. NEW `email_thread_id DESC` tie-break
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** CTE rule 3; S5; AC-4
- **Ожидаемый результат:** CTE slice contains `SELECT DISTINCT ON (contact_id)` and `ORDER BY contact_id, last_message_at DESC NULLS LAST, email_thread_id DESC` (bare aliases — the ordering is over the `legs` subquery, no `ce.`/`et.` prefixes). The tie-break token `email_thread_id DESC` is mandatory (it is the new deterministic equal-timestamp rule; its absence = plan-dependent ordering regression).
- **Файл для теста:** `tests/listPaginationByContact.test.js`

### TC-EO-U06: Frozen CTE output shape — six aliases, unchanged consumers
- **Приоритет:** P0
- **Тип:** Unit (regression)
- **Связанный сценарий:** CTE rule 4; API contract §
- **Ожидаемый результат:** CTE selects exactly the six columns/aliases `contact_id`, `email_thread_id`, `email_subject`, `last_message_at`, `last_message_direction`, `unread_count` (assert leg 1 aliases `et.id AS email_thread_id`, `et.subject AS email_subject` present; no seventh alias added). Outside the CTE (already partially pinned by U01): join `eml.contact_id = tl.contact_id`, surfacing `eml.email_thread_id IS NOT NULL`, outer aliases `email_last_message_at` / `email_last_message_direction` / `email_unread_count` all still present in the SQL.
- **Файл для теста:** `tests/listPaginationByContact.test.js`

### TC-EO-U07: Search variant intact over the rewritten CTE
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Edge 7; FR-6; d56db8f precedent
- **Входные данные:** `run({search:'Acme'})`.
- **Ожидаемый результат:** SQL contains `eml.email_subject ILIKE` and does NOT contain `eml.subject ILIKE`; params include `'%Acme%'`; the CTE shape assertions of U02/U03/U05 hold identically in the search variant (same builder path — assert at least UNION ALL + outbound predicates present).
- **Файл для теста:** `tests/listPaginationByContact.test.js`

### TC-EO-U08: Route maps outbound-first row → `email_outbound`, not unread, not AR
- **Приоритет:** P1
- **Тип:** Unit (route layer, query facade mocked)
- **Связанный сценарий:** S1 (route-compute half); FR-2/FR-3; AC-1
- **Входные данные:** fixture `row(N, {id:null, call_sid:null, started_at:null, email_thread_id:42, email_subject:'Intro', email_last_message_at:'2026-07-03T13:00:00Z', email_last_message_direction:'outbound', email_unread_count:0, any_unread:false, open_task_id:null})`.
- **Моки:** `mockGetUnifiedTimelinePage` returns the fixture (existing harness); `leadsService` inert.
- **Ожидаемый результат:** response row has `last_interaction_type='email_outbound'`, `last_interaction_at='2026-07-03T13:00:00Z'`, `has_unread=false`, `has_open_task=false`, `email_thread_id=42`. (Existing test `outbound-email attribution → type email_outbound` stays as-is; this case adds the unread/AR halves.)
- **Файл для теста:** `tests/listPaginationByContact.test.js` (describe `GET /api/calls/by-contact — route`)

### TC-EO-U09: Frozen response shape — envelope + per-row keys for an email-outbound row
- **Приоритет:** P0
- **Тип:** Unit (regression)
- **Связанный сценарий:** API contract § (explicitly NO changes); AC-4
- **Входные данные:** U08 fixture.
- **Ожидаемый результат:** envelope keys exactly `{conversations, leads_map, total, limit, offset}` (existing assertion re-run); the conversation row still carries every frozen field the frontend keys off: `last_interaction_at`, `last_interaction_type`, `last_interaction_phone`, `email_thread_id`, `email_subject`, `has_unread`, `tl_has_unread`, `sms_has_unread`, `sms_conversation_id`, `timeline_id`, `tl_phone`, `is_action_required`, `action_required_reason`, `action_required_set_at`, `snoozed_until`, `owner_user_id`, `has_open_task`, `open_task_count` — no field added/removed/renamed/retyped vs a pre-change snapshot of the same fixture.
- **Файл для теста:** `tests/listPaginationByContact.test.js`

### TC-EO-U10: Negative — DB failure keeps the existing 500 contract
- **Приоритет:** P2
- **Тип:** Unit (route layer, negative)
- **Связанный сценарий:** Error handling § (no new error codes)
- **Входные данные:** `mockGetUnifiedTimelinePage.mockRejectedValue(new Error('boom'))`.
- **Ожидаемый результат:** `GET /api/calls/by-contact` → 500 with body `{error:'Failed to fetch calls by contact'}` — unchanged message, no stack leak, no new code path.
- **Файл для теста:** `tests/listPaginationByContact.test.js`

---

## 2. Integration — real local DB, node scripts against real functions (NO mocks)

All cases run the REAL `timelinesQueries.getUnifiedTimelinePage` (and, where stated, the real `routes/calls.js` handler / real `emailTimelineService.linkOutboundMessage` / real mig 155 SQL) against seeded Postgres data. Script: `scripts/verify-email-outbound-001.js` (+ psql for the migration). Every case is also re-run once against the prod-copy restore before deploy (spec Test plan) — same script, `DATABASE_URL` pointed at the copy.

### TC-EO-I01: S1 — outbound-first (composer-linked) thread surfaces correctly
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S1; FR-1/FR-2/FR-3; AC-1
- **Предусловия:** shared fixtures: company A, contact C (email-only), post-fix outbound-linked message + thread T (`unread_count=0`, `last_message_direction='outbound'`, `last_message_at=t1`) + timeline TL. Zero calls/SMS/inbound email/open tasks.
- **Шаги:** 1) call real `getUnifiedTimelinePage({limit:50, offset:0, companyId:A})`; 2) GET `/api/calls/by-contact` through the real route harness.
- **Ожидаемый результат:** (1) exactly one row for TL: `email_thread_id=T`, `email_subject` from T, `email_last_message_at=t1`, `email_last_message_direction='outbound'`, `email_unread_count=0`, `any_unread=false`, `total_count` includes the row; (2) route row: `last_interaction_type='email_outbound'`, `last_interaction_at=t1`, `has_unread=false`, `has_open_task=false` (tier 2, not AR-pinned).
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section s1)

### TC-EO-I02: S2 — Gmail-direct send is list-identical to S1 (real `linkOutboundMessage`)
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S2; FR-4; AC-2 (surface half)
- **Предусловия:** contact C; an UNLINKED outbound `email_messages` row + thread (as ingested pre-link: `contact_id NULL, on_timeline=false`), `unread_count` seeded to a non-zero value to prove the clear.
- **Шаги:** invoke the real `emailTimelineService.linkOutboundMessage` with a normalized outbound message fixture (`labelIds` WITHOUT `'DRAFT'`, TO = `lead@example.com`), then fetch the list.
- **Ожидаемый результат:** the writer (protected, unchanged — this asserts equivalence, not new behavior) stamps `contact_id=C / timeline_id / on_timeline=true` and `markThreadRead` zeroes `unread_count`; the list row is byte-identical in shape/values to I01 (`email_outbound`, not unread, not AR). First-matching-recipient rule: with TO = `[unknown@x.com, lead@example.com]` the link still lands on C (first MATCHING wins).
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section s2)

### TC-EO-I03: S3 — reply flips to inbound+unread; mark-read clears; NO duplicate row
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S3; AC-3; EMAIL-UNREAD-001 flow
- **Предусловия:** I01 state.
- **Шаги:** 1) simulate the reply as sync writes it: insert inbound `email_messages` (direction='inbound', `from_email='Lead@Example.com '` — mixed case + trailing space to exercise `lower(trim())`, thread T, company A) and update thread T: `last_message_at=t2>t1`, `last_message_direction='inbound'`, `unread_count=1`; 2) fetch list; 3) POST real `/api/calls/timeline/:TL/mark-read` (and repeat via `/contact/:C/mark-read`); 4) fetch again.
- **Ожидаемый результат:** after (2): still exactly ONE row for C (both legs now emit the same thread tuple → `DISTINCT ON` collapses), `last_interaction_at=t2`, `last_interaction_type='email_inbound'`, `has_unread=true` (unread tier); after (4): `has_unread=false`, position/timestamps unchanged (`email_last_message_at` still t2). The mark-read route's inbound-join clearing works with zero changes.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section s3)

### TC-EO-I04: S4 — mixed-channel bump: existing row re-orders, no duplicate, tie keeps call priority
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S4; AC-4 (one row); route tie rule
- **Предусловия:** contact C2 in company A with timeline TL2 + one completed call at t0; a second contact C3 with a call at t_mid (t0 < t_mid) to give the list two rows.
- **Шаги:** 1) fetch list (baseline: C3 above C2); 2) link an outbound email to C2 with thread `last_message_at=t3 > t_mid`; 3) fetch; 4) tie probe: set C2's email thread `last_message_at` exactly = C2's call `started_at`; 5) fetch.
- **Ожидаемый результат:** after (3): C2's EXISTING row (same `timeline_id`) moves above C3, `last_interaction_at=t3`, `last_interaction_type='email_outbound'`; row count and `total` unchanged vs (1) — no duplicate row for C2. After (5): `last_interaction_type='call'` (exact-tie priority call > sms > email preserved by the route).
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section s4)

### TC-EO-I05: S5 — two threads, one contact: newest wins across directions + deterministic tie
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S5; CTE rule 3; AC-4
- **Предусловия:** contact C with thread T1 (inbound-matched only: inbound message from C's address, `last_message_at=t1`) and thread T2 (outbound-linked only, `last_message_at=t2 > t1`).
- **Шаги:** 1) fetch → assert; 2) bump T1 with a newest inbound reply (`last_message_at=t3 > t2`, direction inbound, unread 1) → fetch; 3) set `T1.last_message_at = T2.last_message_at` exactly (and both directions distinct) → fetch.
- **Ожидаемый результат:** (1) ONE row for C with `email_thread_id=T2`, subject/direction/time from T2; (2) row flips back to T1 (`email_inbound`, unread); (3) the thread with the HIGHER `email_threads.id` wins — deterministic, stable across repeated fetches (run the fetch 3× and assert identical result; pre-fix this was plan-dependent). Symmetric check: older outbound-only + newer inbound thread also picks the newer.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section s5)

### TC-EO-I06: S6 — outbound to a NON-contact recipient surfaces nothing (negative)
- **Приоритет:** P0
- **Тип:** Integration (negative)
- **Связанный сценарий:** S6; requirements scenario 5 (second half)
- **Предусловия:** outbound message in company A, `to_recipients_json=[{"email":"stranger@nowhere.com"}]` matching NO contact; stored as the ingest path leaves it: `contact_id NULL, on_timeline=false`; its thread exists.
- **Шаги:** 1) (optional writer half) run real `linkOutboundMessage` with that TO → expect `{skipped:'no_contact'}`; 2) fetch list; 3) run mig 155; 4) fetch again.
- **Ожидаемый результат:** no list row ever references the thread; no contact auto-created (contacts count unchanged); after mig 155 the message is STILL unlinked (`contact_id IS NULL`) — the migration matched nothing. `total` unchanged throughout.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section s6)

### TC-EO-I07: S7 — DRAFT never surfaces, pre- and post-migration (negative)
- **Приоритет:** P0
- **Тип:** Integration (negative)
- **Связанный сценарий:** S7; mig 155 step 1 draft guard; AC-2 (draft half)
- **Предусловия:** outbound `email_messages` row shaped like a stored draft: `direction='outbound'`, `contact_id NULL`, `on_timeline=false`, `message_id_header NULL` (second variant: `''`), TO matching contact C.
- **Шаги:** 1) fetch list; 2) run mig 155; 3) fetch list; 4) writer half: call `linkOutboundMessage` with `labelIds` INCLUDING `'DRAFT'` → expect skip, row untouched; 5) "send later": set `message_id_header='<real@id>'` on a fresh copy, re-run mig 155 → now links (degenerates to S1).
- **Ожидаемый результат:** (1)(3) draft never yields a list row or timeline entry; mig 155 links 0 rows for both NULL and `''` header variants (the `listUnlinkedOutboundForTimeline` discriminator quoted verbatim: `message_id_header IS NOT NULL AND message_id_header <> ''`); (5) the genuinely-sent copy links and surfaces.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section s7)

### TC-EO-I08: S8 — migration 155 happy path: historical rows link; missing timeline is CREATED
- **Приоритет:** P0
- **Тип:** Integration (migration)
- **Связанный сценарий:** S8; FR-5/D1; mig 155 steps 1–3; AC-1 (historical)
- **Предусловия:** two pre-fix candidates in company A: (a) contact C_a WITH an existing timeline, unlinked outbound message M_a (TO matches via `contact_emails.email_normalized`); (b) EMAIL-ONLY contact C_b with NO timeline row at all, unlinked outbound message M_b (TO matches via `lower(contacts.email)` — covers the OR-branch of the `findEmailContact` mirror). Both: `message_id_header` present, threads with distinct `last_message_at`.
- **Шаги:** 1) fetch list (baseline: neither surfaces); 2) apply mig 155 via psql, capture NOTICE output; 3) fetch list.
- **Ожидаемый результат:** NOTICE counts: messages linked = 2, timelines created = 1 (C_b), orphans adopted = 0, tasks re-homed = 0. M_a/M_b now carry `contact_id / timeline_id / on_timeline=true`; C_a reuses the EXISTING timeline (no second row created — timelines count for C_a unchanged); C_b has exactly one NEW timeline. List surfaces both as S1 rows ordered by their threads' `last_message_at`; a seeded variant thread with a later unanswered inbound reply correctly shows inbound + unread (direction/unread come from the thread AS-IS; migration never touches `unread_count` — assert C_a's thread `unread_count` value is byte-identical before/after).
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section s8) + `backend/db/migrations/155_…sql`

### TC-EO-I09: Migration 155 idempotency — second run is an all-zeros no-op
- **Приоритет:** P0
- **Тип:** Integration (migration, negative)
- **Связанный сценарий:** S8 ("re-running changes nothing"); mig 155 contract
- **Предусловия:** I08 just ran.
- **Шаги:** snapshot `email_messages` (linked set), `timelines` (count + `updated_at`s), `tasks.thread_id`s; apply mig 155 AGAIN; re-snapshot; fetch list.
- **Ожидаемый результат:** every NOTICE count = 0; snapshots byte-identical (linked rows fail `contact_id IS NULL`; `DO NOTHING` arbiter bumps no `updated_at`); list output identical.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section mig-rerun)

### TC-EO-I10: Migration 155 matches TO only — a CC-only match must NOT link (negative)
- **Приоритет:** P0
- **Тип:** Integration (migration, negative)
- **Связанный сценарий:** mig 155 step 1 ("TO only — CC/BCC never matched", mirrors `extractRecipientEmails`); Out-of-scope §
- **Предусловия:** unlinked outbound candidate whose `to_recipients_json` contains ONLY non-matching addresses while the contact's address appears ONLY in the CC field of the stored message (and a BCC variant); `message_id_header` present.
- **Шаги:** apply mig 155; fetch list.
- **Ожидаемый результат:** message remains `contact_id IS NULL, on_timeline=false`; linked-count NOTICE excludes it; nothing surfaces. Also assert the recipient normalization: a TO entry `{"email":" LEAD@Example.COM "}` on a separate candidate DOES link (lower/trim applied), and TO entries with NULL/empty `email` keys are skipped without error.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section mig-to-only)

### TC-EO-I11: Migration 155 — first matching TO recipient wins; contact tie-break parity
- **Приоритет:** P1
- **Тип:** Integration (migration)
- **Связанный сценарий:** mig 155 step 1 (`DISTINCT ON (em.id) ORDER BY em.id, ord ASC, c.updated_at DESC NULLS LAST, c.id ASC`); S2 parity
- **Предусловия:** (a) candidate with TO = `[addr_X (matches contact X), addr_Y (matches contact Y)]` in that array order; (b) candidate whose single TO address matches TWO contacts (same address on both), with distinct `updated_at`.
- **Шаги:** apply mig 155.
- **Ожидаемый результат:** (a) links to X — ordinality, not id order, decides (swap array order in a second run after cleanup → links to Y); (b) links to the contact with the newest `updated_at` (NULLS LAST, then lowest id) — exact `findEmailContact` parity, one contact per message, never two links.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section mig-recipient-pick)

### TC-EO-I12: Migration 155 — orphan ADOPTION instead of fork + calls re-point + task sweep
- **Приоритет:** P1
- **Тип:** Integration (migration)
- **Связанный сценарий:** mig 155 step 2(b) + step 4; ORPHAN-TASK-REHOME-001 bug class
- **Предусловия:** contact C_o (with phone P, matching TO address) has NO contact-linked timeline; an ORPHAN timeline O exists (`contact_id NULL`, `phone_e164` digits = P's digits), carrying: one call (`calls.timeline_id=O, contact_id NULL`) and one OPEN task (`tasks.thread_id=O`); one unlinked outbound candidate to C_o.
- **Шаги:** apply mig 155; fetch list.
- **Ожидаемый результат:** NO new timeline row (timelines count unchanged): O is ADOPTED — `O.contact_id=C_o`, `O.phone_e164 NULL`, `updated_at` bumped; the call's `contact_id` re-pointed to C_o; the open task still reachable (AR band pins the row — `has_open_task=true`); NOTICE counts: orphans adopted = 1, timelines created = 0, tasks re-homed as applicable. The list shows ONE row for C_o carrying BOTH the call history and the email signal — a bare-INSERT fork (two timelines, hidden call history) = FAIL.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section mig-adopt)

### TC-EO-I13: Migration 155 — two matched contacts share one orphan (corner)
- **Приоритет:** P2
- **Тип:** Integration (migration)
- **Связанный сценарий:** mig 155 step 2(b) corner ("double DISTINCT ON")
- **Предусловия:** contacts C1 and C2 (both TO-matched by two different candidates, neither has a timeline) whose phone digits BOTH match the single orphan O.
- **Шаги:** apply mig 155 twice (second = idempotency).
- **Ожидаемый результат:** exactly ONE of C1/C2 adopts O (deterministic per the stable ORDER BY — assert the same winner on a fresh re-seed), the other falls through to CREATE (one new timeline); both messages linked; no timeline has two contacts, no contact has two timelines; second run = all zeros.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section mig-orphan-contention)

### TC-EO-I14: Migration 155 — create path arbiter: `ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL DO NOTHING` + re-select
- **Приоритет:** P1
- **Тип:** Integration (migration)
- **Связанный сценарий:** mig 155 step 2(c) — the two pinned deltas from the JS helper
- **Предусловия:** static half: the migration file text; behavioral half: contact C with an EXISTING timeline whose `updated_at` is recorded, plus one unlinked candidate to C.
- **Шаги:** 1) grep the migration file; 2) apply mig 155; 3) compare `updated_at`.
- **Ожидаемый результат:** (1) the INSERT carries the arbiter verbatim `ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL DO NOTHING` (WITHOUT the WHERE clause Postgres cannot infer the mig 029 partial unique — an arbiter-less or clause-less variant = FAIL) and there is NO `DO UPDATE SET updated_at` in the create step; (2) the message links to the EXISTING timeline (re-select found it); (3) that timeline's `updated_at` is UNCHANGED (untouched rows never bumped).
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section mig-arbiter) + static grep of `155_…sql`

### TC-EO-I15: Migration 155 — empty-data run is a clean no-op (negative)
- **Приоритет:** P1
- **Тип:** Integration (migration, negative)
- **Связанный сценарий:** mig 155 contract ("safe on empty data"); Error handling § (single transaction)
- **Предусловия:** a DB (fresh schema at mig 154) with ZERO candidate rows — and separately zero `email_messages` at all.
- **Шаги:** apply mig 155; apply rollback file.
- **Ожидаемый результат:** migration completes without error, every NOTICE prints 0, no rows written; `rollback_155_…sql` exists, runs without error, and documents the one-way posture (PITR; it must NOT attempt to NULL links — assert no `UPDATE email_messages` in the rollback file).
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section mig-empty)

### TC-EO-I16: Edge 5 — contact deleted → link SET NULL → message leaves leg 2
- **Приоритет:** P2
- **Тип:** Integration (negative)
- **Связанный сценарий:** Edge 5; mig 129 FK
- **Предусловия:** I01 state (linked outbound-first row surfacing).
- **Шаги:** DELETE the contact C; fetch list.
- **Ожидаемый результат:** `email_messages.contact_id` is NULL (FK `ON DELETE SET NULL`); the email tuple leaves leg 2; no list row carries a dangling email attribution for the deleted contact; no query error.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section edge-contact-delete)

### TC-EO-I17: Edge 2 — NULL `last_message_at` ordering (NULLS LAST inside CTE, GREATEST outside)
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** Edge 2
- **Предусловия:** contact C with two linked outbound threads: T_null (`last_message_at NULL`) and T_ts (timestamped); second contact C_onlynull with ONLY a NULL-timestamped linked thread and no other signals.
- **Шаги:** fetch list.
- **Ожидаемый результат:** C's row picks T_ts (NULLS LAST demotes T_null); C_onlynull STILL surfaces (`email_thread_id IS NOT NULL`) with `email_last_message_at` NULL and sorts LAST within its tier (`GREATEST` of all-NULL channels → NULL); no crash, no row loss.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section edge-null-ts)

### TC-EO-I18: Edges 3+4 — multi-address contact + many outbound messages collapse to ONE row
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** Edges 3, 4; CTE rule 5
- **Предусловия:** contact C with THREE `contact_emails` rows; ONE thread with 5 linked outbound messages AND 2 inbound messages (from two different of C's addresses) — so leg 1 emits multiple tuples and leg 2 emits 5 tuples, all for the same thread; plus a second thread to prove newest still wins under fan-out.
- **Шаги:** fetch list; fetch page with `limit=1, offset=0` and `offset=1`.
- **Ожидаемый результат:** exactly ONE row for C (DISTINCT ON collapses all fan-out); the pagination probe shows no phantom second row for C on offset 1; `total_count` counts C once.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section edge-fanout)

### TC-EO-I19: Edge 7 / FR-6 — search hits an outbound-first thread's subject
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Edge 7; FR-6; AC-1 discoverability
- **Предусловия:** I01 state with thread subject `'Granite countertop quote'`; contact name/phone deliberately NOT containing the term.
- **Шаги:** 1) real query with `search:'granite'` (case-insensitive probe); 2) `search:'zzz-no-match'`; 3) regression: search by a term matching only an INBOUND-first thread's subject of another contact.
- **Ожидаемый результат:** (1) returns C's row (predicate `eml.email_subject ILIKE`), `total_count=1`; (2) empty page, `total=0`, HTTP 200 (no 500 — the d56db8f alias regression stays dead); (3) inbound-search behavior unchanged.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section search)

### TC-EO-I20: Edge 1 — company with no email at all (sanity, negative)
- **Приоритет:** P2
- **Тип:** Integration (negative)
- **Связанный сценарий:** Edge 1
- **Предусловия:** company A2 with one call-only timeline and ZERO `email_messages`/`email_threads`.
- **Шаги:** fetch list for A2.
- **Ожидаемый результат:** CTE yields zero rows; LEFT JOIN gives NULL email fields; the call row surfaces normally with `email_thread_id NULL`; no error; `total` = 1.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section edge-no-email)

### TC-EO-I21: Edge 9 — pagination invariants + AR pinning unaffected by email direction
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Edge 9; AC-4; LIST-PAGINATION-001 invariants
- **Предусловия:** ~12 surfaced timelines in company A: mix of call-only, SMS, inbound-email, several outbound-email-only (from I01-style seeds), one open-task AR row, one shadow-orphan pair (orphan on a contact's secondary phone).
- **Шаги:** fetch `limit=5, offset=0`, `offset=5`, `offset=10`; repeat with a search term.
- **Ожидаемый результат:** every page ≤ limit and never shrunk post-query (dedup/surfacing decided in SQL before LIMIT — the shadow orphan is absent from ALL pages, not dropped from one); pages pairwise disjoint by `timeline_id`; `total_count` identical on every page and equals the full surfaced count; the AR (open-task) row is pinned tier-0 ABOVE newer outbound-email rows (email direction never promotes into/out of the AR band); outbound-email-only rows order among tier-2 by `GREATEST` recency.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section pagination)

### TC-EO-I22: Edge 6 — orphan (contactless) timelines never gain email signal
- **Приоритет:** P3
- **Тип:** Integration (negative)
- **Связанный сценарий:** Edge 6
- **Предусловия:** orphan timeline (contact_id NULL, phone set, one call so it surfaces) in company A; separately a linked outbound email for an unrelated contact.
- **Шаги:** fetch list.
- **Ожидаемый результат:** the orphan's row has ALL email fields NULL (`NULL = NULL` join never matches); the email row belongs only to its contact's timeline.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section edge-orphan)

---

## 3. Performance — P0 deploy gate (AC-6, PULSE-PERF-001 methodology)

Prod-sized data ONLY (fresh prod `pg_dump` restore or read-only on prod from the app container). Local dev DB is disqualified (5 email rows). Results (plans + timings + NOTICE counts) are recorded in the PR — this is a blocking gate, not advisory.

### TC-EO-P01: EXPLAIN (ANALYZE, BUFFERS) before/after × plain/search — plan acceptance
- **Приоритет:** P0
- **Тип:** Performance (integration, prod copy)
- **Связанный сценарий:** AC-6; Performance acceptance §1–2
- **Предусловия:** prod-copy restore; the EXACT production SQL captured from `getUnifiedTimelinePage` (both variants), real params: Boston Masters company UUID, `limit 50 / offset 0`, search term for the search variant.
- **Шаги:** four runs: {before, after} × {plain, search}; save plans.
- **Ожидаемый результат:** `email_by_contact` evaluated ONCE (single CTE node, no per-timeline re-scan); NO per-row Seq Scan over `email_messages`; leg 1 served by mig 143 `idx_email_messages_from_normalized`; leg 2 served by mig 129 partial `idx_email_messages_contact_timeline` (company_id prefix + partial condition drive it; `direction`/`on_timeline` acceptable as residual filters over the small linked set); total latency ≈ current ~0.3s baseline (no regression class change). FAIL → TC-EO-P03.
- **Файл для теста:** psql session on prod copy; plans attached to PR

### TC-EO-P02: Real function timed in the app container (before/after)
- **Приоритет:** P0
- **Тип:** Performance
- **Связанный сценарий:** AC-6; Performance acceptance §3; PULSE-PERF-001 discipline ("time the real function, not just EXPLAIN")
- **Предусловия:** app container (prod, read-only, during the consented deploy window — deploy itself only with explicit owner consent).
- **Шаги:** node one-liner requiring `timelinesQueries` and timing `getUnifiedTimelinePage({limit:50, offset:0, companyId:<Boston Masters>})` and the search variant, N=5 runs each, before and after the code lands.
- **Ожидаемый результат:** after ≈ before (~0.3s class); no run shows the PULSE-PERF-001 pathology (multi-second). Record numbers in the PR.
- **Файл для теста:** node one-liner in app container (documented in PR)

### TC-EO-P03: Escape hatch — mig 156 only on gate failure, predicate verbatim
- **Приоритет:** P1
- **Тип:** Performance (conditional)
- **Связанный сценарий:** Performance acceptance §4
- **Предусловия:** TC-EO-P01 FAILED on leg 2 (and only then — creating mig 156 with a green P01 = FAIL of this case: no speculative indexes).
- **Шаги:** create mig 156 `CREATE INDEX … ON email_messages (company_id, contact_id, thread_id) WHERE direction = 'outbound' AND contact_id IS NOT NULL AND on_timeline = true` (predicate byte-equal to leg 2 — PULSE-PERF-001 rule: expression = exact copy of the predicate); re-run P01/P02.
- **Ожидаемый результат:** gate passes with the new index in the leg-2 plan; if P01 passed originally, assert mig 156 does NOT exist in the branch.
- **Файл для теста:** `backend/db/migrations/156_…` (conditional) + re-run of P01/P02

### TC-EO-P04: Migration 155 prod-copy dry run — counts recorded
- **Приоритет:** P2
- **Тип:** Performance / migration ops
- **Связанный сценарий:** Performance acceptance §5; mig 155 Observability
- **Предусловия:** prod-copy restore.
- **Шаги:** apply mig 155 once, then a second time.
- **Ожидаемый результат:** first run completes inside the single migration transaction in acceptable one-shot time (no lock storm on `timelines`/`email_messages`); per-step NOTICE counts (linked N / adopted K / created M / re-homed T) captured into the PR; second run prints all zeros (prod-scale idempotency proof).
- **Файл для теста:** psql on prod copy; output pasted in PR

---

## 4. Security — tenant isolation (P0) + middleware regressions

### TC-EO-SEC01: Cross-tenant list isolation — same address in two companies (Edge 8 / AC-5)
- **Приоритет:** P0
- **Тип:** Integration (real DB, negative)
- **Связанный сценарий:** Edge 8; AC-5; LIST-PAGINATION-001 SMS-leak precedent
- **Предусловия:** company A: contact C_A (`shared@example.com`) + linked outbound-first thread (leg-2 shape) + an inbound-matched thread (leg-1 shape). Company B: contact C_B with the SAME address `shared@example.com`, plus one call-only timeline so B's list is non-empty.
- **Шаги:** fetch the real list (query + route) as company B; then as company A. Direct-access probe: fetch B's list and search B by A's email subject term.
- **Ожидаемый результат:** B's list NEVER contains A's threads/subjects/timestamps — neither via leg 1 (the address matches B's `contact_emails`, but A's messages fail `em.company_id = $1`/`et.company_id = $1`) nor via leg 2 (A's `contact_id` link is A-scoped); B's search on A's subject returns 0. A's own fetch shows both threads normally. Any leak = release blocker.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section sec-cross-tenant)

### TC-EO-SEC02: Migration 155 never links across tenants (negative)
- **Приоритет:** P0
- **Тип:** Integration (migration, negative)
- **Связанный сценарий:** Security § ("matching never crosses tenants"); Edge 8
- **Предусловия:** unlinked outbound candidate in company A whose TO address matches a contact existing ONLY in company B (no A-contact match); plus an A-candidate matching an A-contact as control.
- **Шаги:** apply mig 155.
- **Ожидаемый результат:** the cross-tenant candidate stays `contact_id IS NULL, on_timeline=false` (`c.company_id = em.company_id` join); NO timeline created/adopted in B on A's behalf; the control candidate links normally; B's list unchanged.
- **Файл для теста:** `scripts/verify-email-outbound-001.js` (section sec-mig-tenant)

### TC-EO-SEC03: Middleware regressions stay green — 401 / 403 / company source
- **Приоритет:** P1
- **Тип:** Unit (jest route layer, regression)
- **Связанный сценарий:** Behavior scenarios preamble (mount chain); Error handling §
- **Предусловия:** existing jest cases in `tests/listPaginationByContact.test.js`.
- **Ожидаемый результат:** unchanged and passing: no company context → 401 `{error:'No company context'}` AND `getUnifiedTimelinePage` NOT called (no page query without tenant); missing `pulse.view`/`reports.calls.view` → 403; `companyId` passed to the query comes ONLY from `req.companyFilter.company_id` (assert call args), never from query-string/client input.
- **Файл для теста:** `tests/listPaginationByContact.test.js`

---

## Traceability

| Spec item | Test cases |
|---|---|
| S1 | I01, U08, U09 |
| S2 | I02, I11 (recipient rules) |
| S3 | I03, U01 (inbound regression) |
| S4 | I04 |
| S5 | I05, U05 |
| S6 | I06 |
| S7 | I07 |
| S8 / mig 155 | I08, I09, I10, I11, I12, I13, I14, I15, P04, SEC02 |
| CTE rules 1–6 | U01–U06 (rule 6 header-comment update = reviewer checklist item, not a test) |
| Edge 1–9 | I20, I17, I18(3), I18(4), I16, I22, I19, SEC01, I21 |
| FR-1…FR-6 | U02/U06, I01, I01/I02/I03 (unread), I01+I02 (send paths), I08 (historical), I19/U07 (search) |
| AC-1…AC-6 | I01/I08; I02/I07; I03; I05/I18/I21/U09; SEC01/SEC02/U03; P01/P02/P03 |
| Unread invariant D2/FR-3 ("asserted, not assumed") | I01, I02 (clear-on-link), I03 (grow-on-inbound + mark-read), I08 (migration never touches unread) |
| Frozen response shape | U09, U06, I01 (real values) |
| Pagination invariants | I21, I18 (probe), U01 (LIMIT/OFFSET params) |

**Notes for the Implementer/Tester agents:** (1) existing assertions in `tests/listPaginationByContact.test.js` are a frozen contract — extend, never edit; (2) integration script must be self-cleaning and re-runnable; (3) mig-155 cases re-verify max migration number = 154 immediately before creating the file (parallel branches); (4) prod deploy (incl. P02 timing window) only with explicit owner consent.
