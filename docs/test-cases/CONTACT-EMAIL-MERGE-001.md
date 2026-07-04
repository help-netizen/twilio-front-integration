# Тест-кейсы: CONTACT-EMAIL-MERGE-001 — adding an email to a contact merges that address's correspondence (email analogue of the phone-merge)

**Source spec:** `Docs/requirements.md` §CONTACT-EMAIL-MERGE-001 (FR-1…FR-8, AC-1…AC-8, user scenarios 1–7, decisions D1–D3) + `Docs/architecture.md` §CONTACT-EMAIL-MERGE-001 (Decisions A–D, emptiness table, FK-order recipe B3). Backend change points: **NEW** `backend/src/services/contactEmailMergeService.js` (`resolveAddedEmail`, `mergeContacts`, `isContactEmailOnly`, `linkInboxMessages`); `backend/src/routes/contacts.js` `PATCH /:id` (accept `emails[]`, wrap contact-update + emails-upsert + per-address `resolveAddedEmail` in ONE tx before `res.json`); `backend/src/services/contactDedupeService.js` (export `enrichEmail` + `getAdditionalEmails`, defined-but-unexported today); `backend/src/services/contactsService.js` (`emails` on contact detail); `backend/src/db/emailQueries.js` (new `listMessageIdsForAddress`); reused unchanged: `emailQueries.findEmailContact` / `linkMessageToContact`, `timelinesQueries.findOrCreateTimelineByContact` / `reassignShadowOrphanOpenTasks`. Frontend: `frontend/src/components/contacts/EditContactDialog.tsx` + `frontend/src/services/contactsApi.ts`.

**House lesson (LIST-PAGINATION-001, binding):** mocked jest validates the SQL **string / dispatch shape** only — it mocks `db`, so it can NOT prove a row moved, a contact was deleted, or an FK was left dangling. Every behavior claim below therefore has a real-DB integration case. The unit section pins dispatch + contract; the integration section pins behavior against real Postgres (`scripts/verify-contact-email-merge-001.js`, tag `CEM1`, self-seeding/self-cleaning, PASS/FAIL per case + sabotage control), exactly as `scripts/verify-tasks-count-001.js` / `scripts/verify-email-outbound-001.js` do.

**Jest gotcha:** in a worktree run with `--testPathIgnorePatterns "/node_modules/"`.

**Migration:** NONE expected (Decision D — mig 025 `contact_emails` + mig 143 `idx_email_messages_from_normalized` cover every lookup). If one becomes necessary the next free number is **156** (re-verify max — parallel branches).

---

## Scenario map (spec → S-id used below)

| S-id | Meaning | Source | Priority focus |
|------|---------|--------|----------------|
| **S1** | Add email with **inbox-only** correspondence (`contact_id NULL`) → link onto target timeline | user-scenario 1, D3, FR-3 bullet 1, AC-1 | P1 |
| **S2** | Add email owned by an **email-only auto-contact** → FULL MERGE + delete dup, re-home its open task | user-scenario 2, D2a, FR-3 bullet 2 + FR-4, AC-2 + AC-7 | **P0 (must-pass — no dangling FK)** |
| **S3** | Add email owned by a contact **WITH identity/data** (phone + job) → re-point emails only, keep contact | user-scenario 3, D2b, FR-3 bullet 3, AC-3 | P1 |
| **S4** | Add email with **no correspondence** → just recorded in `contact_emails` | user-scenario 4, FR-2, AC-4 | P2 |
| **S5** | **Multi-email** list + editing the **primary** persists to `contact_emails` (closes the pre-existing gap) | user-scenarios 5 + 6, FR-1/FR-2, AC-5 | P1 |
| **S6** | **Idempotence** — re-run same add → no-op, no second delete, identical state | FR-5, AC-7, D-idempotency | P1 |
| **S7** | **Cross-tenant** — address also used by company-B contact never merged into company-A target | FR-6, AC-6, constraints | **P0 (must-pass — security)** |
| **S8** | **Removal** (non-destructive) — drop an email → `contact_emails` row gone, already-linked history preserved | user-scenario 7, FR-8, Decision C.3 | P2 |

**The two P0 must-pass gates:** **S2** (full-merge leaves ZERO dangling rows and re-homes the open task, not CASCADE-deletes it) and **S7** (no cross-tenant read / move / delete). A red on either blocks the release.

---

## Покрытие / Coverage

- Всего тест-кейсов: **34** (numbered) + **7** regression/protected items = **41**.
- **Numbered cases by priority — P0: 13 | P1: 13 | P2: 7 | P3: 1.** Regression items — P0: 1 | P1: 2 | P2: 2 | P3: 2.
- **Unit (jest, mocked db): 13** | **Integration (real DB, `scripts/verify-contact-email-merge-001.js`): 17** | **Frontend (manual + build): 4**.
- Security (cross-tenant): **3** (TC-CEM-I09 + TC-CEM-I10 real-DB + TC-CEM-U03/U05/U08 dispatch guards). Sabotage negative control: **1** (TC-CEM-ISAB).

---

## Shared fixtures & harness (Integration section)

House pattern of `scripts/verify-tasks-count-001.js` (**no mocks anywhere in this section** — Gmail API is never called; `resolveAddedEmail` consumes an already-normalized address, so the ingest boundary is simulated at the function argument, not at HTTP):

- **Script:** `scripts/verify-contact-email-merge-001.js`, sections `s1…s8` + `sab` selectable via `--section=<id>|all`. `DATABASE_URL` defaults to `postgresql://localhost/twilio_calls` (house default; never point at prod). Exit 0 only when no case FAILs.
- **Unique tag `CEM1`** on every seeded row for self-cleaning: contacts `full_name LIKE 'CEM1 %'`, companies `id IN {A, B-tagged}`, timelines by tagged company / tagged contact, tasks `title LIKE 'CEM1 %'`, `contact_emails` by tagged contact, `email_messages`/`email_threads` by tagged company + `from_email LIKE '%@cem1.test'`. **Cleanup runs at process start, before EACH case, and at end**, FK order: tasks → email_messages → email_threads → timelines → business entities → contact_emails → contacts → crm_users → companies.
- **Companies:** A = seed `00000000-0000-0000-0000-000000000001` (real dev rows coexist → assertions are delta / tagged-scoped, never absolute whole-company counts); **B** = tagged `c0000000-0000-4000-8000-0000000000e1`, CREATED + deleted here (cross-tenant).
- **Real functions exercised (unmocked):** `contactEmailMergeService.resolveAddedEmail` / `mergeContacts` / `isContactEmailOnly`; the real `PATCH /api/contacts/:id` handler mounted in an express app with a stub auth middleware injecting `req.user` / `req.authz` (`contacts.edit`) / `req.companyFilter = {company_id: A}` (same harness shape as the jest route layer, real `db/connection`); `emailQueries.findEmailContact` / `linkMessageToContact` / `listMessageIdsForAddress`; `timelinesQueries.findOrCreateTimelineByContact` / `reassignShadowOrphanOpenTasks`.
- **Seed builders (tagged CEM1):** `mkContact(company, {name, phone})`, `mkTimeline(company, {contactId})` (chk_timelines_identity: contact_id OR phone), `mkEmailThread(company, {subject, lastAt, direction})`, `mkEmailMessage(company, {fromEmail, contactId, timelineId, onTimeline, threadId, providerMessageId, direction})`, `mkContactEmail(contactId, {email, isPrimary})`, `mkJob(company, {contactId})`, `seedOpenTask(company, {threadId, contactId, owner, status:'open'})` (an Action-Required task = the ORPHAN-TASK-REHOME-001 trap subject).
- **The "dangling FK" scan (S2 core):** after a full-merge, assert **zero** rows reference the deleted dup id across **every** `contact_id`/`thread_id` FK enumerated in the architecture emptiness table — `email_messages.contact_id`, `contact_emails.contact_id`, `contact_addresses.contact_id`, `tasks.contact_id`, `tasks.thread_id (= dupTl)`, `jobs/leads/estimates/invoices/payment_transactions/stripe_payment_sessions/portal_*/crm_*` `.contact_id`, `timelines.contact_id` — plus `SELECT 1 FROM contacts WHERE id = dupId` returns 0 and `SELECT 1 FROM timelines WHERE id = dupTl` returns 0.

---

## 1. Unit — jest, mocked db (`tests/contactEmailMerge.test.js` NEW; PATCH cases extend `tests/*contacts*` route suite)

`jest.mock('../backend/src/db/connection')`; dispatch/contract assertions read the mocked query calls and the branch actually taken. These pin the **decision tree and the request contract** — never "a row moved" (that is the integration section's job).

### TC-CEM-U01: `resolveAddedEmail` — inbox-only (no owner) → link-only, no `mergeContacts`
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S1; D3; architecture Decision B `resolveAddedEmail` bullet 1
- **Предусловия:** `findEmailContact`-style lookup mocked to return **no owning contact** for `emailNormalized`; `findOrCreateTimelineByContact` → `timelineId=TL`; `listMessageIdsForAddress` → `['m1','m2']`.
- **Входные данные:** `resolveAddedEmail(target=10, 'a@cem1.test', companyId=A, client)`.
- **Ожидаемый результат:** dispatch calls `linkInboxMessages`, which calls `linkMessageToContact('m1', A, {contact_id:10, timeline_id:TL, on_timeline:true})` and the same for `'m2'`; `mergeContacts` is **never** called; no contact DELETE issued.
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U02: `resolveAddedEmail` — owner is a separate EMPTY contact → `mergeContacts(survivor=target, dup=owner)`
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S2; D2a; Decision B bullet 2
- **Предусловия:** lookup returns owner contact `id=77 ≠ target`; `isContactEmailOnly(77,…)` mocked `true`.
- **Входные данные:** `resolveAddedEmail(target=10, 'x@cem1.test', A, client)`.
- **Ожидаемый результат:** exactly one call `mergeContacts(10, 77, A, client)`; the plain inbox link-loop is NOT the taken branch. `client` (the PATCH tx) is threaded through unchanged.
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U03: `resolveAddedEmail` — owner is a separate NON-empty contact → re-point ONLY, no merge/delete
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S3; D2b; Decision B bullet 3
- **Предусловия:** lookup returns owner `id=88 ≠ target`; `isContactEmailOnly(88,…)` mocked `false`; `listMessageIdsForAddress('bob@cem1.test',…)` → `['mb1']`.
- **Ожидаемый результат:** `linkMessageToContact('mb1', A, {contact_id:10, timeline_id:TL, on_timeline:true})` is called (re-point that address's messages to target); `mergeContacts` **never** called; **no** DELETE of contact 88.
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U04: `resolveAddedEmail` — owner **is** the target (address already on this contact) → no-op
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S6; Decision B bullet 4 ("Owner IS the target")
- **Предусловия:** lookup returns owning contact `id === target (10)`.
- **Ожидаемый результат:** neither `mergeContacts` nor any `linkMessageToContact` re-point fires (or only an idempotent no-op re-link to the same timeline id); zero DELETE. Function returns without error.
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U05: `isContactEmailOnly` — TRUE only when NO phone AND zero rows in every enumerated table
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S2 gate; FR-4; architecture Decision B2 emptiness table
- **Предусловия:** contact has `phone_e164 NULL`, `secondary_phone NULL`, and the `EXISTS` probe over every enumerated table returns false; only its own `contact_emails` / `email_messages` / email timeline exist (explicitly EXCLUDED from the test).
- **Ожидаемый результат:** returns `true`. Assert the emitted SQL enumerates **every** identity table from the architecture table — `jobs, leads, estimates, invoices, payment_transactions, stripe_payment_sessions, portal_access_tokens, portal_sessions, portal_events, crm_account_contacts, crm_deal_contacts, crm_activities, tasks, contact_addresses` — and that it does **NOT** count `contact_emails`, `email_messages`, or `timelines` (those are the footprint being moved). Each table leg that carries `company_id` is company-scoped.
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U06: `isContactEmailOnly` — FALSE if a **phone** exists (parametrized: primary and secondary)
- **Приоритет:** P0
- **Тип:** Unit (parametrized)
- **Связанный сценарий:** S3 gate; FR-4
- **Входные данные:** case (a) `phone_e164='+1617…'`, secondary null; case (b) `phone_e164` null, `secondary_phone='+1617…'`.
- **Ожидаемый результат:** both return `false` — a phone alone makes the contact "identity/data" (degrades D2a→D2b). No delete may ever follow.
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U07: `isContactEmailOnly` — FALSE if ANY one enumerated table has a row (parametrized over `tasks` + `jobs` at minimum)
- **Приоритет:** P0
- **Тип:** Unit (parametrized — table-driven; at minimum `tasks` and `jobs`, ideally all 14)
- **Связанный сценарий:** S3 gate; FR-4; "identity never under-counted"
- **Входные данные:** phone null; exactly one enumerated table returns a matching row — parametrize: `{jobs}`, then `{tasks}` (an independent task NOT the email-timeline task), then each remaining identity table.
- **Ожидаемый результат:** `false` for **every** parametrization (short-circuits on the first non-empty `EXISTS`). This is the "err toward not-empty is safe" guarantee: any doubt keeps the contact.
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U08: `mergeContacts` — FK-order guard: re-point open tasks off `dupTl` BEFORE any timeline delete
- **Приоритет:** P0
- **Тип:** Unit (call-order)
- **Связанный сценарий:** S2; architecture Decision B3 steps 2 + 6; ORPHAN-TASK-REHOME-001
- **Предусловия:** capture the ordered sequence of mocked `client.query` calls in `mergeContacts(survivor, dup,…)`.
- **Ожидаемый результат:** an `UPDATE tasks SET thread_id = survivorTl WHERE thread_id = dupTl AND status='open'` (open-task re-home) is issued **before** any `DELETE FROM timelines … dupTl` and before `DELETE FROM contacts … dup`; the contact DELETE is the **last** mutation. `email_messages` re-point (`contact_id=survivor, timeline_id=survivorTl, on_timeline=true`) precedes the timeline delete. Any ordering that deletes the timeline before re-homing the open task = FAIL (the exact CASCADE trap).
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U09: `mergeContacts` — M2M children moved with NOT-EXISTS guards
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S2; Decision B3 step 5
- **Ожидаемый результат:** the `contact_emails` (and `contact_addresses`, `crm_account_contacts`, `crm_deal_contacts`, `portal_access_tokens`, `portal_sessions`) re-point UPDATEs each carry a `NOT EXISTS (SELECT 1 … WHERE contact_id = survivor AND <unique-cols match>)` guard so a would-be duplicate is left on the dup (and dies with the CASCADE), never raising a unique violation.
- **Файл для теста:** `tests/contactEmailMerge.test.js`

### TC-CEM-U10: PATCH accepts `emails[]` and upserts each via `enrichEmail`, keeping scalar `contacts.email` synced to primary
- **Приоритет:** P0
- **Тип:** Unit (route, db mocked)
- **Связанный сценарий:** S5; FR-2; Decision C
- **Входные данные:** `PATCH /api/contacts/:id` body `{ emails: [{email:'Work@Acme.com', is_primary:true}, {email:'p2@acme.com'}] }`, `req.companyFilter={company_id:A}`.
- **Ожидаемый результат:** `emails` is handled **outside** the scalar `allowedFields` loop; each address upserts with `email_normalized = lower(trim(email))` (→ `work@acme.com`, `p2@acme.com`) via `enrichEmail`-semantics (`ON CONFLICT (contact_id, email_normalized) DO NOTHING`); the scalar `contacts.email` UPDATE is set to the primary (`work@acme.com`); exactly one `is_primary=true` enforced (first-primary-wins; if none flagged, first entry). Body **without** `emails` leaves the email path untouched (backward compatible).
- **Файл для теста:** route suite (e.g. `tests/contactsPatchEmails.test.js`)

### TC-CEM-U11: PATCH calls `resolveAddedEmail` per **newly-added** address only (not for pre-existing ones)
- **Приоритет:** P1
- **Тип:** Unit (route, db mocked)
- **Связанный сценарий:** S5 + S6; Decision C.4
- **Предусловия:** `getAdditionalEmails`/current set mocked so `a@acme.com` already exists in `contact_emails`; `b@acme.com` is new.
- **Ожидаемый результат:** `resolveAddedEmail` is called **once**, for `b@acme.com`; NOT called for the already-present `a@acme.com`. Confirms "newly added in this PATCH" gating (idempotent re-save does no work).
- **Файл для теста:** route suite

### TC-CEM-U12: Whole PATCH is ONE transaction — a thrown merge rolls back the email add
- **Приоритет:** P0
- **Тип:** Unit (route, db mocked — tx boundary)
- **Связанный сценарий:** S6 integrity; architecture Decision A (atomic tx); constraints "a failure must not … lose the `contact_emails` write" (by rolling BACK, not half-committing)
- **Предусловия:** mock the pooled client so `BEGIN` succeeds, the `contact_emails` upsert succeeds, but `resolveAddedEmail` (the merge leg) **throws**.
- **Ожидаемый результат:** the handler issues `ROLLBACK` (never `COMMIT`); the contact-update + emails-upsert are rolled back together with the merge (atomic — no state where `contact_emails` is written but the merge is half-done, and no partially-deleted contact); the route returns a 500 (or its defined error) without leaking a stack. Assert `client.query('COMMIT')` was **not** called and `client.query('ROLLBACK')` **was**.
- **Файл для теста:** route suite

### TC-CEM-U13: PATCH removal drops the `contact_emails` row **non-destructively** (no reverse-merge, no message un-link)
- **Приоритет:** P1
- **Тип:** Unit (route, db mocked)
- **Связанный сценарий:** S8; FR-8; Decision C.3
- **Входные данные:** current set `{primary p@acme.com, extra old@acme.com}`; PATCH body `emails:[{email:'p@acme.com', is_primary:true}]` (drops `old@acme.com`).
- **Ожидаемый результат:** a `DELETE FROM contact_emails WHERE contact_id=$ AND email_normalized='old@acme.com'` is issued; **no** UPDATE that clears `email_messages.contact_id`/`timeline_id`/`on_timeline` for the removed address (already-linked history stays put). No `mergeContacts`/un-merge path is taken.
- **Файл для теста:** route suite

---

## 2. Integration — real DB, `scripts/verify-contact-email-merge-001.js` (NO mocks)

All cases run the REAL merge service (and, where stated, the REAL `PATCH /api/contacts/:id` handler) against seeded Postgres, self-seeding/self-cleaning with tag `CEM1`. Every case is also re-run once against a prod-copy restore before deploy (`DATABASE_URL` pointed at the copy) — AC-8.

### TC-CEM-I01 (s1): S1 inbox-only email → messages get contact_id + timeline_id = target, on_timeline=true, surface on target's list
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S1; D3; AC-1
- **Предусловия:** company A; target contact T (has a phone, its own timeline TL_T or none yet). Two `email_messages` for `inbox@cem1.test` with `contact_id IS NULL`, `timeline_id IS NULL`, `on_timeline=false`, joined to thread TH (`last_message_at=t1`). No owning contact for that address.
- **Шаги:** 1) `resolveAddedEmail(T, 'inbox@cem1.test', A, client)` (or full `PATCH` with `emails:[{email:'inbox@cem1.test'}]`); 2) query the two messages; 3) call real `getUnifiedTimelinePage({limit:50,offset:0,companyId:A})`.
- **Ожидаемый результат:** both messages now have `contact_id = T`, `timeline_id = TL_T` (target's timeline, adopted/created via `findOrCreateTimelineByContact`), `on_timeline = true`; the thread is attached; `getUnifiedTimelinePage` surfaces a row for TL_T carrying `email_thread_id=TH`, positioned by `t1`, with the email icon (`last_interaction_type` email). Re-running step 1 changes nothing (idempotent re-link).
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s1)

### TC-CEM-I02 (s2): **S2 P0 LOAD-BEARING** — full-merge of an EMPTY email-only auto-contact: dup deleted, ALL its email moved, its open task RE-HOMED, ZERO dangling FK
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration
- **Связанный сценарий:** S2; D2a; FR-3 bullet 2 + FR-4; **AC-2 + AC-7**; ORPHAN-TASK-REHOME-001
- **Предусловия:** company A. **Dup D** = a bare email-only auto-contact: `phone_e164 NULL`, `secondary_phone NULL`, name blank, **no** row in any identity table; it owns address `x@cem1.test` (`contact_emails` row), N=3 `email_messages` for that address (`contact_id=D, timeline_id=dupTl, on_timeline=true`), its email thread, **its timeline `dupTl`**, and **one OPEN agent task on `dupTl`** (`tasks.thread_id=dupTl, status='open'` — the Action-Required trap). **Target T** = a real contact with its own identity (a phone).
- **Шаги:** 1) capture `dupId`, `dupTl`, the 3 message ids, the open-task id; 2) run `resolveAddedEmail(T, 'x@cem1.test', A, client)` (D2a → `mergeContacts(T, D, A, client)`); 3) run the **dangling-FK scan** (shared harness).
- **Ожидаемый результат:**
  - `SELECT 1 FROM contacts WHERE id = dupId` → **0 rows** (dup DELETED); `findEmailContact('x@cem1.test', A)` → returns **T** (AC-2).
  - `SELECT 1 FROM timelines WHERE id = dupTl` → **0 rows** (dup timeline gone).
  - all 3 `email_messages` now have `contact_id = T`, `timeline_id = TL_T`, `on_timeline = true` (none left on D/dupTl).
  - the open task is **RE-HOMED**: it still EXISTS, `status='open'`, `thread_id = TL_T` (survivor's timeline) — **NOT** cascade-deleted (assert the task id is still present; a missing task = FAIL, that is the exact ORPHAN-TASK-REHOME regression).
  - **dangling-FK scan = ZERO** across every `contact_id`/`thread_id` FK enumerated in the architecture table (no `email_messages`, `contact_emails`, `contact_addresses`, `tasks.contact_id`, `tasks.thread_id`, `jobs/leads/estimates/invoices/payment_transactions/stripe_payment_sessions/portal_*/crm_*`, `timelines` row still references `dupId`/`dupTl`).
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s2)

### TC-CEM-I03 (s2): S2 corner — dup owns MULTIPLE addresses + multiple threads; all move, delete still clean
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S2; Decision B3 (generic re-point); AC-2
- **Предусловия:** empty dup D owns `x@cem1.test` AND `y@cem1.test`, two threads, 2+2 messages, plus its `contact_emails` has both rows.
- **Шаги:** add ONLY `x@cem1.test` to T → `mergeContacts(T, D)`.
- **Ожидаемый результат:** because `mergeContacts` moves the whole contact (not one address), BOTH threads' messages and BOTH `contact_emails` rows re-point to T (NOT-EXISTS guarded); D deleted; dangling-FK scan zero. (Documents that D2a is a whole-contact merge, so a second address on the same empty dup follows.)
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s2)

### TC-CEM-I04 (s3): S3 non-empty owner (phone + job) → emails re-pointed to target, other contact + its job STILL EXIST
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S3; D2b; AC-3
- **Предусловия:** company A. **Owner O** = contact WITH a `phone_e164` AND an open **job** (`jobs.contact_id=O`) AND its own timeline TL_O with a call/SMS leg; O owns address `bob@cem1.test` (2 email_messages `contact_id=O, timeline_id=TL_O`). **Target T** = a different real contact.
- **Шаги:** 1) `resolveAddedEmail(T, 'bob@cem1.test', A, client)` (`isContactEmailOnly(O)` → false → D2b re-point-only); 2) assert.
- **Ожидаемый результат:** the 2 `email_messages` for `bob@cem1.test` now have `contact_id=T, timeline_id=TL_T, on_timeline=true` (re-pointed); **O still exists** (`SELECT 1 FROM contacts WHERE id=O` → 1), O keeps its `phone_e164`, its **job** (`jobs.contact_id=O` still 1 row), its call/SMS leg, and its timeline TL_O — **NOT deleted**. `mergeContacts` did not run (no contact DELETE anywhere).
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s3)

### TC-CEM-I05 (s4): S4 no-correspondence → exactly one `contact_emails` row written, no timeline/list change
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** S4; FR-2; AC-4
- **Предусловия:** target T (no primary email yet); address `fresh@cem1.test` appears in **no** message anywhere.
- **Шаги:** `PATCH` with `emails:[{email:'fresh@cem1.test', is_primary:true}]`.
- **Ожидаемый результат:** exactly one `contact_emails` row for T (`email_normalized='fresh@cem1.test', is_primary=true`), scalar `contacts.email` synced; **no** `email_messages` touched, no timeline created for a merge, no new list row beyond the address being on file; a subsequent `findEmailContact('fresh@cem1.test', A)` resolves to T.
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s4)

### TC-CEM-I06 (s5): S5 editing ONLY the primary email persists to `contact_emails` (closes the pre-existing gap) + runs resolution
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S5 / user-scenario 6; AC-5; the exact bug in requirements §"The bug this closes"
- **Предусловия:** contact T with `contacts.email` currently NULL and **no** `contact_emails` row (reproduces today's gap); `newprimary@cem1.test` has one inbox-only message.
- **Шаги:** `PATCH` with `emails:[{email:'newprimary@cem1.test', is_primary:true}]` (the case that does nothing today).
- **Ожидаемый результат:** a `contact_emails` primary row now EXISTS for T (`email_normalized='newprimary@cem1.test', is_primary=true`) — the regression the feature fixes; scalar `contacts.email` = `newprimary@cem1.test`; and resolution ran (the inbox-only message linked onto TL_T, `on_timeline=true`). Pre-fix, `contact_emails` would have zero rows here — that absence = FAIL.
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s5)

### TC-CEM-I07 (s5): S5 multi-email — several addresses added at once, each resolved independently, exactly one primary
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** S5 / user-scenario 5; FR-1/FR-2
- **Предусловия:** target T; `m1@cem1.test` has inbox-only messages, `m2@cem1.test` owned by an empty auto-contact, `m3@cem1.test` has no correspondence.
- **Шаги:** one `PATCH` with `emails:[{email:'m1@cem1.test',is_primary:true},{email:'m2@cem1.test'},{email:'m3@cem1.test'}]`.
- **Ожидаемый результат:** three `contact_emails` rows for T, exactly one `is_primary=true` (`m1`); `m1` messages linked; `m2`'s auto-contact fully merged + deleted; `m3` simply recorded — each branch fired independently in the same tx; dangling-FK scan (for the `m2` dup) zero.
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s5)

### TC-CEM-I08 (s6): **S6 idempotence** — re-run the same add → no-op, no second delete, byte-identical state
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S6; FR-5; AC-7
- **Предусловия:** run the S2 full-merge once (dup D merged into T, deleted). Snapshot T's `contact_emails`, the moved messages, the re-homed task, and row counts.
- **Шаги:** run `resolveAddedEmail(T, 'x@cem1.test', A, client)` a **second** time (and a third).
- **Ожидаемый результат:** now the address resolves to **T itself** (owner == target → no-op branch, TC-CEM-U04): no `mergeContacts`, no attempt to re-delete an already-gone D (clean no-op), no duplicate `contact_emails` row (`ON CONFLICT DO NOTHING`), no double-move of messages, no error. State (row counts + FK targets) is **identical** to the post-first-run snapshot.
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s6)

### TC-CEM-I09 (s7): **S7 P0 SECURITY cross-tenant** — address used by a company-B contact is NEVER merged into a company-A target; B untouched
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (Security)
- **Связанный сценарий:** S7; FR-6; **AC-6**; LIST-PAGINATION-001 SMS-leak / ZB-ISO-001 precedents
- **Предусловия:** company A target T. **Company B** (tagged, created here) has its own contact BC owning the SAME address string `shared@cem1.test` — with B-scoped `email_messages` (`company_id=B`), thread, timeline, and an open task. A has **no** footprint for `shared@cem1.test`.
- **Шаги:** `resolveAddedEmail(T /* company A */, 'shared@cem1.test', A, client)` (or PATCH scoped to A).
- **Ожидаемый результат:** resolution is scoped to company A → finds **no** A-side owner → treated as inbox-only for A with **zero** A messages to link (no-op) — it MUST NOT reach into B. Assert: BC still exists (`SELECT 1 FROM contacts WHERE id=BC` → 1); every B `email_messages` row still `contact_id=BC, company_id=B` (none re-pointed to T); B's thread/timeline/open task untouched; T gained only its `contact_emails` row (address on file), nothing from B. No B row is read, moved, or deleted by any leg.
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s7)

### TC-CEM-I10 (s7): S7 symmetric — a full-merge in A never deletes or touches an identically-addressed B contact
- **Приоритет:** P0
- **Тип:** Integration (Security)
- **Связанный сценарий:** S7; AC-6; constraints "no cross-tenant delete"
- **Предусловия:** A has an empty auto-contact D_A owning `dup@cem1.test`; B has a real contact BC also owning `dup@cem1.test` (B-scoped, with a phone + messages).
- **Шаги:** add `dup@cem1.test` to A-target T → D2a merges D_A into T.
- **Ожидаемый результат:** D_A (company A) is deleted and merged into T; **BC (company B) is completely untouched** — still exists, still owns its B messages, keeps its phone; the merge's every SQL leg carried `company_id = A`, so B was never in scope. Confirms the `company_id` gate (not the address) is what isolates.
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s7)

### TC-CEM-I11 (s8): S8 removal → `contact_emails` row gone, previously-linked `email_messages` KEEP their `contact_id` (history preserved)
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** S8; FR-8; AC (non-destructive default); Decision C.3
- **Предусловия:** contact T has address `old@cem1.test` in `contact_emails` AND previously-linked `email_messages` for it (`contact_id=T, timeline_id=TL_T, on_timeline=true`).
- **Шаги:** `PATCH` with an `emails[]` that omits `old@cem1.test` (keeps the primary).
- **Ожидаемый результат:** `SELECT 1 FROM contact_emails WHERE contact_id=T AND email_normalized='old@cem1.test'` → **0 rows** (row deleted); BUT the previously-linked `email_messages` **still** have `contact_id=T, timeline_id=TL_T, on_timeline=true` (history preserved — NO reverse-merge, NO un-link). The contact and its timeline are intact.
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s8)

### TC-CEM-I12 (s2/perf): mig-143 index serves the inbox-only `from_email` lookup (no new index, PULSE-PERF-001)
- **Приоритет:** P2
- **Тип:** Integration (plan probe — prod-copy only)
- **Связанный сценарий:** architecture Decision D; constraints "no speculative index"
- **Предусловия:** run on a fresh prod `pg_dump` restore (local dev has too few `email_messages` rows to be representative).
- **Шаги:** `EXPLAIN` the `listMessageIdsForAddress` query (`… WHERE lower(trim(from_email)) = $ AND company_id = $`).
- **Ожидаемый результат:** the plan uses `idx_email_messages_from_normalized` (mig 143) — an Index/Bitmap scan on `email_messages`, not a Seq Scan at scale; confirms Decision D "no new migration/index required."
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s2, `--explain`)

### TC-CEM-I13 (s2): Phone-merge regression — the async `mergeOrphanTimelines` path still fires byte-for-byte alongside the new email leg
- **Приоритет:** P1
- **Тип:** Integration (regression — Protected)
- **Связанный сценарий:** Protected parts; requirements "phone path must keep working byte-for-byte"
- **Предусловия:** a `PATCH` that changes BOTH `phone_e164` (with an orphan timeline to merge) AND adds an `emails[]` entry.
- **Ожидаемый результат:** the phone-side `mergeOrphanTimelines(contactId,[phone,secondary])` still runs (async, outside the tx) and merges the orphan phone timeline exactly as before; the email merge runs sync in the tx. Neither interferes; both results present. (Guards the "added ALONGSIDE" requirement.)
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s2)

### TC-CEM-I14 (s6): Atomic rollback on merge failure — real DB proves `contact_emails` write is rolled back, not orphaned
- **Приоритет:** P1
- **Тип:** Integration (fault-injection)
- **Связанный сценарий:** S6 integrity; architecture Decision A; TC-CEM-U12 real-DB counterpart
- **Предусловия:** seed the S2 shape but force `mergeContacts` to throw mid-way (e.g. a section flag injecting an error after the `contact_emails` upsert, before the dup delete — a temporary test hook or a deliberately malformed address that trips a late guard).
- **Шаги:** run the full `PATCH` handler against real DB with the injected failure.
- **Ожидаемый результат:** after the failed request, the DB shows **no** partial state: the `contact_emails` row was **rolled back** (not left written), the dup contact still exists intact (not half-deleted), no message re-pointed, the open task still on `dupTl`. The single-tx guarantee holds on real Postgres (mocks can't prove this — LIST-PAGINATION-001 lesson).
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s6)

### TC-CEM-I15 (s4): GET contact detail returns `emails[]` for the editor to load
- **Приоритет:** P2
- **Тип:** Integration (contract)
- **Связанный сценарий:** Decision C "GET surfaces the list"; FR-1 (editor loads the list)
- **Предусловия:** contact T with a primary + two additional `contact_emails` rows.
- **Шаги:** GET the contact detail (real `contactsService.getById` consumer / route).
- **Ожидаемый результат:** the response includes an `emails` array reflecting all three addresses, primary-first, de-duped, one flagged primary — enough for `EditContactDialog` to render/populate the multi-email list. (Pre-fix returned only the scalar email.)
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s4)

### TC-CEM-I16 (s3): D2b re-point moves ONLY the added address's messages, not the owner's other-address email
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** S3; D2b precision ("ONLY the email_messages for that address")
- **Предусловия:** non-empty owner O (phone+job) owns TWO addresses `bob@cem1.test` and `bob2@cem1.test`, each with messages on TL_O.
- **Шаги:** add ONLY `bob@cem1.test` to T.
- **Ожидаемый результат:** only `bob@cem1.test` messages re-point to TL_T; `bob2@cem1.test` messages stay on O/TL_O; O intact. Confirms D2b is address-scoped, not contact-scoped (the key difference from D2a).
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section s3)

### TC-CEM-ISAB (sab): Sabotage negative control — deliberately break one expectation, confirm the harness FAILs, then restore
- **Приоритет:** P0
- **Тип:** Integration (self-check — mirrors `verify-tasks-count-001.js` TC-SABOTAGE)
- **Связанный сценарий:** harness integrity (LIST-PAGINATION-001 "a green run must certify the detector works")
- **Предусловия:** the S2 full-merge just ran (dup deleted, task re-homed, zero dangling).
- **Шаги:** run the S2 assertion suite against a **deliberately-wrong** expectation — e.g. assert the dup contact STILL exists after the merge (it does not), or assert the dangling-FK count is 999 — via the same assert kit used everywhere.
- **Ожидаемый результат:** the harness throws a `CheckError` and records **FAIL** for the sabotaged assertion (proving it actually inspects state, not just prints PASS). Then restore the correct expectation and re-assert green. If the sabotage does NOT trip a FAIL, this case fails — the detector is broken and every PASS above is suspect.
- **Файл для теста:** `scripts/verify-contact-email-merge-001.js` (section sab)

---

## 3. Frontend — manual + build (no FE harness; `frontend/src/components/contacts/EditContactDialog.tsx`)

### TC-CEM-F01: Multi-email list — add / remove rows, exactly one primary
- **Приоритет:** P1
- **Тип:** Frontend (manual)
- **Связанный сценарий:** S5; FR-1; FORM-CANON (floating-label filled fields, right-side panel), mirrors secondary-phone control
- **Шаги:** open a contact in `EditContactDialog`; the email control shows the primary + any additional as a list; add two rows, remove one, toggle which is primary.
- **Ожидаемый результат:** rows add/remove correctly; exactly one primary can be selected; empty/invalid rows are blocked (basic email-shape validation) before Save; layout follows FORM-CANON (no stacked `<Label>`, filled fields, add/remove affordance like the secondary-phone control).
- **Файл для теста:** manual / dev-preview

### TC-CEM-F02: Save persists `emails[]` and GET returns it on reopen
- **Приоритет:** P1
- **Тип:** Frontend (manual + network)
- **Связанный сценарий:** S5; Decision C (PATCH `emails[]`; GET surfaces `emails`); AC-5
- **Шаги:** add a primary + one additional, Save; observe the PATCH payload; reopen the contact.
- **Ожидаемый результат:** the `PATCH /api/contacts/:id` request body carries `emails: [{email, is_primary}]`; after Save the reopened editor re-populates BOTH addresses from the GET `emails` array (round-trips through `contact_emails`), and the primary is marked. A pure primary-email edit also persists (S5/AC-5 — the case that did nothing before).
- **Файл для теста:** manual / dev-preview + Network tab

### TC-CEM-F03: Merged thread appears in the contact's Pulse row / timeline detail after Save (end-to-end smoke)
- **Приоритет:** P2
- **Тип:** Frontend (manual E2E)
- **Связанный сценарий:** S1/S2; FR-7; AC-1/AC-2
- **Шаги:** with an address that has real inbox correspondence, add it to a contact and Save; open Pulse.
- **Ожидаемый результат:** the contact's row now reflects the email thread (email icon, ordered by last-message time) with **no list-code change**, and timeline detail shows the merged email history (`email_by_contact` CTE surfaces it automatically).
- **Файл для теста:** manual / dev-preview

### TC-CEM-F04: Build stays green
- **Приоритет:** P3
- **Тип:** Frontend (build)
- **Связанный сценарий:** ship gate (frontend-build-command: `npm run build`, stricter than `tsc --noEmit`)
- **Шаги:** `cd frontend && npm run build`.
- **Ожидаемый результат:** exit 0; `contactsApi.updateContact` accepts `emails?: {email:string; is_primary?:boolean}[]` and the contact detail type exposes `emails`; no unused-locals error.
- **Файл для теста:** build

---

## Regression / Protected (must stay green)

- **TC-R-1 (P0):** phone-merge `timelineMergeService.mergeOrphanTimelines` + its async trigger + ORPHAN-TASK-REHOME-001 task re-home unchanged byte-for-byte (covered live by TC-CEM-I13).
- **TC-R-2 (P1):** `email_by_contact` CTE / `getUnifiedTimelinePage` (EMAIL-OUTBOUND-001, LIST-PAGINATION-001) shape/semantics untouched — existing `tests/listPaginationByContact.test.js` stays 100% green; the merged thread surfaces with **no** query change.
- **TC-R-3 (P1):** `emailQueries.linkMessageToContact` idempotent-relink + EMAIL-UNREAD-001 unread semantics, and `findEmailContact` resolution — reused unchanged (existing `emailTimeline*` / `emailMailboxMultitenancy` tests stay green).
- **TC-R-4 (P2):** `contact_emails` mig-025 invariants — `UNIQUE(contact_id, email_normalized)`, single primary, `ON DELETE CASCADE` — never violated by any merge/upsert leg.
- **TC-R-5 (P2):** the leads-cascade + async ZB contact sync in `PATCH /:id` keep firing (stay async, outside the tx); the new email logic is additive.
- **TC-R-6 (P3):** middleware chain unchanged — `PATCH /api/contacts/:id` still gated by `authenticate` → `requireCompanyAccess` → `requirePermission('contacts.edit')`; 401 without token, 403 without company binding (existing `contactsPulseTenantIsolation.test.js` coverage).
- **TC-R-7 (P3):** no new migration introduced (Decision D); if any appears it is numbered ≥156 with rollback + logged row count.
