# AGENT-BOOKING-FAIL-001 — outbound lead booking graceful failure

Status: implementation draft, 2026-07-19. Production attribution is based only on
the owner-provided VAPI artifact plus code and a local real-PostgreSQL reproduction;
the lost production stack is not reconstructed or guessed. Production customer PII
is intentionally omitted from this artifact.

## Incident contract

An outbound lead call offered a concrete arrival window. The customer selected it,
`confirmLeadBooking` received a valid `chosenSlot` and validated service address, but
returned:

`I had trouble locking that time in — let me have a teammate confirm it with you.`

The caller-facing refusal remains unchanged. The internal failure must be searchable
by the stable prefix `[agentSkills] confirmLeadBooking failed:` and include the stack
plus only PII-free booking context.

Date correction: 2026-07-20 was Monday, not Sunday. At the reported 21:10Z call time,
the company-local time in America/New_York was approximately 17:10 on Sunday July 19;
the selected window was the next day, Monday July 20.

## Root cause

`5178b94` (OLC-POSTCALL-001, 2026-07-14) added `Status: 'Review'` to the same
`leadsService.updateLead` call that writes `LeadDateTime` and `LeadEndDateTime`.
Migration 095 had added the `Review` state to published lead workflows, but it added
only transitions *out of* Review. Existing non-final states had no transition *into*
Review.

`leadsService.updateLead` validates every status change through the active company
SCXML. For a normal `Submitted` lead, `resolveTransition(companyId, 'lead',
'Submitted', 'Review')` returns `{ valid:false, error:'Transition not allowed' }`.
`updateLead` throws `LeadsServiceError` with `code='FSM_TRANSITION_DENIED'` and
`httpStatus=403` before executing the hold UPDATE. `confirmLeadBooking` caught that
error without logging it and returned the incident phrase.

The local real database independently confirmed that its active lead graph contained
Review but rejected `Submitted → Review`, `Contacted → Review`, and
`Proposal Sent → Review`. The new regression constructs the reported Monday
10:00–12:00 booking on the real skill/service/FSM/PG stack: before migration it gets
the exact refusal and leaves both hold columns null; after migration it succeeds and
stores 14:00Z–16:00Z (America/New_York EDT).

This is a deterministic code regression. Proving that it was the exact production
exception for this one lead still requires the lead's status at the tool-call time or
the lost stack; see Questions.

## End-to-end trace

1. `outboundLeadCallService.processLeadAttempt` re-reads the lead under the attempt's
   `company_id`, calls `recommendSlots`, and refuses to dial if no eligible slot exists.
2. `outboundCallService.placeCall` injects `companyId`, `leadUuid`, `slotKey`, and slot
   fields into VAPI `assistantOverrides.variableValues`.
3. `POST /api/vapi-tools` authenticates with `x-vapi-secret`. `buildSkillInput` spreads
   the server-injected variable values after model arguments, so the model cannot
   replace tenant/entity identity or the offered key.
4. `agentSkills.runSkill` resolves `confirmLeadBooking` from the registry as an L0
   write. The shared verification gate is still called, but L0 passes. Wave-3 MCP
   authorization is not involved: `confirmLeadBooking` is deliberately absent from
   the MCP registry and is voice-only.
5. `confirmLeadBooking.run` uses the injected `input.companyId` (`cid`), not the VAPI
   transport's default company argument, for every lead/slot/write operation.
6. `leadsService.updateLead(leadUuid, hold, cid)` maps the hold fields, validates the
   status transition against that company's active lead SCXML, and then performs an
   UPDATE with both `uuid` and `company_id` predicates.

### `confirmLeadBooking` refusal/failure inventory

| stage | outcome | causes represented or masked |
|---|---|---|
| injected identity guard | pull-up refusal | missing/falsy server-injected `leadUuid` or `companyId`; no read/write |
| chosen-slot guard | `needsConfirmation` refusal | missing/non-object slot; date/start/end fail the existing shape regex; non-positive/inverted span |
| offered guard | teammate-confirm refusal | derived key differs from injected `slotKey` and live `recommendSlots` returns fallback/unavailable/empty/no matching key, or unexpectedly throws |
| live revalidation internals | same offered-guard refusal | smart-slot app disconnected; no resolvable location; target day outside engine window; dispatch settings/timezone unavailable; roster/service-area resolution failure; no eligible technicians; schedule/time-off filtering removes candidates; slot engine missing/non-2xx/timeout/malformed/empty |
| tenant-scoped lead read | not-found refusal | `LEAD_NOT_FOUND` (including foreign-company UUID), PG/query failure, row mapping failure |
| closed-status guard | closed refusal | case-insensitive `Lost` or `Converted` |
| supplied address validation | address refusal | `validateAddress` throws, returns null, or returns `valid:false` |
| stored-address guard | address refusal | no provided address and lead lacks street plus city/postal code |
| hold try/catch (incident phrase) | lock-in refusal | module/load fault; `tzCombine`/date conversion error (invalid date/time/timezone leading to invalid Date/RangeError); any `updateLead` failure: custom-field lookup/query error, FSM graph query/parse error, `FSM_TRANSITION_DENIED`, validation error, UPDATE/constraint/connection error, tenant-scoped zero-row `LEAD_NOT_FOUND` |
| attempt flip | non-fatal log, success retained | PG failure updating the matching `company_id + lead_uuid + dialing` attempt; zero rows is idempotent success |
| event audit | silently non-fatal | event service load/call failure or fire-and-forget event insert failure |
| shared `runSkill` backstop | generic safe fallback | any throw that escapes the skill; verification-required is impossible for this registered L0 skill |

`resolveTimezone` currently catches dispatch-settings errors and returns
America/New_York, so ordinary dispatch-settings read failures do not reach the
incident catch. `tzCombine` can still throw for invalid conversion inputs. Neither
the ownership read nor `updateLead` returns a nullable success: they throw on missing
or failed work.

### `bookOnLead` inventory

`bookOnLead` is a separate inbound L1 write. `runSkill` can stop it at the verification
gate (`needsVerification`) before the module runs. Inside the module:

| stage/site | outcome | causes represented or masked |
|---|---|---|
| company/contact guard | pull-up refusal | missing `companyId` or missing server-verified `contactId` |
| slot guard | `needsConfirmation` refusal | missing/malformed `chosenSlot`; unlike `confirmLeadBooking`, this guard does not check positive span |
| line 108 slot-compose catch | incident-style lock-in refusal | module/load fault, timezone resolution or `tzCombine`/Date conversion error; ordinary dispatch read error defaults to America/New_York |
| open-lead read catch | pull-up refusal | `getOpenLeadsByContact` PG/query/row-mapping failure; read is contact + company scoped |
| ownership re-assertion | ownership refusal | returned lead's `ContactId` does not match the verified contact (defensive impossible-state guard) |
| line 150 update catch | incident-style lock-in refusal | `updateLead` custom-field lookup/query error, validation error, UPDATE/constraint/connection failure, concurrent deletion/foreign zero-row `LEAD_NOT_FOUND`; this hold carries no Status, so it does not hit the Review FSM regression |
| no-open-lead fallback | get-booked refusal | delegated `createLead` throws, returns null, or returns `success !== true`; includes phone guard and both create retries failing |
| audit | non-fatal log, success retained | event logging throws after the hold/create has succeeded |
| shared `runSkill` backstop | generic safe fallback | unexpected escape; L1 verification failure is handled before skill execution |

## Suspect cross-check

| suspect | finding |
|---|---|
| TENANCY-RBAC waves 1–3 | Not causal. Wave 1 did not touch this path. Wave 2 changed only lead SSE commentary/tenant fan-out behavior in `leadsService`, not the hold write. Wave 3 gates MCP tools; `confirmLeadBooking` is not MCP-exposed and VAPI dispatch is unchanged. |
| `836b791` weak public-surface gating | Not causal. It changed Twilio signatures, portal public gates, and events stats; it did not touch `/api/vapi-tools`, agent skills, lead writes, or slot calculation. |
| missing company scope after hardening | Not present in this call. The pre-dial attempt supplies `companyId`, VAPI variable injection wins over model args, the skill checks it, and both lead read/write receive `cid`. The failing regression occurs *because* the correctly company-scoped write loads and enforces that company's FSM. |
| TECH-SCHEDULE-001 / settings / zones | Not the incident catch. These changes are on the offer path: unavailable company schedule, unresolved service-area target, no eligible tech, schedule gap, or time off yields no smart recommendation. The worker then does not place the call. A changed slot revalidation returns the distinct offered-guard phrase. When `chosenSlot` matches injected `slotKey`, confirm does not call the slot engine at all. |
| robot actor / `created_by` | Not present. The hold update and attempt flip do not write a crm-user FK. The migration uses the existing FSM `created_by/published_by` text columns with `system`. |
| Sunday/date window | Factually not Sunday: July 20 was Monday. TECH-SCHEDULE filters smart offers before dialing. This incident phrase is emitted later by the hold/FSM catch, not by offer filtering. |
| concrete regression | `Status:'Review'` was made atomic with the hold, but the published SCXML has no inbound Review transition. `FSM_TRANSITION_DENIED` aborts the entire update. |

## Fix

- Migration 188 versions each company's active lead SCXML and adds a hidden
  `AI_BOOKING_TO_REVIEW → Review` edge to every non-final state except Review.
  There is no `blanc:action=true`, so no new human workflow button appears. Existing
  edges, final states, company scope, and FSM enforcement remain intact.
- The migration is replay-safe. Its paired rollback publishes a new version with
  only those exact hidden edges removed; it does not destructively edit history.
- `confirmLeadBooking` now logs the caught stack with the stable prefix and only:
  company ID, internal lead UUID, chosen date/window, offered-key-match boolean, and
  booleans for address/coordinate presence. It never logs name, phone, street,
  city, ZIP, or coordinates. The speech-safe refusal is unchanged.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `POST /api/vapi-tools` → `confirmLeadBooking` | server-injected `variableValues.companyId`; skill ignores transport default for ownership | injected `leadUuid`, final UPDATE uses `uuid + company_id` | VAPI shared-secret + L0 outbound-system skill; not user-role callable; absent from MCP | outbound system ✓; MCP/user roles ✗ | spoofed model args are overwritten; foreign UUID is 404-equivalent and unchanged |
| outbound attempt flip | same injected company ID | `company_id + lead_uuid + status='dialing'` | same internal call | outbound system ✓ | zero-row update is safe; no cross-company natural-key action |
| migration 188 / rollback 188 | each active `fsm_machines.company_id` carried into the new `fsm_versions` row and machine UPDATE | `machine_id + company_id + active_version_id` | deploy-only DB migration | deploy operator ✓; application roles ✗ | every tenant is versioned independently; no company data enters another SCXML |

Existing `tests/confirmLeadBooking.test.js` covers own/foreign behavior and injected
identity precedence. The real-PG regression additionally seeds two companies with the
same phone, proves an A-scoped call naming B's lead refuses, and proves B remains
byte-unchanged before and after A's booking. There is no end-user role matrix for this
voice-only internal L0 surface; user roles cannot invoke it through MCP.

## Verification

### Tests and exact commands

- Pre-fix red reproduction (real PostgreSQL; before migration implementation):

  `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/agentBookingFsmRegression.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand`

  Result: exit 1; 1 suite failed / 1 test failed. The real skill returned the lock-in
  refusal (`out.success` was undefined) where success was expected; the transaction
  rolled back.

- Focused implementation run (unit logging/guards plus real PostgreSQL migration,
  replay, rollback, tenant isolation, and incident booking):

  `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/confirmLeadBooking.test.js tests/agentBookingFsmRegression.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand`

  Final result after explicit test-owned SSE timer cleanup: exit 0; 2 suites passed /
  32 tests passed; no open-handle warning.

- Broader affected-area regression (confirm/bookOnLead, agent verification gate, FSM,
  outbound worker/webhook, TECH-SCHEDULE day-off/service-area offer filters, and
  tenant-safety lint):

  `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/confirmLeadBooking.test.js tests/agentSkillsBookOnLead.test.js tests/agentSkillsGate.test.js tests/services/fsmService.test.js tests/outboundLeadCallWorker.test.js tests/outboundLeadCallWebhook.test.js tests/slotEngineDayOffFilter.test.js tests/slotEngineServiceAreas.test.js tests/tenantSafetyLint.test.js --testPathIgnorePatterns "/node_modules/" --runInBand`

  Result: exit 0; 9 suites passed / 225 tests passed. Jest emitted its generic
  post-run open-handle warning from the broader existing module set; the process then
  exited and a process sweep found no remaining Jest process. The focused new DB suite
  owns and stops the SSE interval it loads, as shown by the clean final focused run.

- Diff hygiene:

  `git diff --check`

  Result: exit 0; no whitespace errors.

### Sabotage controls

- Broke: inserted a temporary unconditional `CONTINUE` in migration 188's state loop,
  disabling every hidden Review-edge insertion.
- Red command:

  `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/agentBookingFsmRegression.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand`

  Result: exit 1; 1 suite failed, 1 test failed / 1 passed. The detector failed at
  `resolveTransition(Submitted, Review)`: expected `{valid:true,targetState:'Review'}`
  and received `{valid:false}`.
- Restored: removed only the temporary sabotage lines with the inverse patch.
- Green command: the same real-PG command above.
- Result: exit 0; 1 suite passed / 2 tests passed. A later final rerun after the
  test-owned SSE cleanup also passed 2/2 without an open-handle warning.

### Live production

Not run. The engineer has no production access. No deploy, migration application,
VAPI change, or customer call was performed.

## Risks and deployment notes

- Migration 188 must be applied before/restart with the application. The FSM graph is
  process-cached; the normal container recreate clears it. Applying the SQL to a
  long-lived process without a restart can leave the old graph cached.
- The migration changes only active lead graphs that already contain Review, matching
  migration 095 and the reproduced active graph. A custom active graph that removed
  Review is not fabricated silently; it needs explicit workflow repair.
- The incident's VAPI `slotKey` equality means confirm trusts the pre-dial smart offer.
  This task does not broaden scope into revalidating a previously offered slot at
  confirm time; TECH-SCHEDULE already filters the offer before the worker dials.

## Questions

To turn the incident attribution from code-proven/high-confidence into historical
certainty, pull either of these production facts if still available:

1. The lead's `status`, `lead_date_time`, and `lead_end_date_time` immediately after
   the failed tool call (a still-Submitted/null/null row matches the reproduction).
2. The active lead FSM state block for that company at the incident time, or current
   active version number plus whether Submitted had any transition targeting Review.
