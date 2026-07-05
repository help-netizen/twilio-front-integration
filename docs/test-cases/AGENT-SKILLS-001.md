# Test Cases: AGENT-SKILLS-001 — Provider-neutral CRM skill layer + existing-customer voice skills + service-CRM MCP surface

**Spec:** `Docs/specs/AGENT-SKILLS-001.md` (source of truth) · **Requirements:** `Docs/requirements.md → ## AGENT-SKILLS-001` (AR-1…AR-6, FR-S1…FR-S9, AC-1…AC-13) · **Architecture:** `Docs/architecture.md → ## AGENT-SKILLS-001`
**Date:** 2026-07-04 · **Author:** Test-Cases Agent (04)

> **Reading note for the Planner/Implementer/Tester.** IDs are grouped by surface: `ASK-VAPI-*` (VAPI adapter back-compat + envelope), `ASK-GATE-*` (verification gate), `ASK-ISO-*` (company isolation, P0), `ASK-SKILL-*` (per-skill behavior), `ASK-WRITE-*` (reschedule/cancel + ZB write-through + audit), `ASK-STATUS-*` (status_map), `ASK-DEG-*` (graceful degradation), `ASK-MCP-*` (MCP transport), `ASK-INT-*` (real-DB integration harness). Every case names its **type** (unit / integration / e2e), **priority**, **the exact assertion**, and **traceability** (AR/FR/AC/§/edge-case). Cases flagged **[REAL-DB]** must be provable against a real Postgres (+ a ZB stub) in `scripts/verify-agent-skills-001.js` — a mocked jest only proves the string/dispatch shape (LIST-PAGINATION-001 / created_by-FK lessons); the load-bearing P0 gates (verification, isolation, ZB write-through, byte-compat) get a real-DB proof **with a sabotage control**.

---

## Coverage

- **Total test cases:** 129
- **By priority:** P0: 60 · P1: 52 · P2: 16 · P3: 1
- **By type:** Unit: 70 · Integration: 57 · E2E: 2
- **Real-DB integration [REAL-DB]:** 21 (in `scripts/verify-agent-skills-001.js`, house `verify-*.js` pattern)

> P0 is deliberately the largest bucket: this feature is a privacy/isolation surface (server-side verification + company isolation + no-card-by-voice) fronting a swappable voice agent, so most of its load-bearing behavior is release-gating. The 21 [REAL-DB] cases are the subset of P0/P1 gates that a mocked jest cannot prove (verification re-derivation, cross-company blocks, ZB write-through, 5-tool byte-compat) and each carries a sabotage control.

### The P0 gate list (a red here BLOCKS release)

| Gate | Cases | Why it blocks |
|---|---|---|
| **G1 — Verification gate (stateless, DB-derived; `verified:true` ignored)** | ASK-GATE-01…12, ASK-INT-06…09 | An L1/masked caller reaching an L2 skill = data breach. LLM-asserted level must never upgrade. |
| **G2 — Company isolation (cross-company never read/mutated)** | ASK-ISO-01…08, ASK-INT-10…13 | `cancelJob(jobId)`/reschedule take only `jobId`; a missing ownership pre-check = cross-tenant cancel/disclosure. |
| **G3 — Back-compat of the 5 relocated live tools (byte-identical)** | ASK-VAPI-01…20, ASK-INT-14…17 | The refactor must not change one byte of `checkServiceArea/validateAddress/checkAvailability/recommendSlots/createLead` output. |
| **G4 — Reschedule ZB write-through + blocking-with-recovery** | ASK-WRITE-01…08, ASK-INT-18…20 | Reschedule must write Albusto AND push ZB; on ZB failure never silently diverge. |
| **G5 — Cancel retention discipline** | ASK-WRITE-10…16, ASK-INT-21 | Never cancel on first ask; exactly one save attempt; reason required + on the note. |
| **G6 — Graceful degradation (SAFE_FALLBACK, no `err.message` leak)** | ASK-DEG-01…07, ASK-MCP-14 | The old `{error: err.message}` leak (vapi-tools.js:381) must be gone; no 500 crashes the call. |

---

## Group A — VAPI adapter: back-compat of the 5 relocated live tools + envelope (G3, AR-2, AC-11)

> **Harness:** extend the existing `tests/routes/vapi-tools.test.js` (supertest against the router mounted with NO auth middleware). The regression bar (AC-11 / spec §7.3): for identical inputs each tool returns a **byte-identical** `result` JSON before and after the refactor. Keep every existing `TC-LQV2-*` green; these `ASK-VAPI-*` cases are the delta that proves the relocation onto the skill layer is behavior-preserving.

### ASK-VAPI-01: checkServiceArea in-area → byte-identical result post-refactor
- **Priority:** P0 · **Type:** Integration · **Traces:** AC-11, AR-2, spec §7.3 (`checkServiceArea`)
- **Preconditions:** `VAPI_TOOLS_SECRET` set; `stQueries.search` mocked.
- **Input:** `toolCall('checkServiceArea', { zip: '02101' })`; `stQueries.search` → `{ zip:'02101', area:'Boston', city:'Boston', state:'MA' }`.
- **Assertion:** `resultOf(res)` **deep-equals** `{ inServiceArea:true, area:'Boston', city:'Boston', state:'MA', zip:'02101' }` — identical to the pre-refactor handler (existing TC-LQV2-008). No extra keys (`ok`/`speak` etc. must NOT appear for a relocated L0 tool — its shape is frozen).

### ASK-VAPI-02: checkServiceArea out-of-area → `{ inServiceArea:false, zip }`
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11, spec §7.3
- **Input:** `{ zip:'03801' }`; `stQueries.search` → `null`.
- **Assertion:** deep-equals `{ inServiceArea:false, zip:'03801' }`.

### ASK-VAPI-03: checkServiceArea missing zip → error branch, no DB call
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11, spec §7.3
- **Input:** `{}`.
- **Assertion:** deep-equals `{ inServiceArea:false, error:'zip is required' }`; `stQueries.search` **not** called.

### ASK-VAPI-04: validateAddress valid → standardized + correctedZip + lat/lng (Geocoding relocated verbatim)
- **Priority:** P0 · **Type:** Integration · **Traces:** AC-11, spec §7.3 (`validateAddress`: the `https`/Geocoding code moves into `skills/validateAddress.js`)
- **Preconditions:** `GOOGLE_GEOCODING_KEY` set; `https.get` mocked (`mockGeocode`).
- **Input:** `{ street:'45 Tremont St', apt:'3', city:'Boston', state:'MA', zip:'02108' }`; geocode payload = the OK fixture from TC-LQV2-012.
- **Assertion:** deep-equals `{ valid:true, standardized:'45 Tremont St Apt 3, Boston, MA 02108', correctedZip:'02108', lat:42.357, lng:-71.059 }`.

### ASK-VAPI-05: validateAddress ZERO_RESULTS → `{ valid:false }`
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11
- **Assertion:** geocode `{ status:'ZERO_RESULTS', results:[] }` → deep-equals `{ valid:false }`.

### ASK-VAPI-06: validateAddress network error → `{ valid:false }`, never throws, HTTP 200
- **Priority:** P0 · **Type:** Integration · **Traces:** AC-11, AC-12
- **Assertion:** `mockGeocodeError('Network timeout')` → HTTP 200, `resultOf` = `{ valid:false }`. Proves the relocated https-error path stays "never block the call".

### ASK-VAPI-07: validateAddress missing geocoding key → `{ valid:false }`, https.get NOT called
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11, spec §7.3
- **Assertion:** with both `GOOGLE_GEOCODING_KEY` and `VITE_GOOGLE_MAPS_API_KEY` unset → `valid:false` and `https.get` not called.

### ASK-VAPI-08: validateAddress key fallback (VITE_GOOGLE_MAPS_API_KEY) preserved
- **Priority:** P2 · **Type:** Integration · **Traces:** AC-11, spec §7.3
- **Assertion:** `GOOGLE_GEOCODING_KEY` unset, `VITE_GOOGLE_MAPS_API_KEY='fallback-key'` → `https.get` IS called (fallback key used).

### ASK-VAPI-09: checkAvailability success → delegates to scheduleService, returns slots verbatim
- **Priority:** P0 · **Type:** Integration · **Traces:** AC-11, spec §7.3 (`checkAvailability` fallback path unchanged)
- **Input:** `{ zip:'02101', unitType:'Refrigerator' }`; `scheduleService.getAvailableSlots` → `{ slots:[…] }`.
- **Assertion:** `resultOf` deep-equals `{ slots }`; `getAvailableSlots` called with `(DEFAULT_COMPANY_ID, objectContaining({ days:5, slotDurationMin:120, maxSlots:3 }))` — same args the pre-refactor handler passed.

### ASK-VAPI-10: checkAvailability no-slots → `{ slots:[], error }` passthrough
- **Priority:** P2 · **Type:** Integration · **Traces:** AC-11
- **Assertion:** `{ slots:[], error:'No availability found in the next 5 days' }` returned unchanged.

### ASK-VAPI-11: checkAvailability throws → `{ slots:[], error }`, HTTP 200 (graceful, unchanged)
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11, AC-12
- **Assertion:** `getAvailableSlots` rejects → HTTP 200 and `{ slots:[], error:'schedule unreachable' }`. **Note the semantic:** post-refactor the skill-layer SAFE_FALLBACK must NOT replace this legacy shape for the L0 tool (byte-compat wins over the generic fallback for the 5 relocated tools). This is the explicit tension case — assert the LEGACY shape, not `{ok:false,speak:…}`.

### ASK-VAPI-12: recommendSlots app-not-connected → `{ available:false, slots:[], fallback:true }`, engine NEVER called
- **Priority:** P0 · **Type:** Integration · **Traces:** AC-11, spec §7.3 (`recommendSlots` `smart-slot-engine` gate)
- **Assertion:** `isAppConnected` → false → deep-equals `{ available:false, slots:[], fallback:true }`; `slotEngineService.getRecommendations` not called.

### ASK-VAPI-13: recommendSlots happy path → keyed slot with label + techName + confidence
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11
- **Assertion:** one rec → `slots[0]` deep-equals `{ key:'2026-07-08|10:00|13:00', date, start, end, label:'Wed Jul 8, 10:00–13:00', techName:'Alex', confidence:'high' }` (identical to existing recommendSlots suite).

### ASK-VAPI-14: recommendSlots safe-fail (engine throws) → fallback, HTTP 200
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11, AC-12
- **Assertion:** `getRecommendations` rejects → `{ available:false, slots:[], fallback:true }`, HTTP 200.

### ASK-VAPI-15: createLead success → JobSource 'AI Phone', full Comments, companyId a string
- **Priority:** P0 · **Type:** Integration · **Traces:** AC-11, spec §7.3 (`createLead` unchanged)
- **Input:** `fullArgs` (TC-LQV2-022).
- **Assertion:** `resultOf` = `{ success:true, leadId:'lead-uuid-001' }`; `createLead` body `.JobSource==='AI Phone'`, `.JobType==='Refrigerator Repair'`, `.Comments===` the exact pipe string from TC-LQV2-022; `companyId` argument is a string (= `DEFAULT_COMPANY_ID`).

### ASK-VAPI-16: createLead phone missing → `{ success:false, error }`, createLead NOT called
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11
- **Assertion:** deep-equals `{ success:false, error:'Phone number is required to create lead' }`; `createLead` not called.

### ASK-VAPI-17: createLead retry-once semantics preserved (fails twice → success:false, called 2×)
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11
- **Assertion:** `createLead` rejects always → `resultOf.success===false`, `createLead` called exactly 2×, HTTP 200. Also the mirror: first-fail-then-succeed → `{ success:true, leadId }`, called 2×.

### ASK-VAPI-18: createLead chosenSlot slot-persist preserved (LeadDateTime/… columns) + tzCombine
- **Priority:** P1 · **Type:** Integration · **Traces:** AC-11, spec §7.3
- **Assertion:** with `chosenSlot`+coords → body has `LeadDateTime/LeadEndDateTime/Latitude/Longitude` (tzCombine called for start+end); with NO chosenSlot → none of the four keys, `tzCombine` never called (byte-identical to today).

### ASK-VAPI-19: envelope shape unchanged — `{ results:[{ toolCallId, result:JSON.stringify(...) }] }`
- **Priority:** P0 · **Type:** Integration · **Traces:** AR-2, spec §7.1, AC-11
- **Input:** any tool call with id `'tcX'`.
- **Assertion:** `res.body.results` length 1; `results[0].toolCallId==='tcX'`; `typeof results[0].result === 'string'`; `JSON.parse(result)` is the skill output. Non-`tool-calls` message → `res.json({})`. Bad-JSON `arguments` → parsed as `{}` (checkServiceArea → `{ inServiceArea:false, error:'zip is required' }`).

### ASK-VAPI-20: multi-tool `toolCallList` still processed in order, all results returned
- **Priority:** P1 · **Type:** Integration · **Traces:** AR-2, spec §7.1
- **Input:** two `checkServiceArea` calls (`tc1` in-area, `tc2` out-of-area).
- **Assertion:** `results` length 2, ids `['tc1','tc2']`, `[0].inServiceArea===true`, `[1].inServiceArea===false`.

### ASK-VAPI-21: adapter contains NO CRM logic after refactor (source-level guard)
- **Priority:** P1 · **Type:** Unit (source scan) · **Traces:** AC-11, AR-2
- **Assertion:** read `backend/src/routes/vapi-tools.js` as text; assert it does **not** `require('../db/...Queries')` for CRM composition, does **not** contain `verificationGate`/L2 logic, and each dispatch body matches `agentSkills.runSkill(` (table-driven). The `https`/Geocoding literal must have moved out (assert `vapi-tools.js` no longer references `maps.googleapis.com`; that string now lives in `skills/validateAddress.js`). Mirrors the existing "server.js mounts without auth" source-scan idiom (TC-LQV2-033).

### ASK-VAPI-22: adapter catch is a thin backstop — never surfaces `err.message` (fixes vapi-tools.js:381 leak)
- **Priority:** P0 · **Type:** Integration · **Traces:** AC-12, spec §6 (fix the existing leak), G6
- **Preconditions:** force `agentSkills.runSkill` to throw a raw `Error('sensitive: SELECT * FROM secrets')` (mock the skill-layer façade).
- **Assertion:** HTTP 200; `resultOf` = SAFE_FALLBACK `{ ok:false, speak:'Let me have a teammate follow up with you on that.' }` (or at minimum contains NO `error` key echoing `err.message`, NO `sensitive:`/`SELECT` substring). The `catch (e) { result = { error: e.message } }` shape from line 381 must be gone.

---

## Group B — Verification gate (G1, AR-6, D4, §2, AC-8)

> **Harness:** new `tests/agentSkillsVerificationGate.test.js` — unit tests of `verificationGate.deriveLevel(companyId, identityBlock)` and `verificationGate.assert(requiredLevel, verifiedContext)` with `identityResolver`/services mocked; plus `tests/agentSkillsRunSkill.test.js` exercising the `index.runSkill` choke-point. The gate must **re-derive from the DB every call** and **ignore** any client-asserted level. Non-vacuous rule: for every "rejected" case, assert the gated service function was **NOT** called (no read/write happened).

### ASK-GATE-01: no match → L0; only identifyCaller proceeds
- **Priority:** P0 · **Type:** Unit · **Traces:** AR-6, §2.2, §2.4, edge E11
- **Preconditions:** resolver finds no lead/contact/job for the phone.
- **Assertion:** `deriveLevel(company, { phone:'+1…nomatch' })` → `{ level:'L0', … }`. `runSkill('getJobStatus', …)` (requires L1) → soft `needsVerification` shape (§6), and `jobsService.getJobById`/`listJobs` **not** called. `runSkill('identifyCaller', …)` proceeds and returns `matchType:'new'`.

### ASK-GATE-02: real single phone match → L1 (DB-derived, not caller's word)
- **Priority:** P0 · **Type:** Unit · **Traces:** AR-6, §2.2 (L1 row), FR-S1
- **Preconditions:** resolver maps phone → exactly one contact.
- **Assertion:** `deriveLevel(company, { phone })` → `level:'L1'`, `contactId` = the resolved id (NOT any `contactId` the caller supplied unless it matches). An L1 read (`getCustomerOverview`) is then permitted.

### ASK-GATE-03: phone + confirmed name + ZIP → L2
- **Priority:** P0 · **Type:** Unit · **Traces:** OQ-V3-1 (DECIDED: name AND ZIP/street), §2.2 (L2 row)
- **Preconditions:** resolver's stored contact has name "Jane Smith", ZIP "02101".
- **Assertion:** `deriveLevel(company, { phone, name:'Jane Smith', zip:'02101' })` → `level:'L2'`. Street instead of ZIP (`{ …, street:'12 Walpole St' }` matching stored) also → L2.

### ASK-GATE-04: name matches but ZIP/street wrong → stays L1 (second factor not confirmed)
- **Priority:** P0 · **Type:** Unit · **Traces:** §2.2, §2.4
- **Assertion:** `{ phone, name:'Jane Smith', zip:'99999' }` (name matches, ZIP does not) → `level:'L1'` (NOT L2). A subsequent `getEstimateSummary` (L2) is rejected with `needsVerification`; `estimatesService.*` not called.

### ASK-GATE-05: client-asserted `verified:true` / `level:'L2'` IGNORED (AC-8) [REAL-DB mirror in ASK-INT-06]
- **Priority:** P0 · **Type:** Unit · **Traces:** AC-8, §2.3, edge E15
- **Preconditions:** identity block resolves to only L1 on the server.
- **Assertion:** `runSkill('rescheduleAppointment', company, ctx, { verified:true, level:'L2', contactId, jobId, newPreferredSlot })` → rejected with the soft `needsVerification` shape; `scheduleService.rescheduleItem` **NOT** called. The gate must never read `input.verified`/`input.level` (assert via a spy or by the fact that a genuinely-L1 block cannot write).

### ASK-GATE-06: ambiguous (>1 contact on phone) → L0-with-marker, no auto-upgrade
- **Priority:** P0 · **Type:** Unit · **Traces:** §2.2 (ambiguity), edge E3, risk-2
- **Preconditions:** resolver returns 2 candidate contacts for the phone.
- **Assertion:** `deriveLevel` → `level:'L0'` with an `ambiguous` marker (+ count). `identifyCaller` returns `matchType:'ambiguous'`, `ambiguousCount:2`. Any L1+ skill is rejected (`needsVerification` / disambiguation prompt); no sensitive read/write runs.

### ASK-GATE-07: masked/spoofed number matching nothing → L0 (never auto-upgrades)
- **Priority:** P0 · **Type:** Unit · **Traces:** §2.2 (masked), edge E11, risk-2
- **Assertion:** `deriveLevel(company, { phone:'+10000000000' })` (no match) → `L0`; L2 reachable ONLY after `{ name+zip }` confirmation is supplied and matches. Assert a second `deriveLevel` with confirmed name+ZIP rises to L2.

### ASK-GATE-08: assert() throws typed `verification_required` when derived < required
- **Priority:** P0 · **Type:** Unit · **Traces:** §2.1 step 3, §2.4
- **Assertion:** `verificationGate.assert('L2', { level:'L1' })` throws an error whose type/code is `verification_required` (not a generic Error); `assert('L1', { level:'L1' })` and `assert('L1', { level:'L2' })` do NOT throw (equal or higher passes).

### ASK-GATE-09: stateless re-derivation — mid-call "downgrade" fails closed
- **Priority:** P1 · **Type:** Unit · **Traces:** §2.3 (fail-closed), risk-4
- **Assertion:** call 1 supplies `{ phone, name, zip }` → L2 read succeeds; call 2 (same skill) supplies only `{ phone }` (agent forgot to resend) → gate re-derives L1 → the L2 skill is rejected again. Proves no stale-trust escalation; each call is independent.

### ASK-GATE-10: below-L2 caller hitting each L2 skill → uniform safe refusal, NO disclosure
- **Priority:** P0 · **Type:** Integration · **Traces:** edge E10, AC-6, §2.5
- **Input:** an L1 verifiedContext; iterate `getJobHistory`, `getEstimateSummary`, `getInvoiceSummary`, `rescheduleAppointment`, `cancelAppointment`.
- **Assertion:** each returns `{ ok:false, needsVerification:true, speak:/verify a couple details/ }`; the corresponding service (`eventService.getEntityHistory`, `estimatesService.*`, `invoicesService.*`, `scheduleService.rescheduleItem`, `jobsService.cancelJob`) is **NOT** called; `speak` contains no amount, address, note text, or other-customer data.

### ASK-GATE-11: L1 reads that ARE unlocked still work (no over-blocking)
- **Priority:** P1 · **Type:** Unit · **Traces:** §2.4 (L1 unlocks)
- **Assertion:** with L1 context, `identifyCaller`, `getCustomerOverview`, `getJobStatus`, `getAppointments` all run (not rejected) and return their normal shapes. Guards against a gate that is too strict.

### ASK-GATE-12: unknown skill name → SAFE_FALLBACK from runSkill, never a crash (E13)
- **Priority:** P1 · **Type:** Unit · **Traces:** §2.1 step 1, edge E13, AC-12
- **Assertion:** `runSkill('svc.bogus', …)` resolves the registry miss to `SAFE_FALLBACK` `{ ok:false, speak:… }` (a resolved value, not a thrown error).

---

## Group C — Company isolation (G2, P0, AR-6, §9, AC-9)

> **Harness:** unit cases in `tests/agentSkillsIsolation.test.js` assert every skill scopes to `companyId` and pre-checks ownership; the *proof* cases are **[REAL-DB]** in `scripts/verify-agent-skills-001.js` (a cross-company job/contact/estimate/invoice seeded under Company B must be unreadable/unmutable from the `DEFAULT_COMPANY_ID` surface). The load-bearing subtlety: `cancelJob(jobId)` and `rescheduleItem`'s target take only `jobId`, so the skill MUST first `getJobById(jobId, companyId)` and confirm the job belongs to `companyId` AND to the verified `contactId` (spec §4.6 / §9 note).

### ASK-ISO-01: every read skill passes companyId to its service
- **Priority:** P0 · **Type:** Unit · **Traces:** AR-6, §9.1, §4 ("Isolation")
- **Assertion:** for `getCustomerOverview/getJobStatus/getAppointments/getJobHistory/getEstimateSummary/getInvoiceSummary`, the reused service (`jobsService.listJobs`, `getJobById`, `eventService.getEntityHistory`, `estimatesService.listEstimates`, `invoicesService.listInvoices`) is called with the first/`companyId` argument === `DEFAULT_COMPANY_ID` (never a value from `input`).

### ASK-ISO-02: cancelAppointment ownership pre-check — foreign job blocked BEFORE cancelJob
- **Priority:** P0 · **Type:** Unit · **Traces:** §4.6 code-note, §9.1, AC-9
- **Preconditions:** `getJobById(jobId, DEFAULT_COMPANY_ID)` → `null` (job belongs to another company); `retentionAttempted:true`, `reason:'x'`, L2 context.
- **Assertion:** the skill returns a not-found-safe shape and `jobsService.cancelJob` is **NOT** called. (A `cancelJob(jobId)` with no company arg would otherwise cancel a foreign job — this is the P0 trap.)

### ASK-ISO-03: cancelAppointment — job belongs to company but NOT to verified contact → blocked
- **Priority:** P0 · **Type:** Unit · **Traces:** §4 ("re-checks ownership by scoping … verified contactId"), AC-9
- **Preconditions:** `getJobById` returns a job whose `contact_id` ≠ `verifiedContext.contactId`.
- **Assertion:** skill refuses (safe shape); `cancelJob` not called. Proves ownership is contact-scoped, not just company-scoped.

### ASK-ISO-04: rescheduleAppointment ownership pre-check — foreign job blocked BEFORE rescheduleItem
- **Priority:** P0 · **Type:** Unit · **Traces:** §4.5/§4.6 code-note, §9.1
- **Preconditions:** `getJobById(jobId, DEFAULT_COMPANY_ID)` → null.
- **Assertion:** `scheduleService.rescheduleItem` **NOT** called; skill returns safe shape (no write, no ZB push, no note).

### ASK-ISO-05: getEstimateSummary — estimateId from another company/contact → not-found-safe, no cross-read
- **Priority:** P0 · **Type:** Unit · **Traces:** §4.8, §9.5, edge E12
- **Preconditions:** `getEstimate(companyId, estimateId)` returns null for a foreign id (because it is company-scoped), OR listEstimates for the verified contact does not include it.
- **Assertion:** skill returns `{ ok:false, speak:/don't see an estimate/ }` (or empty); no other-company estimate fields ever appear in the output; amounts never guessed.

### ASK-ISO-06: getInvoiceSummary — foreign invoiceId → not-found-safe, no amounts leaked
- **Priority:** P0 · **Type:** Unit · **Traces:** §4.9, §9.5, edge E12
- **Assertion:** as ASK-ISO-05 for invoices; `balanceDue`/`amountPaid`/`total` of a foreign invoice never surfaced.

### ASK-ISO-07: getJobStatus with a foreign jobId (but valid L1 contact) → does not read the foreign job
- **Priority:** P0 · **Type:** Unit · **Traces:** §4.3, §9.1
- **Preconditions:** caller (L1) supplies `jobId` of a job in another company.
- **Assertion:** `getJobById(jobId, DEFAULT_COMPANY_ID)` → null → skill falls back to the verified contact's own most-relevant job or a safe "let me check" shape; the foreign job's `serviceName`/`statusLabel` never returned.

### ASK-ISO-08: identifyCaller never returns cross-company contact for a matching phone
- **Priority:** P0 · **Type:** Unit · **Traces:** FR-S1, §3, §9.5
- **Preconditions:** the same phone exists under Company B; resolver is scoped to `DEFAULT_COMPANY_ID`.
- **Assertion:** `identifyCaller` resolves only within `DEFAULT_COMPANY_ID` (all resolver service calls carry that companyId); a Company-B-only contact yields `matchType:'new'`, not a cross-company `existing`.

---

## Group D — Identity resolution (P1/P2, FR-S1, §3, §6.2)

> **Harness:** `tests/agentSkillsIdentityResolver.test.js` (resolver unit) + real-DB proof ASK-INT-01…05. The critical real-code fact: `leadsService.getLeadByPhone` **returns null when the matched contact already has a job** (leadsService.js:1140–1146) — the resolver must NOT rely on that getter alone.

### ASK-SKILL-ID-01: phone → single lead, no job yet → matchType 'new'-eligible / existing lead resolved
- **Priority:** P1 · **Type:** Unit · **Traces:** FR-S1, §3 step 1
- **Assertion:** `getLeadsByPhones([phone])` returns one lead whose contact has no job → resolver returns that contact; `identifyCaller` → `matchType:'existing'` (a lead-only existing customer), L1.

### ASK-SKILL-ID-02: getLeadByPhone returns null BUT contact has a job → resolver bridges to existing (§6.2)
- **Priority:** P0 · **Type:** Unit · **Traces:** FR-S1, §3 step 2, §6.2, AC-1
- **Preconditions:** `getLeadByPhone` → null (suppressed because a job exists); a contacts/timeline phone match yields `contact_id`; `jobsService.listJobs({contactId})` returns ≥1 job.
- **Assertion:** resolver does NOT stop at the null getter; it bridges phone→contact→jobs and returns `matchType:'existing'` (L1). This is THE existing-customer case (AC-1: a caller with an open job is never pushed through new-lead qualification).

### ASK-SKILL-ID-03: masked/no phone → resolve by name + ZIP/street against contacts+jobs
- **Priority:** P1 · **Type:** Unit · **Traces:** FR-S1, §3 step 3, edge E11
- **Assertion:** with `phone` absent/masked and `{ name:'Jane Smith', zip:'02101' }`, resolver finds the contact via name+ZIP (fuzzy name, normalized ZIP) → `existing`; confirmed name+ZIP → L2.

### ASK-SKILL-ID-04: multiple candidates → disambiguate by last-appointment/address; still >1 → ambiguous
- **Priority:** P1 · **Type:** Unit · **Traces:** FR-S1, §3 step 4, edge E3
- **Assertion:** two contacts match name+ZIP → resolver attempts disambiguation by last appt date/address; if it cannot narrow to one → `matchType:'ambiguous'`, `ambiguousCount:2`, level stays L0-with-marker.

### ASK-SKILL-ID-05: phone normalization (last-10 digits) + fuzzy name tolerance
- **Priority:** P2 · **Type:** Unit · **Traces:** FR-S1, §3 step 1, NFR identity-tolerance
- **Assertion:** `+1 (617) 555-1234`, `6175551234`, `16175551234` all normalize to the same lookup; a minor name variance ("Jon" vs "John") still matches for the L2 name-confirm within tolerance.

### ASK-SKILL-ID-06: identifyCaller output is speech-safe (display name only, no PII dump)
- **Priority:** P1 · **Type:** Unit · **Traces:** FR-S1, §4.1 ("Never a raw PII dump")
- **Assertion:** the result has `matchType/contactId/customerName/verificationLevel/ambiguousCount/speak` only; `customerName` is the display name; NO phone/email/full-address echoed in the object or `speak`.

---

## Group E — Read skills (P1/P2, FR-S2…S4, S7…S9, §4)

> **Harness:** `tests/agentSkillsReadSkills.test.js` (services mocked). Every read skill's output is provider-neutral & speech-safe; below-L2 non-disclosure specifics are asserted precisely.

### ASK-SKILL-OV-01: getCustomerOverview → counts + next window + booleans, NO amounts/addresses
- **Priority:** P1 · **Type:** Unit · **Traces:** FR-S2, §4.2, §2.5
- **Preconditions:** `jobsService.listJobs({contactId, onlyOpen})` → 2 open jobs with `start_date/end_date`; one open estimate + one unpaid invoice exist.
- **Assertion:** output = `{ ok:true, openJobsCount:2, nextAppointment:{ jobId, window:'between 10 and 12' }, lastJobStatus:<phrase>, hasOpenEstimate:true, hasUnpaidInvoice:true, speak }`. `hasOpenEstimate/hasUnpaidInvoice` are booleans (not counts/totals); NO `total`/amount/address key anywhere.

### ASK-SKILL-OV-02: getCustomerOverview derives window from listJobs, NOT getScheduleItems({contactId})
- **Priority:** P1 · **Type:** Unit · **Traces:** §4.2 code-vs-arch note ("schedule can't filter by contact")
- **Assertion:** the skill calls `jobsService.listJobs({ contactId })` and derives `nextAppointment.window` from the job's `start_date`/`end_date`; it does NOT pass `{contactId}` into `scheduleService.getScheduleItems` expecting a contact filter (assert getScheduleItems is either not called with a contactId param, or only correlated by `entity_id===jobId`).

### ASK-SKILL-OV-03: multiple open jobs → speak asks which appliance/service to scope (E2)
- **Priority:** P2 · **Type:** Unit · **Traces:** §4.2 guardrails, edge E2, AC-2
- **Assertion:** with ≥2 open jobs, `speak` contains a disambiguation prompt (asks which appliance/service); the skill does not silently pick one.

### ASK-SKILL-JS-01: getJobStatus → mapped statusLabel (phrase), never raw blanc_status
- **Priority:** P1 · **Type:** Unit · **Traces:** FR-S3, §4.3, AC-2
- **Preconditions:** job `blanc_status='On the way'`.
- **Assertion:** `statusLabel==='Your technician is on the way.'`; `statusStage` is an internal key (not spoken); `speak` contains NO literal `'On the way'` code path leak beyond the mapped phrase; `technicianEtaText` = "the tech will text before arriving" and contains NO tech name/number.

### ASK-SKILL-JS-02: getJobStatus omitting jobId → most-relevant open job selected
- **Priority:** P2 · **Type:** Unit · **Traces:** FR-S3, §4.3
- **Assertion:** with `jobId` absent and one open job, that job is used; with several, the skill scopes/prompts (does not guess wrongly).

### ASK-SKILL-JS-03: booked-not-started (Submitted + schedule window) → offer reschedule, NOT a 'Scheduled' label
- **Priority:** P1 · **Type:** Unit · **Traces:** §4.10 / §6.1 (NO `Scheduled` label), AC-2
- **Assertion:** a `Submitted` job WITH a schedule window yields the `Submitted` phrase and a `nextAction` offering reschedule; the string "Scheduled" is never emitted as a status label.

### ASK-SKILL-AP-01: getAppointments → windows as ranges, statusLabel phrases
- **Priority:** P1 · **Type:** Unit · **Traces:** FR-S4, §4.4, AC-3
- **Assertion:** each appointment `window` is a range (e.g. "between 10 and 12"), never an exact minute; `statusLabel` is a mapped phrase. Correlated with `getScheduleItems` by `entity_id===jobId`.

### ASK-SKILL-AP-02: no appointments → `appointments:[]`, speak offers to book (E7)
- **Priority:** P2 · **Type:** Unit · **Traces:** edge E7, edge E1
- **Assertion:** empty jobs → `{ ok:true, appointments:[], speak:/nothing scheduled/ + offer to book }` — never an error.

### ASK-SKILL-HIST-01: getJobHistory (L2) → summarized timeline, internal/tech-private notes REDACTED
- **Priority:** P0 · **Type:** Unit · **Traces:** FR-S7, §4.7, AC-6
- **Preconditions:** L2 context; notes include one internal-only/technician-private note + one customer-facing note.
- **Assertion:** `timeline[].note_summary` summarizes; the internal/tech-private note is NOT read raw (its verbatim text is absent from output); `eventService.getEntityHistory` called with companyId.

### ASK-SKILL-EST-01: getEstimateSummary (L2) → summary + total + itemCount, NEVER line items
- **Priority:** P1 · **Type:** Unit · **Traces:** FR-S8, §4.8, AC-7
- **Assertion:** output has `estimateNumber/status/total/itemCount/summaryText/speak`; `itemCount` is an integer, NOT a list; `speak`/`summaryText` do not enumerate per-item pricing; offers to text a secure link (SEND-DOC-001 channel).

### ASK-SKILL-INV-01: getInvoiceSummary (L2) → balance + status; payment handoff to link/human, NEVER card
- **Priority:** P0 · **Type:** Unit · **Traces:** FR-S9, §4.9, AC-7, §9.3
- **Assertion:** output has `invoiceNumber/status/total/amountPaid/balanceDue/speak`; `speak` states balance + status and offers a secure link or human; the skill has NO parameter for and never requests card/PAN/CVV (assert no code path collects payment). See also ASK-SEC-01 (no-card invariant across all skills).

### ASK-SKILL-EST-02 / INV-02: unknown/absent estimate or invoice id → not-found-safe shape (E12)
- **Priority:** P2 · **Type:** Unit · **Traces:** edge E12
- **Assertion:** id not on file → `{ ok:false, speak:/don't see an estimate|invoice on file/ }`; no error, no other customer's doc, amounts never guessed.

### ASK-SKILL-EMPTY-01: first-run contact (no jobs/appts/estimates/invoices) → empty shapes, offer to help (E1)
- **Priority:** P2 · **Type:** Unit · **Traces:** edge E1
- **Assertion:** `getCustomerOverview` → `openJobsCount:0, nextAppointment:null, hasOpenEstimate:false, hasUnpaidInvoice:false`; `getAppointments` → `[]`; each `speak` says nothing is on file and offers to book — never an error.

---

## Group F — status_map correctness (P1, §4.10 / §6.1, AC-2)

> **Harness:** `tests/agentSkillsStatusMap.test.js` (pure unit over `statusMap.js`). The map is reconciled to the REAL `BLANC_STATUSES` (jobsService.js:25) — **there is NO `Scheduled` label**; the roadmap's illustrative set must NOT be used.

### ASK-STATUS-01: every REAL BLANC_STATUS maps to its exact spoken phrase
- **Priority:** P1 · **Type:** Unit · **Traces:** §6.1 table, AC-2
- **Assertion:** table-driven — `statusMap('Submitted')` → "We've got your request and are getting it scheduled.", `'Waiting for parts'` → "We're waiting on a part to finish the repair.", `'Follow Up with Client'` → "Our team needs to follow up with you to move forward.", `'Visit completed'` → "The technician has completed the visit.", `'Job is Done'` → "The job is complete.", `'Rescheduled'` → "Your appointment has been rescheduled.", `'On the way'` → "Your technician is on the way.", `'Canceled'` → "That appointment is canceled." Each with the spec's `nextAction` hint.

### ASK-STATUS-02: 'Scheduled'/'Review'/'Enroute'/'In Progress' are NOT valid keys (roadmap set rejected)
- **Priority:** P1 · **Type:** Unit · **Traces:** §4.10, §6.1 ("do not use it")
- **Assertion:** `statusMap` has no `'Scheduled'` entry; feeding `'Scheduled'` (never produced by the real FSM) falls to the neutral safe phrase (see ASK-STATUS-04). Guards against re-introducing the illustrative roadmap labels.

### ASK-STATUS-03: ZB substatus en-route/in-progress → "on the way" / "working on it now"
- **Priority:** P2 · **Type:** Unit · **Traces:** §6.1 (ZB substatus row)
- **Assertion:** `zb_status:'en-route'` → "on the way"; `'in-progress'` → "working on it now".

### ASK-STATUS-04: unknown/unmapped status → neutral safe phrase, NO code leak
- **Priority:** P1 · **Type:** Unit · **Traces:** §4.10 ("An unmapped/unknown status → a neutral safe phrase")
- **Assertion:** `statusMap('Frobnicated')` → "Let me check the latest on that for you" (or the defined neutral phrase); the raw code string is NEVER present in the output.

---

## Group G — Write flows: reschedule ZB write-through + cancel retention + audit (G4, G5, §5, AR-4, AR-5)

> **Harness:** `tests/agentSkillsWriteSkills.test.js` (unit, services + zenbookerClient mocked) for the ordering/gating; `tests/scheduleServiceRescheduleZb.test.js` for the `rescheduleItem` seam; the real proofs are ASK-INT-18…21. The reschedule write-through is the **AR-4 gap** — `rescheduleItem` today has NO ZB push (confirmed in source: only a `job_rescheduled` best-effort pushService hook).

### ASK-WRITE-01: reschedule (L2) success → writes Albusto AND calls zenbookerClient.rescheduleJob
- **Priority:** P0 · **Type:** Unit · **Traces:** AR-4, §5.2, AC-4, S5
- **Preconditions:** L2 context; job is ZB-linked (`zenbooker_job_id` set); ownership pre-check passes; `newPreferredSlot` confirmed.
- **Assertion:** `scheduleService.rescheduleItem(companyId,'job',jobId,newStartAt,newEndAt)` called; the extended `rescheduleItem` calls `zenbookerClient.rescheduleJob(zenbookerJobId, { start_date:<ISO 8601>, … })`. Skill output `{ ok:true, success:true, newWindow:<range>, conflict:false, speak }`.

### ASK-WRITE-02: reschedule writes an 'AI Phone' audit note + job_rescheduled domain event
- **Priority:** P0 · **Type:** Unit · **Traces:** AR-5, §5.1, AC-4
- **Assertion:** `jobsService.addNote(jobId, <text>, [], 'AI Phone', 'AI Phone')` called (author + createdBy both 'AI Phone'); `eventService.logEvent(companyId,'job',jobId,'job_rescheduled', objectContaining({ actor:'AI Phone' }), 'system')` called.

### ASK-WRITE-03: reschedule ZB failure → blocking-with-recovery, graceful skill shape (E4)
- **Priority:** P0 · **Type:** Unit · **Traces:** §5.3 (Decided default B), edge E4, G4
- **Preconditions:** `zenbookerClient.rescheduleJob` rejects; `forceSyncOnZbError` cannot reconcile → `rescheduleItem` throws a friendly 409.
- **Assertion:** the SERVICE layer throws (does not silently local-only diverge); the SKILL catches the 409 and returns `{ ok:false, success:false, conflict:true, speak:/teammate confirm that time/ }`. The customer is NEVER told the reschedule succeeded. State stays recoverable/consistent (ZB is master).

### ASK-WRITE-04: reschedule NOT called without confirmed newPreferredSlot (confirm old→new first)
- **Priority:** P1 · **Type:** Unit · **Traces:** §4.5 guardrails, AC-4 ("no reschedule write without explicit confirmation")
- **Assertion:** `rescheduleAppointment` invoked without a valid confirmed `newPreferredSlot` (missing/empty) → no write, no ZB push; a safe/needs-confirmation shape returned. (Offer/confirm happen across turns; the write skill only runs after confirmation.)

### ASK-WRITE-05: reschedule conflict (slot taken between offer and confirm) → conflict:true, offers next, NO write (E9)
- **Priority:** P1 · **Type:** Unit · **Traces:** edge E9, §4.5
- **Preconditions:** availability/`rescheduleItem` surfaces the window is now taken.
- **Assertion:** skill returns `{ conflict:true, speak:<offers next window> }`; `rescheduleItem` write path not committed / ZB not pushed.

### ASK-WRITE-06: rescheduleItem seam — ZB push ONLY for entityType 'job' on a ZB-linked job
- **Priority:** P0 · **Type:** Unit · **Traces:** §5.2, AR-4
- **Preconditions:** call `rescheduleItem(company,'job',jobId,…)` where `getJobById` shows NO `zenbooker_job_id`.
- **Assertion:** local write happens; `zenbookerClient.rescheduleJob` is NOT called (skip if not linked). A non-'job' entityType never triggers a ZB reschedule push. Mirrors `cancelJob`'s "skip if not linked" discipline.

### ASK-WRITE-07: rescheduleItem seam — the existing job_rescheduled pushService hook stays best-effort/non-fatal
- **Priority:** P2 · **Type:** Unit · **Traces:** §5.2 (reassignItem best-effort precedent)
- **Assertion:** a thrown pushService error is caught and logged (non-fatal); the reschedule still returns success and still does the ZB reschedule push. Guards against the new ZB seam accidentally making the internal push fatal.

### ASK-WRITE-08: reschedule appears on dispatcher schedule immediately (synchronous Albusto write)
- **Priority:** P1 · **Type:** Integration [REAL-DB mirror ASK-INT-19] · **Traces:** AC-4, §4.5
- **Assertion:** after a successful reschedule, `scheduleQueries.rescheduleJob` committed synchronously so `getScheduleItems` reflects the new window in the same request (no async lag).

### ASK-WRITE-10: cancel NEVER on first ask — retentionAttempted falsey/absent → rejected, no cancel (E14)
- **Priority:** P0 · **Type:** Unit · **Traces:** AR-5, §4.6 step 3, §5.4, AC-5, edge E14
- **Preconditions:** L2 context; `{ reason:'price', retentionAttempted:false }` (and a separate case with the key absent).
- **Assertion:** skill returns the soft "I need to note why, and let me try one thing first" shape; `jobsService.cancelJob` **NOT** called. Enforced server-side, not just in the prompt.

### ASK-WRITE-11: cancel with empty/missing reason → rejected, no cancel (E14)
- **Priority:** P0 · **Type:** Unit · **Traces:** §4.6 step 1, AC-5, edge E14
- **Assertion:** `{ reason:'', retentionAttempted:true }` (and `reason` absent) → refused with "I need to note why"; `cancelJob` not called.

### ASK-WRITE-12: cancel happy path (reason + retentionAttempted:true) → cancelJob + reason note + domain event
- **Priority:** P0 · **Type:** Unit · **Traces:** AR-4, AR-5, §4.6, §5.4, AC-5
- **Preconditions:** ownership pre-check passes; `{ reason:'found-someone', retentionAttempted:true }`.
- **Assertion:** `jobsService.cancelJob(jobId)` called (which already ZB-pushes); `jobsService.addNote(jobId, <text incl. reason>, [], 'AI Phone', 'AI Phone')` called; `eventService.logEvent(companyId,'job',jobId,'job_canceled', objectContaining({ reason:'found-someone', retentionAttempted:true, actor:'AI Phone' }), 'system')` called. Output `{ ok:true, success:true, status:'That appointment is canceled.', speak }`.

### ASK-WRITE-13: cancel note MUST include the captured reason every time (AR-5 hard rule)
- **Priority:** P0 · **Type:** Unit · **Traces:** AR-5, §5.1 ("cancel note MUST include the captured reason"), AC-5
- **Assertion:** the `addNote` text argument contains the reason string; a cancel that somehow reached the write without a reason is impossible (blocked by ASK-WRITE-11). The domain event `reason` field equals the input reason.

### ASK-WRITE-14: exactly ONE save attempt is enforced by requiring retentionAttempted:true (matched to reason)
- **Priority:** P1 · **Type:** Unit · **Traces:** §4.6 step 2, §5.4, AC-5
- **Assertion:** the write skill's precondition is (`reason` non-empty AND `retentionAttempted===true`); it does not itself loop retention (that is the conversation's job across turns). Assert both preconditions are required and that the skill neither re-attempts retention nor cancels twice.

### ASK-WRITE-15: cancel on an ALREADY-canceled job → "already canceled", no duplicate cancelJob (E8)
- **Priority:** P1 · **Type:** Unit · **Traces:** edge E8
- **Preconditions:** `getJobById` shows `blanc_status:'Canceled'` (terminal).
- **Assertion:** skill detects the terminal status and returns "that appointment is already canceled"; `cancelJob` NOT called again (and `cancelJob` itself also pre-checks `zb_canceled`). No error.

### ASK-WRITE-16: cancel states the policy (free before visit, no fee) before writing — Decided default A
- **Priority:** P2 · **Type:** Unit · **Traces:** §4.6 (Decided default A / OQ-V3-2), §14-A
- **Assertion:** `speak` on the confirm/cancel path states the cancellation is free before the visit and captures the reason, stating no fee (default). (If Ops later supplies fee/window copy, this case updates to assert that copy is stated before the write.)

### ASK-WRITE-17: reschedule slot-offer step gated on smart-slot-engine, graceful fallback (E6, Gate-E)
- **Priority:** P2 · **Type:** Unit · **Traces:** §8.3 (Decided default E), edge E6
- **Assertion:** the OFFER step uses `recommendSlots`/engine gated on `isAppConnected(company,'smart-slot-engine')`; not connected → falls back to `scheduleService.getAvailableSlots`; no windows → `speak` offers a teammate callback. The reschedule *write* itself is NOT gated. Never blocks the call.

---

## Group H — Graceful degradation & error sanitization (G6, §6, AC-12)

> **Harness:** `tests/agentSkillsRunSkill.test.js` (skill-layer guard) + assertions on the VAPI adapter (ASK-VAPI-22) and MCP surface (ASK-MCP-14).

### ASK-DEG-01: any skill internal throw → SAFE_FALLBACK, no stack/SQL/PII, call continues
- **Priority:** P0 · **Type:** Unit · **Traces:** §6, AC-12, User-story 8
- **Preconditions:** a reused service (e.g. `jobsService.listJobs`) rejects with `Error('ECONNREFUSED … at pg (/app/node_modules/pg/...)')`.
- **Assertion:** `runSkill` returns `{ ok:false, speak:'Let me have a teammate follow up with you on that.' }`; output contains NO stack frame, NO `pg`, NO SQL, NO PII; nothing rethrows.

### ASK-DEG-02: SAFE_FALLBACK shape is exactly the resultShapes constant
- **Priority:** P1 · **Type:** Unit · **Traces:** §6, resultShapes.js
- **Assertion:** the fallback deep-equals `{ ok:false, speak:'Let me have a teammate follow up with you on that.' }` (single source of truth in `resultShapes.js`).

### ASK-DEG-03: verification failure on a sensitive skill → soft needsVerification shape (not a hard 4xx)
- **Priority:** P0 · **Type:** Unit · **Traces:** §6 (soft shape), edge E10
- **Assertion:** an L1 caller to an L2 skill → `{ ok:false, needsVerification:true, speak:'I'll need to verify a couple details first — can I get the name and ZIP on the account?' }` — distinct from SAFE_FALLBACK; no internal error surfaced.

### ASK-DEG-04: ZB 409 inside a write → skill returns conflict/graceful, not the raw 409 message
- **Priority:** P1 · **Type:** Unit · **Traces:** §6, §5.3, edge E4
- **Assertion:** the friendly-409 (whose `.message` is the ZB refresh text) is transformed to `{ ok:false, conflict:true, speak:… }`; the raw ZB message text does not appear in `speak`.

### ASK-DEG-05: cancel ZB error handled by cancelJob's forceSyncOnZbError → success or SAFE_FALLBACK (E5)
- **Priority:** P2 · **Type:** Unit · **Traces:** edge E5, §5 (cancel already handles ZB)
- **Assertion:** with `cancelJob` internally recovering via forceSyncOnZbError, the Albusto cancel still records and the skill returns success or SAFE_FALLBACK per the recovery result — never a raw error.

### ASK-DEG-06: latency budget — a slow ZB/engine call falls back within timeout (p95 < 2000ms posture)
- **Priority:** P3 · **Type:** Unit · **Traces:** NFR latency, §6
- **Assertion:** with a stubbed slow dependency exceeding the skill's timeout, the skill returns a fallback/graceful shape rather than hanging (assert a bounded resolution). Full load-test p95 is out of jest scope; this proves the timeout-and-fallback wiring exists.

### ASK-DEG-07: unknown tool via VAPI adapter → well-formed results[] entry (not a 500)
- **Priority:** P1 · **Type:** Integration · **Traces:** edge E13, AC-12
- **Assertion:** `toolCall('svc.bogus', {})` through the adapter → HTTP 200 with a well-formed `results[{toolCallId, result}]` whose parsed result is SAFE_FALLBACK; never a 500.

---

## Group I — MCP transport (svc.* triplet) (P1, AR-3, §8, AC-10)

> **Harness:** new `tests/routes/agentSkillsMcp.test.js` (authenticated JSON-RPC, mirrors `crmMcp.test.js`) + `tests/routes/agentSkillsMcpPublic.test.js` (token-gated public, mirrors `crmMcpPublic.test.js`) + `tests/services/agentSkillsMcpRegistry.test.js`. The rule: reuse the `crmMcp*` framework (generic `crmMcpSchemaValidator` + `crmMcpResponse` shared as-is); the parallel triplet points at the SAME skill layer, so verification composes as an OUTER gate on top of L2.

### ASK-MCP-01: tools/list exposes all 9 svc.* tools with correct kind + requiresConfirmation
- **Priority:** P1 · **Type:** Integration · **Traces:** §8.1 table, AR-3
- **Assertion:** `tools/list` returns `svc.identify_caller/get_customer_overview/get_job_status/get_appointments/get_job_history/get_estimate_summary/get_invoice_summary` as `kind:'read', requiresConfirmation:false`; `svc.reschedule_appointment/svc.cancel_appointment` as `kind:'write', requiresConfirmation:true`. No delete/bulk tools (mirror crmMcp guard).

### ASK-MCP-02: each tool declares the correct requiredLevel (L0/L1/L2) in the registry
- **Priority:** P1 · **Type:** Unit · **Traces:** §8.1 table, §4 (per-tool requiredLevel)
- **Assertion:** registry projection — `svc.identify_caller`:L0; overview/job_status/appointments:L1; job_history/estimate_summary/invoice_summary/reschedule/cancel:L2. (`requiredLevel` is enforced by the skill layer, declared here.)

### ASK-MCP-03: read tool executes with company from req.companyFilter.company_id (NEVER client)
- **Priority:** P0 · **Type:** Integration · **Traces:** §8.2 (tenant-from-context), AR-6, AC-9
- **Preconditions:** `makeApp({ companyId:'company-1' })`-style middleware sets `req.companyFilter.company_id`; the JSON-RPC `arguments` also (maliciously) carry `company_id:'company-2'`.
- **Assertion:** the executor's `buildContext` uses `'company-1'`; the skill/service receives `company-1`, NOT the client's `company-2`. The client-supplied company is ignored.

### ASK-MCP-04: write tool requires framework write-gate (permission + confirmation) AND skill L2 — both
- **Priority:** P0 · **Type:** Integration · **Traces:** §8.2 (D4, composes as OUTER gate), AC-10
- **Assertion:** `tools/call svc.reschedule_appointment` WITHOUT `confirmation.confirmed`+`confirmation_id` → framework `access_denied`/confirmation error, skill never runs. WITH confirmation but identity block resolving only to L1 → the skill-layer L2 gate rejects (`needsVerification`), no write. Only confirmation + a genuine L2 identity block writes. (Strictly stronger than voice — correct for a non-voice caller.)

### ASK-MCP-05: write permission absent → access_denied, skill not called
- **Priority:** P0 · **Type:** Integration · **Traces:** §8.1 (requiredPermission on writes), §8.2
- **Preconditions:** `req.authz.permissions` lacks the service-CRM write permission (e.g. `service.crm.write`).
- **Assertion:** `svc.cancel_appointment` (even with confirmation) → `access_denied`; `agentSkills.runSkill` not invoked for the write.

### ASK-MCP-06: schema validation (reused crmMcpSchemaValidator) rejects bad args before dispatch
- **Priority:** P1 · **Type:** Integration · **Traces:** §8 (reuse validator), AR-3
- **Assertion:** `svc.get_job_status` with missing required `contact_id` (snake_case per MCP convention) → HTTP/JSON-RPC `invalid_request` with `details.field==='contact_id'`; the skill is not dispatched. Mirrors `crmMcp` "validates tool arguments" test.

### ASK-MCP-07: snake_case ↔ skill input mapping (contact_id, job_id, new_preferred_slot, retention_attempted)
- **Priority:** P1 · **Type:** Integration · **Traces:** §8.1 (snake_case fields)
- **Assertion:** MCP `arguments` `{ contact_id, job_id, new_preferred_slot:{date,start,end}, retention_attempted }` reach the skill as the camelCase inputs the skill layer expects (or the skill accepts both); the identity block `phone/name/zip/street` passes through so `verificationGate` runs identically to VAPI.

### ASK-MCP-08: identify + reads NOT gated on a marketplace app (inbound must always resolve)
- **Priority:** P1 · **Type:** Integration · **Traces:** §8.3 (Decided default E), AR-3
- **Assertion:** `svc.identify_caller` and L1 reads succeed regardless of marketplace connection state (no `isAppConnected` short-circuit on identify/reads). Only the reschedule slot-offer uses the `smart-slot-engine` gate.

### ASK-MCP-09: public transport — missing bearer token → 401 MCP_PUBLIC_UNAUTHORIZED
- **Priority:** P1 · **Type:** Integration · **Traces:** §8 (public-auth mirror), NFR security
- **Assertion:** mirror crmMcpPublic — no `Authorization` header → 401, error code `MCP_PUBLIC_UNAUTHORIZED`.

### ASK-MCP-10: public transport disabled (SVC_MCP_PUBLIC_ENABLED != true) → 403 MCP_PUBLIC_DISABLED
- **Priority:** P1 · **Type:** Integration · **Traces:** §8 (public transport), NFR security
- **Assertion:** with a valid token but `SVC_MCP_PUBLIC_ENABLED='false'` → 403, `MCP_PUBLIC_DISABLED`.

### ASK-MCP-11: public transport company is env-bound (SVC_MCP_PUBLIC_COMPANY_ID = …0001), never client
- **Priority:** P0 · **Type:** Integration · **Traces:** §8 (env-bound company), AC-9
- **Assertion:** a public read with `arguments.company_id:'company-2'` still executes against `SVC_MCP_PUBLIC_COMPANY_ID`; the client company is ignored.

### ASK-MCP-12: public WRITES disabled unless SVC_MCP_PUBLIC_WRITE_ENABLED — write → access_denied
- **Priority:** P0 · **Type:** Integration · **Traces:** §8 (writes disabled by default), NFR security, AC-10
- **Assertion:** with `SVC_MCP_PUBLIC_WRITE_ENABLED` unset/false, `svc.reschedule_appointment` (even confirmed + L2) → `access_denied`; the service is not called. With it `='true'` (and confirmation + L2), the write proceeds. Mirrors crmMcpPublic write-gate.

### ASK-MCP-13: serverInfo.name === 'albusto-service-crm-mcp' (distinct from sales MCP)
- **Priority:** P2 · **Type:** Integration · **Traces:** §8 (protocol mirror)
- **Assertion:** `initialize` → `result.serverInfo.name === 'albusto-service-crm-mcp'` (not `blanc-sales-crm-mcp`). The sales MCP (`/api/crm/mcp`, `/mcp/crm`) is untouched.

### ASK-MCP-14: MCP errors go through crmMcpResponse.sanitizeDetails (drops token/secret/password/oauth/sql/stack)
- **Priority:** P0 · **Type:** Integration · **Traces:** §6 (MCP sanitized errors), AC-12
- **Assertion:** force a skill to throw an error carrying `{ sql:'SELECT …', token:'abc' }` in details → the MCP response's error details have those keys dropped/redacted and long strings truncated (reused `sanitizeDetails` contract); no internal detail leaks.

### ASK-MCP-15: same skill over BOTH adapters yields equivalent result (swappability, AC-10)
- **Priority:** P1 · **Type:** E2E · **Traces:** AC-10, User-story 7
- **Assertion:** for a read like `getCustomerOverview` with identical identity+input, the VAPI adapter result and the MCP `structuredContent` are semantically equivalent (same fields/values) — proving the skill layer is the single source and both adapters are thin.

### ASK-MCP-16: sales CRM MCP untouched — crm.* tools + /api/crm/mcp still behave as before
- **Priority:** P2 · **Type:** Integration (regression) · **Traces:** §8 (additive, not modifying), Constraints (protected)
- **Assertion:** the existing `crmMcp.test.js`/`crmMcpPublic.test.js` suites remain green (run them); the new svc.* mount does not alter `crm.*` tool defs or the `blanc-sales-crm-mcp` serverInfo.

---

## Group J — Security invariants cross-cutting (P0, §9)

### ASK-SEC-01: NO skill takes a card / payment by voice — ever (§9.3, AC-7)
- **Priority:** P0 · **Type:** Unit · **Traces:** §9.3, AC-7, Non-goals
- **Assertion:** inspect every skill's input schema (registry + MCP registry): none declares a card/PAN/CVV/payment field; `getInvoiceSummary` routes payment to a secure link/human only. A source-level scan asserts no skill references card capture. This is a standing invariant, not a single-flow check.

### ASK-SEC-02: full street address is confirm-only, never read back unprompted (§2.5, §9.5)
- **Priority:** P1 · **Type:** Unit · **Traces:** §2.5 (full street address confirm-only), §9.5
- **Assertion:** no read skill emits the full street address in `speak`/output at any level; where address is referenced it is a yes/no confirm ("is this still the Walpole Street address?"), and only the street NAME token used to confirm — never the full line unprompted.

### ASK-SEC-03: technician personal info never disclosed (§2.5)
- **Priority:** P1 · **Type:** Unit · **Traces:** §2.5, FR-S3
- **Assertion:** `getJobStatus.technicianEtaText` and any ETA framing contain NO technician name/phone/PII; ETA = "the tech will text before arriving."

### ASK-SEC-04: below-L2 non-disclosure specifics — no amounts, no line items, existence-only
- **Priority:** P0 · **Type:** Unit · **Traces:** §2.5, AC-7
- **Assertion:** at L1, `getCustomerOverview` exposes only `hasOpenEstimate`/`hasUnpaidInvoice` booleans (no totals); estimate/invoice amounts require L2; estimate line items are never read line-by-line at any level.

---

## Group K — Real-DB integration harness [REAL-DB] (`scripts/verify-agent-skills-001.js`)

> **Why a real-DB harness (not just jest):** LIST-PAGINATION-001 and created_by-FK proved a mocked jest validates only the SQL string / dispatch shape and can hide a real bug. The P0 gates (verification, isolation, ZB write-through, byte-compat) get a real-Postgres proof, matching the house `scripts/verify-*.js` pattern: **self-seeded uniquely-tagged fixtures** (e.g. `leads.uuid LIKE 'ask1%'`, contacts/jobs tagged), **row-targeted assertions** (never a whole-company count — real dev rows coexist under seed Company A `…0001`), **cleanup before each case + at start/end** (FK order), a **tiny check/eq/record kit**, `DATABASE_URL` defaulting to `postgresql://localhost/twilio_calls`, **never point at prod**, exit 0 only when no case FAILs. Each write path uses a **ZB stub** (a fake `zenbookerClient` or a captured HTTP double) so `rescheduleJob`/`cancelJob` are observed without hitting real ZB. Every P0 case pairs the assertion with a **sabotage control** (deliberately break the invariant and prove the harness goes RED) so a green run is meaningful.

**Company setup:** Company A = seed `00000000-0000-0000-0000-000000000001` (= `DEFAULT_COMPANY_ID`); Company B = a second seeded company id used only to seed cross-tenant rows that MUST be invisible.

### ASK-INT-01: identity — phone→existing customer WITH a job (the getLeadByPhone-returns-null case)
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** FR-S1, §6.2, AC-1
- **Steps:** seed a contact + a lead + a job for a tagged phone such that `leadsService.getLeadByPhone(phone, A)` returns null (job exists). Run the real `identityResolver`/`identifyCaller`.
- **Assertion:** resolver bridges phone→contact→job and returns `matchType:'existing'`, L1, the correct `contactId`. **Sabotage control:** temporarily make the resolver stop at `getLeadByPhone` → assert it wrongly returns `new` (harness RED), proving the bridge is what fixes it.

### ASK-INT-02: identity — masked number → name+ZIP resolves the same existing customer, → L2
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** FR-S1, §3 step 3, edge E11, OQ-V3-1
- **Assertion:** with no phone but the seeded contact's real name+ZIP, `deriveLevel` → L2; wrong ZIP → stays L1. Sabotage: feed a name+ZIP that matches a DIFFERENT seeded contact → assert it does NOT resolve to the first (no false-positive).

### ASK-INT-03: identity — ambiguous (two contacts, same phone) → ambiguous, no upgrade
- **Priority:** P1 · **Type:** Integration [REAL-DB] · **Traces:** §3 step 4, edge E3
- **Assertion:** two tagged contacts share a phone → `identifyCaller` → `matchType:'ambiguous'`, `ambiguousCount:2`, level L0-with-marker; a subsequent L1 read is refused.

### ASK-INT-06: verification — client `verified:true` without a real match is IGNORED (AC-8) [pairs ASK-GATE-05]
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** AC-8, §2.3, edge E15
- **Steps:** seed a contact resolving only to L1; call `runSkill('rescheduleAppointment', A, ctx, { verified:true, level:'L2', contactId, jobId, newPreferredSlot })` against the real DB.
- **Assertion:** rejected `needsVerification`; the job's `blanc_status`/schedule row are UNCHANGED in the DB (row-targeted). Sabotage: make the gate read `input.verified` → assert the reschedule wrongly commits (harness RED).

### ASK-INT-07: verification — L2 requires server-confirmed name AND ZIP against the stored row
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** OQ-V3-1, §2.2
- **Assertion:** correct name+ZIP → an L2 read (`getInvoiceSummary`) returns the real amounts; wrong ZIP → refused and NO amounts in output.

### ASK-INT-08: verification — L1 unlocks its reads against real data
- **Priority:** P1 · **Type:** Integration [REAL-DB] · **Traces:** §2.4
- **Assertion:** phone-only match → `getJobStatus`/`getAppointments` return the seeded job's mapped phrase + range window; L2-only reads refused.

### ASK-INT-09: verification — below-L2 → NO sensitive disclosure (history/estimate/invoice) against real rows
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** edge E10, §2.5, AC-6
- **Assertion:** seed a job with an internal note + an estimate + an invoice; an L1 caller's `getJobHistory/getEstimateSummary/getInvoiceSummary` all return the soft refuse shape and the real note text / amounts NEVER appear in output.

### ASK-INT-10: isolation — cross-company JOB is never read (real Company B row)
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** AC-9, §9.1
- **Steps:** seed a job under Company B; from the `DEFAULT_COMPANY_ID` surface call `getJobStatus` with that jobId (L1 A-contact).
- **Assertion:** `getJobById(jobId, A)` → null → B's job fields never returned. Sabotage: call `getJobById(jobId)` WITHOUT companyId → assert B's job is read (harness RED), proving the company scope is load-bearing.

### ASK-INT-11: isolation — cross-company CANCEL is blocked before cancelJob (the jobId-only trap)
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** §4.6 code-note, AC-9, §9.1
- **Steps:** seed a ZB-linked job under Company B; from surface A call `cancelAppointment({ jobId:<B>, reason, retentionAttempted:true })` at L2-for-A.
- **Assertion:** ownership pre-check (`getJobById(jobId, A)` → null) refuses; B's job `blanc_status` stays unchanged in the DB and the ZB stub's `cancelJob` was NOT called. Sabotage: drop the pre-check → assert B's job gets canceled (harness RED). **This is the single most important isolation proof** given `cancelJob(jobId)` has no company param.

### ASK-INT-12: isolation — cross-company RESCHEDULE is blocked before rescheduleItem
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** §4.5/§4.6, AC-9
- **Assertion:** as ASK-INT-11 for reschedule — B's schedule row unchanged, ZB stub `rescheduleJob` not called; sabotage (drop pre-check) → RED.

### ASK-INT-13: isolation — cross-company ESTIMATE/INVOICE never read
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** §4.8/§4.9, AC-9, edge E12
- **Assertion:** seed an estimate + invoice under Company B; `getEstimateSummary/getInvoiceSummary` from A with those ids → not-found-safe, B's amounts never surfaced.

### ASK-INT-14: back-compat — checkServiceArea byte-identical old-handler vs new-skill (real stQueries)
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** AC-11, spec §7.3
- **Steps:** seed a service-territory row; run the PRE-refactor handler output (captured/golden) and the new skill for a matrix of zips (in-area, out-of-area, missing).
- **Assertion:** `JSON.stringify` equal byte-for-byte across the matrix. (Golden fixtures captured from the current handler before the refactor.)

### ASK-INT-15: back-compat — createLead byte-identical body + real lead row written
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** AC-11, spec §7.3
- **Assertion:** for the fullArgs matrix (+ disqualified, + chosenSlot, + no-phone), the composed `createLead` body and the result JSON match the pre-refactor golden byte-for-byte; the real lead row lands with `JobSource='AI Phone'` and (with chosenSlot) real TIMESTAMPTZ columns. Cleanup by tag.

### ASK-INT-16: back-compat — checkAvailability + recommendSlots outputs unchanged (real schedule/engine or stubbed engine)
- **Priority:** P1 · **Type:** Integration [REAL-DB] · **Traces:** AC-11, spec §7.3
- **Assertion:** identical outputs pre/post for the availability fallback and the recommendSlots gate/fallback/happy shapes.

### ASK-INT-17: back-compat — validateAddress geocode path unchanged (Geocoding double)
- **Priority:** P1 · **Type:** Integration [REAL-DB] · **Traces:** AC-11, spec §7.3
- **Assertion:** with a fixed Geocoding response double, the relocated `skills/validateAddress.js` returns the same `{ valid, standardized, correctedZip, lat, lng }` bytes as the old handler.

### ASK-INT-18: reschedule — Albusto write AND ZB push both happen (real rescheduleItem + ZB stub)
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** AR-4, §5.2, AC-4, G4
- **Steps:** seed a ZB-linked job under A with a schedule window; run `rescheduleAppointment` at L2 with a confirmed slot; ZB stub records calls.
- **Assertion:** the DB schedule row is updated (row-targeted `getScheduleItems` shows the new window) AND the ZB stub's `rescheduleJob(zbId, { start_date:<ISO> })` was called exactly once AND an 'AI Phone' note + `job_rescheduled` domain_event row exist. **Sabotage:** revert the AR-4 seam (remove the ZB push from `rescheduleItem`) → assert the ZB stub was NOT called (harness RED) — proving the seam is what closes the gap.

### ASK-INT-19: reschedule appears on the dispatcher schedule immediately (same-request read)
- **Priority:** P1 · **Type:** Integration [REAL-DB] · **Traces:** AC-4, §4.5, ASK-WRITE-08
- **Assertion:** immediately after the write, a real `getScheduleItems(A, {window})` returns the job at the NEW window (synchronous), no async lag.

### ASK-INT-20: reschedule ZB failure → blocking-with-recovery; local state consistent, call graceful (E4)
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** §5.3, edge E4, G4
- **Steps:** ZB stub `rescheduleJob` throws; forceSyncOnZbError cannot reconcile.
- **Assertion:** `rescheduleItem` throws the friendly 409; the skill returns `{ ok:false, conflict:true, speak:… }`; the DB is left in a recoverable/consistent state per the recovery policy (assert the row is NOT a silent local-only divergence that the master rejected). Sabotage: make the seam swallow the ZB error and keep the local write → assert a divergence (local moved, ZB stub shows the old time) is detected as RED.

### ASK-INT-21: cancel — retention discipline + reason on note + ZB push (real cancelJob path + ZB stub)
- **Priority:** P0 · **Type:** Integration [REAL-DB] · **Traces:** AR-4, AR-5, §4.6, §5.4, AC-5, G5
- **Steps:** seed a ZB-linked open job under A. (a) call cancel with `retentionAttempted:false` → refused, job still open in DB, ZB stub not called. (b) call with empty `reason` → refused. (c) call with `reason:'price', retentionAttempted:true` → job `blanc_status='Canceled'` in DB, ZB stub `cancelJob(zbId)` called, an 'AI Phone' note containing "price" exists, a `job_canceled` domain_event with `retentionAttempted:true` exists.
- **Assertion:** all three sub-steps as stated (the (a)/(b) refusals are the retention/reason gate; (c) is the happy write). **Sabotage:** drop the `retentionAttempted` precondition → assert (a) wrongly cancels on first ask (harness RED).

### ASK-INT-22: MCP JSON-RPC end-to-end over real skill layer (authed) — read + gated write
- **Priority:** P1 · **Type:** E2E [REAL-DB] · **Traces:** AC-10, §8
- **Assertion:** drive the authenticated `/api/agent-skills/mcp` JSON-RPC against the real skill layer + DB: `svc.get_customer_overview` returns the seeded contact's real snapshot; `svc.reschedule_appointment` requires confirmation + L2 and then performs the same real write as ASK-INT-18 (company from `req.companyFilter.company_id`, ignoring any client `company_id`). Confirms both adapters drive one skill layer end-to-end.

---

## Recommended test harnesses to build

1. **Extend `tests/routes/vapi-tools.test.js`** (existing) — add Groups A + H adapter cases (`ASK-VAPI-*`, `ASK-DEG-07`, `ASK-VAPI-22`). Keep every `TC-LQV2-*` green; the delta proves the 5 tools are byte-identical after relocation onto the skill layer and that the `err.message` leak (line 381) is gone. This is the AC-11 regression bar.

2. **New `tests/agentSkills*.test.js` unit suites** (services + zenbookerClient + eventService mocked, mirroring `slotEngineHeldLeads.test.js` idiom):
   - `agentSkillsVerificationGate.test.js` — Group B (`deriveLevel`/`assert`, `verified:true` ignored, L0/L1/L2 derivation, fail-closed).
   - `agentSkillsRunSkill.test.js` — the `index.runSkill` choke-point: unknown skill, graceful guard, soft-vs-hard shapes (Group H).
   - `agentSkillsIdentityResolver.test.js` — Group D (the getLeadByPhone-null bridge, masking, ambiguity, normalization).
   - `agentSkillsIsolation.test.js` — Group C ownership pre-checks (companyId + verified contactId), the `cancelJob(jobId)` trap.
   - `agentSkillsReadSkills.test.js` — Group E read shapes + speech-safety + below-L2 non-disclosure.
   - `agentSkillsStatusMap.test.js` — Group F (real BLANC_STATUSES only; no 'Scheduled').
   - `agentSkillsWriteSkills.test.js` — Group G reschedule/cancel ordering, audit note, retention gate.
   - `scheduleServiceRescheduleZb.test.js` — the AR-4 `rescheduleItem` ZB-seam unit (push only for ZB-linked jobs; best-effort internal push stays non-fatal; blocking-with-recovery on ZB failure).

3. **New MCP suites** mirroring the crmMcp trio:
   - `tests/routes/agentSkillsMcp.test.js` (authed JSON-RPC; mirrors `crmMcp.test.js`), `tests/routes/agentSkillsMcpPublic.test.js` (token-gated public; mirrors `crmMcpPublic.test.js`), `tests/services/agentSkillsMcpRegistry.test.js` (tool defs + requiredLevel projection). Covers Group I — tenant-from-context, the OUTER write/confirmation gate composing with L2, sanitized errors, public writes-disabled, distinct serverInfo. Re-run the existing `crmMcp*` suites unchanged (ASK-MCP-16) to prove the sales stack is untouched.

4. **New `scripts/verify-agent-skills-001.js` real-DB harness** (house `verify-*.js` pattern: tagged self-seeded fixtures, row-targeted assertions, FK-ordered cleanup before each case + start/end, `check/eq/record` kit, `DATABASE_URL` → `postgresql://localhost/twilio_calls`, never prod, exit 0 only on all-pass). Covers Group K [REAL-DB] — identity (incl. the null-getter bridge), verification (incl. `verified:true` ignored), isolation (the cross-company cancel/reschedule/read proofs with `cancelJob(jobId)` as the trap), the 5-tool byte-compat matrix (golden capture pre-refactor), and the reschedule ZB write-through + cancel retention with a **ZB stub**. **Every P0 case carries a sabotage control** (break the invariant, prove RED) so a green run is trustworthy. Sections selectable via `--section=<id>|all`, mirroring `verify-vapi-slot-engine-001.js`.

---

## Traceability matrix (requirement/AC → cases)

| Requirement / AC | Cases |
|---|---|
| **AR-1** provider-neutral skill layer | ASK-GATE-11, ASK-SKILL-*, ASK-MCP-15 (single layer, both adapters) |
| **AR-2** thin vapi-tools adapter | ASK-VAPI-01…22 |
| **AR-3** new MCP surface (reuse crmMcp*) | ASK-MCP-01…16 |
| **AR-4** ZB write-through (reschedule gap) | ASK-WRITE-01, 03, 06, 07; ASK-INT-18, 20 |
| **AR-5** audit note on every write | ASK-WRITE-02, 12, 13; ASK-INT-18, 21 |
| **AR-6** isolation + server-side verification (P0) | ASK-GATE-*, ASK-ISO-*, ASK-MCP-03/11, ASK-INT-06…13 |
| **FR-S1** identifyCaller | ASK-GATE-01/02/06/07, ASK-SKILL-ID-01…06, ASK-INT-01…03 |
| **FR-S2** getCustomerOverview | ASK-SKILL-OV-01…03, ASK-SKILL-EMPTY-01 |
| **FR-S3** getJobStatus | ASK-SKILL-JS-01…03, ASK-SEC-03 |
| **FR-S4** getAppointments | ASK-SKILL-AP-01/02 |
| **FR-S5** rescheduleAppointment | ASK-WRITE-01…08, ASK-INT-18…20 |
| **FR-S6** cancelAppointment | ASK-WRITE-10…16, ASK-INT-21 |
| **FR-S7** getJobHistory | ASK-SKILL-HIST-01, ASK-INT-09 |
| **FR-S8** getEstimateSummary | ASK-SKILL-EST-01/02, ASK-ISO-05, ASK-INT-13 |
| **FR-S9** getInvoiceSummary | ASK-SKILL-INV-01/02, ASK-ISO-06, ASK-INT-13 |
| **status_map** (corrected) | ASK-STATUS-01…04, ASK-SKILL-JS-01/03 |
| **AC-1** identify (never mis-qualify existing) | ASK-SKILL-ID-02, ASK-INT-01 |
| **AC-2** status phrases / multi-job scope | ASK-SKILL-JS-01, ASK-SKILL-OV-03, ASK-STATUS-01 |
| **AC-3** window range / ETA framing | ASK-SKILL-AP-01, ASK-SKILL-JS-01, ASK-SEC-03 |
| **AC-4** reschedule (confirm, ZB, dispatcher, note) | ASK-WRITE-01/02/04/08, ASK-INT-18/19 |
| **AC-5** cancel retention + reason + ZB | ASK-WRITE-10…14, ASK-INT-21 |
| **AC-6** history redaction / L1 must verify | ASK-SKILL-HIST-01, ASK-GATE-10, ASK-INT-09 |
| **AC-7** estimate/invoice / no card by voice | ASK-SKILL-EST-01, ASK-SKILL-INV-01, ASK-SEC-01/04 |
| **AC-8** server-side verification (verified:true ignored) | ASK-GATE-05, ASK-INT-06 |
| **AC-9** isolation (cross-tenant) | ASK-ISO-01…08, ASK-MCP-03/11, ASK-INT-10…13 |
| **AC-10** swappability / MCP equivalence | ASK-MCP-04/15, ASK-INT-22 |
| **AC-11** thin adapter + legacy byte-compat | ASK-VAPI-01…22, ASK-INT-14…17 |
| **AC-12** graceful degradation | ASK-DEG-01…07, ASK-VAPI-22, ASK-MCP-14 |
| **AC-13** repo-config routing (lead-qualifier-v2.json) | ASK-CFG-01 (below) |
| **Edge E1–E15** | E1:ASK-SKILL-EMPTY-01 · E2:ASK-SKILL-OV-03 · E3:ASK-GATE-06/ASK-SKILL-ID-04/ASK-INT-03 · E4:ASK-WRITE-03/ASK-INT-20 · E5:ASK-DEG-05 · E6:ASK-WRITE-17 · E7:ASK-SKILL-AP-02 · E8:ASK-WRITE-15 · E9:ASK-WRITE-05 · E10:ASK-GATE-10/ASK-DEG-03 · E11:ASK-GATE-07/ASK-SKILL-ID-03/ASK-INT-02 · E12:ASK-SKILL-EST-02/ASK-ISO-05-06 · E13:ASK-GATE-12/ASK-DEG-07 · E14:ASK-WRITE-10/11 · E15:ASK-GATE-05/ASK-INT-06 |

### ASK-CFG-01: repo assistant JSON routes existing-vs-new, offers skills, passes only skill-shaped args (AC-13)
- **Priority:** P2 · **Type:** Unit (config lint) · **Traces:** AC-13, §11
- **Assertion:** parse `voice-agent/assistants/lead-qualifier-v2.json`: `model.tools[]` contains the 9 skill tool-defs (same `function`/`server` shape as the 5 existing; `server.url` = `https://api.albusto.com/api/vapi-tools`); the routing prompt instructs identify-first-then-branch; tool arg schemas are skill-shaped (identity block + skill fields). The **live** assistant (`30e85a87`) is NOT touched by this pipeline (owner-gated PATCH). Mirrors the assistant-JSON lint in `verify-vapi-slot-engine-001.js`.
