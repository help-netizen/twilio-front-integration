# Тест-кейсы: EMAIL-LEAD-ORIGIN-001 — email-only Pulse timelines are first-class (show the contact card + let a lead be born from an email, phone OPTIONAL)

**Source spec:** `Docs/requirements.md` §EMAIL-LEAD-ORIGIN-001 (PART A + PART B, FR-A1/A2, FR-B1…B4, AC-1…AC-7, user scenarios 1–6, constraints) + `Docs/architecture.md` §EMAIL-LEAD-ORIGIN-001 (Decisions A–F). **Change points confirmed in source:**
- **Backend:** `backend/src/services/leadsService.js` — **NEW** `getLeadByContact(contactId, companyId)` (byte-for-byte clone of `getLeadByPhone` @ leadsService.js:1096 with the phone predicate swapped for `l.contact_id = $1`; export it). `backend/src/routes/leads.js` — **NEW** `GET /by-contact/:contactId` (with the `by-*` static routes **above** `/:uuid` @ line 175; gate `requirePermission('leads.view','pulse.view')` identical to `by-phone` @ line 104; int-validate like `by-id/:id` @ line 148 → 400 `INVALID_ID`); relax `POST /` validation @ **line 202** (`if (!body.Phone || body.Phone.length < 5)`) to phone-OR-email-OR-`selected_contact_id`; guard the `update_contact` `phone_e164` write @ **line 219** (`params.push(toE164(body.Phone) || body.Phone)`) with `if (body.Phone)`. `backend/src/services/contactDedupeService.js` `resolveContact` — **reused unchanged** (already resolves phoneless: email-match / name-only→ambiguous; `createNewContact` writes `phone_e164` NULL).
- **Frontend:** `frontend/src/pages/PulsePage.tsx` (ungate the tri-state @ ~line 361 to identity-based `(p.phone || p.contact?.id)`; pass `contactId`+`email` to the wizard); `frontend/src/hooks/usePulsePage.ts` (call `useLeadByContact` alongside `useLeadByPhone`); `frontend/src/components/contacts/PulseContactPanel.tsx` (null-guard the primary-phone row @ lines 117-122); `frontend/src/components/conversations/CreateLeadJobWizard.tsx` (phone optional + email/contactId origin; `convertLead` customer phone conditional @ line 170; with-JOB leg hidden when phone blank); **NEW** `frontend/src/hooks/useLeadByContact.ts`; `frontend/src/services/leadsApi.ts` (`getLeadByContact`).

**House lesson (LIST-PAGINATION-001 / created_by-FK, binding):** mocked jest mocks `db`, so it validates the **SQL string / dispatch shape only** — it can NOT prove a phoneless row was inserted with `phone` NULL, that `getLeadByContact` returns the right lead, or that a foreign-company `contactId` is excluded. Every behavior claim therefore has a **real-DB** integration case in `scripts/verify-email-lead-origin-001.js` (tag `ELO1`, self-seeding/self-cleaning, PASS/FAIL per case + sabotage control), exactly as `scripts/verify-tasks-count-001.js` / `scripts/verify-contact-email-merge-001.js` do.

**Jest gotcha:** in a worktree run with `--testPathIgnorePatterns "/node_modules/"` (JOBS-UX-RBAC-001 lesson).

**Migration:** **NONE** (architecture Decision F — mig 004 `leads.phone` NULLABLE + `leads.email`; mig 023 `leads.contact_id` + `idx_leads_contact_id` cover storage AND the by-contact lookup's index). If one ever becomes necessary the next free number is **156** (re-verify max — parallel branches). **Max migration = 155; no new file.**

---

## Scenario map (spec → S-id used below)

The requirement lists 6 "User scenarios"; the S-numbering below is the verify-script's internal id (the task's own S1–S8 designation). S1–S6 = user-scenarios 1–6; S7 = tenancy (AC-7); S8 = the phone-path regression (Protected parts / AC-6).

| S-id | Meaning | Source | Priority focus |
|------|---------|--------|----------------|
| **S1** | Open an email-only timeline → the detail card **renders** (identity: name + email), no `tel:`/call/SMS affordance, no thrown render | user-scenario 1, FR-A1/A2, AC-1 | P1 |
| **S2** | Card shows an **existing** lead when one is linked by `contact_id` (LeadDetailPanel, no "create") — via the new by-contact lookup | user-scenario 2, FR-B2, AC-2, AC-5 | **P0 (lookup correctness)** |
| **S3** | No lead yet → offer **"create lead from email"** (email-origin wizard, phone blank/optional) | user-scenario 3, FR-A1, FR-B3 | P1 |
| **S4** | **Create a lead from an email** with email + name, phone OPTIONAL → row has `phone` NULL, `email` set, `contact_id` set (no fabricated phone) | user-scenario 4, FR-B1, FR-B3, **AC-3, AC-4** | **P0 (must-pass — phoneless create)** |
| **S5** | Phoneless `PulseContactPanel` / `LeadDetailPanel` **do not crash** and hide/disable phone-only actions (primary-phone row omitted, SMS composer hidden); email row/composer stay | user-scenario 5, FR-A2, AC-1 | P1 (its lookup-correctness half folds into **S2 P0**) |
| **S6** | Email-origin lead appears on the **Leads page** + on the **contact** (`leads.contact_id`); reopening the timeline now shows LeadDetailPanel (S2); sidebar surfaces via the **email** signal | user-scenario 6, FR-B1, FR-B4-defer, AC-4 | P1 |
| **S7** | **Cross-tenant** — `getLeadByContact(contactId_of_B, companyA)` → null; company-B lead never returned/attached for company A | AC-7, constraints (ONBOARD-FIX-001 / ZB-ISO-001) | **P0 (must-pass — security)** |
| **S8** | **Regression** — phone timeline / `getLeadByPhone` / phone-origin `POST /api/leads` / `useLeadByPhone` byte-for-byte unchanged; no duplicate lead for a contact that already has one | AC-6, Protected parts | P0 |

**The two P0 must-pass gates:** **S4** (phoneless create stores `phone` NULL / `email` / `contact_id`, no faked phone) and **S7** (no cross-tenant lead read/attach). **S2/S5** (by-contact lookup correctness incl. the job-filter + Lost/Converted filter) is **also P0** — it is what prevents duplicate leads. A red on any of S4 / S7 / S2 blocks the release.

---

## Покрытие / Coverage

- Всего тест-кейсов: **32** (numbered) + **7** regression/protected items = **39**.
- **Numbered cases by priority — P0: 12 | P1: 12 | P2: 6 | P3: 2.** Regression items — P0: 1 | P1: 3 | P2: 2 | P3: 1.
- **Unit (jest, mocked db): 13** | **Integration (real DB, `scripts/verify-email-lead-origin-001.js`): 12** | **Frontend (manual + build): 7**.
- Security (cross-tenant): **3** (TC-ELO-I05 + TC-ELO-I06 real-DB + TC-ELO-U03 route company-scope guard). Sabotage negative control: **1** (TC-ELO-ISAB).
- Every spec scenario **S1–S8** covered; positive + negative per scenario; middleware **401/403** + cross-tenant isolation + direct-foreign-id included.

---

## Shared fixtures & harness (Integration section)

House pattern of `scripts/verify-tasks-count-001.js` (**no mocks anywhere in this section** — Zenbooker/Gmail never called; the create path is exercised at the service boundary `leadsService.createLead` + the resolve helper, and — where stated — via the real `POST /api/leads` handler in an express app with stub auth):

- **Script:** `scripts/verify-email-lead-origin-001.js`, sections `s1…s8` + `explain` + `sab` selectable via `--section=<id>|all`. `DATABASE_URL` defaults to `postgresql://localhost/twilio_calls` (house default; **never point at prod**). Exit code 0 only when **no case FAILs**. Reuse the tiny assert kit from `verify-tasks-count-001.js` (`check`/`eq`/`record`, `CheckError`).
- **Unique tag `ELO1`** on every seeded row for self-cleaning: contacts `full_name LIKE 'ELO1 %'`; leads `uuid LIKE 'elo1%'` (uuid is varchar(20) — keep the tagged value short+unique, mirror `mkLead` in the tasks script); jobs by tagged contact / tagged company; companies `id IN {A, B-tagged}`. **Cleanup runs at process start, before EACH case, and at end**, FK order: `jobs → leads → contacts → crm_users → companies` (+ any tagged timeline/`email_*` if a case seeds one).
- **Companies:** A = seed `00000000-0000-0000-0000-000000000001` (real dev rows coexist → assertions are **row-targeted by the tagged contact/lead id or delta**, never absolute whole-company counts); **B** = tagged `c0000000-0000-4000-8000-0000000000f1`, **CREATED + deleted here** (cross-tenant), via an `ensureCompany`/`ON CONFLICT DO NOTHING` helper.
- **Real functions exercised (unmocked):** `leadsService.getLeadByContact` (the NEW lookup — the star of the section); `leadsService.getLeadByPhone` (S8 regression, must be byte-identical on the same seed); `leadsService.createLead` (phoneless + phone-origin); optionally the real `POST /api/leads` handler mounted with stub auth injecting `req.user`/`req.authz`/`req.companyFilter = {company_id:A}` (mirrors the jest route harness, real `db/connection`) for the end-to-end AC-3/AC-4 legs.
- **Seed builders (tagged ELO1):** `mkContact(company,{name,phone})` (phoneless = `phone_e164 NULL`); `mkLead(company,{contactId,status,phone,email})` (default `status:'Submitted'`, phone omitted → NULL; direct INSERT so we control status incl. `Lost`/`Converted`); `mkJob(company,{contactId})` (the "contact has a job → lookup returns null" trap).
- **Byte-identical assertion helper (S8):** capture `JSON.stringify(getLeadByPhone(phone, A))` on a fixed seed, run once before and once after a phoneless lead is added for a **different** contact, assert the two serializations are **identical** (the new code path must not perturb the phone path).

---

## 1. Unit — jest, mocked db (`tests/leadByContact.test.js` NEW; POST cases extend the leads route suite `tests/routes/leads.test.js`)

`jest.mock('../../backend/src/db/connection')`; assertions read the mocked query calls + the branch taken. These pin the **SQL shape and the request contract** — never "a phoneless row exists" (that is the integration section's job).

### TC-ELO-U01: `getLeadByContact` SQL shape — `contact_id` predicate + status filter + newest-open, mirrors `getLeadByPhone`
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S2; FR-B2; architecture Decision B (`getLeadByContact` bullet)
- **Предусловия:** mocked `db.query` returns one lead row (`contact_id=10`, no matching job on the 2nd call).
- **Входные данные:** `getLeadByContact(10, 'A')`.
- **Ожидаемый результат:** the first SQL matches `/WHERE .*l\.contact_id = \$1/`, contains `l.status NOT IN ('Lost', 'Converted')` and `l.company_id = $2` (company param present), the `lead_team_assignments` `team` aggregation (`json_agg(... 'name', lta.user_name ...)`), `ORDER BY l.id DESC` and `LIMIT 1` (newest open). It does **NOT** reference `l.phone` / `REGEXP_REPLACE`. Returns `rowToLead(row)`.
- **Файл для теста:** `tests/leadByContact.test.js`

### TC-ELO-U02: `getLeadByContact` post-filter — contact already has a job → returns **null** (mirrors `getLeadByPhone` @ leadsService.js:1132)
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S2; FR-B2 ("mirror the phone-lookup's open-lead semantics — phone lookups already filter out leads whose contact has a job")
- **Предусловия:** first `db.query` (lead) returns a row with `contact_id=10`; second `db.query` (`SELECT 1 FROM jobs WHERE contact_id=$1 LIMIT 1`) returns **1 row**.
- **Ожидаемый результат:** the function issues the `jobs` existence probe with `[10]` and returns **`null`** (the stale lead is suppressed so the card shows the contact panel, not the lead) — exact parity with `getLeadByPhone`. When the job probe returns 0 rows, it returns `rowToLead(row)` instead.
- **Файл для теста:** `tests/leadByContact.test.js`

### TC-ELO-U03: `getLeadByContact` — company scope threaded; no company arg → predicate omitted (parity with `getLeadByPhone`)
- **Приоритет:** P0
- **Тип:** Unit (parametrized)
- **Связанный сценарий:** S7; constraints "every new leg company-scoped"
- **Входные данные:** (a) `getLeadByContact(10,'A')`; (b) `getLeadByContact(10)` (no companyId).
- **Ожидаемый результат:** (a) SQL includes `l.company_id = $2`, params `[10,'A']`; (b) SQL omits the company predicate, params `[10]` — byte-for-byte the `getLeadByPhone` conditional-scope shape. (The route ALWAYS passes a company id — TC-ELO-U06 — so (b) documents the service contract, not a reachable route state.)
- **Файл для теста:** `tests/leadByContact.test.js`

### TC-ELO-U04: `getLeadByContact` — no matching lead → returns **null** (no throw)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S2 (empty case); AC-5 ("empty result when none")
- **Предусловия:** first `db.query` returns `{ rows: [] }`.
- **Ожидаемый результат:** returns `null` (NOT a thrown `LEAD_NOT_FOUND` — unlike `getLeadByUUID`; it must mirror `getLeadByPhone`'s null-return so the card offers "create"). The `jobs` probe is not issued when there is no lead.
- **Файл для теста:** `tests/leadByContact.test.js`

### TC-ELO-U05: Route `GET /api/leads/by-contact/:contactId` — happy path envelope, company-scoped
- **Приоритет:** P0
- **Тип:** Unit (route, db mocked)
- **Связанный сценарий:** S2; AC-5; architecture Decision B route bullet
- **Предусловия:** stub auth injects `req.companyFilter={company_id:'A'}` + `leads.view`; `leadsService.getLeadByContact` spied → returns a lead object.
- **Входные данные:** `GET /api/leads/by-contact/10`.
- **Ожидаемый результат:** 200, body is the success envelope `{ ok:true, data:{ lead:<obj> } }`; `getLeadByContact` called with `(10, 'A')` (Number-coerced id + `req.companyFilter.company_id`). Empty-lead case → `{ data:{ lead:null } }`.
- **Файл для теста:** `tests/routes/leads.test.js`

### TC-ELO-U06: Route gating — 403 without `leads.view`/`pulse.view`; 401 without auth (identical gate to `by-phone`)
- **Приоритет:** P0
- **Тип:** Unit (route)
- **Связанный сценарий:** middleware (agent-04 §"Тесты безопасности"); constraints; permission gate = `requirePermission('leads.view','pulse.view')`
- **Входные данные:** (a) session perms `['jobs.view']` (neither `leads.view` nor `pulse.view`); (b) documented: real `authenticate` at the `app.use('/api/leads', authenticate, requireCompanyAccess, …)` mount (server.js:160).
- **Ожидаемый результат:** (a) **403**, `getLeadByContact` never called; (b) an unauthenticated request is rejected before the handler (**401**) exactly as the rest of the leads suite asserts — the count/lookup never runs.
- **Файл для теста:** `tests/routes/leads.test.js`

### TC-ELO-U07: Route int-validation — non-numeric / non-positive `:contactId` → 400 `INVALID_ID`, no query
- **Приоритет:** P1
- **Тип:** Unit (route, parametrized)
- **Связанный сценарий:** AC-5 ("validate contactId is a positive int"); mirrors `by-id/:id` @ leads.js:148
- **Входные данные:** `:contactId` ∈ { `abc`, `-1`, `0`, `1.5`, `` }.
- **Ожидаемый результат:** **400** with `errorResponse('INVALID_ID', …)`; `getLeadByContact` **not** called for any of them. A valid positive int (`10`) passes through.
- **Файл для теста:** `tests/routes/leads.test.js`

### TC-ELO-U08: Route order — `/by-contact/:contactId` resolves to its handler, NOT parsed as `/:uuid`
- **Приоритет:** P1
- **Тип:** Unit (route order)
- **Связанный сценарий:** architecture Decision B ("placed with the other static-segment `by-*` routes **above** `/:uuid`")
- **Входные данные:** `GET /api/leads/by-contact/10`.
- **Ожидаемый результат:** hits the by-contact handler (calls `getLeadByContact`), is **not** captured by `GET /:uuid` @ leads.js:175 as `uuid='by-contact'`. Assert by spying both handlers / asserting `getLeadByUUID` is never invoked. (Same class of bug as LEADS-NEW-BADGE-001's `/new-count` ordering.)
- **Файл для теста:** `tests/routes/leads.test.js`

### TC-ELO-U09: `POST /api/leads` validation — accepts phone≥5 **OR** email **OR** `selected_contact_id`; rejects when all three absent
- **Приоритет:** P0
- **Тип:** Unit (route, parametrized — the core relaxation @ leads.js:202)
- **Связанный сценарий:** S4; FR-B1; architecture Decision C validation; **AC-3** ("none of the three → still 400")
- **Входные данные (name always present per existing rules):**
  - (a) `{ FirstName, Phone:'6175551212' }` (phone-only) → **accept**
  - (b) `{ FirstName, Email:'a@b.com' }` (email-only, no phone) → **accept**
  - (c) `{ FirstName, selected_contact_id:10 }` (contact-only, no phone/email) → **accept**
  - (d) `{ FirstName, Email:'a@b.com', selected_contact_id:10 }` (no phone) → **accept** (AC-3 exact shape)
  - (e) `{ FirstName }` (none of phone/email/contact) → **reject**
  - (f) `{ FirstName, Phone:'123' }` (phone < 5, no email/contact) → **reject**
  - (g) `{ FirstName, Email:'   ' }` (blank/whitespace email, no phone/contact) → **reject** (email presence is trimmed-non-empty)
- **Ожидаемый результат:** (a)-(d) pass the validation block (no `errors.push`), reaching the resolve branch; (e)-(g) return **400** with a message like `'Phone, Email, or a selected contact is required'`. `FirstName`/`LastName` rules are unchanged (removing name still 400s independently).
- **Файл для теста:** `tests/routes/leads.test.js`

### TC-ELO-U10: `POST /api/leads` `update_contact`-mode phone guard — a **blank** Phone must NOT null an existing contact's phone
- **Приоритет:** P0
- **Тип:** Unit (route, db mocked — the guard @ leads.js:219)
- **Связанный сценарий:** S4/S8 integrity; architecture Decision C bullet "`selected_contact_id` + `update_contact`"; Protected ("don't null-out an existing phone")
- **Предусловия:** `body = { selected_contact_id:10, contact_update_mode:'update_contact', FirstName:'A', Email:'a@b.com' }` (no `Phone`); capture the `UPDATE contacts SET …` call.
- **Ожидаемый результат:** the emitted `UPDATE contacts` SET-list contains **no** `phone_e164 = …` assignment (the write is guarded by `if (body.Phone)`), so an existing `contacts.phone_e164` is preserved; `email`/`full_name`/`first_name`/`last_name` writes still fire. **Contrast case:** with `Phone:'6175551212'` present, `phone_e164 = $` **is** in the SET-list (phone-origin unchanged). Pre-fix (unconditional `params.push(toE164(body.Phone) || body.Phone)`), a blank Phone would write `phone_e164 = NULL` — that regression = FAIL.
- **Файл для теста:** `tests/routes/leads.test.js`

### TC-ELO-U11: `POST /api/leads` `selected_contact_id` + `attach` with no phone → `body.contact_id` set, `resolveContact` NOT called, no phone touched
- **Приоритет:** P1
- **Тип:** Unit (route, db mocked)
- **Связанный сценарий:** S4; architecture Decision C bullet "`selected_contact_id` + `attach` (or default) — works phoneless as-is"
- **Входные данные:** `{ FirstName, Email:'a@b.com', selected_contact_id:10 }` (default/`attach` mode).
- **Ожидаемый результат:** `body.contact_id` becomes `10`; `contactDedupeService.resolveContact` is **not** invoked (the attach branch short-circuits); no phone is fabricated anywhere; `createLead` is called with `Email` set and no `Phone`.
- **Файл для теста:** `tests/routes/leads.test.js`

### TC-ELO-U12: `createLead` inserts `phone` NULL when Phone absent (column omitted, no fabricated E.164)
- **Приоритет:** P0
- **Тип:** Unit (service, db mocked)
- **Связанный сценарий:** S4; FR-B1; architecture Decision C ("`createLead` sees no `Phone` → `columns.phone` unset → NULL") — the `if (columns.phone)` guard @ leadsService.js:320
- **Предусловия:** `createLead({ FirstName:'A', Email:'a@b.com', contact_id:10 }, 'A')`; mocked `generateUniqueUUID` + INSERT `RETURNING`.
- **Ожидаемый результат:** the generated `INSERT INTO leads (...)` column list **omits `phone`** (so it defaults NULL) — the E.164 normalization block (`columns.phone.replace(/\D/g,'')`) is skipped because `columns.phone` is falsy; `email` and `contact_id` **are** in the column list mapped via `FIELD_MAP`. No `+1`-prefixed placeholder value appears. **Contrast:** with `Phone:'6175551212'` the column list includes `phone` normalized to `+16175551212` (phone-origin unchanged).
- **Файл для теста:** `tests/leadByContact.test.js` (or `tests/leadsService.test.js`)

### TC-ELO-U13: `CreateLeadJobWizard` payload — email-origin build omits Phone when blank, always sends Email, attaches `selected_contact_id` (dispatch shape)
- **Приоритет:** P1
- **Тип:** Unit (frontend, if a component/unit harness exists) **or** documented for the FE build check (TC-ELO-F04)
- **Связанный сценарий:** S3/S4; FR-B3; architecture Decision D (payload bullet)
- **Входные данные:** wizard invoked with `contactId=10`, `email='a@b.com'`, phone left blank; `handleCreate` fired.
- **Ожидаемый результат:** the create payload contains **no** `Phone` key (`...(toE164(phoneNumber) ? { Phone } : {})`), **has** `Email:'a@b.com'`, and carries `selected_contact_id:10` + `contact_update_mode:'attach'`; `invalidateQueries` includes `['lead-by-contact', 10]`. With a phone typed, `Phone: toE164(...)` is present (phone-origin unchanged). *(If no FE unit harness — assert this via code review under TC-ELO-F04.)*
- **Файл для теста:** frontend unit (if present) / else code-review note under TC-ELO-F04

---

## 2. Integration — real DB, `scripts/verify-email-lead-origin-001.js` (NO mocks)

All cases run the REAL `leadsService` functions (and, where stated, the REAL `POST /api/leads` handler) against seeded Postgres, self-seeding/self-cleaning with tag `ELO1`. Per the verify plan, every case is also re-run once against a **prod-copy restore** before deploy (`DATABASE_URL` pointed at the copy).

### TC-ELO-I01 (s4): **S4 P0 LOAD-BEARING** — phoneless create stores `phone` NULL, `email` set, `contact_id` set, linked to the right contact
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration
- **Связанный сценарий:** S4; FR-B1; **AC-3 + AC-4**; verify plan step (2)
- **Предусловия:** company A; a phoneless target contact `C` (`phone_e164 NULL`, an email on file). No existing lead for `C`.
- **Шаги:** 1) run the phoneless create — either `leadsService.createLead({ FirstName:'ELO1', Email:'elo1@elo1.test', contact_id:C }, A)` **or** the real `POST /api/leads` with body `{ FirstName:'ELO1', Email:'elo1@elo1.test', selected_contact_id:C }` (no phone); 2) `SELECT phone, email, contact_id, company_id FROM leads WHERE id = <returned ClientId>`; 3) list leads for `C`.
- **Ожидаемый результат:**
  - the row has **`phone` IS NULL** (not `''`, not a fabricated `+1…`), `email = 'elo1@elo1.test'`, `contact_id = C`, `company_id = A`.
  - the lead is **linked to `C`** (the SAME phoneless contact — no new/duplicate contact created; `C`'s `phone_e164` still NULL).
  - the lead **appears** in a leads query for that contact (`listLeads` and/or a `contact_id=C` filter returns it) — proving it surfaces on the Leads page + on the contact (AC-4). No validation error thrown.
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s4)

### TC-ELO-I02 (s2/s5): **S2/S5 P0** — `getLeadByContact` returns the OPEN lead for the contact
- **Приоритет:** **P0**
- **Тип:** Integration
- **Связанный сценарий:** S2; FR-B2; AC-5
- **Предусловия:** company A; contact `C` (phoneless) with **one** open lead `L` (`status='Submitted'`, `contact_id=C`), no job for `C`.
- **Шаги:** `getLeadByContact(C, A)`.
- **Ожидаемый результат:** returns a `rowToLead` object whose `ClientId === L` (the open lead), `ContactId === C`, `Status='Submitted'`. (This is the positive that drives LeadDetailPanel → "no create offered".)
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s2)

### TC-ELO-I03 (s2): **S2 P0** — contact has a JOB → `getLeadByContact` returns **null** (stale-lead suppression, parity with `getLeadByPhone`)
- **Приоритет:** **P0**
- **Тип:** Integration
- **Связанный сценарий:** S2; FR-B2 (job post-filter); the exact `getLeadByPhone` @ leadsService.js:1132 behavior cloned
- **Предусловия:** company A; contact `C` with an open lead `L` **AND** a job (`jobs.contact_id=C`).
- **Шаги:** `getLeadByContact(C, A)`.
- **Ожидаемый результат:** returns **`null`** (the lead exists but its contact already has a job → suppressed, so the card shows the contact panel, not a stale lead card). Removing the job and re-running returns `L` again — proving the job is the discriminator.
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s2)

### TC-ELO-I04 (s2): **S2 P0** — only lead is Lost/Converted → `getLeadByContact` returns **null**; newest OPEN wins when several
- **Приоритет:** **P0**
- **Тип:** Integration (two asserts)
- **Связанный сценарий:** S2; FR-B2 (`status NOT IN ('Lost','Converted')`, `ORDER BY id DESC LIMIT 1`)
- **Предусловия / Шаги:**
  - (a) contact `C1` whose ONLY lead is `status='Lost'` (then a second sub-case `status='Converted'`) → `getLeadByContact(C1,A)`.
  - (b) contact `C2` with THREE open leads `L1<L2<L3` (ascending id) + one `Lost` → `getLeadByContact(C2,A)`.
- **Ожидаемый результат:** (a) returns **`null`** for both `Lost` and `Converted` (closed leads never offered). (b) returns the **newest open** lead `L3` (`ORDER BY l.id DESC LIMIT 1`), never `L1`/`L2` and never the `Lost` one.
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s2)

### TC-ELO-I05 (s7): **S7 P0 SECURITY cross-tenant** — `getLeadByContact(contactId_of_B, companyA)` → null; B's lead never returned for A
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (Security)
- **Связанный сценарий:** S7; **AC-7**; ONBOARD-FIX-001 / ZB-ISO-001 precedents
- **Предусловия:** company **B** (tagged, created here) has a contact `BC` with an open lead `BL` (`contact_id=BC, company_id=B`). Company A has no footprint for `BC`.
- **Шаги:** `getLeadByContact(BC, A)` (a company-A caller asking for a company-B contact's id).
- **Ожидаемый результат:** returns **`null`** — the `l.company_id = $2 (=A)` predicate excludes `BL` even though `l.contact_id = BC` matches. Assert `BL` still exists under B (`getLeadByContact(BC, B)` → `BL`), untouched. **No company-B lead is ever returned to a company-A caller.** (A red here = a cross-tenant lead leak — release blocker.)
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s7)

### TC-ELO-I06 (s7): S7 symmetric — phoneless create scoped to A never attaches to / reads a company-B contact or lead
- **Приоритет:** P0
- **Тип:** Integration (Security)
- **Связанный сценарий:** S7; constraints "no cross-tenant attach/create"
- **Предусловия:** B has contact `BC` + lead `BL`. A create is issued with `company_id=A` referencing an A-side contact `C_A` only.
- **Ожидаемый результат:** the created lead is `company_id=A`, `contact_id=C_A`; **no** B row (`BC`/`BL`) is read, mutated, or linked; a subsequent `getLeadByContact(BC, A)` is still `null` and `BL` is unchanged. The `company_id` gate (not the id value) is what isolates.
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s7)

### TC-ELO-I07 (s8): **S8 REGRESSION** — `getLeadByPhone` byte-identical on the same seed before/after a phoneless lead is added
- **Приоритет:** **P0**
- **Тип:** Integration (Protected)
- **Связанный сценарий:** S8; AC-6; Protected parts ("phone path byte-for-byte")
- **Предусловия:** company A; a **phone** contact `P` with an open phone-origin lead `PL` (`phone='+16175550001'`).
- **Шаги:** 1) `before = JSON.stringify(getLeadByPhone('+16175550001', A))`; 2) add an unrelated **phoneless** email-origin lead for a different contact `C`; 3) `after = JSON.stringify(getLeadByPhone('+16175550001', A))`.
- **Ожидаемый результат:** `before === after` (the phone lookup returns the exact same `PL` serialization — the phoneless lead, having `phone` NULL, is invisible to the phone-digit predicate and does not perturb the phone path). Also assert `getLeadByPhone` still applies its own job/Lost/Converted filters unchanged.
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s8)

### TC-ELO-I08 (s8): S8 regression — phone-origin `createLead` unchanged (normalizes E.164; row identical to pre-feature)
- **Приоритет:** P1
- **Тип:** Integration (Protected)
- **Связанный сценарий:** S8; Protected ("phone create path keeps working byte-for-byte")
- **Предусловия:** company A.
- **Шаги:** `createLead({ FirstName:'ELO1', Phone:'617 555 0002', Email:'p@elo1.test', contact_id:C }, A)`.
- **Ожидаемый результат:** the stored row has `phone='+16175550002'` (E.164 normalization @ leadsService.js:320 still runs for a present phone), `email` + `contact_id` set — i.e. the phone leg is untouched by the phoneless relaxation. (Anchors that "phone OR email OR contact" is purely additive.)
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s8)

### TC-ELO-I09 (s6): S6 — email-origin lead lists on the Leads page (phone-independent) and on the contact
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S6; FR-B1; AC-4
- **Предусловия:** the phoneless lead `L` from TC-ELO-I01 exists (`phone` NULL, `contact_id=C`).
- **Шаги:** 1) `listLeads({ companyId:A })` (the Leads-page query, which does not filter by phone); 2) resolve leads for `C` (`getLeadByContact(C,A)` and/or a `contact_id=C` query).
- **Ожидаемый результат:** `L` appears in the `listLeads` result (Leads page lists it despite `phone` NULL) and is associated to `C` (`getLeadByContact(C,A)` → `L`, since `C` has no job) — the round-trip that makes scenario 6 → scenario 2 true.
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s6)

### TC-ELO-I10 (s2/no-dup): No-duplicate — creating "from email" when an open lead already exists must not spawn a second lead
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** constraints "No duplicate-lead creation"; FR-B2 (lookup gates the wizard)
- **Предусловия:** contact `C` already has an open lead `L1` (so `getLeadByContact(C,A)` → `L1`).
- **Шаги:** assert the guard: `getLeadByContact(C,A)` is truthy **before** any create (the card would therefore render LeadDetailPanel and NOT offer "create"). *(Documents that duplicate-prevention is lookup-driven; the create itself is unconditional at the service layer, so the gate lives in the lookup + UI — this case pins that the lookup reports "exists" so the UI suppresses the wizard.)*
- **Ожидаемый результат:** `getLeadByContact(C,A)` returns `L1` (non-null) → the "already-linked" signal is present; the by-contact count of open leads for `C` is exactly 1. (A null here would wrongly re-offer the wizard and risk a duplicate.)
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section s2)

### TC-ELO-I11 (explain): `getLeadByContact` uses `idx_leads_contact_id` — no seq-scan (Decision F, PULSE-PERF-001 discipline)
- **Приоритет:** P2
- **Тип:** Integration (plan probe)
- **Связанный сценарий:** architecture Decision F ("Reuses `idx_leads_contact_id` (mig 023) — no seq-scan, no new index"); verify plan step (1)
- **Предусловия:** run on a prod-copy restore (local dev may have too few `leads` rows to force the index — assert with `SET LOCAL enable_seqscan=off` inside a `BEGIN…ROLLBACK`, mirroring `verify-tasks-count-001.js` TC-40).
- **Шаги:** `EXPLAIN` the exact `getLeadByContact` first-query SQL (`… WHERE l.contact_id = $1 AND l.status NOT IN (…) AND l.company_id = $2 … ORDER BY l.id DESC LIMIT 1`).
- **Ожидаемый результат:** the plan shows an `Index Scan` / `Bitmap Index Scan` on **`idx_leads_contact_id`** over `leads` (no `Seq Scan` at scale) — confirming Decision F's "no new migration/index required." A regression to Seq Scan (or a new index appearing) = FAIL.
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section explain)

### TC-ELO-ISAB (sab): Sabotage negative control — deliberately break one expectation, confirm the harness FAILs, then restore
- **Приоритет:** P0
- **Тип:** Integration (self-check — mirrors `verify-tasks-count-001.js` TC-SABOTAGE)
- **Связанный сценарий:** harness integrity (LIST-PAGINATION-001 "a green run must certify the detector works")
- **Предусловия:** the S4 phoneless create just ran (row has `phone` NULL, `email` set, `contact_id=C`).
- **Шаги:** run the S4 assertions against a **deliberately-wrong** expectation via the same assert kit — e.g. assert the stored `phone` **equals** a fabricated `'+1…'` (it is NULL), or assert `getLeadByContact(BC,A)` returns `BL` in the S7 cross-tenant case (it must be null).
- **Ожидаемый результат:** the harness throws a `CheckError` and records **FAIL** for the sabotaged assertion (proving it inspects real state, not just prints PASS). Then restore the correct expectation and re-assert green. If the sabotage does NOT trip a FAIL, this case fails — the detector is broken and every PASS above is suspect.
- **Файл для теста:** `scripts/verify-email-lead-origin-001.js` (section sab)

---

## 3. Frontend — manual + build (no FE test harness; `PulsePage.tsx` / `PulseContactPanel.tsx` / `CreateLeadJobWizard.tsx`)

### TC-ELO-F01: **PART A** — email-only timeline shows the contact card (the gate no longer suppresses it)
- **Приоритет:** P1
- **Тип:** Frontend (manual)
- **Связанный сценарий:** S1; FR-A1; AC-1; architecture Decision E (gate @ PulsePage.tsx:361 → `(p.phone || p.contact?.id)`)
- **Шаги:** open a Pulse conversation that is an **email thread** whose contact has `phone_e164` NULL (no phone).
- **Ожидаемый результат:** the detail card **renders** (not blank space) — showing contact identity (name + email); the tri-state resolves to LeadDetailPanel (if a lead is linked) → PulseContactPanel (contact, no lead) → "create lead from email". Anonymous timelines still show **no** card (the `!isAnonTimeline` guard is untouched). No console error / thrown render.
- **Файл для теста:** manual / dev-preview

### TC-ELO-F02: **PART A** — `PulseContactPanel` renders without a phone (no `tel:` / `ClickToCallButton` / `OpenTimelineButton`, no SMS composer)
- **Приоритет:** P1
- **Тип:** Frontend (manual + DOM inspect)
- **Связанный сценарий:** S5; FR-A2; AC-1; architecture Decision E (primary-phone row @ PulseContactPanel.tsx:117-122 wrapped in `{contact.phone_e164 && (…)}`)
- **Шаги:** with the phoneless contact from F01 open, inspect the contact panel DOM + the Pulse SMS composer region.
- **Ожидаемый результат:** the **primary-phone row is omitted** (no `tel:null` anchor, no `ClickToCallButton`, no `OpenTimelineButton` rendered — mirroring the already-guarded secondary-phone row @ line 123); the **SMS composer is hidden** (`{p.phone && …}` guard @ PulsePage.tsx:415 already suppresses it); the **email row + `mailto:` + inline add-email** render normally. No empty-string phone reaches any affordance. `LeadDetailPanel`/`LeadInfoSections` (already `{phone && …}`-guarded) likewise show no phone row.
- **Файл для теста:** manual / dev-preview

### TC-ELO-F03: **PART B** — wizard on a phoneless contact shows **only "Create Lead"** (no "Create Lead & Job")
- **Приоритет:** P1
- **Тип:** Frontend (manual)
- **Связанный сценарий:** S3; FR-B3; architecture Decision D (ZB needs a phone → email-origin lead is LEAD-ONLY; with-JOB leg hidden/disabled when phone blank)
- **Шаги:** on the phoneless email-only contact (no linked lead), open the "create lead from email" wizard; leave phone blank.
- **Ожидаемый результат:** the wizard is pre-filled from the contact (name + email), phone field blank/optional (no `*` required marker); it offers **"Create Lead" only** — the "Create Lead & Job" button/leg is **hidden or disabled** until a phone is entered (typing a phone re-enables the with-job leg). The header phone-row (`tel:`/ClickToCall/OpenTimeline @ CreateLeadJobWizard.tsx:220-225) is **not** rendered (gated on `phone`) — no empty stub.
- **Файл для теста:** manual / dev-preview

### TC-ELO-F04: **PART B** — creating from the wizard posts email + contactId, **no phone**; created lead then shows as LeadDetailPanel on reopen
- **Приоритет:** P1
- **Тип:** Frontend (manual + Network)
- **Связанный сценарий:** S4 + S6 + S2 round-trip; FR-B1/B3; AC-4; also validates TC-ELO-U13's payload shape live
- **Шаги:** 1) in the phoneless wizard fill name (email pre-filled), leave phone blank, submit; 2) observe the `POST /api/leads` request body; 3) reopen the same Pulse timeline.
- **Ожидаемый результат:** the request body carries **`Email`** + **`selected_contact_id`** (+ `contact_update_mode:'attach'`) and **no `Phone`** key (and the ZB customer payload, if the with-job leg were reached, would omit phone — but the with-job leg is hidden here); no fabricated phone anywhere. After submit, reopening the timeline resolves the new lead via **`useLeadByContact`** and renders **LeadDetailPanel** (scenario 2), NOT the wizard again. The lead is visible on the **Leads page**.
- **Файл для теста:** manual / dev-preview + Network tab

### TC-ELO-F05: Regression — a **phone** timeline still shows all phone affordances (card, `tel:`, ClickToCall, SMS composer) unchanged
- **Приоритет:** P1
- **Тип:** Frontend (manual — Protected)
- **Связанный сценарий:** S8; AC-6; Protected ("phone timelines keep working; `useLeadByPhone` path intact")
- **Шаги:** open a normal **phone** contact/timeline in Pulse.
- **Ожидаемый результат:** the card renders exactly as before — primary-phone row with `tel:` + `ClickToCallButton` + `OpenTimelineButton` present, SMS composer present, `useLeadByPhone` drives the lead (its result wins when both by-phone and by-contact resolve). The wizard's existing phone invocation (`phone={p.phone}`) still offers **both** "Create Lead" and "Create Lead & Job". No visual/behavioral change from pre-feature.
- **Файл для теста:** manual / dev-preview

### TC-ELO-F06: `useLeadByContact` hook wiring — fires only when `contactId` present; phone timeline never fires it needlessly
- **Приоритет:** P2
- **Тип:** Frontend (manual — Network / React Query devtools)
- **Связанный сценарий:** architecture Decision B (hook) + `usePulsePage` wiring ("`enabled:!!contactId`; a phone timeline never fires the contact query")
- **Шаги:** open (a) an email-only contact, then (b) a phone contact; watch the query for `['lead-by-contact', id]`.
- **Ожидаемый результат:** (a) the `by-contact` query fires (`enabled` true) and drives the card's lead; (b) for a phone timeline the by-contact query may also fire when `contact?.id` is present but is harmless/idempotent, and `useLeadByPhone` still wins — no double-fetch storm, no error. Switching timelines clears the previous `leadOverride` (reset keys off `contact?.id`, not just `phone`).
- **Файл для теста:** manual / React Query devtools

### TC-ELO-F07: Build stays green
- **Приоритет:** P3
- **Тип:** Frontend (build)
- **Связанный сценарий:** ship gate (frontend-build-command: `npm run build`, stricter than `tsc --noEmit` — noUnusedLocals)
- **Шаги:** `cd frontend && npm run build`.
- **Ожидаемый результат:** exit 0; `CreateLeadJobWizard` accepts `phone?` optional + `contactId?`/`email?` props; `leadsApi.getLeadByContact` + `useLeadByContact` typed; `PulseContactPanel` null-guard compiles; no unused-locals error.
- **Файл для теста:** build

---

## Regression / Protected (must stay green)

- **TC-R-1 (P0):** `getUnifiedTimelinePage` / `email_by_contact` CTE (PULSE-PERF-001, LIST-PAGINATION-001, EMAIL-OUTBOUND-001) shape/semantics **untouched** — FR-B4 is deferred (Decision A); the email-only conversation still surfaces via its **email** signal with **no** list-query change. Existing `tests/listPaginationByContact.test.js` stays 100% green.
- **TC-R-2 (P1):** Phone lead path added-**alongside** — `useLeadByPhone`/`useLeadsByPhones`, `getLeadByPhone`/`getLeadsByPhones`, `GET /by-phone/:phone` + `POST /by-phones`, and the wizard's phone invocation — all byte-for-byte (covered live by TC-ELO-I07/I08/F05).
- **TC-R-3 (P1):** `contactDedupeService.resolveContact` **signature unchanged** (reused, not modified); the default/`only_lead` branch still calls it with `phone: body.Phone` (absent → Step 3 email / Step 4 name-only→ambiguous→409, correct); `createNewContact` writes `phone_e164` NULL for a blank phone as today.
- **TC-R-4 (P1):** `POST /api/leads` phone-origin contract — the async contact→lead cascade, ZB sync, push, address sync, and `contact_resolution` echo all keep firing; only the phone-mandatory rule relaxed (name rules, `selected_contact_id`/`contact_update_mode` resolution intact).
- **TC-R-5 (P2):** LEADS-NEW-BADGE-001 — an email-origin "new"-status lead is counted the same (status/`lead_lost`-based, phone-independent); no badge/SSE regression (`/new-count` + its SSE types untouched).
- **TC-R-6 (P2):** `leads.phone` nullable invariant + `leads.contact_id`/`idx_leads_contact_id` (migs 004, 023) relied on; **no destructive schema change, no new migration** (Decision F). If one appears it is numbered ≥156 with rollback + logged row count. Anonymous-timeline handling unchanged (gate keys on identity, not on removing the `!isAnonTimeline` guard).
- **TC-R-7 (P3):** middleware chain unchanged — `GET /api/leads/by-contact/:contactId` inherits `authenticate → requireCompanyAccess` from the `server.js:160` mount + its own `requirePermission('leads.view','pulse.view')`; **no `server.js` edit** (existing leads tenant-isolation tests stay green); `cd frontend && npm run build` exit 0 + backend Jest green (`npm test`; in the worktree add `--testPathIgnorePatterns "/node_modules/"`).

## Notes for the Implementer / Tester

- **The three tests that matter most, run against the REAL DB:** **TC-ELO-I01 (S4 phoneless create)** and **TC-ELO-I05 (S7 cross-tenant)** are the two P0 must-pass gates; **TC-ELO-I02/I03/I04 (S2/S5 lookup correctness incl. the job + Lost/Converted filters)** are also P0. Mocks (TC-ELO-U01/U12) prove the SQL **shape**; only the real query proves `phone` landed NULL, the right lead came back, and B stayed invisible to A. **Do not ship on green mocks alone** (LIST-PAGINATION-001 / created_by-FK lessons).
- **`getLeadByContact` is a byte-for-byte clone of `getLeadByPhone` @ leadsService.js:1096** with ONE change: the `RIGHT(REGEXP_REPLACE(l.phone,…),10) = $1` predicate becomes `l.contact_id = $1`. Keep the `status NOT IN ('Lost','Converted')` filter, the `team` aggregation, `ORDER BY l.id DESC LIMIT 1`, and the "contact has a job → return null" post-filter (`SELECT 1 FROM jobs WHERE contact_id=$1 LIMIT 1`) identical — those are the load-bearing semantics S2/S3/S4 assert.
- **The two subtle write-path bugs to guard:** (1) the `update_contact`-mode `phone_e164` write @ **leads.js:219** must be wrapped `if (body.Phone) { … }` (TC-ELO-U10) so a blank Phone doesn't null an existing contact's phone; (2) `createLead`'s `if (columns.phone)` guard @ **leadsService.js:320** already omits the column when absent → NULL (TC-ELO-U12) — do not "fix" it to fabricate a phone.
- **Harness:** mirror `scripts/verify-tasks-count-001.js` — tag `ELO1`, clean before each case + at start/end, company A = seed `…0001` (row-targeted by tagged contact/lead id, never whole-page absolutes), tagged company B for TC-ELO-I05/I06 cross-tenant (created + deleted by cleanup), `DATABASE_URL` default `postgresql://localhost/twilio_calls`, exit 0 only when no case FAILs, and a `TC-ELO-ISAB` sabotage control so a green run certifies the detector works.
- `companyId(req)` = `req.companyFilter?.company_id`; created_by-FK rule (`req.user.crmUser.id`, never `sub`) applies to any recorded_by write the create path performs.
