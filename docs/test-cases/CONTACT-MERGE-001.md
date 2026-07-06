# Тест-кейсы: CONTACT-MERGE-001 — confirm-dialog merge/transfer when a user adds another contact's phone/email

**Source spec:** `Docs/specs/CONTACT-MERGE-001.md` (S1–S16) + `Docs/requirements.md` §CONTACT-MERGE-001 (FR-1…FR-10, AC-1…AC-10, owner decisions 1–4) + `Docs/architecture.md` §CONTACT-MERGE-001 (Decisions A–F, C2 steps 3b/3c, OQ-2/OQ-3 resolved). Backend change points: `backend/src/services/contactEmailMergeService.js` (**NEW** `detectAttributeConflicts`, `transferPhone`, `transferEmail`, `ContactConflictError` sentinel; **EXTENDED** `mergeContacts` steps 3b/3c; **CHANGED** `resolveAddedEmail` separate-owner branches → throw sentinel); `backend/src/routes/contacts.js` `PATCH /:id` (detection at tx top, `resolutions[]` strict-echo validation, 409 `CONTACT_ATTRIBUTE_CONFLICT`, Decision-E scalar branch). Frontend: **NEW** `MergeContactsDialog.tsx` + `useContactConflictFlow.ts`; `EditContactDialog.tsx`, `PulseContactPanel.tsx`, `contactsApi.ts`.

**House lesson (LIST-PAGINATION-001, binding):** mocked jest proves the SQL string / dispatch / call-order only — it can NOT prove a row moved, an FK held, or a rollback left the DB byte-identical. Every destructive/behavioral claim below has a real-DB case in `scripts/verify-contact-merge-001.js` (tag `CM1`, self-seeding/self-cleaning, PASS/FAIL per case), mirroring the house-standard `scripts/verify-contact-email-merge-001.js` (`CEM1`) harness — including its assert kit, section selection and the **sabotage negative control (amendment #5: stash the feature → harness must FAIL → restore → green)**.

**Jest gotcha:** in a worktree run with `--testPathIgnorePatterns "/node_modules/"`.

**Migration:** NONE (Decision F — mig 012/025/027/028/079/129/143/149 + `idx_calls_timeline_id` cover every lookup/re-point). Max verified = 155; if one ever becomes necessary, re-verify max immediately before creating it (parallel branches).

**Existing-test-cases check:** `Docs/test-cases/CONTACT-EMAIL-MERGE-001.md` covers the email-merge base (kept in force). This document covers ONLY the delta: conflict round-trip, phone side, transfers, scalar hole, dialog. Cases below do not duplicate TC-CEM-*; where a TC-CEM case must be **updated** (silent D2a/D2b are intentionally replaced) that is called out in the Regression section — never silently deleted.

---

## Scenario map (spec → cases)

| S-id | Meaning | Cases | Priority focus |
|------|---------|-------|----------------|
| **S1** | Email conflict → Merge (owner with identity) — full AC-2 checklist | I01, U11 | **P0** |
| **S2** | Email conflict → Transfer email (row moves, scalar syncs, messages re-linked) | I04, U10 | P1 |
| **S3** | Phone conflict → Merge — calls FK-trap 3b, slot fill 3c | I02, U01, U07, U08 | **P0** |
| **S4** | Phone conflict → Transfer phone + OQ-3 secondary→primary promotion | I03, U09 | **P0** |
| **S5** | Cancel → byte-identical DB (round 1 committed nothing) | I05, F02 | **P0** |
| **S6** | Single-attribute owner → merge-only dialog (`transfer_allowed:false`, D2a replaced) | I06, U05 | P1 |
| **S7** | Multi-owner conflicts → grouped by owner, sequential dialogs, ONE retry | I07, U04, F02 | P1 |
| **S8** | Scalar email via Pulse panel → same flow (4175/4228 closed, Decision E) | I11, U16, F03 | P1 |
| **S9** | Stale echo (owner changed between rounds) → fresh 409, never a stale action | I09, U12 | **P0** |
| **S10** | Idempotent repeated retry (double-submit) → clean no-op | I10, U12 | P1 |
| **S11** | Cross-tenant isolation on EVERY leg + forged echo + foreign :id | I08, U15 | **P0 (security)** |
| **S12** | Conflict with self → no detection, no dialog | I16, U03 | P2 |
| **S13** | Owner deleted between rounds → resolution ignored, save proceeds | I17 | P2 |
| **S14** | Error mid-resolution → full rollback, never half-merge | I14, U17 | **P0** |
| **S15** | Phone-slot overflow (OQ-2) + `contact_merged` audit event + SMS caveat | I12, U08 | P1 |
| **S16** | Silent branches unregressed (D3, orphans, ingestion) + Pulse list after merge/transfer | I13, I15, U06 | **P0** |

**P0 must-pass gates (a red on ANY blocks the release):** I01/I02 (FK traps: open-task re-home + calls re-point BEFORE timeline delete — real DB, mocked jest can't prove it), I05 (cancel = byte-identical DB), I08 (cross-tenant), I09 (stale echo), I13 (silent branches byte-for-byte), I14 (mid-tx rollback), I18 (no new Seq Scan — PULSE-PERF-001), ISAB (harness self-check).

## AC map (requirements → cases)

| AC | Covered by |
|----|-----------|
| AC-1 (no silent action; dialog shows both compositions, conflict highlighted) | U11, I01, F01 |
| AC-2 (merge checklist: scalars win, children move, open task alive, ZB kept, dup gone) | U07, U08, I01, I02 |
| AC-3 (transfer phone: only this number's calls/SMS move; owner alive) | U09, I03 |
| AC-4 (transfer email: row moves, scalar syncs, messages re-linked; owner alive) | U10, I04 |
| AC-5 (single-attribute owner → merge-only; no silent D2a anywhere) | U05, U06, I06 |
| AC-6 (cancel: DB byte-for-byte; editor keeps input; re-save w/o conflict passes) | I05, F02 |
| AC-7 (Pulse scalar email → same dialog; 4175/4228 unreproducible) | U16, I11, F03 |
| AC-8 (silent branches unregressed: D3, orphans, ingestion) | U06, I13 |
| AC-9 (tenancy: foreign company invisible + untouchable) | U15, I08 |
| AC-10 (idempotency + race + real prod-copy run of all branches) | U12, I09, I10, harness run vs prod copy |

---

## Покрытие / Coverage

- Всего тест-кейсов: **40** (numbered) + **6** regression/protected items = **46**.
- **Numbered cases by priority — P0: 18 | P1: 16 | P2: 5 | P3: 1.** Regression items — P0: 1 | P1: 2 | P2: 2 | P3: 1.
- **Unit (jest, mocked db): 17** | **Integration (real DB, `scripts/verify-contact-merge-001.js`): 19** | **Frontend (manual + build): 4**.
- Security (tenancy/middleware): U15 + I08 (real-DB) + forged-echo leg. Sabotage negative controls: ISAB (**two** legs: wrong-expectation + amendment-#5 feature-stash).
- Perf (PULSE-PERF-001): I18 — `EXPLAIN` on prod copy, ship gate.

---

## Shared fixtures & harness (Integration section)

House pattern of `scripts/verify-contact-email-merge-001.js` (**no mocks anywhere in this section**; external APIs never called — ZB push and leads-cascade are post-commit async and are asserted NOT to fire on rollback paths by spying on the outbox/log level, not by mocking the tx):

- **Script:** `scripts/verify-contact-merge-001.js`, sections `s1…s16` (grouped) + `sab`, selectable `--section=<id>|all`, optional `--explain` (prod-copy plan probes). `DATABASE_URL` defaults to `postgresql://localhost/twilio_calls`; **never point at prod** — prod-copy restore for the pre-deploy run (AC-10).
- **Unique tag `CM1`** on every seeded row: contacts `full_name LIKE 'CM1 %'`, tasks `title LIKE 'CM1 %'`, emails `%@cm1.test`, phones `+1999777XXXX` block, tagged company B. Cleanup at process start, before EACH case, and at end; FK order: tasks → email_messages → email_threads → calls → sms_conversations → timelines → business entities → contact_emails → contacts → crm_users → companies.
- **Companies:** A = seed `00000000-0000-0000-0000-000000000001` (dev rows coexist → assertions are delta/tagged, never absolute counts); **B** = tagged `c0000000-0000-4000-8000-0000000000f1`, created + deleted here (cross-tenant).
- **Real code exercised (unmocked):** the REAL `PATCH /api/contacts/:id` handler mounted via express + stub auth middleware injecting `req.user`/`req.authz` (`contacts.edit`)/`req.companyFilter={company_id:A}` (same shape as the jest route layer but real `db/connection`) — the conflict round-trip is driven through HTTP both rounds; plus direct service calls where stated (`mergeContacts`, `transferPhone`, `transferEmail`, `detectAttributeConflicts`).
- **Seed builders (tagged CM1):** `mkContact(company,{name,phone,secondaryPhone,secondaryName,email,zbId})`, `mkTimeline(company,{contactId})`, `mkCall(company,{timelineId,contactId,fromNumber,toNumber})`, `mkSmsConversation(company,{customerDigits,lastAt})`, `mkEmailThread`/`mkEmailMessage` (as CEM1), `mkContactEmail(contactId,{email,isPrimary})`, `mkLead`/`mkJob(company,{contactId})`, `seedOpenTask(company,{threadId,contactId,status:'open'})`.
- **The dangling-FK scan** (reused from CEM1): after any merge, zero rows reference the deleted dup id / dup timeline across every `contact_id`/`thread_id`/`timeline_id` FK — now **including `calls.contact_id` and `calls.timeline_id`** (the 3b addition; `calls.timeline_id` has no ON DELETE action — a dangling reference is an FK violation waiting at delete time, so the scan asserts both "dup timeline gone" AND "no call still points at it").
- **The byte-identical snapshot** (S5/S14): before the acting request, snapshot ordered row-sets of `contacts, contact_emails, timelines, calls, email_messages, email_threads, tasks, leads, jobs` for the CM1 fixture (SELECT … ORDER BY id, hashed); after cancel/rollback, re-snapshot and compare hash-for-hash.

---

## 1. Unit — jest, mocked db

Service cases → `tests/contactMergeConflicts.test.js` (NEW, house style of `tests/contactEmailMerge.test.js`: mock `db/connection` + `emailQueries` + `timelinesQueries`, capturing tx client, assert emitted SQL/params/ordering/branch). Route cases → `tests/contactsPatchMergeConflict.test.js` (NEW, house style of `tests/contactsPatchEmails.test.js`: capturing pooled client, real router via supertest, injected auth). Mocks: eventService (`logEvent`), zenbookerSyncService (assert NOT called on merge), timelineMergeService.

### TC-CM-U01: `detectAttributeConflicts` — phone owner found by full-digit legs, company-scoped, `id <> target`, locked, take-latest
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S3; FR-1; Decision B
- **Предусловия:** capturing client; SELECT router returns owner row `{id:77}` for the phone leg.
- **Входные данные:** `detectAttributeConflicts(10, {phones:['16175550022'], emails:[]}, A, client)`.
- **Ожидаемый результат:** emitted owner-lookup SQL carries: `company_id=$` param = A; `id <> $target`; both full-digit equality legs on `phone_e164`/`secondary_phone` using the **exact mig-149 expression** (`NULLIF(regexp_replace(...,'\D','','g'),'')`) so the index serves it verbatim; `ORDER BY updated_at DESC LIMIT 1`; a `FOR UPDATE` lock on the owner row AND the target row. Result grouped as one conflict `{owner:77, attributes:[{kind:'phone', …}]}`.
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U02: `detectAttributeConflicts` — `RIGHT(digits,10)` fallback leg matches a legacy non-E.164 owner
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S3; Decision B (last-10 correctness fallback); architecture note "multi-owner dirt → take-latest"
- **Входные данные:** owner row stored as `(617) 555-0022` (non-E.164); submitted `+16175550022`.
- **Ожидаемый результат:** the last-10 leg is present in the SQL (`RIGHT(…,10) = $last10` for both slots) and the owner is detected; with two owner rows mocked, only the latest-`updated_at` one is returned (LIMIT 1).
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U03: `detectAttributeConflicts` — added-sets exclude values already on the target (S12) + email legs incl. Decision-E scalar
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S12; S8; FR-1; Decision B/E
- **Входные данные:** (a) target already holds `+16175550022` (by digits) and `a@cm1.test` (normalized) → submit both again; (b) scalar `email:'new@cm1.test'` without `emails[]`, not on target.
- **Ожидаемый результат:** (a) neither value enters the added-set → **zero owner lookups issued, zero conflicts** (idempotent re-save = no dialog); (b) the scalar address IS included in the email added-set and resolved via `findEmailContact(…, A, client)` (reused, not reimplemented).
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U04: `detectAttributeConflicts` — grouping: 2 attributes of ONE owner = 1 entry; 2 owners = 2 entries
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S7; Decision A payload shape
- **Входные данные:** phone → owner 77, email#1 → owner 77, email#2 → owner 88.
- **Ожидаемый результат:** result = 2 conflict entries: `{owner:77, attributes:[phone, email#1]}` and `{owner:88, attributes:[email#2]}`; each entry carries `owner`/`editing` compositions (name + ALL phones + ALL emails) and `transfer_allowed`.
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U05: FR-3 gate — `transfer_allowed` simulation: inventory minus ALL conflicting attributes ≥ 1
- **Приоритет:** P0
- **Тип:** Unit (parametrized)
- **Связанный сценарий:** S6; FR-3; Decision D gate; AC-5
- **Входные данные:** (a) owner = email-only auto-contact, conflict takes its only email → `false`; (b) owner has 1 phone + 1 email, conflict takes the email → `true`; (c) owner has phone+email, ONE dialog takes BOTH (S7 grouped) → `false`; (d) owner has 2 phones, conflict takes 1 → `true`.
- **Ожидаемый результат:** `transfer_allowed` exactly per the simulation (inventory = `{phone_e164, secondary_phone} ∪ {scalar email + all contact_emails}` **minus the whole conflicting set of this dialog**). Case (c) is the trap: per-attribute simulation would say `true` — must be `false`.
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U06: `resolveAddedEmail` — separate-owner branches THROW `ContactConflictError`; inbox-only + owner==target byte-for-byte
- **Приоритет:** P0
- **Тип:** Unit (dispatch)
- **Связанный сценарий:** S16; FR-9; Decision B "no silent path left"; AC-8
- **Предусловия:** parametrize `findEmailContact` → (a) `null` (inbox-only), (b) `{id: target}` (self), (c) `{id: other, email-only}` (old D2a), (d) `{id: other, with identity}` (old D2b).
- **Ожидаемый результат:** (a) `linkInboxMessages` link-loop fires exactly as in TC-CEM-U01 — no throw, no dialog machinery; (b) no-op as TC-CEM-U04; (c) AND (d) **throw `ContactConflictError`** — `mergeContacts` is NEVER called from here, `linkMessageToContact` re-point is NEVER called; no DELETE issued. The sentinel carries enough to build a fresh 409 (owner id, attribute).
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U07: `mergeContacts` — extended call-order guard: task re-home → email re-point → **3b calls re-point** → timeline delete → contact delete LAST
- **Приоритет:** P0
- **Тип:** Unit (call-order)
- **Связанный сценарий:** S3; Decision C2; FK-recipe B3; ORPHAN-TASK-REHOME-001 + the calls FK trap (`calls.timeline_id` no ON DELETE)
- **Предусловия:** ordered capture of `client.query` calls in `mergeContacts(survivor, dup, A, client)`.
- **Ожидаемый результат:** the sequence contains, **in this relative order**: `UPDATE tasks SET thread_id=… WHERE thread_id=dupTl AND status='open'` → `UPDATE email_messages …` → **`UPDATE calls SET timeline_id=$survivorTl, contact_id=$survivor WHERE timeline_id = ANY($dupTlIds)`** AND `UPDATE calls SET contact_id=$survivor WHERE contact_id=$dup AND company_id=$` → `DELETE FROM timelines … dupTl` → `DELETE FROM contacts … dup` (the LAST mutation). Any ordering placing the timeline DELETE before the calls UPDATE = FAIL (the exact FK trap). Tenant-guard throw and NOT-EXISTS M2M guards still present (regression on B3).
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U08: `mergeContacts` 3c — slot fill order, label carry, survivor scalars NEVER touched, overflow → `contact_merged` event
- **Приоритет:** P1
- **Тип:** Unit (parametrized)
- **Связанный сценарий:** S15; OQ-2 default; Decision C2 3c; AC-2 "scalars win"
- **Входные данные:** (a) survivor 0 phones, dup 2 → both fill (`phone_e164` first, then `secondary_phone` with `secondary_phone_name` carried); (b) survivor 1 phone, dup 2 → one fills secondary, one dropped; (c) survivor 2 phones, dup 2 → nothing fills, both dropped.
- **Ожидаемый результат:** the survivor UPDATE never sets `full_name`/`company_name`/`notes`/`zenbooker_customer_id`/`email`; dropped numbers appear in `eventService.logEvent(A,'contact',survivor,'contact_merged',{merged_contact_id, merged_name, dropped_phones})` + a warn log; `zenbookerSyncService` NOT called from inside the merge.
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U09: `transferPhone` — OQ-3 promotion + this-number-only call filter on the owner's ONE timeline
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S4; FR-5; Decision D; AC-3
- **Предусловия:** owner row: `phone_e164=+1617…22` (transferred), `secondary_phone=+1617…33`, `secondary_phone_name='Wife'`.
- **Ожидаемый результат:** owner UPDATE sets `phone_e164 = <…33>` (promotion), `secondary_phone = NULL`, `secondary_phone_name = NULL`; when the cleared slot is `secondary_phone` instead — no promotion, only that slot NULLed. `findOrCreateTimelineByContact(target, A, client)` called (adopts orphans + re-homes shadow-orphan open tasks). Calls UPDATE is scoped `WHERE timeline_id=$ownerTl AND (RIGHT(digits(from_number),10)=$last10 OR RIGHT(digits(to_number),10)=$last10)` — never an unscoped digit sweep. **No** `sms_conversations` write anywhere. **No** DELETE of the owner contact.
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U10: `transferEmail` — owner row DELETE + scalar sync + `linkInboxMessages` re-point
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S2; FR-6; Decision D; AC-4
- **Входные данные:** (a) transferred address == owner's scalar `contacts.email`, owner has another `contact_emails` row → scalar synced to remaining primary-or-first; (b) it was the only row → scalar → NULL; (c) address ≠ scalar → scalar untouched.
- **Ожидаемый результат:** `DELETE FROM contact_emails WHERE contact_id=$owner AND email_normalized=$`; scalar UPDATE per case; `linkInboxMessages(target, emailNormalized, A, client)` called (reused loop — messages land on the TARGET's timeline); no owner DELETE, no `mergeContacts`.
- **Файл для теста:** `tests/contactMergeConflicts.test.js`

### TC-CM-U11: Route round 1 — unresolved conflict → ROLLBACK (COMMIT never) + 409 `CONTACT_ATTRIBUTE_CONFLICT` with full payload; detection precedes ALL writes
- **Приоритет:** P0
- **Тип:** Unit (route, db mocked)
- **Связанный сценарий:** S1/S5; FR-1/FR-7; Decision A; AC-1
- **Предусловия:** router makes detection return one phone conflict; PATCH body also carries a non-conflicting `full_name` edit and NO `resolutions`.
- **Ожидаемый результат:** response **409** `{ok:false, error:{code:'CONTACT_ATTRIBUTE_CONFLICT', message, correlation_id}, conflict:{conflicts:[{owner:{id,full_name,company_name,phones:[{value,label,slot}],emails:[{email,is_primary}]}, editing:{…}, attributes:[{kind,value,normalized}], transfer_allowed}]}}` (leads.js `CONTACT_AMBIGUOUS` envelope precedent); `client.query('ROLLBACK')` issued, `COMMIT` **never**; **no UPDATE/INSERT/DELETE was issued before the detection SELECTs** (the `full_name` write must NOT precede detection — order-assert on the captured calls). No cross-company data in the payload.
- **Файл для теста:** `tests/contactsPatchMergeConflict.test.js`

### TC-CM-U12: Route round 2 — strict echo: mismatch → fresh 409; non-matching resolution → ignored (idempotency contract)
- **Приоритет:** P0
- **Тип:** Unit (route, parametrized)
- **Связанный сценарий:** S9/S10; FR-10; Decision A resolution contract; AC-10
- **Входные данные:** detected conflict = `{owner:77, attributes:[phone P]}`. (a) resolution `{owner:77, action:'merge', attributes:[P]}` → executes; (b) resolution echoes `attributes:[P, emailQ]` (set differs) → fresh 409, nothing executed; (c) resolution for `owner:99` only → detected conflict unresolved → fresh 409; (d) NO conflicts detected but body carries a leftover resolution → ignored, plain save proceeds, `mergeContacts`/transfers never called.
- **Ожидаемый результат:** exactly per case; on every 409 leg ROLLBACK issued and no resolution primitive was invoked; on (d) response 200 `{ok:true}`.
- **Файл для теста:** `tests/contactsPatchMergeConflict.test.js`

### TC-CM-U13: Route — malformed `resolutions[]` → fresh 409, never 500
- **Приоритет:** P1
- **Тип:** Unit (route, parametrized — negative)
- **Связанный сценарий:** Error handling §"Malformed resolutions"
- **Входные данные:** `action:'delete'` (unknown), missing `owner_contact_id`, `attributes: 'x'` (not an array), `attributes:[{kind:'fax'}]`.
- **Ожидаемый результат:** every shape → treated as non-matching → **409** with the current conflict payload (when a conflict exists) — never a 500, никакого stack leak; with no conflict present the garbage resolution is ignored (as U12-d).
- **Файл для теста:** `tests/contactsPatchMergeConflict.test.js`

### TC-CM-U14: Route — execution order (Decision C) + FR-3 re-check at transfer execution
- **Приоритет:** P1
- **Тип:** Unit (route)
- **Связанный сценарий:** S9; Decision C steps 1–5; Decision D gate re-check
- **Предусловия:** valid transfer resolution; router flips the owner's inventory between detection and execution so the FR-3 re-check fails (stale-allowed transfer).
- **Ожидаемый результат:** ordered capture shows: detection SELECTs → resolution validation → contact UPDATE + email block → resolution execution → non-conflicted `resolveAddedEmail` loop → COMMIT. On the stale-gate leg: sentinel → ROLLBACK → fresh 409 (transfer never half-executed). Post-commit async legs (leads-cascade, `mergeOrphanTimelines`, ZB push) fire only after COMMIT (and NOT on the 409 leg).
- **Файл для теста:** `tests/contactsPatchMergeConflict.test.js`

### TC-CM-U15: Middleware/tenancy contract — 401 / 403 / 404 foreign id / forged echo ignored
- **Приоритет:** P0
- **Тип:** Unit (route — security)
- **Связанный сценарий:** S11; FR-10; house rule "каждый API-фиче тесты 401/403 и изоляции"
- **Входные данные:** (a) no token → **401**; (b) token without `contacts.edit` permission → **403**; (c) `:id` of a company-B contact with `req.companyFilter={company_id:A}` → **404 NOT_FOUND** (not 200, not 403 — no existence leak); (d) valid A-target but `resolutions:[{owner_contact_id:<B-contact>, action:'merge', …}]` → matches no detected conflict → **ignored**, `mergeContacts` never called with the B id; (e) invalid `:id` → 400 INVALID_ID; (f) no fields and no emails → 400 NO_FIELDS (unchanged; `emails: []` still a valid removal-only update).
- **Ожидаемый результат:** exactly per case; middleware chain unchanged (`authenticate` → `requireCompanyAccess` → `requirePermission('contacts.edit')`), no new route.
- **Файл для теста:** `tests/contactsPatchMergeConflict.test.js`

### TC-CM-U16: Decision E — scalar `email` branch: detection + in-tx `enrichEmail`+`resolveAddedEmail`; `emails[]` precedence kept
- **Приоритет:** P1
- **Тип:** Unit (route, parametrized)
- **Связанный сценарий:** S8; FR-8; Decision E; AC-7
- **Входные данные:** (a) body `{email:'new@cm1.test'}` (no `emails[]`), address not on the contact → included in detection; on no-conflict path `enrichEmail(id, email, client)` + `resolveAddedEmail(id, email, A, client)` called INSIDE the tx, scalar column written as today; (b) body `{email:'x', emails:[…]}` → `emails[]` wins, scalar branch skipped (existing behavior byte-for-byte); (c) scalar equals an address already on the contact (scalar or `contact_emails`) → no detection, no enrich duplicate; (d) empty scalar → untouched path.
- **Ожидаемый результат:** exactly per case — this is the server-side closure of the 4175/4228 hole for EVERY client of the route.
- **Файл для теста:** `tests/contactsPatchMergeConflict.test.js`

### TC-CM-U17: Route — in-tx sentinel from step-5 `resolveAddedEmail` (surprise owner born inside the tx) → ROLLBACK → fresh 409, not 500
- **Приоритет:** P2
- **Тип:** Unit (route — negative)
- **Связанный сценарий:** S14; Decision B hard guarantee
- **Предусловия:** detection returns no conflicts, but the step-5 `resolveAddedEmail` mock throws `ContactConflictError` (owner inserted after detection — race window).
- **Ожидаемый результат:** ROLLBACK issued (the contact UPDATE + email upserts undone with it), response **409** with a freshly-built conflict payload; NOT a 500; COMMIT never issued.
- **Файл для теста:** `tests/contactsPatchMergeConflict.test.js`

---

## 2. Integration — real DB, `scripts/verify-contact-merge-001.js` (NO mocks)

All cases drive the REAL `PATCH /api/contacts/:id` handler (both rounds over HTTP via supertest against real Postgres) unless stated; self-seeding/self-cleaning tag `CM1`. The full suite is re-run once against a **prod-copy restore** before deploy (AC-10; LIST-PAGINATION-001 lesson).

### TC-CM-I01 (s1): **P0 LOAD-BEARING** — S1 email-conflict full merge: complete AC-2 checklist incl. open-task re-home + zero dangling FK
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S1; FR-4; **AC-1 + AC-2**; ORPHAN-TASK-REHOME-001
- **Предусловия:** company A. Target **Jane** (phone, `zenbooker_customer_id='zb-jane'`). Owner **X Acme**: holds `x@cm1.test` (scalar + `contact_emails`), a phone, a lead, an **open task** on his timeline, 2 calls, an SMS conversation (`customer_digits` = his number), 2 email_messages.
- **Шаги:** 1) round-1 PATCH adds `x@cm1.test` to Jane → assert **409** with correct payload (owner=X Acme composition, attribute highlighted-able, `transfer_allowed:true`) AND **DB snapshot unchanged** after round 1; 2) round-2 PATCH with `resolutions:[{owner_contact_id, action:'merge', attributes:[{kind:'email', value:'x@cm1.test'}]}]` → 200; 3) assert + dangling-FK scan.
- **Ожидаемый результат:** Jane's `full_name`/`company_name`/`notes`/`zenbooker_customer_id` untouched (`zb-jane` kept); X Acme's phone fills Jane's free slot; his emails in Jane's `contact_emails` (NOT-EXISTS guarded); his lead, calls, email_messages on Jane / Jane's timeline; **the open task EXISTS, `status='open'`, `thread_id = Jane's timeline`** (re-homed, NOT cascade-deleted — a missing task = FAIL); X Acme and his timeline **gone**; dangling-FK scan (incl. `calls.timeline_id`/`calls.contact_id`) = **ZERO**; `findEmailContact('x@cm1.test',A)` → Jane; `contact_merged` event on Jane; **no ZB API call** (no zb-sync outbox row for the dup).
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s1)

### TC-CM-I02 (s3): **P0 FK-TRAP** — S3 phone-conflict merge: dup timeline HOLDS CALLS; 3b re-points them BEFORE the timeline delete
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S3; Decision C2 3b; AC-2; the `calls.timeline_id` no-ON-DELETE trap
- **Предусловия:** target "Acme Billing" (1 phone); owner **Bob**: `phone_e164=+1999777…22`, 3 calls **on his timeline**, a job. This is the generic-dup shape v1's email-only dups never had — mocked jest cannot prove the FK holds; only real Postgres can (a wrong order raises `foreign key violation` here).
- **Шаги:** round-1 add `…22` as Acme Billing's secondary → 409 (detection digit-matched via mig-149 legs) → round-2 `action:'merge'` → 200.
- **Ожидаемый результат:** the merge **commits without an FK error**; all 3 calls now `timeline_id = survivorTl, contact_id = survivor`; Bob's job re-pointed; Bob's number in a survivor slot; Bob + his timeline deleted; dangling-FK scan zero; inbound resolve (`findOrCreateTimeline` digit-match) → Acme Billing.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s3)

### TC-CM-I03 (s4): **P0** — S4 transfer phone: promotion, this-number-only calls move, owner's world stays, SMS flips at query time
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S4; FR-5; OQ-3; **AC-3**
- **Предусловия:** owner **Bob**: `phone_e164=…22` (conflicting), `secondary_phone=…33` + `secondary_phone_name='Wife'`; 2 calls from `…22` + 2 calls from `…33` on his timeline; a job; SMS conversations for both numbers. Target "Acme Billing".
- **Шаги:** round-1 add `…22` → 409 `transfer_allowed:true` → round-2 `action:'transfer'` → 200.
- **Ожидаемый результат:** Bob: `phone_e164 = …33` (**promoted**), `secondary_phone/secondary_phone_name = NULL`, NOT deleted, job intact, `…33` calls still on his timeline; target carries `…22`; **only** the 2 `…22` calls moved to the target's timeline (`contact_id` updated too); `getUnifiedTimelinePage` / SMS digit-lateral now surfaces the `…22` SMS conversation on the target row and NOT on Bob's (no `sms_conversations` row was written — assert row untouched); `findOrCreateTimeline` for a new inbound `…22` call resolves to the target. **No event emitted** (transfers are event-less by spec S4).
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s4)

### TC-CM-I04 (s2): S2 transfer email — row moves, owner scalar syncs, messages re-linked, owner intact
- **Приоритет:** P1
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S2; FR-6; AC-4
- **Предусловия:** owner **Bob**: scalar `contacts.email='bob@cm1.test'` (+ `contact_emails` primary row) + a second address + a phone; 2 `email_messages` for `bob@cm1.test` on his timeline. Target "Acme Billing".
- **Шаги:** 409 → `action:'transfer'` → 200.
- **Ожидаемый результат:** `bob@cm1.test` exists ONLY on the target (`contact_emails` + detection resolves there); its 2 messages on the target's timeline (`on_timeline=true`); Bob's `contact_emails` row for it **deleted**, his scalar synced to his remaining address; Bob's other address, phone, calls, timeline untouched; Bob alive. Future `findEmailContact` → target.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s2)

### TC-CM-I05 (s5): **P0** — S5 cancel: round 1 commits NOTHING — byte-identical DB snapshot, incl. the non-conflicting field edits
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S5; FR-7; **AC-6**
- **Предусловия:** the I01 fixture; snapshot hash of the full CM1 row-set taken BEFORE the request.
- **Шаги:** 1) round-1 PATCH carrying the conflicting email **plus** `full_name:'Jane Edited'` and a new secondary phone → 409; 2) NO retry (= Cancel); 3) re-snapshot + compare; 4) send a fresh PATCH withOUT the conflicting attribute (only `full_name`) → 200.
- **Ожидаемый результат:** step 3: **hash-identical** — no contact field (incl. `full_name`), no `contact_emails`, no timeline/call/message/task row changed by round 1 (detection precedes all writes; ROLLBACK proven on real Postgres, not a mock); step 4 passes with **no dialog** and only then persists the name.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s5)

### TC-CM-I06 (s6): S6 single-attribute owner — `transfer_allowed:false` end-to-end; forced `transfer` retry rejected server-side
- **Приоритет:** P1
- **Тип:** Integration (real DB — negative + positive)
- **Связанный сценарий:** S6; FR-3; AC-5 (D2a replacement)
- **Предусловия:** owner = email-only auto-contact (one email, no phone, zero identity rows) — exactly what old D2a silently ate. Second parametrization: owner with ONLY the conflicting phone.
- **Шаги:** 1) round 1 → assert `transfer_allowed:false` in the payload; 2) retry with `action:'transfer'` anyway (hostile client) → assert **fresh 409**, owner untouched; 3) retry with `action:'merge'` → 200.
- **Ожидаемый результат:** the transfer attempt never strips the owner (server re-checks the gate at execution); the merge deletes the dup ONLY after the explicit confirm; `contact_merged` event on the survivor; dangling-FK scan zero. **No silent auto-merge happened at any point** (round 1 provably changed nothing — snapshot check).
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s6)

### TC-CM-I07 (s7): S7 multi-owner — ONE 409 grouped by owner; ONE retry executes both resolutions (merge A + transfer B)
- **Приоритет:** P1
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S7; FR-2 grouping; Decision A
- **Предусловия:** one Save adds: phone owned by contact **A2** + email ALSO owned by A2 + email owned by contact **B2** (B2 keeps a phone).
- **Шаги:** round 1 → assert `conflicts.length === 2`, A2's entry carries BOTH attributes; round 2 with `[{A2, merge, [phone,email]}, {B2, transfer, [email]}]` → 200.
- **Ожидаемый результат:** A2 fully merged+deleted (one `contact_merged` event), B2 alive minus the transferred address; both effects in ONE tx (both present after the single 200; a mid-way failure would have left neither — covered by I14).
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s7)

### TC-CM-I08 (s11): **P0 SECURITY** — S11 cross-tenant: same number AND address in company B → invisible, untouchable; forged echo ignored; foreign :id → 404
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (real DB — security)
- **Связанный сценарий:** S11; FR-10; **AC-9**; LIST-PAGINATION-001 / ZB-ISO-001 / ONBOARD-FIX-001 precedents
- **Предусловия:** company **B** (tagged, created here): contact **BC** with phone `…44` + email `shared@cm1.test`, B-scoped calls/messages/timeline/open task. Company A: target T; **no** A-side owner of either value.
- **Шаги & Ожидаемый результат (four legs, each asserted):**
  1. **Detection leg:** A-PATCH adds `…44` AND `shared@cm1.test` to T → **200, NO 409** (B invisible to detection); values saved on T; BC + every B row byte-untouched.
  2. **Forged-echo leg:** A-PATCH with `resolutions:[{owner_contact_id: BC, action:'merge', attributes:[…]}]` → resolution matches no detected conflict → **ignored**; BC alive, nothing of B read/re-pointed/deleted (assert B snapshot identical).
  3. **Foreign-:id leg:** PATCH `/api/contacts/<BC-id>` under A's companyFilter → **404** (not 200/403), body leaks nothing of B.
  4. **Execution leg:** direct service sanity — `mergeContacts(T, BC, A, client)` **throws** the tenant guard (never reachable via route, belt-and-braces); `transferPhone`/`transferEmail` with a B-owner id under company A touch 0 rows.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s11)

### TC-CM-I09 (s9): **P0** — S9 stale echo on real DB: owner mutated between rounds → fresh 409 (mismatch) or clean ignore (conflict gone)
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (real DB — race)
- **Связанный сценарий:** S9; FR-1 race-safe; **AC-10**
- **Предусловия:** round-1 409 issued for owner O (attribute = phone P).
- **Шаги:** (a) between rounds, a second session gives O ANOTHER conflicting attribute being added in the same Save → retry with the old echo → **fresh 409** with the CURRENT attribute set, nothing committed (snapshot check); (b) between rounds, P is transferred away from O by another session → retry → resolution matches nothing → **ignored**, plain save proceeds, P lands on the target, O untouched.
- **Ожидаемый результат:** a stale resolution is NEVER executed against changed reality; on the mismatch path the DB is snapshot-identical; on the gone path no error and no ghost-merge.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s9)

### TC-CM-I10 (s10): S10 double-submit of the confirmed retry → idempotent no-op (merge, transfer-phone, transfer-email — all three)
- **Приоритет:** P1
- **Тип:** Integration (real DB, parametrized over the 3 actions)
- **Связанный сценарий:** S10; FR-10; AC-10
- **Предусловия:** each action's confirmed retry has just succeeded; snapshot taken.
- **Шаги:** re-send the exact same round-2 request (double click / network retry); for transfers additionally re-run the primitive directly (`transferPhone`/`transferEmail` second call).
- **Ожидаемый результат:** **200**, state snapshot-identical: no second `contact_merged` event, no tenant-guard throw (detection finds nothing → resolutions ignored → plain save), transfer re-runs are 0-row UPDATEs / no-row DELETE / no-op re-link. No error anywhere.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s10)

### TC-CM-I11 (s8): S8 scalar email via the REAL handler — 4175/4228 regression closed for both branches
- **Приоритет:** P1
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S8; Decision E; **AC-7**
- **Предусловия:** exact `PulseContactPanel` payload shape: `PATCH {email:'p@cm1.test'}` — no `emails[]`.
- **Шаги & Ожидаемый результат:** (a) **no-conflict branch:** address unowned, has 1 inbox-only message → 200; scalar written AND `contact_emails` row EXISTS (pre-fix: absent — that absence = FAIL, the literal 4175/4228 reproduction) AND the stray message linked onto the target timeline; (b) **conflict branch:** address owned by another A-contact → **409** with the same payload shape as the `emails[]` path → merge retry → same outcomes as I01. (c) scalar already on the contact → 200, no duplicate row, no dialog.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s8)

### TC-CM-I12 (s15): S15 slot overflow — dropped numbers audited, their calls still move, SMS caveat observed
- **Приоритет:** P1
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S15; OQ-2; Decision C2 3c
- **Предусловия:** survivor with 2 phones; dup with 2 phones, calls + an SMS conversation on the number that will be dropped.
- **Шаги:** merge via the two-round PATCH.
- **Ожидаемый результат:** survivor still has exactly its own 2 numbers (no slot overwritten); `contact_merged` event carries `dropped_phones` with both dup numbers; the dropped number's **calls moved** (they rode the dup timeline via 3b); its **SMS conversation no longer surfaces** on the survivor's Pulse row (query-time digit match — documented v1 limitation) while the `sms_conversations` rows are NOT deleted; warn log emitted.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s15)

### TC-CM-I13 (s16): **P0** — S16 silent branches byte-for-byte: inbox-only D3, orphan `mergeOrphanTimelines`, background ingestion
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (real DB — regression)
- **Связанный сценарий:** S16; FR-9; **AC-8**; Protected parts
- **Шаги & Ожидаемый результат (three legs):**
  1. **D3 inbox-only:** PATCH adds an address nobody owns, with 2 unowned `email_messages` → **200, no 409**, messages silently linked onto the target timeline (identical to TC-CEM-I01 behavior — re-run that assertion body under the new code).
  2. **Orphan phones:** PATCH changes a phone that has an ownerless orphan timeline (+ after a transfer, the just-gained number has one) → the async post-commit `mergeOrphanTimelines` still adopts it byte-for-byte (poll post-commit); no dialog was involved.
  3. **Ingestion path:** call the real ingestion entry (`linkInboundMessage` / lead-create contact upsert) with an address owned by ANOTHER contact → **no sentinel, no 409, no behavior change** (the sentinel lives only in the PATCH-called `resolveAddedEmail` branches) — ingestion never throws `ContactConflictError`.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s16)

### TC-CM-I14 (s14): **P0** — S14 fault injection mid-resolution → FULL rollback on real Postgres; async legs never fired
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (real DB — fault injection)
- **Связанный сценарий:** S14; Constraints "одна транзакция"; **AC-6/AC-2 integrity**
- **Предусловия:** I07's two-resolution fixture; a test hook (env-guarded, e.g. `CM1_FAIL_AFTER='mergeContacts'`) makes the SECOND resolution leg throw after the first fully executed inside the tx.
- **Шаги:** round-2 PATCH → 500 (or sentinel-409) → snapshot compare.
- **Ожидаемый результат:** DB **snapshot-identical to pre-request**: the FIRST resolution's merge is rolled back too (dup alive, task on its old timeline, calls unmoved), the contact UPDATE + email upserts undone, no cleared owner slot without moved calls, no half-merge. Leads-cascade / `mergeOrphanTimelines` / ZB push did **NOT** fire (post-commit only). Never a deleted contact with orphaned children.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s14)

### TC-CM-I15 (s16): Pulse list after merge/transfer — dup row disappears, survivor row surfaces; thread flips on transfer; NO query change
- **Приоритет:** P2
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S16 Pulse leg; S1/S4 side effects
- **Шаги:** after I01's merge and I03's transfer, call the real `getUnifiedTimelinePage({companyId:A, limit:50, offset:0})`.
- **Ожидаемый результат:** merged dup's conversation row gone; survivor's row present, positioned by the merged thread's last activity; after the phone transfer the `…22` SMS/call thread appears under the target's row and not the owner's — all via the **unchanged** query (assert no code change needed: the same function from master's `timelinesQueries`).
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s16)

### TC-CM-I16 (s12): S12 self-conflict — re-saving own attributes = byte-identical no-op, no dialog
- **Приоритет:** P2
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S12
- **Шаги:** PATCH re-submits the target's own email (scalar and `emails[]` forms) and its own secondary number as primary; snapshot before/after.
- **Ожидаемый результат:** **200, no 409**; snapshot-identical outcome to today's re-save (`resolveAddedEmail` owner==target no-op branch intact).
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s12)

### TC-CM-I17 (s13): S13 owner deleted between rounds → resolution ignored, attribute lands, stray messages linked
- **Приоритет:** P2
- **Тип:** Integration (real DB)
- **Связанный сценарий:** S13
- **Предусловия:** 409 issued for owner O; O deleted (another session) before the retry, his messages now unowned.
- **Шаги:** retry with the now-ghost resolution.
- **Ожидаемый результат:** **200**; no error, no ghost-merge, no tenant-guard throw; the email lands on the target and `resolveAddedEmail` takes the now-silent inbox-only branch linking O's stray messages.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (s13)

### TC-CM-I18 (explain): **P0 perf gate** — `EXPLAIN` on prod copy: detection uses mig-149 expression indexes; transfer call-filter uses `idx_calls_timeline_id`; NO new Seq Scan
- **Приоритет:** **P0 (ship gate, prod-copy only)**
- **Тип:** Integration (plan probe)
- **Связанный сценарий:** Verify plan bullet 3; PULSE-PERF-001 discipline; Decision B/D "no new index expected"
- **Предусловия:** fresh prod `pg_dump` restore (local dev too small to be representative).
- **Шаги:** `--explain` mode: 1) `EXPLAIN (ANALYZE, BUFFERS)` the exact detection phone-lookup SQL (full-digit legs) → 2) the same with only a last-10 hit shape → 3) the `transferPhone` calls UPDATE filter (as a SELECT).
- **Ожидаемый результат:** (1) Index/Bitmap scan on the **mig-149 expression indexes** over `contacts` — a Seq Scan on `contacts` at prod scale = FAIL; (2) documented plan (the last-10 leg is a bounded per-Save lookup — record actual cost; if it degrades to a Seq Scan, note it in the PR as the accepted per-Save cost per architecture, but the full-digit leg MUST be indexed); (3) Index scan on `idx_calls_timeline_id` then filter — no Seq Scan on `calls`. Plans pasted into the PR (house requirement).
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (`--explain`)

### TC-CM-ISAB (sab): **P0** — sabotage negative controls: wrong-expectation FAIL + amendment-#5 feature-stash FAIL
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (harness self-check)
- **Связанный сценарий:** harness integrity; LIST-PAGINATION-001 "a green run must certify the detector works"; амендмент #5
- **Шаги & Ожидаемый результат (two legs):**
  1. **Wrong-expectation leg:** after I01's merge, run the assertion suite with a deliberately-wrong expectation (dup still exists / dangling-FK count = 999) → the assert kit throws `CheckError`, the case records **FAIL**; restore → green.
  2. **Feature-stash leg (амендмент #5):** `git stash` the feature diff (service + route), restart the harness on the s1/s5/s8 sections → the harness **MUST record FAILs** (no 409 arrives / scalar `contact_emails` row absent / silent D2a merge happens without confirmation) — proving the suite detects the pre-feature world; `git stash pop` → re-run → green. A harness that stays green with the feature stashed = every PASS above is vacuous → release blocked.
- **Файл для теста:** `scripts/verify-contact-merge-001.js` (sab)

---

## 3. Frontend — manual + build (no FE test harness; SCHED-TILE-001 precedent)

### TC-CM-F01: `MergeContactsDialog` — canonical confirmation surface, gated actions, hint lines, tokens only
- **Приоритет:** P1
- **Тип:** Frontend (manual)
- **Связанный сценарий:** S1/S6; FR-2; UI section of the spec; OVERLAY-CANON-002
- **Шаги:** trigger a real conflict from `EditContactDialog` on desktop and mobile viewport; inspect the dialog for both `transfer_allowed` values and for a phone vs an email conflict.
- **Ожидаемый результат:** center modal `variant="dialog"` (NOT panel) on desktop, **auto-BottomSheet on mobile** with no extra code; title "Merge contacts?"; two-column grid (stacks to 1 col on narrow), each side = name (semibold) + ALL phones + ALL emails, **no empty rows**, conflicting attribute highlighted by weight/`--blanc-ink-1` (no hardcoded hex — grep the new files for `#`); primary `Merge contacts` + its consequence hint; `Transfer phone`/`Transfer email` visible ONLY when `transfer_allowed`, else the one-line explanation; ghost `Cancel`; Escape/backdrop = Cancel (shared overlay logic, no hand-rolled close button); no input fields, no checkbox picker.
- **Файл для теста:** manual / dev-preview

### TC-CM-F02: `useContactConflictFlow` — sequential dialogs, ONE retry, cancel aborts whole Save, editor keeps state, stale 409 restarts round
- **Приоритет:** P1
- **Тип:** Frontend (manual + Network tab)
- **Связанный сценарий:** S5/S7/S9 client side; FR-7; AC-6
- **Шаги:** (a) craft a two-owner conflict (S7 fixture) → Save; (b) resolve dialog 1, then Cancel dialog 2; (c) redo and confirm both; (d) simulate a stale second 409 (concurrent session between rounds).
- **Ожидаемый результат:** (a) dialogs appear **sequentially per owner** (one at a time); (b) Cancel at ANY dialog → **no retry request in Network**, editor still open with entered values, no toast of failure; (c) exactly **ONE** retry PATCH carrying BOTH resolutions (Network shows 2 PATCH total: 409 + 200), success toast/close as today; (d) a retry that 409s again reopens the dialog round with the FRESH payload, no stale action. 409 never shows the generic error toast (flow intercepts `CONTACT_ATTRIBUTE_CONFLICT`; other errors keep today's toasts).
- **Файл для теста:** manual / dev-preview + Network tab

### TC-CM-F03: `PulseContactPanel` inline email through the same flow — UX preserved
- **Приоритет:** P2
- **Тип:** Frontend (manual)
- **Связанный сценарий:** S8; FR-8; AC-7
- **Шаги:** type a conflicting email into the Pulse-panel inline editor and save; also cancel from the dialog; also save a non-conflicting email.
- **Ожидаемый результат:** payload stays scalar `PATCH {email}` (Network check — no `emails[]` conversion); conflict → the SAME `MergeContactsDialog`; cancel keeps the typed draft in the inline editor; spinner during save preserved; non-conflict save works as today.
- **Файл для теста:** manual / dev-preview + Network tab

### TC-CM-F04: Build stays green
- **Приоритет:** P3
- **Тип:** Frontend (build)
- **Связанный сценарий:** ship gate (frontend-build-command: `npm run build` = `tsc -b`, stricter than `tsc --noEmit` — noUnusedLocals)
- **Шаги:** `cd frontend && npm run build`.
- **Ожидаемый результат:** exit 0; `contactsApi.updateContact(contactId, fields, resolutions?)` typed; `ContactsApiError.details?` carries the `conflict` payload; `ContactConflict`/`ContactConflictResolution` exported and consumed by the hook/dialog without `any`.
- **Файл для теста:** build

---

## Regression / Protected (must stay green)

- **TC-R-1 (P0):** **CONTACT-EMAIL-MERGE-001 suites** — `tests/contactEmailMerge.test.js`, `tests/contactsPatchEmails.test.js`, `scripts/verify-contact-email-merge-001.js`. The D2a/D2b **silent** expectations (TC-CEM-U02/U03 and the s2/s3 auto-merge legs) are the intentionally replaced behavior: they must be **UPDATED to expect the sentinel/409** as part of this feature — an update is required and reviewed, a silent deletion of those cases = FAIL. Everything else (U01/U04 dispatch, isContactEmailOnly, B3 order, s1/s6/s7/s8, sabotage) stays green unchanged.
- **TC-R-2 (P1):** `timelineMergeService.mergeOrphanTimelines` + its async PATCH trigger byte-for-byte (live-covered by TC-CM-I13 leg 2); ORPHAN-TASK-REHOME-001 re-home semantics intact.
- **TC-R-3 (P1):** `getUnifiedTimelinePage` / `email_by_contact` CTE / SMS digit-lateral — zero query change (TC-CM-I15 asserts the master-shape function suffices); `tests/listPaginationByContact.test.js` stays 100% green; PULSE-PERF-001 plans unchanged.
- **TC-R-4 (P2):** `contact_emails` mig-025 invariants (UNIQUE(contact_id, email_normalized), single primary, CASCADE) never violated by transfer/merge legs; `linkMessageToContact` idempotent re-link + EMAIL-UNREAD-001 semantics reused unchanged.
- **TC-R-5 (P2):** leads-cascade + async ZB contact push in `PATCH /:id` keep firing post-commit on success paths (and never on rollback paths — TC-CM-I14); `server.js`/`authedFetch`/`useRealtimeEvents` untouched (git diff scope check).
- **TC-R-6 (P3):** no migration introduced (Decision F); if one ever appears it is numbered ≥156 after re-verifying max (parallel branches), with rollback + logged row count.
