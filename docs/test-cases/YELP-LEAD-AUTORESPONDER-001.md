# Test Cases: YELP-LEAD-AUTORESPONDER-001 (Phase 1a) — Yelp new-lead email → detect → claim → parse → create lead → ONE Gemini greeting

Spec/Arch: no `Docs/specs/YELP-*` or `Docs/architecture.md §YELP-*` on disk yet at authoring time — cases are anchored to the **LOCKED DESIGN** handed to this agent (reproduced below) and to the real code seams read from the worktree.

## LOCKED DESIGN (source of truth for these cases)
`yelpLeadService.maybeHandleYelpLead(companyId, msg)` → **detect → claim → parse → createLead → greet → send**, **never throws**. Hooked in `emailTimelineService.linkInboundMessage`; returns `{skipped:'yelp_lead'}` when handled.
- **detect** = `from_email` @`messaging.yelp.com` **AND** a first-message signal (`utm_source=request_a_quote_first_message` **OR** a "requested a quote … for a `<service>`" header line).
- **claim** = `yelp_lead_events` `UNIQUE(company_id, provider_message_id)` → `INSERT … ON CONFLICT DO NOTHING RETURNING` **before** greet/send.
- **lead** via `leadsService.createLead` (`JobSource='Yelp'`, `Status='Submitted'`, `Phone` null in 1a).
- **greeting** via `yelpGreetingService` (Gemini + static fallback); **send** via `emailService.sendEmail(to = reply_to relay address)`.
- env gate `YELP_AUTORESPONDER_ENABLED` (default **off**).

## Coverage
- Total test cases: **32**
- P0: **12** · P1: **15** · P2: **5** · P3: **0**
- **Jest, fully mocked (no DB/network): 26** · **Jest + real Postgres: 2** (`YLA-C-02/03`) · **Live/manual psql (migration up/down): 2** (`YLA-MIG-01/02`) · **Static/build check: 1** (`YLA-MIG-03`) · **Live deploy, manual: 1** (`YLA-LIVE-01`)
- **P0 must-pass gates:** the DETECTION truth table (`YLA-D-01..04`), the IDEMPOTENT-CLAIM DB gate (`YLA-C-02/03`), the HAPPY-PATH (`YLA-H-01`), and the two SABOTAGE controls (`YLA-N-01/02`) that must flip named checks **red**.

### Load-bearing findings from the code read (drive several cases)
- **Hook placement is the whole additivity story.** `linkInboundMessage` (`backend/src/services/email/emailTimelineService.js:91`) sends a **no-contact** inbound to the Mail Secretary at **lines 138–143** (`mailAgentService.reviewInboundEmail(companyId, msg, {noContact:true})`). A 1a Yelp lead has **no phone → no contact**, so it would hit that branch. The Yelp interception MUST run **before line 138** (ideally at the very top of the `try`, alongside the existing early guards) and `return {skipped:'yelp_lead'}` so no `reviewInboundEmail` / AR task / unread fires for it. `YLA-M-02` + sabotage `YLA-N-03` pin this.
- **The normalized message has NO relay field.** `NormalizedInboundMessage` (`backend/src/services/mail/MailProvider.js:25–43`) exposes `from_email, from_name, subject, body_text, snippet, to[], message_id_header, in_reply_to_header, references_header, internal_at, labelIds[], is_outbound, provider_message_id, provider_thread_id` — **no `reply_to`, no raw header map.** So the parser derives both the **reply relay** and the **thread_token** from `from_email` itself (the real Yelp From IS `reply+<hex>@messaging.yelp.com`). `YLA-P-04` targets this; see **COVERAGE GAP #1**.
- **`createLead` on create runs no FSM gate.** `leadsService.createLead` (`backend/src/services/leadsService.js:312`) inserts directly; the FSM transition check lives only in `updateLead` (l.388). So `Status:'Submitted'` is accepted with no published-FSM dependency. `Phone` is optional (only normalized `if (columns.phone)`), so **phone null is fine**. Fields are PascalCase→column mapped: `FirstName→first_name`, `JobSource→job_source`, `Status→status`, `Comments→comments`. Returns `{UUID, SerialId, ClientId, link}`. Default company `00000000-0000-0000-0000-000000000001`.
- **`emailService.sendEmail(companyId, {to, subject, body, cc?, files?, userId?, userEmail?})`** (`backend/src/services/emailService.js:68`) opens a fresh thread — correct for 1a: replying **to** the `reply+<hex>@messaging.yelp.com` relay is what threads it on Yelp's side (the token carries the thread), so a plain `sendEmail` (not `replyToThread`) is sufficient.
- **Test harness.** Jest files live in top-level `tests/*.test.js`; they `jest.mock('../backend/src/...')` and the DB seam is mocked as `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))` (see `tests/emailTimelineInbound.test.js`). **Worktree gotchas:** every `jest.mock` factory closure var must be named `mock*`; run one file at a time with the main-repo bin:
  `node /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js <testfile> --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit` (the explicit `--testPathIgnorePatterns` overrides package.json's `"/\\.claude/worktrees/"` ignore so a worktree file is not skipped).
- **Next-free migration = 161** (highest on disk **160** across the worktree + sibling worktrees at authoring time). **FLAG:** re-verify at build — parallel sessions add migrations (`YLA-MIG-03`).

### Canonical fixtures (referenced by ID below)
- **`Y-NEW`** (new lead → DETECTED): `from_email='reply+8160b36a1c2d3e4f@messaging.yelp.com'`, `from_name='Kim L.'`, `provider_message_id='ymsg-NEW-1'`, `labelIds=['INBOX']`, `is_outbound=false`; `body_text` contains `"Kim requested a quote … for a dishwasher repair"`, `"Maytag"`, `"mid cycle"`, ZIP `"02467"`, and a tracking link carrying `utm_source=request_a_quote_first_message`.
- **`Y-REPLY`** (customer follow-up → NOT): same `@messaging.yelp.com` relay From, `provider_message_id='ymsg-REPLY-1'`; body is `"… in response to your message"` with `utm_source=request_a_quote_new_message`; **no** "requested a quote…for a `<service>`" header.
- **`Y-CONFIRM`** (Yelp's confirmation to the business → NOT): `from_email='no-reply@notify.yelp.com'`, subject/body `"Good news! Your request was sent."`.
- **`NON-YELP`** (→ NOT): `from_email='jane@gmail.com'`, arbitrary body/subject.

---

## A. DETECTION truth table — `tests/yelpLeadService.detect.test.js` (unit, mocked)

Target: `yelpLeadService.detectYelpLead(msg)` (pure; no I/O).

### YLA-D-01: new-lead sample → DETECTED — **P0**
- **Priority:** P0 · **Type:** Unit (jest) · **Scenario:** detect
- **Inputs:** `Y-NEW`.
- **Expected:** `detectYelpLead(Y-NEW)` truthy (e.g. `{isYelpLead:true, reason:'first_message'}`). Both signals present (relay domain + `request_a_quote_first_message`).
- **File:** `tests/yelpLeadService.detect.test.js`

### YLA-D-02: customer-reply (`request_a_quote_new_message`) → NOT detected — **P0**
- **Priority:** P0 · **Type:** Unit (jest) · **Scenario:** detect (discriminator)
- **Inputs:** `Y-REPLY`.
- **Expected:** falsy. Same relay domain, but **no first-message signal** → the "new_message" utm and absence of the "requested a quote…for a `<service>`" header keep it out. **Named check for sabotage `YLA-N-01`: `DET-reply-not-detected`.**
- **File:** `tests/yelpLeadService.detect.test.js`

### YLA-D-03: confirmation `no-reply@notify.yelp.com` → NOT detected — **P0**
- **Priority:** P0 · **Type:** Unit (jest) · **Scenario:** detect (wrong sender)
- **Inputs:** `Y-CONFIRM`.
- **Expected:** falsy — `notify.yelp.com` ≠ `messaging.yelp.com`; the domain gate rejects it even though the word "request" appears. **Named check for sabotage `YLA-N-01`: `DET-confirm-not-detected`.**
- **File:** `tests/yelpLeadService.detect.test.js`

### YLA-D-04: non-Yelp email → NOT detected — **P0**
- **Priority:** P0 · **Type:** Unit (jest) · **Scenario:** detect (unrelated)
- **Inputs:** `NON-YELP`.
- **Expected:** falsy — fails the domain gate outright.
- **File:** `tests/yelpLeadService.detect.test.js`

### YLA-D-05: domain match is case-insensitive; display-name From still resolves — **P1**
- **Priority:** P1 · **Type:** Unit (jest) · **Scenario:** detect robustness
- **Inputs:** `Y-NEW` variant with `from_email='reply+abc123@Messaging.Yelp.Com'` (mixed case; note `from_email` holds the bare address, display name lives in `from_name`).
- **Expected:** DETECTED — matcher lower-cases the domain before comparing.
- **File:** `tests/yelpLeadService.detect.test.js`

### YLA-D-06: utm present but NON-Yelp domain → NOT (both conditions required) — **P1**
- **Priority:** P1 · **Type:** Unit (jest) · **Scenario:** detect (AND-gate)
- **Inputs:** `from_email='marketing@othersite.com'`, body carries `utm_source=request_a_quote_first_message`.
- **Expected:** falsy — the first-message signal alone must not trip detection without the `messaging.yelp.com` sender.
- **File:** `tests/yelpLeadService.detect.test.js`

### YLA-D-07: `messaging.yelp.com` but NO first-message signal → NOT — **P2**
- **Priority:** P2 · **Type:** Unit (jest) · **Scenario:** detect (AND-gate, other side)
- **Inputs:** relay From `reply+xyz@messaging.yelp.com`, body has neither `request_a_quote_first_message` nor a "requested a quote…for a `<service>`" line (e.g. a Yelp system notice).
- **Expected:** falsy — domain alone is insufficient.
- **File:** `tests/yelpLeadService.detect.test.js`

---

## B. PARSE — `tests/yelpLeadService.parse.test.js` (unit, mocked)

Target: `yelpLeadService.parseYelpLead(msg)` (pure). **Fail-safe contract:** always returns a parse object; unknown fields → `null`, never throws.

### YLA-P-01: full parse of the new-lead sample — **P0**
- **Priority:** P0 · **Type:** Unit (jest) · **Scenario:** parse (happy)
- **Inputs:** `Y-NEW`.
- **Expected:** returns `{ name:'Kim', service:'dishwasher repair', problem:<string>, zip:'02467', reply_to:'reply+8160b36a1c2d3e4f@messaging.yelp.com', thread_token:'8160b36a1c2d3e4f' }`; `problem` **contains** `'Maytag'` **and** `'mid cycle'` (assert substring, not exact). `name` derives from the body header line (`"Kim requested a quote…"`), not the last-initialed `from_name`.
- **File:** `tests/yelpLeadService.parse.test.js`

### YLA-P-02: fail-safe — missing ZIP → `zip:null`, still returns — **P0**
- **Priority:** P0 · **Type:** Unit (jest) · **Scenario:** parse (fail-safe)
- **Inputs:** `Y-NEW` with the ZIP removed from the body.
- **Expected:** `zip === null`; `name`/`service`/`reply_to`/`thread_token` still populated; **no throw**; object returned.
- **File:** `tests/yelpLeadService.parse.test.js`

### YLA-P-03: fail-safe — missing problem detail → `problem:null`, still returns — **P1**
- **Priority:** P1 · **Type:** Unit (jest) · **Scenario:** parse (fail-safe)
- **Inputs:** `Y-NEW` stripped to just the "requested a quote…for a dishwasher repair" header, no free-text detail.
- **Expected:** `problem === null`; `service==='dishwasher repair'`; returns; no throw.
- **File:** `tests/yelpLeadService.parse.test.js`

### YLA-P-04: `reply_to` + `thread_token` extracted from the `reply+<hex>@messaging.yelp.com` local-part — **P1**
- **Priority:** P1 · **Type:** Unit (jest) · **Scenario:** parse (relay derivation) · see **GAP #1**
- **Inputs:** `from_email='reply+8160b36a1c2d3e4f@messaging.yelp.com'`.
- **Expected:** `reply_to === 'reply+8160b36a1c2d3e4f@messaging.yelp.com'` (the full relay address, verbatim, used as the send target); `thread_token === '8160b36a1c2d3e4f'` (only the hex between `reply+` and `@`).
- **File:** `tests/yelpLeadService.parse.test.js`

### YLA-P-05: mangled From (no `reply+` token) → `reply_to:null`, `thread_token:null`, still returns — **P1**
- **Priority:** P1 · **Type:** Unit (jest) · **Scenario:** parse (fail-safe; feeds `YLA-S-04`)
- **Inputs:** `from_email='noreply@messaging.yelp.com'` (no `reply+<hex>`).
- **Expected:** `reply_to === null`, `thread_token === null`; other fields best-effort; no throw. (Downstream `YLA-S-04` asserts a null relay → **no** `sendEmail`.)
- **File:** `tests/yelpLeadService.parse.test.js`

---

## C. IDEMPOTENT CLAIM — `tests/yelpLeadService.claim.test.js` (unit) + `tests/yelpLeadClaim.db.test.js` (real DB)

### YLA-C-01: claim SQL is `ON CONFLICT DO NOTHING RETURNING`; first wins, second no-ops — **P0**
- **Priority:** P0 · **Type:** Unit (jest, `db.query` stubbed) · **Scenario:** claim
- **Mocks:** `jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }))`. First call → `{rows:[{id:1}]}`; second → `{rows:[]}`.
- **Steps:** call `claimYelpLead(companyId, 'ymsg-NEW-1')` twice.
- **Expected:** (1) the SQL text passed to `db.query` **matches** `/insert into yelp_lead_events/i` **and** `/on conflict\s*\(\s*company_id\s*,\s*provider_message_id\s*\)\s*do nothing/i` **and** `/returning/i`; (2) params `=== [companyId, 'ymsg-NEW-1']`; (3) first call returns claimed=`true` (row present), second returns claimed=`false` (empty `rows`).
- **File:** `tests/yelpLeadService.claim.test.js`

### YLA-C-02: real Postgres — two inserts of one `(company, pmid)` → exactly ONE row — **P0**
- **Priority:** P0 · **Type:** Integration (jest + **real Postgres**) · **Scenario:** claim (DB constraint)
- **Preconditions:** migration applied to a test DB; `yelp_lead_events` present with `UNIQUE(company_id, provider_message_id)`.
- **Steps:** run the claim query twice with the same `(companyId,'ymsg-DUP')`.
- **Expected:** 1st `RETURNING` yields a row, 2nd yields **zero rows**; `SELECT count(*) … WHERE company_id=$1 AND provider_message_id='ymsg-DUP'` = **1**. Proves the constraint (not app logic) enforces single-claim.
- **File:** `tests/yelpLeadClaim.db.test.js`

### YLA-C-03: poll re-scan re-fires `maybeHandleYelpLead` on the same pmid → exactly ONE greeting + ONE lead — **P0**
- **Priority:** P0 · **Type:** Integration (jest + **real Postgres**, collaborators stubbed) · **Scenario:** end-to-end idempotency
- **Mocks:** real `db` for the claim; `leadsService.createLead` + `emailService.sendEmail` + `yelpGreetingService` as jest spies. Env gate **on**.
- **Steps:** call `maybeHandleYelpLead(companyId, Y-NEW)` **twice** (simulating push then a poll re-scan of the same message).
- **Expected:** `createLead` called **once**, `sendEmail` called **once**; the second invocation short-circuits at the lost claim (returns handled/no-op without re-greeting). **Named check for sabotage `YLA-N-02`: `CLAIM-single-greet-on-reingest`.**
- **File:** `tests/yelpLeadClaim.db.test.js`

### YLA-C-04: claim runs BEFORE createLead/greet/send; a lost claim makes ZERO of them — **P1**
- **Priority:** P1 · **Type:** Unit (jest, mocked) · **Scenario:** ordering
- **Mocks:** `claimYelpLead` (or `db.query`) → **lost** (`rows:[]`); `leadsService.createLead`, `yelpGreetingService.buildGreeting`, `emailService.sendEmail` as spies.
- **Expected:** on a lost claim, `createLead`, `buildGreeting`, and `sendEmail` are each `.not.toHaveBeenCalled()`; and on the winning path, the claim `db.query` is invoked **before** the first `createLead` call (assert via `mock.invocationCallOrder`). Locks the LOCKED "claim before greet/send" ordering.
- **File:** `tests/yelpLeadService.claim.test.js`

---

## D. HAPPY PATH — `tests/yelpLeadHappyPath.test.js` (integration, jest, collaborators stubbed)

### YLA-H-01: new-lead → ONE lead (JobSource='Yelp') + ONE greeting to the relay; hook returns `{skipped:'yelp_lead'}` — **P0**
- **Priority:** P0 · **Type:** Integration (jest, mocked) · **Scenario:** full pipeline
- **Mocks:** env gate **on**; `claimYelpLead` → won; `leadsService.createLead` → `{UUID:'lead-uuid', SerialId:1001, ClientId:'55'}`; `yelpGreetingService.buildGreeting` → `'Hi Kim, thanks for reaching out about your dishwasher…'`; `emailService.sendEmail` → `{message_id_header:'<x>'}`.
- **Steps:** `const r = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, Y-NEW)`.
- **Expected:**
  - `createLead` called **once**; its `fields` arg has `JobSource:'Yelp'`, `Status:'Submitted'`, `FirstName:'Kim'`, **no** truthy `Phone` (null/absent), and `Comments` containing the parsed service/problem (`'dishwasher repair'`, `'Maytag'`); 2nd arg `=== DEFAULT_COMPANY_ID`.
  - `sendEmail` called **once**; `to === 'reply+8160b36a1c2d3e4f@messaging.yelp.com'`; `body` === the greeting; `subject` non-empty; `companyId === DEFAULT_COMPANY_ID`.
  - `maybeHandleYelpLead` resolves to a handled signal; when driven through the hook (`YLA-M-02`), `linkInboundMessage` returns `{skipped:'yelp_lead'}`.
- **File:** `tests/yelpLeadHappyPath.test.js`

### YLA-H-02: parsed detail reaches the lead body and the greeting target — **P1**
- **Priority:** P1 · **Type:** Integration (jest, mocked) · **Scenario:** field wiring
- **Mocks:** as `YLA-H-01`, capturing `createLead` fields and `sendEmail` args.
- **Expected:** `Comments`/service fields reflect `zip:'02467'` and the problem text; the greeting `buildGreeting` was called with the **parsed** `{name:'Kim', service:'dishwasher repair', …}` (LLM sees parsed context, not the raw email); `sendEmail.to` equals the parsed `reply_to`.
- **File:** `tests/yelpLeadHappyPath.test.js`

---

## E. SAFE-FAIL — `tests/yelpLeadSafeFail.test.js` (unit/integration, jest, mocked)

### YLA-S-01: Gemini throws → STATIC greeting still sent + lead still created — **P1**
- **Priority:** P1 · **Type:** Unit (greeting) + Integration (send) · **Scenario:** LLM outage
- **Mocks:** the Gemini client inside `yelpGreetingService` → rejects/throws; `createLead`, `sendEmail` spies; gate on.
- **Expected:** (a) unit: `yelpGreetingService.buildGreeting({name:'Kim',service:'dishwasher repair'})` **resolves** to a non-empty **static** string that includes `'Kim'` and references the service — it does **not** propagate the Gemini error; (b) integration: `createLead` called once, `sendEmail` called once with that static body. LLM failure never blocks the greeting or the lead.
- **File:** `tests/yelpLeadSafeFail.test.js`

### YLA-S-02: greeting builder throws entirely → never-throws, lead still created — **P1**
- **Priority:** P1 · **Type:** Integration (jest, mocked) · **Scenario:** defense-in-depth
- **Mocks:** `yelpGreetingService.buildGreeting` → throws (both Gemini AND static path fail); `createLead` spy; gate on.
- **Expected:** `maybeHandleYelpLead` does **not** throw; error is logged; `createLead` still called once (lead preserved so a dispatcher sees it). `sendEmail` behavior is impl-defined (skip vs static-of-last-resort) but must not throw — assert **no rejection** + lead created.
- **File:** `tests/yelpLeadSafeFail.test.js`

### YLA-S-03: `createLead` throws → logged, ingest not crashed — **P1**
- **Priority:** P1 · **Type:** Integration (jest, mocked) · **Scenario:** DB write failure · see **GAP #2**
- **Mocks:** `leadsService.createLead` → rejects `new Error('DB down')`; claim won; gate on.
- **Expected:** `maybeHandleYelpLead` resolves (never throws); the error is `console.error`-logged; the outer `linkInboundMessage` does **not** throw and does **not** silently fall through to the Mail Secretary mid-way (it is already committed to the Yelp branch). **GAP #2 (must be pinned by impl):** the claim was taken **before** `createLead`, so a poll retry is a no-op → assert the documented recovery behavior once decided.
- **File:** `tests/yelpLeadSafeFail.test.js`

### YLA-S-04: absent/mangled relay From → BAIL, NO `sendEmail` — **P1**
- **Priority:** P1 · **Type:** Integration (jest, mocked) · **Scenario:** unsendable
- **Mocks:** message parses to `reply_to:null` (per `YLA-P-05`); `sendEmail` spy; gate on.
- **Expected:** `sendEmail` `.not.toHaveBeenCalled()` (nowhere to send). Lead creation is impl-defined (may still create for the dispatcher) — the **load-bearing** assertion is **no send** to a null/garbage address; never throws.
- **File:** `tests/yelpLeadSafeFail.test.js`

### YLA-S-05: env gate OFF → `maybeHandleYelpLead` is a no-op; email flows to the NORMAL pipeline — **P1**
- **Priority:** P1 · **Type:** Integration (jest, mocked) · **Scenario:** gate
- **Mocks:** `YELP_AUTORESPONDER_ENABLED` unset/`'false'`; `detectYelpLead`, `createLead`, `sendEmail` spies.
- **Expected:** `maybeHandleYelpLead` returns a not-handled signal **without** running detect/claim/parse/create/send (all spies `.not.toHaveBeenCalled()`); when driven through the hook, `linkInboundMessage` proceeds unchanged (for a no-contact Yelp email it reaches the Mail Secretary branch — gate off must **not** swallow the email).
- **File:** `tests/yelpLeadSafeFail.test.js`

---

## F. MAIL-SECRETARY ADDITIVITY — `tests/yelpLeadHook.test.js` (integration over `linkInboundMessage`, jest, mocked)

Strategy mirrors `tests/emailTimelineInbound.test.js`: mock `emailQueries`, `timelinesQueries`, `queries`, `connection`, `realtimeService`, `providerRegistry`, `mailAgentService`, and the new `yelpLeadService`.

### YLA-M-01: non-Yelp no-contact inbound still reaches the Mail Secretary (unchanged) — **P1**
- **Priority:** P1 · **Type:** Integration (jest, mocked) · **Scenario:** additivity (control)
- **Mocks:** `yelpLeadService.maybeHandleYelpLead` → not-handled; `emailQueries.findEmailContact` → `null`; `mailAgentService.reviewInboundEmail` spy; `mailAgentService.isSenderMuted` → false.
- **Inputs:** `linkInboundMessage(companyId, NON-YELP)`.
- **Expected:** returns `{skipped:'no_contact'}`; `mailAgentService.reviewInboundEmail` called **once** with `(companyId, msg, {noContact:true})` — the pre-existing behavior is intact.
- **File:** `tests/yelpLeadHook.test.js`

### YLA-M-02: detected Yelp lead → `{skipped:'yelp_lead'}`; NO reviewInboundEmail / task / unread — **P0**
- **Priority:** P0 · **Type:** Integration (jest, mocked) · **Scenario:** additivity (intercept)
- **Mocks:** `yelpLeadService.maybeHandleYelpLead` → handled (`{skipped:'yelp_lead'}`); `mailAgentService.reviewInboundEmail`, `timelinesQueries.createTask`, `queries.markContactUnread` spies.
- **Inputs:** `linkInboundMessage(companyId, Y-NEW)`.
- **Expected:** returns `{skipped:'yelp_lead'}`; `reviewInboundEmail`, `createTask`, `markContactUnread`, and `realtimeService.publishMessageAdded` are each `.not.toHaveBeenCalled()`. The Yelp lead does not generate a `mail_agent_review` or an AR task. **Named check for sabotage `YLA-N-03`: `HOOK-yelp-not-reviewed`.**
- **File:** `tests/yelpLeadHook.test.js`

---

## G. NEGATIVE CONTROL / SABOTAGE — `tests/…` (jest; mutate source, assert a named check flips RED)

Each case is a *procedure*: apply the mutation, run the referenced case(s), confirm the named check **fails**, then revert. Guards against a test that is green for the wrong reason.

### YLA-N-01: drop the `messaging.yelp.com` sender gate (accept any sender) → confirmation & reply wrongly greeted — **P0**
- **Priority:** P0 · **Type:** Sabotage (jest) · **Guards:** `YLA-D-02` (`DET-reply-not-detected`), `YLA-D-03` (`DET-confirm-not-detected`)
- **Mutation:** in `detectYelpLead`, make the domain check always-true (rely only on the first-message-ish signal, or remove the AND).
- **Expected:** `YLA-D-03` and/or `YLA-D-02` turn **RED** (`Y-CONFIRM`/`Y-REPLY` now detected). If they stay green, the detection tests are not actually pinning the sender gate — fix the tests.
- **File:** `tests/yelpLeadService.detect.test.js` (run after mutation)

### YLA-N-02: remove the claim (read-then-write / always proceed) → double-greet on re-ingest — **P0**
- **Priority:** P0 · **Type:** Sabotage (jest + real DB) · **Guards:** `YLA-C-03` (`CLAIM-single-greet-on-reingest`)
- **Mutation:** replace the `INSERT … ON CONFLICT DO NOTHING RETURNING` claim with an unconditional "proceed" (or a `SELECT`-then-`INSERT` with a gap).
- **Expected:** `YLA-C-03` turns **RED** — `sendEmail`/`createLead` fire **twice** on the second ingest. If it stays green, the idempotency test isn't exercising re-ingest.
- **File:** `tests/yelpLeadClaim.db.test.js` (run after mutation)

### YLA-N-03: move the Yelp hook AFTER the no-contact Mail-Secretary branch → Yelp lead gets reviewed — **P1**
- **Priority:** P1 · **Type:** Sabotage (jest) · **Guards:** `YLA-M-02` (`HOOK-yelp-not-reviewed`)
- **Mutation:** relocate the `maybeHandleYelpLead` interception below line ~143 of `linkInboundMessage` (after `reviewInboundEmail({noContact:true})`).
- **Expected:** `YLA-M-02` turns **RED** — `reviewInboundEmail` is now called for `Y-NEW`. Pins the "intercept before the mail-agent branch" placement.
- **File:** `tests/yelpLeadHook.test.js` (run after mutation)

---

## H. MIGRATION — `yelp_lead_events`

### YLA-MIG-01: up creates `yelp_lead_events` with `UNIQUE(company_id, provider_message_id)` — **P2**
- **Priority:** P2 · **Type:** Live/manual psql (or CI with a test DB) · **Scenario:** schema
- **Steps:** apply the migration; inspect the table.
- **Expected:** table exists with at least `id`, `company_id (uuid/not-null)`, `provider_message_id (text/not-null)`, `created_at (timestamptz default now())`; a UNIQUE constraint/index on `(company_id, provider_message_id)`. Verify: `\d yelp_lead_events` shows the unique index; a duplicate `INSERT` raises `23505` (or is absorbed by `ON CONFLICT`).
- **File:** `backend/db/migrations/161_yelp_lead_events.sql` (number **presumptive** — see `YLA-MIG-03`)

### YLA-MIG-02: rollback drops the table — **P2**
- **Priority:** P2 · **Type:** Live/manual psql · **Scenario:** rollback
- **Expected:** the down/rollback path removes `yelp_lead_events` cleanly (`DROP TABLE IF EXISTS yelp_lead_events`); re-applying up succeeds (idempotent guards).
- **File:** `backend/db/migrations/161_yelp_lead_events.sql`

### YLA-MIG-03: migration number is the next FREE one at build time — **P2**
- **Priority:** P2 · **Type:** Static/build check · **Scenario:** parallel-session hygiene
- **Steps:** `ls backend/db/migrations` here **and** across sibling `.claude/worktrees/*/backend/db/migrations`; take max+1.
- **Expected:** the new file's numeric prefix `= max(existing)+1`. **Authoring-time max = 160 → presumptive 161.** **FLAG:** parallel sessions add migrations — re-verify immediately before creating the file; if 161 is taken, renumber (cf. the "parallel dialogs share tree" gotcha).
- **File:** n/a (verification step)

---

## I. LIVE (deploy) — manual, prod

### YLA-LIVE-01: fresh not-yet-replied Yelp test lead → greeted + lead created; customer receives it — **P2**
- **Priority:** P2 · **Type:** Live/manual (prod) · **Scenario:** end-to-end on real Yelp+Gmail+Gemini
- **Preconditions:** feature deployed; `YELP_AUTORESPONDER_ENABLED=true` in prod; **owner's explicit "да" per deploy** (deploy-consent). Use a **Yelp test account / owner-controlled second account** — do **NOT** trigger against a real prospective customer.
- **Steps:** owner generates a genuinely new (not-yet-replied) Yelp quote request to the business mailbox → wait one push/poll cycle.
- **Expected:** within the cycle, exactly **one** lead appears (`JobSource='Yelp'`, `Status='Submitted'`, name/service/zip parsed) **and** exactly **one** greeting is delivered to the Yelp relay; the test account **receives** the greeting (manual confirm). No duplicate on the next poll (claim holds). No `mail_agent_review`/AR task for the Yelp thread. Measure by DB ingest, not by inbox feel (cf. gmail-push lesson).
- **File:** n/a (manual runbook)

---

## Coverage gaps & flags (for Planner / Implementer)
1. **Relay source (GAP #1 — highest).** `NormalizedInboundMessage` carries **no `reply_to` / raw-header map** (`MailProvider.js:25–43`). These cases assume the parser derives the relay + token from `from_email` (the real Yelp From *is* `reply+<hex>@messaging.yelp.com`). If Yelp ever sends a **display-alias From** with the true relay only in a `Reply-To:` header, detection/reply-target will miss it. **Action:** confirm the live sample's `from_email`; if a Reply-To is needed, `GmailProvider` must surface it (add `reply_to` to the normalized shape) and `YLA-P-04`/`YLA-D-01` fixtures update accordingly.
2. **Claim-before-createLead failure window (GAP #2).** LOCKED order claims **before** `createLead`; on a `createLead` failure the claim is already consumed, so a poll retry is a no-op → the lead is lost (and, if the hook still returns `{skipped:'yelp_lead'}`, it's also absent from the Mail Secretary). `YLA-S-03` asserts *never-throws* but **cannot** assert recovery until the design decides: (a) claim only **after** a successful `createLead`, or (b) record the failure so a retry re-attempts, or (c) accept best-effort loss. **Must be pinned by the Implementer**; add the concrete assertion then.
3. **No migration-runner jest harness** in the repo → `YLA-MIG-01/02` are live/CI-DB psql checks, not pure jest. The claim's `ON CONFLICT` *shape* is unit-tested (`YLA-C-01`); the *constraint* that makes it real is only proven on a DB (`YLA-C-02`).
4. **Duplicate-lead risk beyond exact re-delivery (out of 1a scope).** The `provider_message_id` claim dedups an identical message re-ingest, but **not** two *distinct* Yelp emails for the same customer (Yelp resend / a first-message + immediate follow-up), because 1a has **no phone** to dedup contacts/leads on. Flag for Phase 1b.
5. **Cross-tenant isolation of `yelp_lead_events`** is only implicit (company_id is in the unique key). 1a is single-mailbox/default-company; add an explicit "company A's pmid ≠ company B's pmid" claim test when multiple Yelp mailboxes onboard (Phase 1b).
