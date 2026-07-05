# Тест-кейсы: MAIL-MUTE-001 — excluding a sender in Mail Secretary also mutes that sender's EMAIL signal in the Pulse timeline (email channel only; calls/SMS unaffected)

**Source spec:** `Docs/specs/MAIL-MUTE-001.md` (scenarios S1–S13, AC-1…AC-12, DECISION-B, OQ-MM-2/3/4) + `Docs/requirements.md` §MAIL-MUTE-001 (FR-1…FR-10, NFR-1…NFR-4) + `Docs/architecture.md` §MAIL-MUTE-001 (decision (a) migration-free param-passing; DECISION-B from-only; matcher-reuse). **Change points confirmed in source (line anchors re-verified against the current worktree):**
- **`backend/src/services/mailAgentService.js`** — **NEW** `isSenderMuted(companyId, msg)`, `getMutedSenderSet(companyId)`, internal `fromOnlyRules(parsed)`; reuse `getActiveState` (l.29, 60s `activeCache`), `safeParseRules` (l.69), `buildRuleInput` (l.80), `mailAgentRules.matchEmail` (imported l.18). **Extend `module.exports`** (l.312 — currently `{ isActive, reviewInboundEmail, dryRun, invalidateCache }`) with the two new fns. Both fail-open.
- **`backend/src/services/mailAgentRules.js`** — **NO change** (exports `{parseRules, matchEmail}`; token shape `{negate, field, kind:'contains'|'regex', value|regex}`, `value` already `.toLowerCase()` @ l.99; `matchEmail` @ l.153 ANDs a line's tokens @ l.160).
- **`backend/src/services/email/emailTimelineService.js`** — **NEW** `{skipped:'muted_sender'}` early return in `linkInboundMessage` (fn @ l.89) **after** the `draft_or_sent` guard (l.104) and **before** `findEmailContact` (l.112), gated on `!opts.skipAgent`. Skip value joins the documented set in the header comment (l.85: `no_message`/`outbound`/`draft_or_sent`/`no_contact`).
- **`backend/src/db/timelinesQueries.js`** — `getUnifiedTimelinePage` gains `mutedEmails = []` (`$4`) + `mutedDomains = []` (`$5`); a per-row `email_muted` scalar (co.email / contact_emails vs $4/$5); gate the **5 email-term sites** with `AND NOT email_muted` (SELECT l.499 GREATEST, l.500–501 any_unread, l.549 surfacing predicate; ORDER-BY l.591 unread-tier, l.598 GREATEST). Call/SMS/task/orphan-dedup/pagination byte-for-byte unchanged.
- **`backend/src/routes/calls.js`** — `GET /by-contact` (router @ l.106; `companyId = req.companyFilter?.company_id` @ l.110; query call @ l.122 currently `getUnifiedTimelinePage({ limit, offset, companyId, search })`; gate = `callsRead` = `requirePermission('reports.calls.view','pulse.view')` @ l.8): fetch `getMutedSenderSet(companyId)` and pass `mutedEmails`/`mutedDomains`.

**House lesson (LIST-PAGINATION-001 / PULSE-PERF-001 / created_by-FK, BINDING — bake into the plan):** mocked jest mocks `db`, so a unit test validates the **SQL string / dispatch shape only** — it can **NOT** prove that `getUnifiedTimelinePage`'s `email_muted` actually suppresses timeline 2915, that a phone+email contact keeps ranking on a call while its email is gated, or that company B is isolated. This exact class of bug (wrong list-query filter passing a mocked suite green) shipped in LIST-PAGINATION-001 and PULSE-PERF-001. **Therefore every SQL-suppression claim (S2/S4/S5/S8/S12/S13-list + the EXPLAIN gate) has a real-DB case in `scripts/verify-mail-mute-001.js`** (tag `MM1`, self-seeding/self-cleaning, PASS/FAIL per case + a sabotage control), mirroring `scripts/verify-contact-email-merge-001.js` / `scripts/verify-email-lead-origin-001.js`. **A mocked-only pass is INSUFFICIENT for the five SQL sites — do not ship on green mocks alone.**

**Jest gotcha:** in a worktree run add `--testPathIgnorePatterns "/node_modules/"` (JOBS-UX-RBAC-001 lesson).

**Migration:** **NONE** (architecture decision (a) — param-passing, schema-free; reversibility is "drop from the next request's set"). Latest migration in repo = **155**; **156 stays unused** by this feature. Any test asserting "no new migration ships" targets 155 as the max (AC-12).

---

## Scenario map (spec S-id → coverage)

| S-id | Meaning | Source AC / FR | Priority | Where it is PROVEN |
|------|---------|----------------|----------|--------------------|
| **S1** | Muted email-only sender → new inbound does not link/unread/bump/SSE/contact | AC-1; FR-2 | **P0** | Unit (link early-return) **+** real-DB (no link row) |
| **S2** | Existing email-only timeline (relyhome/2915) drops out of the Pulse list while muted | AC-2; FR-4/5 | **P0 (SQL — must-run real-DB)** | **real-DB** (`getUnifiedTimelinePage`) |
| **S3** | Un-exclude restores link-on-inbound AND list surfacing (within ~60s cache) | AC-6; FR-6 | **P0** | Unit (invalidateCache→empty) **+** real-DB (row reappears) |
| **S4** | Phone+email contact: muted email doesn't bump/unread; a new call/SMS still surfaces & bumps | AC-3; FR-4/5 | **P0 (SQL — must-run real-DB)** | **real-DB** (ordering) |
| **S5** | Email-only muted contact drops out entirely (motivates gating the surfacing predicate l.549) | AC-2; FR-5 | **P0** | **real-DB** (folded into S2 shape) |
| **S6** | Redelivery/duplicate of a muted email → still no link, no contact, dedup intact | AC-5; FR-8 | P1 | Unit (early-return precedes dedup) **+** real-DB (no dup side-effect) |
| **S7** | Muted first-time (unknown) sender → NO contact auto-created (early-return precedes no-contact agent path) | AC-4; FR-3 | **P0** | Unit (agent path not reached) **+** real-DB (no contacts/timelines row) |
| **S8** | Multi-tenant: mute in company A never suppresses email in company B | AC-7; FR-7 | **P0 (security — must-run real-DB)** | Unit (company-scoped calls) **+** **real-DB** (cross-company data) |
| **S9** | Fail-open at link-time OR list-time → behaves as today (no throw, no 500) | AC-8; FR-10 | **P0** | Unit (both helpers swallow throw) |
| **S10** | Negation / mixed-line DSL: mute follows `matchEmail` + from-only filter exactly | AC-9; DECISION-B, C-2 | **P0** | Unit (`isSenderMuted`/`getMutedSenderSet`) |
| **S11** | Interplay w/ agent: from-only ⇒ no task AND no timeline; subject/body ⇒ task-only, email still appears | AC-9; DECISION-B, FR-1/2 | P1 | Unit (link + `getMutedSenderSet` projection) |
| **S12** | Contact with multiple emails, ONE muted → the contact's EMAIL is muted (address-in-set rule) | FR-4/5; §Multiple-email rule | P1 | Unit (SQL shape) **+** real-DB (EXISTS on contact_emails) |
| **S13** | Mid-thread mute → history retained, list contribution stops, new inbound stops linking | AC-2/12; FR-9/2/4 | P1 | **real-DB** (rows retained + list drop) |

**The three P0 gates that MUST be green on the REAL DB (a red = release blocker):** **S2/S5** (email-only drop-out & restore — proves `email_muted` gates the surfacing predicate), **S4** (channel split — proves call/SMS ranking survives while email is gated), **S8** (cross-tenant — company B's identical sender is never suppressed). The **EXPLAIN/perf gate (TC-MM-I09, AC-11)** is also a P0 verification item. Mocks prove the SQL/dispatch *shape* (S1/S7/S9/S10 helper behavior); only the real query proves suppression, ranking, and isolation.

---

## Покрытие / Coverage

- Всего тест-кейсов: **34** (numbered) + **7** regression/protected items = **41**.
- **Numbered cases by priority — P0: 15 | P1: 12 | P2: 5 | P3: 2.** Regression/protected — P0: 1 | P1: 3 | P2: 2 | P3: 1.
- **Unit (jest, mocked db): 18** | **Integration (real DB, `scripts/verify-mail-mute-001.js`, NO mocks): 12** | **Manual/build: 4.**
- Every spec scenario **S1–S13** covered; positive + negative per scenario. **3 fail-open paths** (link-time, list-time, malformed-token) covered (TC-MM-U15/U16/U17 + real-DB I11). **Multi-tenant isolation** = 401/403 middleware (TC-MM-U13) + cross-company data (TC-MM-I07 real-DB). **Redelivery idempotency** = TC-MM-U08 + TC-MM-I05. **Perf/EXPLAIN gate** = TC-MM-I09 (**P0 verification**). Sabotage negative control = TC-MM-ISAB.

**Unit-vs-real-DB split at a glance (explicit, per the constraint):**
- **Unit-mocked (Jest) — sufficient here because the assertion is JS/DSL/dispatch shape, not row-level DB truth:** `isSenderMuted` & `getMutedSenderSet` parsing (from-only filter, negation rescue, domain-vs-exact, subject/body excluded, regex→link-only-not-projected, inactive→empty, fail-open→empty/false) → **S9, S10, S11 (helper half)**; the `linkInboundMessage` `muted_sender` early-return (no link/contact/unread when muted; normal when not; redelivery precedes dedup; `!opts.skipAgent` gate) → **S1, S6, S7 (link half)**; `calls.js` wiring (muted set fetched + params passed) → **S2/S4 (route half)**; multi-tenant company-scoping of the helper *calls* → **S8 (call half)**.
- **Real-DB integration (NOT mocked) — MANDATORY because a mocked pass cannot see the filter:** the `getUnifiedTimelinePage` `email_muted` suppression → **S2/S5 (email-only drop-out + restore), S4 (channel split ordering), S12 (multi-email EXISTS), S13 (retained-but-hidden)**; cross-company data isolation → **S8**; the redelivery no-contact/no-dup outcome → **S6**; the no-auto-create outcome → **S7**; the fail-open list path (forced error → all rows present) → **S9**; the **negative control** (empty muted set = feature off → every row present) and the **sabotage** (break `AND NOT email_muted` → suite FAILs) → harness integrity; the **EXPLAIN (ANALYZE, BUFFERS)** perf gate → **AC-11/NFR-1**.

---

## Shared fixtures & harness (Integration section)

House pattern of `scripts/verify-contact-email-merge-001.js` / `scripts/verify-tasks-count-001.js` (**no mocks anywhere in this section** — Gmail/Twilio/Zenbooker never called; the mute verdict is exercised at the service boundary `mailAgentService.isSenderMuted`/`getMutedSenderSet`, the link at `emailTimelineService.linkInboundMessage`, and the list at `timelinesQueries.getUnifiedTimelinePage`, all against a real Postgres):

- **Script:** `scripts/verify-mail-mute-001.js`, sections `s1…s13` (grouped) + `explain` + `neg` (negative control) + `sab` (sabotage) selectable via `--section=<id>|all`. `DATABASE_URL` defaults to `postgresql://localhost/twilio_calls` (house default; **never point at prod**). Exit code 0 only when **no case FAILs**. Reuse the tiny assert kit (`check`/`eq`/`record`, `CheckError`) verbatim from `verify-contact-email-merge-001.js`.
- **Unique tag `MM1`** on every seeded row for self-cleaning: contacts `full_name LIKE 'MM1 %'`; timelines by tagged contact; `email_threads`/`email_messages`/link rows by tagged contact/company; `mail_agent_settings` for the tagged companies is set/reset per case (the `exclusion_rules` text and `enabled` flag are the knob). **Cleanup runs at process start, before EACH case, and at end**, FK order: `email_messages → email_threads → (email link rows) → tasks → timelines → contacts → mail_agent_settings → crm_users → companies` (+ any tagged calls/SMS a case seeds). **`mailAgentService.invalidateCache(company)` is called after every settings write in the harness** so the 60s `activeCache` never serves a stale verdict between cases (mirrors the `PUT /settings` production path).
- **Companies:** A = seed `00000000-0000-0000-0000-000000000001` (real dev rows coexist → assertions are **row-targeted by the tagged contact/timeline id or a delta on the returned page**, never absolute whole-company counts); **B** = tagged `c0000000-0000-4000-8000-0000000000d1`, **CREATED + deleted here** (cross-tenant), via an `ensureCompany`/`ON CONFLICT DO NOTHING` helper. Both get a `mail_agent_settings` row with `enabled=true` and the app connected (so C-4 is satisfied; a dedicated case toggles it off).
- **Real functions exercised (unmocked):** `mailAgentService.getMutedSenderSet` / `isSenderMuted` (real settings read + real `matchEmail`); `emailTimelineService.linkInboundMessage` (real link/skip against seeded contacts); `timelinesQueries.getUnifiedTimelinePage` (**the star** — the real Pulse SQL with real `mutedEmails`/`mutedDomains` params). Where an end-to-end route leg is stated, mount the real `GET /api/calls/by-contact` handler with stub auth injecting `req.companyFilter = {company_id: A}` + `pulse.view` (real `db/connection`).
- **Seed builders (tagged MM1):**
  - `mkContactEmailOnly(company, {name, email})` → a contact with `phone_e164 NULL` + `contacts.email = email` (or a `contact_emails` row), its timeline, and **one inbound `email_message` + `email_thread`** so it has a real email signal (this is the relyhome/2915 shape).
  - `mkContactPhoneEmail(company, {name, phone, email})` → a contact with **both** `phone_e164` and a (mutable) email, its timeline; helpers `addCall(contact, at)` and `addSms(contact, at)` to inject a call/SMS signal for S4.
  - `mkContactMultiEmail(company, {name, primaryEmail, extraEmail})` → `contacts.email = primaryEmail` + a `contact_emails.email_normalized = extraEmail` row (S12).
  - `setRules(company, rulesText)` → upsert `mail_agent_settings.exclusion_rules` + `enabled=true` + `invalidateCache(company)`.
- **The muted set is derived, not hand-fed:** each list case calls the **real** `getMutedSenderSet(company)` and threads its `{emails, domains}` into `getUnifiedTimelinePage`, so the JS-parse and the SQL-suppression are verified **end-to-end together** (NFR-4 — they must agree). A separate assert confirms `getMutedSenderSet` returned the expected literals.
- **Negative control (section `neg`):** every list case is re-run once with `mutedEmails=[]`, `mutedDomains=[]` (feature off / nothing muted) and asserts the muted row **IS present** (proving the suppression is *caused by* the set, not by an unrelated seed defect — `ANY(empty)=false` path).
- **Sabotage (section `sab`):** exactly as `verify-contact-email-merge-001.js` TC-CEM-ISAB — run an S2 assertion against a deliberately-wrong expectation and confirm the harness throws `CheckError` / records FAIL; PLUS the code-level sabotage described in TC-MM-ISAB.

---

## 1. Unit — jest, mocked db

`jest.mock('../db/connection')` (and, for the link cases, `jest.mock('../mailAgentService')` / spy on it). Existing suites to extend: **`tests/mailAgentService.test.js`** (helper cases), **`tests/emailTimelineInbound.test.js`** (link early-return), **`tests/listPaginationByContact.test.js`** (route wiring + query param plumbing). A NEW **`tests/mailMuteSender.test.js`** may hold the helper cases if preferred over extending the mail-agent suite — both are acceptable; keep helper cases together. These pin the **DSL/dispatch/SQL shape** — never "a row is suppressed" (that is the integration section's job).

### TC-MM-U01: `isSenderMuted` — from-only exact-address rule matches → true
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S1, S10; AC-1, AC-9; Contract 1
- **Предусловия:** `getActiveState` stubbed → `{active:true, settings:{exclusion_rules:'from:customerservice@relyhome.com'}}`. `mailAgentRules.matchEmail` NOT mocked (reuse the real matcher — C-2).
- **Входные данные:** `isSenderMuted('A', { from_name:'Rely Support', from_email:'customerservice@relyhome.com', subject:'x', body_text:'y' })`.
- **Ожидаемый результат:** returns **`true`**. Assert `matchEmail` was invoked with a `{rules}` object containing ONLY the from-only line, and with the `from` surface `"Rely Support <customerservice@relyhome.com>"` (byte-identical to `buildRuleInput`), `subject:''`, `body:''`. No extra `mail_agent_settings` DB read (reads the cache).
- **Файл для теста:** `tests/mailAgentService.test.js` (or `tests/mailMuteSender.test.js`)

### TC-MM-U02: `isSenderMuted` — from-only domain rule (`from:relyhome.com` / `@relyhome.com`) matches any `*@relyhome.com` → true
- **Приоритет:** P0
- **Тип:** Unit (parametrized on the rule form)
- **Связанный сценарий:** S1, S10; FR-1 (domain vs exact); AC-9
- **Предусловия:** `getActiveState` → active; rules ∈ { `from:relyhome.com`, `from:@relyhome.com` } (two sub-cases).
- **Входные данные:** `from_email:'anyone@relyhome.com'`.
- **Ожидаемый результат:** **`true`** for both rule forms (substring match against `"<anyone@relyhome.com>"`). A different domain `foo@other.com` → **`false`**.
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U03: `isSenderMuted` — subject/body/`any`/MIXED rules are NOT muted (from-only filter drops them) → false
- **Приоритет:** P0
- **Тип:** Unit (parametrized — DECISION-B core)
- **Связанный сценарий:** S10(b/c), S11(y); DECISION-B; AC-9
- **Предусловия:** `getActiveState` → active; four sub-cases, each the ONLY rule: (a) `subject:invoice`; (b) `body:unsubscribe`; (c) `any:promo`; (d) **mixed** `from:relyhome.com subject:invoice` (a `from:`+`subject:` line — every-token-is-from is FALSE).
- **Входные данные:** a message that WOULD match each rule (e.g. from `x@relyhome.com` with subject "invoice" for (d)).
- **Ожидаемый результат:** `isSenderMuted` returns **`false`** for all four — `fromOnlyRules(parsed)` yields an empty rule set, so `matchEmail({rules:[]}, …).excluded === false`. (These lines still gate the *task* via the full-DSL `reviewInboundEmail`, unchanged — TC-MM-U18.)
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U04: `isSenderMuted` — same-line `-from:` negation rescue honored verbatim → false when rescued
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S10(a); DECISION-B, C-2; AC-9
- **Предусловия:** `getActiveState` → active; rule = `from:notifications@github.com -from:security` (a from-only line: both tokens are `from:`).
- **Входные данные:** (a) a github notification whose `from` is `notifications@github.com` (no "security" in the from surface) → line matches; (b) a github address `security@github.com` where `-from:security` rescues.
- **Ожидаемый результат:** (a) **`true`** (line matches, not rescued); (b) **`false`** (the `-from:security` token flips the line to non-match — `matchEmail` ANDs tokens, negation inverts). Mute equals `matchEmail`'s final `.excluded` verbatim; no divergent logic.
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U05: `isSenderMuted` — Mail Secretary inactive / not connected (C-4) → false immediately, no matcher run
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** edge-case 1; C-4; FR-1
- **Предусловия:** `getActiveState` → `{active:false, settings:…}` (app disconnected or `enabled=false`).
- **Входные данные:** a message that WOULD match a from-only rule if active.
- **Ожидаемый результат:** returns **`false`**; `matchEmail` (or `safeParseRules`) is **not** invoked (short-circuit on inactive). This is the "behaves exactly as today when Mail Secretary is off" guarantee.
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U06: `isSenderMuted` — regex `from:` token participates at link time → true (but see TC-MM-U12 for list projection)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** edge-case 3; OQ-MM-4; AC-10
- **Предусловия:** `getActiveState` → active; rule = `from:/rely.*/i` (a from-only regex line).
- **Входные данные:** `from_email:'billing@relyhome.com'`.
- **Ожидаемый результат:** **`true`** — `isSenderMuted` delegates to `matchEmail`, which runs the regex. (Confirms the link-time skip fires for regex mutes; the SQL projection deliberately drops it — TC-MM-U12.)
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U07: `getMutedSenderSet` — projects literal from-only `contains` tokens into `emails` vs `domains`; excludes subject/body/mixed
- **Приоритет:** P0
- **Тип:** Unit (the list-side extraction — the star of the helper suite)
- **Связанный сценарий:** S2, S10; AC-2, AC-9; Contract 2
- **Предусловия:** `getActiveState` → active with `exclusion_rules` =
  ```
  from:customerservice@relyhome.com
  from:@vendor.com
  from:acme.io
  from:foo@bar.com subject:invoice   # mixed → excluded
  subject:promo                      # not from-only → excluded
  ```
- **Ожидаемый результат:** returns exactly `{ emails:['customerservice@relyhome.com'], domains:['vendor.com','acme.io'] }` — `customerservice@relyhome.com` is an address (has `@` with a `.` after → `emails`); `@vendor.com` → `@` stripped → `domains`; bare `acme.io` → `domains`. The **mixed** line's `foo@bar.com` and the **subject-only** line contribute **nothing** (not from-only → dropped by `fromOnlyRules`). All values lower-cased.
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U08: `getMutedSenderSet` — inactive (C-4) → `{emails:[],domains:[]}`
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** edge-case 1; C-4; FR-1
- **Предусловия:** `getActiveState` → `{active:false}`.
- **Ожидаемый результат:** returns `{ emails:[], domains:[] }` (no parse attempted). Downstream `email_muted` is then always false → zero list change.
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U09: `getMutedSenderSet` — negated from-only token NOT projected into the set
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** edge-case 4; OQ-MM-4; C-2
- **Предусловия:** `getActiveState` → active; rule = `from:relyhome.com -from:billing` (from-only line with a negation).
- **Ожидаемый результат:** the **positive** literal `relyhome.com` IS projected into `domains`; the **negated** `billing` token is **NOT** projected (negation can't be expressed as positive membership). So the list suppresses `*@relyhome.com` (over-broad vs. the link-time rescue, but the spec accepts that `getMutedSenderSet` projects positive literals only and negation/regex refine at link time — documented one-directional narrowing; the row for a rescued `billing@relyhome.com` may hide in the list but that is the accepted v1 asymmetry, OQ-MM-4). Assert `domains` contains `relyhome.com` and there is no attempt to encode `billing` as an exclusion. *(If the Planner instead chooses to skip projecting a domain literal that shares a line with a negation, this case asserts THAT contract; the implementer pins one — the test must match the shipped contract, not both.)*
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U10: `getMutedSenderSet` — regex `from:` token NOT projected into the SQL set (link-time only)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** edge-case 3; OQ-MM-4; AC-10
- **Предусловия:** `getActiveState` → active; rule = `from:/rely.*/i` (from-only regex line).
- **Ожидаемый результат:** returns `{ emails:[], domains:[] }` — a `kind:'regex'` token is skipped by the literal extractor (only `kind:'contains' && !negate` projects). Confirms AC-10's asymmetry: `isSenderMuted` (TC-MM-U06) is true (new inbound skips) but the pre-existing timeline stays in the list.
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U11: `getMutedSenderSet` — domain vs exact discrimination on token shape
- **Приоритет:** P1
- **Тип:** Unit (parametrized)
- **Связанный сценарий:** edge-case 2; FR-1; US-4
- **Входные данные (each the only rule):** (a) `from:customerservice@relyhome.com`; (b) `from:@relyhome.com`; (c) `from:relyhome.com`; (d) `from:justaword` (no dot, no `@`).
- **Ожидаемый результат:** (a) `emails:['customerservice@relyhome.com'], domains:[]`; (b) `emails:[], domains:['relyhome.com']`; (c) `emails:[], domains:['relyhome.com']`; (d) `emails:[], domains:[]` (a bare word with no `@` and no `.` is neither an address nor a domain → projected nowhere, so it never suppresses in SQL; it may still match at link time as a substring via `isSenderMuted`).
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U12: `fromOnlyRules(parsed)` — keeps only lines where EVERY token targets `field==='from'`
- **Приоритет:** P0
- **Тип:** Unit (the internal filter — DECISION-B encoding)
- **Связанный сценарий:** S10; DECISION-B
- **Предусловия:** `parseRules` output for lines: `from:a@x.com` (keep), `from:a -from:b` (keep — both from), `from:a subject:b` (drop — mixed), `subject:b` (drop), `a@x.com` (drop — bare = `any`), `from:a body:c` (drop).
- **Ожидаемый результат:** the returned subset is exactly the two from-only lines; every retained line satisfies `tokens.every(t => t.field === 'from')`. Both `isSenderMuted` and `getMutedSenderSet` consume this subset (single source of the from-only decision — NFR-4).
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U13: Route `GET /api/calls/by-contact` — 403 without `pulse.view`/`reports.calls.view`; 401 without auth (unchanged middleware)
- **Приоритет:** P0
- **Тип:** Unit (route — security/middleware)
- **Связанный сценарий:** S8 (middleware half); agent-04 §"Тесты безопасности"; spec "Two internal contracts — keeps its existing middleware"
- **Входные данные:** (a) session perms `['jobs.view']` (neither `pulse.view` nor `reports.calls.view`); (b) an unauthenticated request at the `app.use('/api/calls', authenticate, requireCompanyAccess, …)` mount.
- **Ожидаемый результат:** (a) **403**, `getMutedSenderSet` and `getUnifiedTimelinePage` never called; (b) **401** before the handler (auth rejects first) — the muted-set fetch and the query never run. The mute feature adds **no** new gate and must not weaken the existing one.
- **Файл для теста:** `tests/listPaginationByContact.test.js` (or the existing calls-route suite)

### TC-MM-U14: Route wiring — `getMutedSenderSet(companyId)` is fetched with the request's company and its `{emails,domains}` are passed as `mutedEmails`/`mutedDomains`
- **Приоритет:** P0
- **Тип:** Unit (route, db mocked — the plumbing that a mocked suite CAN prove)
- **Связанный сценарий:** S2/S4 (route half), S8 (scoping half); FR-4/7 entry point
- **Предусловия:** stub `req.companyFilter={company_id:'A'}` + `pulse.view`; spy `mailAgentService.getMutedSenderSet` → `{emails:['x@y.com'], domains:['z.com']}`; spy `queries.getUnifiedTimelinePage` → `{rows:[]}`.
- **Ожидаемый результат:** `getMutedSenderSet` called **once with `'A'`** (the request's `req.companyFilter.company_id`, NOT `crm_users.company_id`); `getUnifiedTimelinePage` called with an object containing `mutedEmails:['x@y.com']` and `mutedDomains:['z.com']` **plus** the existing `limit/offset/companyId/search`. The response envelope shape is unchanged (rows may be fewer). *(This proves the wiring only — that suppression actually happens is TC-MM-I01…I06 real-DB.)*
- **Файл для теста:** `tests/listPaginationByContact.test.js`

### TC-MM-U15: `linkInboundMessage` — muted sender → `{skipped:'muted_sender'}` BEFORE contact lookup; no link/unread/bump/SSE
- **Приоритет:** P0
- **Тип:** Unit (link path, db + mailAgentService mocked)
- **Связанный сценарий:** S1, S13; AC-1; FR-2; architecture (a.5) early return
- **Предусловия:** `mailAgentService.isSenderMuted` spied → `true`; spy `emailQueries.findEmailContact`, `timelinesQueries.findOrCreateTimelineByContact`, `queries.markContactUnread`, `timelinesQueries.markTimelineUnread`, and any SSE/realtime broadcast. `msg` is a normal inbound (`is_outbound:false`, no SENT/DRAFT label, has `provider_message_id`).
- **Ожидаемый результат:** returns **`{skipped:'muted_sender'}`**; `findEmailContact` is **NOT** called (the guard is strictly before l.112), and therefore `findOrCreateTimelineByContact`, `markContactUnread`, `markTimelineUnread`, and every SSE broadcast are **NOT** called. The early return sits **after** the `outbound` (l.100) and `draft_or_sent` (l.104) guards (assert an outbound/draft still returns its own skip and never calls `isSenderMuted`).
- **Файл для теста:** `tests/emailTimelineInbound.test.js`

### TC-MM-U16: `linkInboundMessage` — NOT muted → normal path (links, flips unread, bumps) — the "off" control for the guard
- **Приоритет:** P0
- **Тип:** Unit (link path)
- **Связанный сценарий:** S1 (negative control), S9 (link-time)
- **Предусловия:** `isSenderMuted` spied → `false`; `findEmailContact` → a real contact stub; downstream stubs succeed.
- **Ожидаемый результат:** does **not** return `{skipped:'muted_sender'}`; proceeds into `findEmailContact` → timeline resolution → `markContactUnread`/`markTimelineUnread` fire (today's behavior). Proves the guard is a pure pass-through when the sender is not muted (guards against a "mute everything" regression).
- **Файл для теста:** `tests/emailTimelineInbound.test.js`

### TC-MM-U17: `linkInboundMessage` — muted guard is gated on `!opts.skipAgent` (recursion no-op)
- **Приоритет:** P1
- **Тип:** Unit (link path)
- **Связанный сценарий:** S7; architecture "!opts.skipAgent gate is required"
- **Предусловия:** call `linkInboundMessage('A', msg, { skipAgent:true })`; `isSenderMuted` spied.
- **Ожидаемый результат:** `isSenderMuted` is **NOT** invoked on the `skipAgent` recursive re-entry (the guard is skipped), so the agent's own re-link isn't double-evaluated; the call proceeds to the normal (skipAgent) path. On the primary call (`skipAgent` falsy), `isSenderMuted` IS invoked (TC-MM-U15).
- **Файл для теста:** `tests/emailTimelineInbound.test.js`

### TC-MM-U18: `linkInboundMessage` — muted sender returns BEFORE the no-contact agent path (no `reviewInboundEmail`/create-contact) — FR-3 unit half
- **Приоритет:** P0
- **Тип:** Unit (link path — the no-auto-create guarantee)
- **Связанный сценарий:** S7, S11(x); AC-4; FR-3
- **Предусловия:** `isSenderMuted` → `true`; `findEmailContact` would return `null` (unknown sender) if reached; spy `mailAgentService.reviewInboundEmail`.
- **Ожидаемый результат:** returns `{skipped:'muted_sender'}` and `reviewInboundEmail` is **NEVER** called — so the `noContact:true` review (l.116, the only entry to `create_contact_for_unknown` → `createEmailContact`) cannot fire. This is the load-bearing "muted first-time sender never materializes a contact" unit proof (the real-DB counterpart is TC-MM-I06). Contrast: with `isSenderMuted → false` and no contact, `reviewInboundEmail(…, {noContact:true})` IS called (existing behavior preserved).
- **Файл для теста:** `tests/emailTimelineInbound.test.js`

### TC-MM-U19: `linkInboundMessage` — redelivery of a muted email stays skipped, precedes dedup (idempotency unit half)
- **Приоритет:** P1
- **Тип:** Unit (link path)
- **Связанный сценарий:** S6; AC-5; FR-8
- **Предусловия:** `isSenderMuted` → `true`; call `linkInboundMessage` twice with the same `msg` (same `provider_message_id`).
- **Ожидаемый результат:** both calls return `{skipped:'muted_sender'}`; the provider-message-id dedup query is **not reached** on either (the early return precedes it), so dedup is neither weakened nor relied upon for muted senders. No state mutation on either call.
- **Файл для теста:** `tests/emailTimelineInbound.test.js`

### TC-MM-U20: `isSenderMuted` fail-open — a thrown error inside the helper → `false` (no throw escapes)
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S9; AC-8; FR-10 (error-handling 1/3)
- **Предусловия:** force a throw — e.g. `getActiveState` rejects, or `safeParseRules`/`matchEmail` throws on a crafted input (stub to throw).
- **Ожидаемый результат:** `isSenderMuted` **catches** and returns **`false`** (never rejects). Consequently `linkInboundMessage` proceeds down its normal link path (the email links/surfaces as today) — assert no rejection propagates out of `linkInboundMessage` either.
- **Файл для теста:** `tests/mailAgentService.test.js` (helper) + `tests/emailTimelineInbound.test.js` (pipeline non-throw)

### TC-MM-U21: `getMutedSenderSet` fail-open — a thrown error → `{emails:[],domains:[]}`
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S9; AC-8; FR-10 (error-handling 2/3)
- **Предусловия:** force `getActiveState` or `safeParseRules` to throw.
- **Ожидаемый результат:** returns `{ emails:[], domains:[] }` (caught). Threaded into `getUnifiedTimelinePage`, `email_muted` is always false → the list surfaces email as today; the route does not 500 (real-DB counterpart TC-MM-I11).
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U22: `mailAgentService.exports` — `isSenderMuted` + `getMutedSenderSet` are exported; `reviewInboundEmail`/`invalidateCache` still exported (no export regression)
- **Приоритет:** P2
- **Тип:** Unit (module surface)
- **Связанный сценарий:** architecture "extend module.exports (l.312)"; Protected (MAIL-AGENT-001 semantics)
- **Ожидаемый результат:** `typeof mailAgentService.isSenderMuted === 'function'` and `typeof mailAgentService.getMutedSenderSet === 'function'`; the pre-existing `{ isActive, reviewInboundEmail, dryRun, invalidateCache }` are all still present (guards a merge that accidentally replaced rather than extended the exports).
- **Файл для теста:** `tests/mailAgentService.test.js`

### TC-MM-U23: `getUnifiedTimelinePage` default params — omitting `mutedEmails`/`mutedDomains` yields today's SQL (empty-array binds), other callers unaffected
- **Приоритет:** P1
- **Тип:** Unit (query builder, db mocked — SQL string/param shape)
- **Связанный сценарий:** edge-case 1; Contract 3; Protected ("other callers")
- **Предусловия:** call `getUnifiedTimelinePage({ limit, offset, companyId, search })` with NO muted params (a sync/other caller).
- **Ожидаемый результат:** `mutedEmails`/`mutedDomains` default to `[]`; `$4`/`$5` bind empty text[]; the `email_muted` expression is present but `ANY(ARRAY[]::text[])` ⇒ always false. Assert the emitted SQL still contains the five email terms and that the search param index shifted to `$6+` (the `params.length + 1` idiom stays dynamic). *(SQL-string level only — that suppression works is the real-DB section; this guards that the DEFAULTED path is byte-compatible so LIST-PAGINATION-001's other callers don't regress.)*
- **Файл для теста:** `tests/listPaginationByContact.test.js`

---

## 2. Integration — real DB, `scripts/verify-mail-mute-001.js` (NO mocks — MANDATORY for the SQL sites)

All cases run the REAL `getMutedSenderSet`/`isSenderMuted`/`linkInboundMessage`/`getUnifiedTimelinePage` against seeded Postgres, self-seeding/self-cleaning with tag `MM1`. **Per the verify posture, every list case is also re-run once against a prod-copy restore in the deploy window** (`DATABASE_URL` pointed at the copy) — a local dev DB may have too few rows to make the EXPLAIN representative.

> **Why this section is non-negotiable (constraint restated):** a mocked jest suite mocks `db`, so it can assert the SQL *string* but not that timeline 2915 actually left the page, that a call still ranked a phone+email contact above its gated email, or that company B was isolated. The bug it would miss (a wrong `email_muted` term, an ungated ORDER-BY mirror desyncing ranking, a set leaking cross-company) is exactly the LIST-PAGINATION-001 / PULSE-PERF-001 class. **A green mocked run does NOT satisfy AC-2/AC-3/AC-7/AC-11.**

### TC-MM-I01 (s2/s5): **P0 SQL must-run** — muted email-only timeline (relyhome/2915 shape) drops out of `getUnifiedTimelinePage`
- **Приоритет:** **P0 (must-pass, real-DB)**
- **Тип:** Integration
- **Связанный сценарий:** S2, S5; AC-2; FR-4, FR-5
- **Предусловия:** company A; `mkContactEmailOnly(A, {name:'MM1 Rely', email:'customerservice@relyhome.com'})` with one inbound email (thread + message), **no phone, no call/SMS/open-task/unread** beyond the email. `setRules(A, 'from:customerservice@relyhome.com')`.
- **Шаги:** 1) `set = getMutedSenderSet(A)` → assert `{emails:['customerservice@relyhome.com'], domains:[]}`; 2) `page = getUnifiedTimelinePage({ limit:50, offset:0, companyId:A, search:'', mutedEmails:set.emails, mutedDomains:set.domains })`; 3) scan `page` for the tagged contact's timeline id.
- **Ожидаемый результат:** the relyhome timeline is **ABSENT** from `page.rows` and is **not** counted in the `COUNT(*) OVER()` total (page length ≤ limit; pagination integrity — NFR-1/edge-case 9). It fails the surfacing predicate because `email_muted=true` gates `OR (eml.email_thread_id IS NOT NULL AND NOT email_muted)` and it has no other signal. **Also assert** the row is directly fetchable (its `email_messages`/`email_threads` still exist — FR-9): a direct `SELECT` for the thread returns the retained rows.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s2)

### TC-MM-I02 (s2/neg): **P0 NEGATIVE CONTROL** — with an EMPTY muted set the SAME relyhome timeline IS present
- **Приоритет:** **P0 (real-DB, negative control)**
- **Тип:** Integration (control for TC-MM-I01)
- **Связанный сценарий:** S2/S5 control; edge-case 1 (`ANY(empty)=false`)
- **Предусловия:** the exact TC-MM-I01 seed.
- **Шаги:** `page = getUnifiedTimelinePage({ …, mutedEmails:[], mutedDomains:[] })` (feature off / nothing muted).
- **Ожидаемый результат:** the relyhome timeline **IS present** in `page.rows` (surfaces via its email signal, today's behavior). **This case is what proves TC-MM-I01's absence is caused by the muted set, not by a broken seed** — if this fails, the seed is wrong and TC-MM-I01 is vacuous. Together I01+I02 form the "feature on hides / feature off shows" pair.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section neg)

### TC-MM-I03 (s3): **P0** — un-exclude restores the timeline (row reappears with an empty/updated set)
- **Приоритет:** **P0 (real-DB)**
- **Тип:** Integration
- **Связанный сценарий:** S3; AC-6; FR-6
- **Предусловия:** TC-MM-I01 state (timeline hidden while muted).
- **Шаги:** 1) `setRules(A, '')` (remove the rule) + `invalidateCache(A)`; 2) `set2 = getMutedSenderSet(A)` → assert `{emails:[],domains:[]}`; 3) `page = getUnifiedTimelinePage({ …, mutedEmails:set2.emails, mutedDomains:set2.domains })`.
- **Ожидаемый результат:** `getMutedSenderSet` now returns empty and the relyhome timeline **REAPPEARS** in `page.rows` (its retained email rows satisfy the surfacing predicate again — no re-import, no cleanup). Proves reversibility is "drop from the set" (decision (a)).
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s2)

### TC-MM-I04 (s4): **P0 SQL must-run** — channel split: muted email doesn't bump/unread, but a new call and a new SMS DO surface & bump
- **Приоритет:** **P0 (must-pass, real-DB)**
- **Тип:** Integration (the ordering proof — the case a mock cannot make)
- **Связанный сценарий:** S4; AC-3; FR-4, FR-5
- **Предусловия:** company A; `mkContactPhoneEmail(A, {name:'MM1 Dual', phone:'+16175559001', email:'customerservice@relyhome.com'})` with an existing linked email thread. `setRules(A, 'from:relyhome.com')` → `domains:['relyhome.com']`.
- **Шаги & Expected (assert on the returned row's presence and rank vs. a second control contact):**
  1. **Email-only signal, muted:** with only the muted email as the recent signal, `getUnifiedTimelinePage` → the row's `last_interaction_at` does **NOT** include `eml.last_message_at` (email term gated), and it is **not** in the unread tier via email (`any_unread` email term gated). Assert the row does not rank above a control contact whose only signal is an *older* call — i.e. the muted email did not bump it.
  2. **Add a new inbound CALL** (`addCall(dualContact, now)`) → re-query → the row's `last_interaction_at` picks up `latest_call.started_at`; the row **surfaces and bumps to the top** (call contribution untouched). 
  3. **Add a new inbound SMS** (`addSms(dualContact, now+1)`) → re-query → `sms.last_message_at` feeds `last_interaction_at`; the row **surfaces/bumps** normally.
  - **Net assertion:** for the phone+email contact, the muted email contributes nothing to ordering/unread, while the call and SMS rank it exactly as today. (A regression where the email still bumps, OR where the call/SMS no longer bumps, = FAIL.)
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s4)

### TC-MM-I05 (s4/neg): S4 negative control — with an empty set the muted email DOES bump the phone+email contact
- **Приоритет:** P1
- **Тип:** Integration (control)
- **Связанный сценарий:** S4 control
- **Предусловия:** the TC-MM-I04 seed, email as the recent signal, no new call/SMS.
- **Шаги:** `getUnifiedTimelinePage({ …, mutedEmails:[], mutedDomains:[] })`.
- **Ожидаемый результат:** with nothing muted, the email **DOES** feed `last_interaction_at`/`any_unread` and the row ranks by its email recency (today's behavior). Confirms the gating in TC-MM-I04 is caused by the muted set, not the seed.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section neg)

### TC-MM-I06 (s1/s7-link): **P0** — muted new inbound does NOT link and does NOT auto-create a contact (real `linkInboundMessage`)
- **Приоритет:** **P0 (real-DB)**
- **Тип:** Integration
- **Связанный сценарий:** S1, S7; AC-1, AC-4; FR-2, FR-3
- **Предусловия:** company A; `setRules(A, 'from:relyhome.com')`; a fresh inbound `msg` from `newvendor@relyhome.com` with a **brand-new** `provider_message_id` and **no existing contact** for that address. `create_contact_for_unknown = true` in settings.
- **Шаги:** call the REAL `emailTimelineService.linkInboundMessage(A, msg)` (primary call, no `skipAgent`); then query state.
- **Ожидаемый результат:** returns **`{skipped:'muted_sender'}`**; assert (a) **no** new `email_messages`/link row for this `provider_message_id`; (b) **no** new `contacts` row for `newvendor@relyhome.com` and **no** new `timelines` row (the early return precedes the no-contact agent path — FR-3); (c) no unread flip anywhere. **Contrast leg:** with `setRules(A,'')` + `invalidateCache`, the same `msg` for a *known* contact links and flips unread as today (proves the skip is mute-caused).
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s1)

### TC-MM-I07 (s8): **P0 SECURITY must-run** — mute in company A never suppresses company B's identical sender
- **Приоритет:** **P0 (must-pass, real-DB, cross-tenant)**
- **Тип:** Integration (Security — cross-company data)
- **Связанный сценарий:** S8; AC-7; FR-7; ONBOARD-FIX-001 / ZB-ISO-001 precedents
- **Предусловия:** company **B** (tagged, created here) has `mkContactEmailOnly(B, {name:'MM1 RelyB', email:'customerservice@relyhome.com'})` + settings `enabled=true` but **NO** exclusion rule. Company A has `from:relyhome.com` muted and its own relyhome contact.
- **Шаги:** 1) `setB = getMutedSenderSet(B)` → assert `{emails:[],domains:[]}` (B has no rule — proves the set is parsed from *each company's own* settings); 2) `pageB = getUnifiedTimelinePage({ …, companyId:B, mutedEmails:setB.emails, mutedDomains:setB.domains })`; 3) also assert A's page with A's set hides A's relyhome timeline (TC-MM-I01 already shows this for A).
- **Ожидаемый результат:** company B's relyhome timeline **IS present** in `pageB` (B never inherits A's mute). Even if the harness *deliberately* passed A's non-empty set into a `companyId:B` query, the SQL `email_muted` only evaluates on rows already `WHERE tl.company_id = $1(=B)`, and `getMutedSenderSet` is called per-company — so **no cross-tenant suppression path exists**. Assert A's suppression and B's non-suppression **in the same run** (both scoped correctly). A red here = a cross-tenant leak → release blocker.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s7)

### TC-MM-I08 (s12): S12 — multi-email contact, ONE address muted → the contact's EMAIL contribution is suppressed (real EXISTS on `contact_emails`)
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S12; FR-4/5; §Multiple-email rule
- **Предусловия:** company A; `mkContactMultiEmail(A, {name:'MM1 Multi', primaryEmail:'b@personal.com', extraEmail:'a@vendor.com'})` (primary in `contacts.email`, extra in `contact_emails`), an email signal on the collapsed thread, no phone. `setRules(A, 'from:vendor.com')` → `domains:['vendor.com']`.
- **Шаги:** `set=getMutedSenderSet(A)`; `page = getUnifiedTimelinePage({ …, mutedEmails:set.emails, mutedDomains:set.domains })`.
- **Ожидаемый результат:** the contact's timeline is **suppressed** (email-only → drops out) because `email_muted` is true via the `EXISTS (… contact_emails ce2 WHERE ce2.contact_id = tl.contact_id AND split_part(ce2.email_normalized,'@',2) = ANY($5))` branch — even though the *primary* `contacts.email` (`b@personal.com`) is NOT muted. Also assert the symmetric case (mute the **primary** `from:personal.com`) suppresses via the `lower(co.email)` branch. Confirms both address surfaces are checked (edge-case 6). Negative control (section neg): empty set → present.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s12)

### TC-MM-I09 (explain): **P0 VERIFICATION** — EXPLAIN (ANALYZE, BUFFERS) with a non-empty muted set: no new Seq Scan, indexes drive the plan, ~0.3s parity
- **Приоритет:** **P0 (perf gate — AC-11 / NFR-1)**
- **Тип:** Integration (plan probe — **prod-copy restore only**)
- **Связанный сценарий:** AC-11; NFR-1; PULSE-PERF-001 discipline
- **Предусловия:** run on a **prod-DB copy** (local dev lacks the row counts to force the real plan). A non-empty `mutedEmails`/`mutedDomains` (e.g. the relyhome literals). Compare against the same query with empty arrays.
- **Шаги:** `EXPLAIN (ANALYZE, BUFFERS)` the modified `getUnifiedTimelinePage` with (a) a non-empty muted set and (b) empty arrays.
- **Ожидаемый результат:** (1) **no new Seq Scan** on `contacts` / `contact_emails` / `email_messages`; (2) the PULSE-PERF-001 phone-digit expression indexes still drive the plan (unchanged); (3) the `contact_emails` `EXISTS` uses the `contact_id` index (PK/`idx` on `contact_emails(contact_id)`), not a scan; (4) latency ≈ today's ~0.3s; (5) the empty-set plan (b) is **identical** to today's (no plan change when nothing is muted). **Documented in the PR** (not mocked jest). A regression to Seq Scan or a per-row regex = FAIL.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section explain) — output pasted into the PR

### TC-MM-I10 (s6): S6 — redelivery of a muted email on the real link path: no link, no contact, dedup intact
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S6; AC-5; FR-8
- **Предусловия:** company A; `setRules(A, 'from:relyhome.com')`; a muted inbound `msg` (fixed `provider_message_id`) for an unknown relyhome sender.
- **Шаги:** call `linkInboundMessage(A, msg)` **twice** (push + poll overlap).
- **Ожидаемый результат:** both return `{skipped:'muted_sender'}`; after both, exactly **zero** link rows and **zero** new `contacts` rows for that address; the provider-message-id dedup table is unperturbed (the early return never wrote it). No duplicate side effects. (Idempotency proven on real state, complementing the unit TC-MM-U19.)
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s1)

### TC-MM-I11 (s9): S9 — fail-open at LIST time on real DB: a forced `getMutedSenderSet` error → the list surfaces every row (no 500, no dropped rows)
- **Приоритет:** P1
- **Тип:** Integration (fail-open list path)
- **Связанный сценарий:** S9; AC-8; FR-10 (error-handling 2/3)
- **Предусловия:** company A with the relyhome email-only contact; simulate the failure by corrupting the settings the helper reads (e.g. temporarily set `exclusion_rules` to a value that would throw in projection, OR stub `getActiveState` to throw for this case) so `getMutedSenderSet` hits its catch.
- **Шаги:** `set = getMutedSenderSet(A)` (expect the caught path → `{emails:[],domains:[]}`); then `getUnifiedTimelinePage` with that empty set; also assert the route `GET /by-contact` returns 200 (not 500) end-to-end with the same corruption.
- **Ожидаемый результат:** `getMutedSenderSet` returns empty (fail-open), the relyhome timeline **surfaces as today** (nothing suppressed), and the Pulse route responds **200** with the normal envelope. Muting failure is invisible and non-destructive — never a dropped email, never a 500.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s9)

### TC-MM-I12 (s13): S13 — mid-thread mute: history retained + reachable, list contribution stops, new inbound stops linking
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S13; AC-2, AC-12; FR-9, FR-2, FR-4
- **Предусловия:** company A; a relyhome contact with an **already-linked** thread (2+ messages) created BEFORE muting. Then `setRules(A, 'from:relyhome.com')`.
- **Шаги:** 1) confirm the thread's messages still exist (`SELECT count(*)` before/after mute — unchanged); 2) `getUnifiedTimelinePage` with the muted set → the timeline is absent from the list; 3) deliver a new inbound from the sender via `linkInboundMessage` → `{skipped:'muted_sender'}`, no new link.
- **Ожидаемый результат:** historical `email_messages`/`email_threads` counts are **unchanged** by muting (FR-9 — query-time hide, not delete); the timeline is **absent** from the list (S2/S4 shape); the new inbound **does not link** (S1). Confirms the three MAIL-MUTE outcomes co-exist on a pre-existing thread. (No-migration/data-safe AC-12 is corroborated: no schema touched, max migration stays 155.)
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s13)

### TC-MM-ISAB (sab): Sabotage negative control — break `AND NOT email_muted` (or a helper expectation) → the harness MUST FAIL, then restore
- **Приоритет:** P0
- **Тип:** Integration (self-check — mirrors `verify-contact-email-merge-001.js` TC-CEM-ISAB)
- **Связанный сценарий:** harness integrity (LIST-PAGINATION-001 "a green run must certify the detector works")
- **Предусловия:** the TC-MM-I01 seed (relyhome muted, expected ABSENT).
- **Шаги (two prongs):**
  1. **Assertion sabotage (always runs):** assert the *wrong* expectation via the same assert kit — e.g. assert the relyhome timeline **IS present** while muted, or assert `getMutedSenderSet(B)` returns A's literals in the cross-tenant case. Confirm the harness throws `CheckError` / records **FAIL**; then restore the correct expectation and re-assert green.
  2. **Code sabotage (documented, run manually in the deploy window):** temporarily remove the `AND NOT email_muted` gate from the surfacing predicate (l.549) in `getUnifiedTimelinePage`, re-run section `s2` → **TC-MM-I01 MUST turn red** (the timeline would wrongly reappear). Restore the gate → green. This proves the real-DB suite actually exercises the SQL suppression and would catch a dropped gate — the precise LIST-PAGINATION-001 failure mode.
- **Ожидаемый результат:** prong 1 trips a FAIL then restores green in one run; prong 2 (manual) shows the suite goes red when the gate is removed and green when restored. If either sabotage does NOT trip a FAIL, the detector is broken and every PASS above is suspect.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section sab) + a one-line PR note for the manual code-sabotage step

---

## 3. Manual / build (no interplay-with-agent or settings-UI test harness; verify by observation + build)

### TC-MM-M01: Interplay with the agent — from-only muted ⇒ no task AND no timeline; subject/body excluded ⇒ task suppressed but email STILL appears
- **Приоритет:** P1
- **Тип:** Manual (or extend an integration case if a task-assertion harness exists)
- **Связанный сценарий:** S11; AC-9; DECISION-B
- **Шаги:** with Mail Secretary active for a company: (x) add a **from-only** rule for sender X, deliver an inbound from X; (y) add a **subject-only** rule matching sender Y's email, deliver an inbound from Y.
- **Ожидаемый результат:** (x) **no task** is created AND the email does **not** link/surface (no Pulse row, no unread) AND **no contact** is auto-created; (y) **no task** (today's `skipped_excluded`) BUT the email **links and appears** in Pulse (surfaces/bumps/unreads) exactly as before this feature. The two exclusion outcomes are cleanly separated by DECISION-B.
- **Файл для теста:** manual / dev observation (task side has no cheap real-DB assertion here; the link side of (x) is covered by TC-MM-I06 and (y)'s "still links" by running `linkInboundMessage` with a subject-only rule → NOT `{skipped:'muted_sender'}`)

### TC-MM-M02: AC-10 v1 limitation — regex `from:` mute stops NEW inbound but a PRE-EXISTING timeline stays in the list; literal domain retro-hides
- **Приоритет:** P2
- **Тип:** Manual + Integration (the "stays in list" half is real-DB)
- **Связанный сценарий:** edge-case 3; OQ-MM-4; AC-10
- **Шаги:** 1) with a pre-existing relyhome timeline, set `from:/rely.*/i` (regex) → the timeline **stays** in the Pulse list (regex not projected into the SQL set — TC-MM-U10) while a **new** inbound from relyhome **stops linking** (`isSenderMuted` → true, TC-MM-U06 / real link check); 2) replace with the literal `from:relyhome.com` → the timeline now **drops out** (TC-MM-I01). 
- **Ожидаемый результат:** the documented asymmetry holds — regex/negated mutes are link-time only (never over-hide); the literal domain form retro-hides AND stops new inbound. The "stays in list under regex" and "drops under literal" assertions run in the verify script (section s2, a regex sub-case); the "new inbound stops under regex" is the `isSenderMuted` real check.
- **Файл для теста:** `scripts/verify-mail-mute-001.js` (section s2, regex sub-case) + manual confirm

### TC-MM-M03: Un-exclude via the real settings PUT reflects within the ~60s cache (both seams)
- **Приоритет:** P2
- **Тип:** Manual
- **Связанный сценарий:** S3; AC-6; edge-case 8; OQ-MM-3; NFR-4
- **Шаги:** with a muted relyhome timeline hidden, remove the rule via the Mail Secretary settings save (fires `invalidateCache`); within ~60s (next uncached read) reload `/pulse`.
- **Ожидаемый результат:** the timeline reappears in the list AND future relyhome inbound links again — both the ingestion (`isSenderMuted`) and list (`getMutedSenderSet`) seams pick up the change on the next uncached read, consistently (NFR-4). ≤ ~60s staleness is acceptable (matches task-gating today).
- **Файл для теста:** manual / dev observation

### TC-MM-M04: Backend build/lint + full Jest suite stays green
- **Приоритет:** P3
- **Тип:** Build
- **Связанный сценарий:** ship gate (frontend-build-command lesson is FE-only; this feature is backend-only)
- **Шаги:** `cd backend && npm test` (worktree: add `--testPathIgnorePatterns "/node_modules/"`); confirm `node -c` / lint clean on the four changed files.
- **Ожидаемый результат:** exit 0; the new helper cases + link cases + route-wiring cases pass; **no existing suite regresses** — especially `tests/listPaginationByContact.test.js`, `tests/emailTimelineInbound.test.js`, `tests/emailTimelineOutbound.test.js`, `tests/mailAgentRules.test.js`, `tests/mailAgentService.test.js`, `tests/contactsPulseTenantIsolation.test.js`.
- **Файл для теста:** build / CI

---

## Regression / Protected (must stay green)

- **TC-R-1 (P0):** **CALL & SMS contributions to `getUnifiedTimelinePage` byte-for-byte unchanged** — `latest_call`, the `sms` lateral, `open_task`, `is_action_required`, `tl.has_unread`, `co.has_unread`, the orphan-shadow dedup, and pagination (`COUNT(*) OVER()`, page ≤ limit; PULSE-PERF-001 indexes). Covered live by TC-MM-I04 (call/SMS still bump) + the EXPLAIN gate (TC-MM-I09) + `tests/listPaginationByContact.test.js` staying 100% green. A muted email-only row simply never enters the window.
- **TC-R-2 (P1):** **`linkInboundMessage` existing skips + "never throw" posture** — `no_message`/`outbound`/`draft_or_sent`/`no_contact` all return their own skip unchanged; the `muted_sender` return is additive and placed after outbound/draft, before contact lookup (TC-MM-U15/U16). No throw escapes the pipeline even on a mute-eval error (TC-MM-U20). `tests/emailTimelineInbound.test.js` / `emailTimelineOutbound.test.js` stay green.
- **TC-R-3 (P1):** **MAIL-AGENT-001 exclusion semantics intact** — `mailAgentRules.parseRules`/`matchEmail` are **reused, not modified** (`tests/mailAgentRules.test.js` unchanged/green); today's `skipped_excluded` task-gating for subject/body/any/mixed rules is unchanged (TC-MM-M01(y), TC-MM-U03). The from-only *filter* is additive.
- **TC-R-4 (P1):** **EMAIL-OUTBOUND-001 / EMAIL-LEAD-ORIGIN-001 surfacing for NON-muted senders** — the `email_by_contact` CTE **shape** is unchanged; only the 5 consuming email terms are gated for muted contacts. A non-muted email still links/surfaces/bumps (TC-MM-I02/I05 negative controls). Outbound composition to a muted address is never blocked (no write-path change — OQ-MM-2).
- **TC-R-5 (P2):** **Tenant isolation** — the muted set and all suppression stay `company_id`-scoped; `getMutedSenderSet`/`isSenderMuted` are called per-request-company; the SQL `email_muted` only evaluates on `WHERE tl.company_id = $1` rows (TC-MM-I07 real-DB + TC-MM-U13/U14 unit + existing `tests/contactsPulseTenantIsolation.test.js` green).
- **TC-R-6 (P2):** **Historical email data — no deletion/mutation; reversibility preserved** — suppression is query-time only; `email_messages`/`email_threads`/link rows for a muted sender are retained and reachable in the detail view (TC-MM-I01 direct-fetch, TC-MM-I12). **No migration ships; max migration stays 155** (AC-12) — assert no new file under `backend/db/migrations/` numbered ≥156 for this feature.
- **TC-R-7 (P3):** **Other `getUnifiedTimelinePage` callers** (LIST-PAGINATION-001 sync callers) pass no muted params → defaulted `[]` → today's behavior byte-for-byte (TC-MM-U23). The route middleware chain (`authenticate → requireCompanyAccess` + `callsRead`) is unchanged (TC-MM-U13); no `server.js` edit.

## Notes for the Implementer / Tester

- **The cases that matter most run against the REAL DB:** **TC-MM-I01/I03 (S2/S5 drop-out + restore)**, **TC-MM-I04 (S4 channel split ordering)**, and **TC-MM-I07 (S8 cross-tenant)** are the three P0 SQL/security gates; **TC-MM-I09 (EXPLAIN)** is the P0 perf gate. Their **negative controls** (TC-MM-I02/I05, empty set = row present) and the **sabotage** (TC-MM-ISAB, remove `AND NOT email_muted` → suite red) are what make a green run trustworthy. **Mocks (TC-MM-U*) prove only the DSL/dispatch/SQL-string shape** — do NOT ship on green mocks alone (LIST-PAGINATION-001 / PULSE-PERF-001).
- **NFR-4 (the two seams must agree)** is verified end-to-end by having each real-DB list case call the REAL `getMutedSenderSet` and thread its result into `getUnifiedTimelinePage` (not a hand-fed literal), plus a real `isSenderMuted` link check on the same rule — so a "hides-but-links" / "links-but-hides" drift would surface.
- **The one documented, accepted asymmetry (OQ-MM-4):** `getMutedSenderSet` projects **only literal, non-negated** from-only `from:` tokens into the SQL set; regex/negated tokens mute at **link time only** (`isSenderMuted`) and never retro-hide an existing list row. TC-MM-U06/U09/U10 + TC-MM-M02 pin both halves. This only ever *shows* extra, never over-hides — and keeps the hot query regex-free (PULSE-PERF-001).
- **Five SQL sites, keep the SELECT and ORDER-BY mirrors in sync** (l.499/500-501/549 SELECT; l.591/598 ORDER-BY). A desync (gating the SELECT term but not its ORDER-BY mirror) would rank a muted email's row inconsistently — TC-MM-I04's ordering asserts catch it; a unit test cannot.
- **Fail-open is a hard requirement in three places** (link-time helper, list-time helper, malformed-token) — TC-MM-U20/U21 (unit) + TC-MM-I11 (real-DB list, route returns 200). A mute failure must never drop an email or 500 the Pulse page.
- **Harness:** mirror `scripts/verify-contact-email-merge-001.js` — tag `MM1`, clean before each case + at start/end, company A = seed `…0001` (row-targeted by tagged contact/timeline id, never whole-page absolutes), tagged company B for TC-MM-I07 cross-tenant (created + deleted by cleanup), `invalidateCache(company)` after every settings write, `DATABASE_URL` default `postgresql://localhost/twilio_calls` (never prod), `--section` selectable incl. `neg`/`explain`/`sab`, exit 0 only when no case FAILs, and TC-MM-ISAB so a green run certifies the detector works. Run the list cases + EXPLAIN once against a **prod-copy restore** in the deploy window (AC-2/AC-11 posture).
- **No migration.** If one is ever (wrongly) added, it must be ≥156 with a rollback; this feature ships **zero** schema (AC-12). `companyId(req) = req.companyFilter?.company_id` (401 on missing tenant — unchanged).
