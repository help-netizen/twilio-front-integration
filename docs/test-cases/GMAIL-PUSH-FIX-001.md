# Тест-кейсы: GMAIL-PUSH-FIX-001 — real-time Gmail push fix (backend-only)

**Source:** orchestrator brief GMAIL-PUSH-FIX-001 + Architect LOCKED DESIGN (Design A) + memory `gmail-push-broken` (Pub/Sub push dead after Fly→Vultr; polling-only; interim `EMAIL_SYNC_INTERVAL_MS=60000`). Change points confirmed against source:
- `backend/src/services/mail/GmailProvider.js` l.129–149 — `handlePushNotification`; the cursor is built at **l.143** `cursor: historyId != null ? String(historyId) : null`.
- `backend/src/db/emailQueries.js` l.394–407 — `listDueMailboxes(intervalMinutes = 5)` (the whole predicate is SQL).
- `backend/src/services/emailSyncService.js` l.570–586 — `runSchedulerTick()` → `listDueMailboxes(Math.floor(SYNC_INTERVAL_MS / 60000))` (the SOLE caller).
- `backend/src/services/email/emailTimelineService.js` l.422–454 — `ingestPushNotification`; the success return is **l.449** `return { handled: true, company, processed, linked, skipped }` (no success log today — FIX#3 adds one before it).
- Existing suite `tests/mailProvider.test.js`: **TC-ET-040** l.134–139 (pins `cursor:'777'` — encodes the bug), **TC-ET-037** l.160–186 (AC-12 seam; the load-bearing `it` at l.167–175).

**Design under test (the three fixes):**
- **FIX#1** — `handlePushNotification` returns `cursor: null` **always** (collapses the l.143 ternary). Downstream `ingestPushNotification` → `pullChanges(companyId, null)` → `emailSyncService.pullChangesNormalized(companyId, null)` then walks from the mailbox's stored `history_id` instead of trusting the push's `historyId` (which can be ahead of / racing the stored cursor — the root cause of dropped pushes).
- **FIX#2** — new `listDueMailboxes` predicate: **cadence** off the last *FINISH* honoring `EMAIL_SYNC_INTERVAL_MS`; **overlap-block only for a genuinely in-flight sync** = a `last_sync_started_at` with **no newer finish** (`last_sync_finished_at IS NULL OR last_sync_finished_at < last_sync_started_at`); **10-min stuck escape** so a crashed/hung sync can't freeze the mailbox forever. Feeds **ONLY** `emailSyncService.runSchedulerTick`.
- **FIX#3** — one success log line in `ingestPushNotification` **before** the `{handled:true}` return: `[EmailPush] push handled …` with `processed` / `linked` counts (observability so a live push can be confirmed in prod logs).

---

## ⚠️ TEST VEHICLE — READ FIRST

| Fact | Consequence |
|------|-------------|
| **Jest IS wired for this seam** — `tests/mailProvider.test.js` (GmailProvider) + `tests/emailPush.test.js` (route) + `tests/emailMailboxMultitenancy.test.js` (emailQueries over a mocked pool) already run green. | Brief cases #1–#6 are **runnable jest**. Run: `npx jest --runTestsByPath tests/mailProvider.test.js --testPathIgnorePatterns "/node_modules/"`. |
| **There is NO live-Postgres test harness.** Every DB test does `jest.doMock('../backend/src/db/connection', () => ({ query: jest.fn() }))` and asserts *emailQueries' own* behavior over controllable rows / captured SQL — *"we are testing emailQueries, not Postgres."* | **The `listDueMailboxes` WHERE clause never executes in jest** — `db.query` returns whatever you `mockResolvedValue`. A mock-db test can only assert **SQL text-shape + params**, NOT the due/not-due truth table. See the **DESIGN ASK** below. |
| **🔑 TEST-ENABLING DESIGN ASK (FIX#2):** to make the brief's real truth-table (#3) and its red/green sabotage (#6) *genuinely runnable jest*, the row-level decision must be extracted into a **pure predicate** `isMailboxDue(row, { intervalMinutes, now })` that the SQL WHERE **mirrors** (same three clauses). | With the helper: TC-GPF-001 seeds plain JS rows against a **frozen `now`** and asserts booleans; sabotage flips the idle-fresh-start row red. **Without** the helper the truth-table is only provable by the **live-pg** case (TC-GPF-003), and jest is limited to the weaker SQL-shape guard (TC-GPF-002). **Recommend the helper.** |
| **`handlePushNotification` is decode-only + safe-fail** — no HTTP, no `company_id` gate of its own (the tenant is *resolved* from `getMailboxByEmail`), never throws (returns `null`). | Its unit tests mock `emailQueries.getMailboxByEmail` and assert the returned shape. The **route's** unconditional fast-ack 200 is already covered by `emailPush.test.js` TC-ET-045 — not re-tested here. |
| **`ingestPushNotification` internally `require`s `../mail/providerRegistry`** (`.get()`), then `provider.pullChanges`, then `linkInbound/OutboundMessage` (which hit db). | FIX#3 log test mocks `providerRegistry.get()` → a fake provider whose `pullChanges` returns `{ messages: [] }`, so the link-loop is skipped (`processed:0, linked:0`) and **no db is touched**. Spy `console.log`. |
| **Config consts are module-load-time** — `SYNC_INTERVAL_MS = parseInt(EMAIL_SYNC_INTERVAL_MS||'300000')` (emailSyncService l.11); `Math.floor(SYNC_INTERVAL_MS/60000)` is the interval arg. | Any test that varies `EMAIL_SYNC_INTERVAL_MS` must set env **before** require and bust the module cache (`jest.resetModules()`), per the multitenancy-test pattern. |
| **P2 live push needs the prod container** (real Gmail creds + real pg + real Pub/Sub push landing on `api.albusto.com`). | `TC-GPF-007` is **opt-in / manual, run once at deploy** — never in headless CI. Node/bash harness, staged on the host via `docker cp` (NOT `ssh 'bash -s'` stdin — that eats `docker compose exec -T … node`). |

**N/A here (deliberate — not a coverage gap):** the role's mandatory auth `401`/`403`, company-isolation, and cross-tenant `404` checks. This fix touches **no new HTTP route and no new tenant-scoped read**. Push-endpoint auth (token + OIDC) is unchanged and covered by `emailPush.test.js` (TC-ET-043/044); mailbox→tenant resolution isolation (`getMailboxByEmail` deterministic `ORDER BY … LIMIT 1`) is covered by `emailMailboxMultitenancy.test.js` GAP #1(c). Both must simply **stay green** (regression).

**Shared fixtures.** `COMPANY = '00000000-0000-0000-0000-00000000000a'`. Push envelope helper (already in `mailProvider.test.js` l.130): `envelope(obj) = { message: { data: Buffer.from(JSON.stringify(obj)).toString('base64') } }`. Frozen clock for the due-matrix: `NOW = new Date('2026-07-10T12:00:00Z')`; `ago(min) = new Date(NOW - min*60000)`.

---

## Scenario map

| Brief item | Meaning | Case(s) | Priority | Type |
|---|---|---|---|---|
| 1 | TC-ET-040 UPDATE — `cursor:'777'` → `cursor:null` (core bug guard) | TC-ET-040 | **P0** | Unit (jest) |
| 2 | TC-ET-037 REGRESSION — AC-12 seam stays green (Design A must not add imports) | TC-ET-037 | **P0** | Unit (jest, source-text) |
| 3 | `listDueMailboxes` due-matrix (7 rows) | TC-GPF-001 (helper) · TC-GPF-002 (SQL-shape) · TC-GPF-003 (live pg) | **P0** / P1 / P2 | Unit + Live |
| 4 | `handlePushNotification` edge — `historyId` null/absent → cursor null; foreign mailbox → null | TC-GPF-004 | **P1** | Unit (jest) |
| 5 | FIX#3 log — success path emits `[EmailPush] push handled …` | TC-GPF-005 | **P1** | Unit (jest) |
| 6 | Negative control / sabotage — revert FIX#1 → TC-ET-040 red; revert FIX#2 → idle-fresh-start red | TC-GPF-006 | **P0** | Unit (jest, procedure) |
| 7 | LIVE push e2e — self-send via RAW Gmail API, appears ≤~15s, log line fired | TC-GPF-007 | **P2** | Live (node/bash) |
| — | Latent edge — sub-minute `EMAIL_SYNC_INTERVAL_MS` floors interval arg to 0 | TC-GPF-008 | **P3** | Unit (jest) |

**Coverage:** 10 cases — **P0:** 4 · **P1:** 3 · **P2:** 2 · **P3:** 1. **Unit (jest):** 8 · **Live/manual:** 2 (TC-GPF-003 pg truth-table, TC-GPF-007 push e2e).

---

### TC-ET-040 — UPDATE: `handlePushNotification({…historyId:777}) → cursor: null` (core bug guard)
- **Priority:** P0 · **Type:** Unit (jest) · **File:** `tests/mailProvider.test.js` l.134–139 (**edit in place**)
- **Related:** brief #1; FIX#1 (GmailProvider.js l.143)
- **Precondition:** `emailQueries.getMailboxByEmail.mockResolvedValue({ company_id: COMPANY })`.
- **Input:** `p.handlePushNotification(envelope({ emailAddress: 'mb@co.com', historyId: 777 }))`.
- **Steps:**
  1. `await` the call.
  2. Assert the mailbox was resolved by address; assert the returned shape.
- **Expected (the flip):**
  - `getMailboxByEmail` called with `'mb@co.com'` (unchanged).
  - `out` **`toEqual({ companyId: COMPANY, cursor: null })`** — was `{ companyId: COMPANY, cursor: '777' }`. The push's `historyId` is **discarded**; it never becomes the cursor.
- **Note:** update the `it` title to reflect intent, e.g. `'decodes {emailAddress, historyId} but returns cursor:null — never trusts the push historyId'`.

---

### TC-ET-037 — REGRESSION: AC-12 seam still green (timeline layer imports no Gmail/EMAIL-001)
- **Priority:** P0 · **Type:** Unit (jest, source-text) · **File:** `tests/mailProvider.test.js` l.160–186 (**must stay green, unmodified**)
- **Related:** brief #2; the P0 seam contract
- **Precondition:** none (pure `fs.readFileSync` + regex over source).
- **Steps / Expected (all already asserted — FIX#3 must not break them):**
  1. `services/email/emailTimelineService.js` `require`s **neither** `googleapis`, `../emailService`, `../emailSyncService`, **nor** `../emailMailboxService`; it **does** `require('../mail/providerRegistry')`.
  2. `services/mail/MailProvider.js` + `services/mail/providerRegistry.js` contain no `require('googleapis')`.
  3. `services/mail/GmailProvider.js` is the ONE file that imports `googleapis`.
- **Load-bearing for this fix:** FIX#3 adds only a `console.log` inside `ingestPushNotification`. It must **not** introduce any new `require` in `emailTimelineService.js` (esp. not `../emailSyncService`, even though FIX#2 lives there — the design says `listDueMailboxes` feeds `runSchedulerTick` **only**). If an implementer wires the scheduler through the timeline layer, this test goes red — which is the intended tripwire.

---

### TC-GPF-001 — `listDueMailboxes` DUE-MATRIX (pure-predicate truth table, 7 rows)
- **Priority:** P0 · **Type:** Unit (jest) · **File (new):** `tests/emailDueMailboxes.test.js`
- **Related:** brief #3; FIX#2
- **⚠️ Depends on the DESIGN ASK:** requires the extracted pure predicate `isMailboxDue(row, { intervalMinutes, now })` (exported from `emailQueries.js` or a small `mailDuePredicate.js` that the SQL WHERE mirrors). If the implementer keeps the logic SQL-only, this case is **not jest-runnable** — fall back to TC-GPF-002 (structure) + TC-GPF-003 (live semantics), and record the gap.
- **Precondition:** `NOW = new Date('2026-07-10T12:00:00Z')`; `intervalMinutes = 5`; each row = `{ status:'connected', last_sync_started_at, last_sync_finished_at }`.
- **Matrix — assert `isMailboxDue(row, { intervalMinutes:5, now:NOW })` per row:**

  | # | Case | `last_sync_started_at` | `last_sync_finished_at` | Expected | Why |
  |---|------|------------------------|-------------------------|----------|-----|
  | A | never-synced | `null` | `null` | **DUE** | no finish → cadence due; no start → not in-flight |
  | B | **idle-fresh-start** (the fix) | `ago(8)` | `ago(7)` | **DUE** | finished 7m ago > 5m interval → cadence due; finished ≥ started → not in-flight |
  | C | just-synced | `ago(3)` | `ago(2)` | **NOT DUE** | finished 2m ago < 5m interval → cadence not due |
  | D | in-flight (recent, unfinished) | `ago(1)` | `null` | **NOT DUE** | started, finish NULL, < 10m → genuinely in-flight → block |
  | D2 | in-flight (stale prior finish) | `ago(1)` | `ago(30)` | **NOT DUE** | finished (30m) < started (1m) → no newer finish → in-flight → block (a naive `finished IS NULL` in-flight test would WRONGLY mark this due) |
  | E | stuck (escape) | `ago(12)` | `ago(30)` | **DUE** | no newer finish BUT started > 10m ago → escape hatch |
  | F | crashed-first-run (escape) | `ago(15)` | `null` | **DUE** | never finished, started > 10m ago → escape hatch |

- **Expected:** DUE set = `{A, B, E, F}`; NOT-DUE set = `{C, D, D2}`. All seven exact.
- **Extra guard (status):** a row `{ status:'disconnected', last_sync_started_at:null, last_sync_finished_at:null }` → **NOT DUE** (only `status='connected'` mailboxes are eligible). If `isMailboxDue` doesn't see `status`, assert this at the query layer instead (TC-GPF-002 confirms the SQL keeps `m.status = 'connected'`).

---

### TC-GPF-002 — `listDueMailboxes` SQL-shape + param guard (structural, mock-db)
- **Priority:** P1 · **Type:** Unit (jest, mocked pool) · **File:** `tests/emailDueMailboxes.test.js`
- **Related:** brief #3 (structural half); runs **regardless** of whether the helper is extracted
- **Precondition:** `jest.doMock('../backend/src/db/connection', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }))`; `require` emailQueries fresh (`jest.resetModules()`).
- **Steps:** `await emailQueries.listDueMailboxes(5)`; capture `sql = db.query.mock.calls[0][0]` and `params = db.query.mock.calls[0][1]`.
- **Expected:**
  1. `db.query` called **once**; `params` `toEqual(['5'])` (interval passed as `String(intervalMinutes)`).
  2. SQL still filters `m.status = 'connected'`.
  3. **Cadence clause present** — matches `/last_sync_finished_at IS NULL/` AND a `last_sync_finished_at < now() - (…$1…)::interval` form (cadence keyed on the *finish*, honoring the interval param).
  4. **In-flight overlap clause is the NEW shape** — the SQL **compares `last_sync_finished_at` to `last_sync_started_at`** (regex e.g. `/last_sync_finished_at\s*<\s*[^;]*last_sync_started_at/` or a `>=` form). This is the structural red/green: the OLD query (l.400–403) gated `started` **only** against a fixed `now() - interval '10 minutes'` and **never** compared finish-to-start.
  5. **Escape hatch retained** — SQL still contains `now() - interval '10 minutes'` (or an equivalent 10-min bound) for `last_sync_started_at`.
- **Note:** text-matching SQL is intentionally brittle → **P1, structural only**. The *semantic* truth-table lives in TC-GPF-001 (helper) and TC-GPF-003 (live pg). Keep the regexes loose (whitespace-tolerant, no exact-string on the whole WHERE).

---

### TC-GPF-003 — `listDueMailboxes` DUE-MATRIX against REAL Postgres (live, at deploy)
- **Priority:** P2 · **Type:** Live / manual (real pg) · **Run:** once at deploy, from inside the app container (`docker compose exec -T app node`), OR against a throwaway local pg with migrations applied
- **Related:** brief #3 — this is the **only** place the actual SQL boolean logic is exercised (jest can't; no pg harness)
- **Precondition:** a scratch `email_mailboxes` row (`status='connected'`) + 7 `email_sync_state` rows seeded with `last_sync_started_at` / `last_sync_finished_at` = `now() - interval 'N minutes'` per the TC-GPF-001 matrix (A–F + a disconnected control). Wrap in a transaction and `ROLLBACK`, or use a disposable company_id, so prod data is untouched.
- **Steps:**
  1. Seed the 7+1 rows.
  2. `SELECT mailbox_id FROM ( … listDueMailboxes(5) query … )` — i.e. call `emailQueries.listDueMailboxes(5)`.
  3. Collect returned `mailbox_id`s.
- **Expected:** returned set = exactly the **DUE** rows `{A, B, E, F}`; `{C, D, D2, disconnected}` absent. Ordering `last_sync_finished_at ASC NULLS FIRST` (A/F first). This confirms the hand-written SQL matches the JS predicate the unit test proved.
- **Cleanup:** `ROLLBACK` / delete the scratch rows. Note them as deletable.

---

### TC-GPF-004 — `handlePushNotification` edge: cursor UNIFORMLY null; mailbox gate intact
- **Priority:** P1 · **Type:** Unit (jest) · **File:** `tests/mailProvider.test.js` (extend the TC-ET-040 describe, l.128–156)
- **Related:** brief #4; FIX#1 edges (the existing l.141–155 cases stay as-is)
- **Precondition (a,b):** `getMailboxByEmail.mockResolvedValue({ company_id: COMPANY })`.
- **Cases & Expected:**
  1. **historyId absent** — `envelope({ emailAddress:'mb@co.com' })` → `{ companyId: COMPANY, cursor: null }` (was already null pre-fix; now proven identical to the 777 path — cursor is independent of the push historyId).
  2. **historyId: 0** (falsy-but-present) — `envelope({ emailAddress:'mb@co.com', historyId: 0 })` → `{ companyId: COMPANY, cursor: null }` (no special-casing; still null).
  3. **foreign/unknown mailbox** — `getMailboxByEmail.mockResolvedValue(null)`, `envelope({ emailAddress:'who@dis.com', historyId: 5 })` → **`null`** (unchanged; route still fast-acks 200; ingest returns `{handled:false}`). *(This re-affirms the existing l.141–145 case — the mailbox resolution gate is NOT weakened by FIX#1.)*
  4. **Regression, still green:** missing `message.data` → `null` (l.147–150); bad-base64 decode → `null` (l.152–155). No throw on any path.

---

### TC-GPF-005 — FIX#3: `ingestPushNotification` success emits `[EmailPush] push handled …`
- **Priority:** P1 · **Type:** Unit (jest) · **File (new):** `tests/emailPushIngestLog.test.js`
- **Related:** brief #5; FIX#3 (emailTimelineService.js before l.449)
- **Precondition / mocks:**
  - `jest.mock('../backend/src/services/mail/providerRegistry', () => ({ get: jest.fn(() => fakeProvider) }))` where `fakeProvider = { handlePushNotification: jest.fn().mockResolvedValue({ companyId: COMPANY, cursor: null }), pullChanges: jest.fn().mockResolvedValue({ messages: [] }) }` — empty `messages` so the link-loop is skipped and **no db is hit**.
  - `const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})`.
- **Steps:** `const out = await emailTimelineService.ingestPushNotification(anyEnvelope)`.
- **Expected:**
  1. `out` `toEqual({ handled: true, company: COMPANY, processed: 0, linked: 0, skipped: 0 })`.
  2. `logSpy` was called with a string matching `/\[EmailPush\] push handled/` that **includes the counts** — `processed` (0) and `linked` (0) surfaced (assert via regex on the numbers, not exact punctuation, e.g. `/processed[=:\s]0/` and `/linked[=:\s]0/`).
  3. The log fires on the **success** path only — assert it did **not** fire when `handlePushNotification` resolves `null` (call again with `fakeProvider.handlePushNotification.mockResolvedValueOnce(null)` → `out.handled === false`, `logSpy` not called with the `push handled` line).
- **Optional non-zero variant:** `pullChanges` → `{ messages: [ inboundMsg ] }` with `linkInboundMessage` mocked → `{ linked:true }`; assert the log shows `processed:1, linked:1`. (Requires mocking the link fns — keep as a nice-to-have; the `messages:[]` path is the clean primary.)

---

### TC-GPF-006 — NEGATIVE CONTROL / sabotage (prove the checks are load-bearing)
- **Priority:** P0 · **Type:** Unit (jest, procedure — run during implementation, revert after) · **Related:** brief #6
- **Precondition:** feature applied and green.
- **Steps & Expected:**
  1. **Revert FIX#1** — restore GmailProvider.js l.143 to `cursor: historyId != null ? String(historyId) : null`. Re-run `mailProvider.test.js`. **Expected: TC-ET-040 RED** (`out.cursor === '777' !== null`). Restore the fix → green. *(Proves the core bug guard actually pins the behavior.)*
  2. **Revert FIX#2** — restore the OLD `listDueMailboxes` predicate (or the old `isMailboxDue` logic: block whenever `last_sync_started_at > now-10min`, no finish-vs-start compare). Re-run the due-matrix. **Expected: TC-GPF-001 row B (idle-fresh-start) RED** — old guard returns NOT-DUE for `{started ago(8), finished ago(7)}` (started < 10m ago blocks it) though it legitimately finished > 1 interval ago. Restore → green. *(Proves the fix is what makes a healthy idle mailbox eligible again — i.e. it's what restores the 5-min cadence.)*
  3. If TC-GPF-001 is unavailable (helper not extracted), run the sabotage against **TC-GPF-003** (live pg): the OLD SQL omits row B from the DUE set.
- **Expected overall:** each revert turns exactly the named case RED and nothing else spurious; the fixes are individually load-bearing.

---

### TC-GPF-007 — LIVE push e2e: raw self-send appears ≤~15s + log line fired (at deploy)
- **Priority:** P2 · **Type:** Live (node/bash harness) · **Run:** once at deploy, sequential, from inside the prod app container
- **Related:** brief #7 — the real proof that push (not the 10-min poll) delivers
- **⚠️ Harness rules (from the brief — do not deviate):**
  - **Self-send via the RAW Gmail API** — `google.gmail('v1').users.messages.send({ userId:'me', requestBody:{ raw: <base64url MIME> } })` with a **hand-built** MIME (`From`/`To` = the connected mailbox, a **UNIQUE** subject e.g. `GMAIL-PUSH-FIX-001 probe <epoch>-<rand>`). **NOT** `emailService.sendEmail` — that hydrates/imports the thread itself and would **void the measurement** (the row would appear via the send path, not via push).
  - **Stage the node file on the host, then `docker cp` into the container** and run with `docker compose exec -T … node /tmp/probe.js`. **Do NOT** pipe via `ssh 'bash -s'` stdin — that stream is consumed by `docker compose exec -T … node` and the script never arrives.
- **Steps:**
  1. Record `T0 = Date.now()`.
  2. Raw-send the unique-subject email to the connected mailbox (triggers a Gmail history change → Pub/Sub push → `api.albusto.com` push route → `ingestPushNotification`).
  3. Poll `SELECT id, created_at FROM email_messages WHERE subject = '<unique>' LIMIT 1` every ~2s.
  4. In parallel, tail the app logs for the FIX#3 line: `docker compose logs --since=1m app | grep '[EmailPush] push handled'`.
- **Expected (PASS):**
  - The row appears at `T_seen − T0 ≤ ~15s` → **push worked**.
  - The `[EmailPush] push handled …` log line fired for this company with `processed ≥ 1` (and `linked` per contact match).
- **FAIL signatures:**
  - Row appears only near the next **~10-min poll tick** (`EMAIL_SYNC_INTERVAL_MS`) → **push still broken** (poll reconciled it). This is exactly the `gmail-push-broken` symptom the fix targets.
  - No `push handled` log within ~15s → push not landing (Pub/Sub sub still pointed at the stale Fly endpoint) OR ingest errored (check `[EmailTimeline] ingestPushNotification error` / `[EmailPush] async ingest error`).
- **Cleanup:** the probe email is **deletable** (delete from the mailbox + optionally the `email_messages` row). Note it as a throwaway.
- **Preflight note:** per `gmail-push-broken`, live push also depends on the Pub/Sub subscription being retargeted to `api.albusto.com`. If that infra step isn't done, this test FAILs by design — that's the signal, not a test defect.

---

### TC-GPF-008 — Latent edge: sub-minute `EMAIL_SYNC_INTERVAL_MS` floors interval arg to 0
- **Priority:** P3 · **Type:** Unit (jest) · **File:** `tests/emailDueMailboxes.test.js`
- **Related:** hardening — `runSchedulerTick` passes `Math.floor(SYNC_INTERVAL_MS / 60000)` (emailSyncService l.573)
- **Precondition:** conceptual — `EMAIL_SYNC_INTERVAL_MS < 60000` (e.g. 30000) → `Math.floor(30000/60000) = 0` → `listDueMailboxes(0)`.
- **Expected / assertion:** document + assert the resulting behavior of `isMailboxDue(row, { intervalMinutes:0, now })`: with `interval '0 minutes'`, the cadence clause `last_sync_finished_at < now() - 0` is true for **any** finish in the past → every non-in-flight mailbox is due every tick. Assert this is **acceptable** (more-frequent polling, still overlap-guarded so no double-sync) — OR, if the design wants a floor of 1, assert `listDueMailboxes` clamps `intervalMinutes` to `>= 1`. Pick per the implementer's choice; the point is the sub-minute config must not silently disable the cadence gate. **Not a blocker** — flagged so it's a conscious decision, not a surprise.

---

## Pre-merge checklist (for the Tester)
- [ ] `tests/mailProvider.test.js` — TC-ET-040 flipped to `cursor:null`; TC-ET-037 untouched & green; TC-GPF-004 edges added.
- [ ] `tests/emailDueMailboxes.test.js` — TC-GPF-001 (7-row matrix, **if** `isMailboxDue` extracted) + TC-GPF-002 (SQL-shape) + TC-GPF-008.
- [ ] `tests/emailPushIngestLog.test.js` — TC-GPF-005 (`[EmailPush] push handled` log + counts; not on the null path).
- [ ] Regression stays green: `emailPush.test.js` (route fast-ack/verify), `emailMailboxMultitenancy.test.js` (getMailboxByEmail isolation).
- [ ] Sabotage TC-GPF-006 run manually: each revert reddens exactly its case.
- [ ] At deploy: TC-GPF-003 (live pg matrix) + TC-GPF-007 (live push ≤~15s) — sequential, cleaned up, probe email deleted.
