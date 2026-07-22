# AGENT-FINANCE-CONTEXT-001 — Voice-agent estimate and invoice context

Status: implemented locally; live VAPI synchronization pending credentials  
Owner: Albusto  
Surfaces: inbound Sara, outbound parts-visit scheduler, outbound lead caller, provider-neutral agent skills, VAPI REST tools, service-CRM MCP  
Migrations: none

## Requirements

### Scope

Extend the existing `getEstimateSummary` and `getInvoiceSummary` skills so all three voice assistants can explain the customer-facing repair work and price from the estimate or invoice associated with the call's customer and repair. Reuse the existing estimate/invoice services and records. Do not create duplicate finance skills, tables, or migrations.

The disclosable spoken fields are:

- customer-facing item name;
- quantity and line amount;
- subtotal, discount, tax, total, amount paid, and amount due;
- customer-facing document state.

Never surface SKU/code fields, internal or technician notes, item metadata, card/payment credentials, payment-source data, raw database status tokens, or more than five line items in one spoken breakdown. When more than five items exist, offer the complete written document.

Amounts are fetched on demand through the skills. No assistant prompt or VAPI variable may contain an estimate total, invoice total, amount paid, or balance due.

### Owner Decision 1 — phone-only verification

Owner decision, verbatim: **“Ничего просить не нужно, номера телефона достаточно”**.

- Finance disclosure remains `requiredLevel: L1`.
- Do not request name + ZIP, street, an SMS code, or any other second factor before finance disclosure.
- A single company-scoped customer match for the caller phone may receive finance disclosure without additional questions.
- This decision does not authorize cross-company access, arbitrary document-ID access, or selecting one person silently when the phone maps to several distinct customers.

**OWNER-ACCEPTED RESIDUAL RISK:** A person answering a phone shared with the customer can hear that customer's repair price. The owner chose phone-only disclosure knowingly.

This limitation is intentional. Do not later raise these two finance skills to L2 or add a second-factor challenge without a new owner decision.

### Finance-only shared-phone subject guard

The existing booking identity behavior remains unchanged: `identityResolver` may select the newest contact when a phone maps to several contacts. Finance disclosure adds a narrower guard after L1 resolution:

1. If `phoneCandidateCount <= 1`, disclose an associated document without asking an identity question.
2. If `phoneCandidateCount > 1`, do not use the resolver's newest-contact choice alone to select finance.
3. An exact, company-scoped job or lead may disambiguate the repair subject when that subject is associated with one of the contacts sharing the caller phone.
4. Without an unambiguous job/lead subject, return a non-disclosing clarification such as “Which repair are you asking about — the refrigerator or the dryer?” or decline.
5. A foreign, unrelated, or nonexistent subject/document returns the same generic refusal and no amount.

No change is permitted to the latest-contact behavior used by booking, cancellation, rescheduling, or lead creation.

### Owner Decision 2 — draft estimates are silent

Owner decision, verbatim: **“Черновики не озвучивать вообще”**.

- A draft estimate amount, total, item, count, or identifying finance detail is never returned or spoken, even when explicitly requested by estimate ID.
- A draft-only result says only that the estimate is still being prepared and the team will follow up.
- Only `sent` and `approved` estimates are disclosable.
- When both exist for the same subject, prefer `approved` over `sent`.
- If several equally decision-relevant non-draft estimates remain, return a short selection list and ask which one.

For invoices, exclude draft invoices. Prefer an invoice with a positive balance. If several equally relevant invoices remain, return a short selection list and ask which one.

### Voice states

| State | Required behavior |
|---|---|
| approved estimate | State that it is approved, then give up to five customer-facing items and totals. |
| sent estimate | State that it was sent and has not been approved, then give the requested breakdown. |
| draft estimate | No amount or item. Say the estimate is still being prepared and the team will follow up. |
| no disclosable estimate | Say no ready estimate is available for that repair. |
| several equally relevant estimates | Briefly list document number/date/state; ask which. Do not choose newest silently. |
| invoice with balance | State invoice number, total, paid, due, and up to five customer-facing items. |
| paid invoice | State paid in full and the total; never imply a balance. |
| shared-phone ambiguous subject | Ask which repair, or decline. No amount or item in the clarification result. |
| foreign/unassociated document | Generic not-found/refusal shape, indistinguishable from nonexistent. |

### Owner-facing sample utterances

- Approved estimate: “Estimate EST-104 is approved. The breakdown is a control board, quantity one, $420; and installation labor, quantity one, $180. The subtotal is $600, the discount is $30, tax is $37.50, and the total is $607.50. I can send the written estimate if you’d like.”
- Sent estimate: “Estimate EST-104 was sent and hasn’t been approved yet. Its total is $607.50. Would you like the item breakdown?”
- Invoice with balance: “Invoice INV-88 totals $607.50. We’ve received $100, so $507.50 is still due. I can send a secure payment link or connect you with a teammate.”
- Paid invoice: “Invoice INV-88 is paid in full. The total was $607.50.”
- Draft estimate: “We’re still preparing that estimate. The team will follow up when it’s ready.” No amount, item, count, or document number follows.
- No ready estimate: “I don’t see an estimate that’s ready for that repair. I can have the team follow up.”
- Several equally relevant documents: “I see estimate EST-104, approved, and estimate EST-107, approved. Which one would you like?”
- Shared phone, unclear repair: “I see more than one customer on this phone. Which repair are you asking about—the refrigerator or the dryer?” No finance detail follows until the repair subject is unambiguous.
- Phone does not establish L1: “I can’t access financial details from this phone. I can have the team follow up.” The agent does not ask for name, ZIP, street, or a code as a finance workaround.

## Architecture

### Shared definition and adapters

`backend/src/services/agentSkills/financeToolDefinitions.js` is the single source for the two finance tools' skill names, MCP names, L1 requirement, descriptions, identity/subject fields, and VAPI/MCP schemas.

- `agentSkills/registry.js` consumes the shared metadata for REST dispatch.
- `agentSkillsMcpRegistry.js` consumes the MCP projections.
- `scripts/sync-vapi-finance-tools.js` materializes the VAPI projections into the three repository assistant JSON files and verifies them with `--check`.
- Each assistant retains an explicit allowlist. Finance is allowed for Sara, parts, and lead; unrelated tools do not spread between assistants.

The three remote VAPI assistants remain separate resources and require three separate PATCH calls. The sync script must GET each live assistant first, merge only the intended model/prompt fields, re-inject the real VAPI tool secret, PATCH through the REST API, then GET and compare. The VAPI CLI update path is not used.

### Call context and tenancy

The VAPI webhook remains secret-authenticated. For outbound calls, the API resolves `message.call.id` against `outbound_call_attempts.vapi_call_id`, then obtains company, job/lead, contact, scenario, and phone from that stored row. Model arguments and echoed VAPI variables cannot replace those values. A call ID associated with more than one company fails closed.

Inbound calls retain the existing server-side default-company binding. MCP obtains company only from `req.companyFilter.company_id` (or the existing environment-bound public MCP context). Client `company_id` is stripped.

### Finance subject resolver

A shared internal finance-disclosure helper:

- accepts only the server-derived L1 context plus optional job/lead subject fields;
- returns an amount-free teammate-follow-up refusal, not a name/ZIP or OTP challenge, when the caller phone cannot establish L1;
- loads jobs/leads with explicit `companyId`;
- for a shared phone, confirms the chosen subject contact is among that company's contacts matching the phone;
- returns an effective contact/job/lead scope to both finance skills;
- never changes the general identity resolver's take-latest decision.

Specific estimates/invoices are fetched company-first, then checked against the effective contact/job/lead. List calls use those same company and subject filters. Child item reads happen only after the company-scoped parent is authorized.

### Document selection and output

Estimate selection filters to `approved` and `sent`, ranks approved first, and asks when several documents remain at the best rank. Draft detection happens before summary creation and returns no numeric finance fields.

Invoice selection filters out `draft`, ranks positive-balance invoices first, and asks when several remain at the best rank.

Successful output contains at most five line items in this shape:

```json
{ "name": "Control board", "quantity": 1, "amount": 420.00 }
```

No description, SKU, unit code, metadata, internal note, or payment data is included.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `POST /api/vapi-tools` inbound | server-bound default company + caller phone | phone, optional company-scoped job/lead/document | `x-vapi-secret` transport gate; skill `L1` | VAPI secret ✓; missing/wrong secret ✗ | Same phone can exist in many companies; company is never accepted from tool arguments. |
| `POST /api/vapi-tools` outbound | company and subject from stored attempt resolved by VAPI call ID | `vapi_call_id`, job/lead/contact | `x-vapi-secret` transport gate; skill `L1` | VAPI secret ✓; missing/wrong secret ✗ | External call IDs are natural keys; multi-company collision must fail closed. |
| authenticated service MCP | `req.companyFilter.company_id` | contact phone, optional job/lead/document | `estimates.view` or `invoices.view` | role with matching view permission ✓; every role lacking it ✗ | Client tenant/document selectors must not widen server context. |
| public service MCP | environment-bound company | contact phone, optional job/lead/document | existing public MCP read permission allowlist | enabled bearer with finance permission ✓; disabled/wrong bearer/no permission ✗ | Shared public token is company-bound; no client company override. |
| estimate/invoice aggregate | explicit skill `companyId` | company + contact/job/lead + document parent | inherited from invoking tool | invoking allow path ✓; denied before service ✗ | Parent must be company-scoped before child item lookup. |
| live VAPI config sync | explicit assistant allowlist + VAPI bearer | assistant ID | deployment credential | owner-approved operator ✓; no key/dry-run ✗ | Three remote resources can drift; GET/merge/PATCH/GET each independently. |

Required tests per company-scoped surface: `T-own`, `T-foreign` (not-found semantics), `T-blast` with the same phone/external ID in companies A and B, every MCP `R-matrix` deny cell, and tenant-guard sabotage.

## Tasks

### T1 — Durable contract

Write this specification, including owner decisions, residual risk, voice states, tenancy/roles, tasks, sabotage controls, and verification commands.

Acceptance: the durable artifact contains both owner decisions verbatim, the exact residual-risk statement, a filled Tenancy & Roles table, T1–T8, exact verification commands, sabotage results, architecture, and changelog.

### T2 — Trusted VAPI call context

Resolve outbound VAPI call IDs to stored attempts, fail closed on cross-company ambiguity, and merge stored context after model arguments. Keep the inbound default-company behavior and existing outbound writes compatible.

Acceptance: stored company/job/lead/contact/phone wins over model or echoed variables; a call ID present under two companies invokes no skill; inbound default-company behavior and existing booking tests stay green.

### T3 — Finance-only subject authorization

Add the shared-phone ambiguity guard and company/contact/job/lead association resolver without changing booking identity resolution.

Acceptance: one phone/contact discloses at L1 without a challenge; a shared phone discloses only after an exact associated job/lead subject; ambiguity and foreign subjects return amount-free results; booking take-latest tests stay green.

### T4 — Extend existing finance skills

Extend `getEstimateSummary` and `getInvoiceSummary` with subject scoping, deterministic selection, draft silence, safe line items, totals, status-aware speech, and five-line caps.

Acceptance: draft estimates never expose numeric or item data; approved outranks sent; positive-balance invoices outrank paid invoices; ties request selection; successful results contain only allowed fields and at most five line items.

### T5 — Shared tool definitions

Create one finance definition source consumed by the skill registry, MCP registry, VAPI config sync, and parity tests. Keep both skills at L1.

Acceptance: changing a shared finance schema makes projection/parity tests fail; both skills remain L1 in registry, MCP, and all three VAPI projections.

### T6 — Wire all three assistants

Materialize the two finance tools in Sara, parts, and lead allowlists. Update prompts for on-demand finance, shared-phone repair clarification, draft silence, five-line speech, and secure written detail. Remove preloaded `balanceDue` from the parts prompt and outbound call variables.

Acceptance: Sara exposes 15 tools, parts exposes 4, and lead exposes 5; each contains both finance tools; no amount-bearing variable/key is present in any assembled prompt/config; unrelated tools and existing flows remain unchanged.

### T7 — MCP parity

Project the shared finance schemas into MCP while preserving tenant-from-context, permissions, confirmation rules for unrelated writes, and public-transport restrictions.

Acceptance: MCP uses `estimates.view`/`invoices.view`, rejects deny-matrix roles, ignores client company selectors, and exactly matches the shared finance schemas.

### T8 — Verification and live synchronization

Run focused and regression suites, execute every named sabotage as BREAK→red→restore, validate all assistant projections, GET/PATCH/GET each live assistant when credentials and IDs are present, and record exact results below.

Acceptance: all local suites and config checks pass after restoration; all four required sabotages demonstrably turn their named control red; live check/apply either verifies all three assistants or records the exact preflight blocker without mutation.

## MANDATORY Verification

### Exact commands

Focused skill/API/MCP/config suite:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/agentFinanceContext.test.js tests/agentSkillsSensitiveReads.test.js tests/agentSkillsGate.test.js tests/agentSkillsIdentity.test.js tests/agentSkillsMcp.test.js tests/routes/vapi-tools.test.js tests/vapiToolsVariableValues.test.js tests/vapiFinanceContextRoute.test.js tests/outboundCallService.test.js tests/outboundCallWorker.test.js --runInBand --testPathIgnorePatterns /node_modules/
```

Tenant-safety suite:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/agentFinanceTenancy.db.test.js tests/tenantSafetyLint.test.js --runInBand --testPathIgnorePatterns /node_modules/
```

Assistant projection and prompt-injection check:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca scripts/sync-vapi-finance-tools.js --check
```

Live GET-first drift check without mutation:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca -r dotenv/config scripts/sync-vapi-finance-tools.js --live-check
```

Owner-approved live GET/merge/PATCH/GET:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca -r dotenv/config scripts/sync-vapi-finance-tools.js --live-apply
```

### Mandatory sabotage controls

Each control is executed against the real guarded path. Copy the modified file first, make one minimal break on top of the uncommitted implementation, run the named test and observe red, restore by reversing that exact edit or restoring the temporary copy, then rerun green. Never use `git checkout` to restore sabotage.

| Control | Attack and invariant | Test that must turn red |
|---|---|---|
| `SAB-FIN-CROSS-CUSTOMER` | Phone shared by contacts A+B; without an exact associated job/lead subject, finance refuses/clarifies and never contains the other contact's sentinel amount. Break: bypass `phoneCandidateCount > 1` subject guard. | `tests/agentFinanceContext.test.js` — `SAB-FIN-CROSS-CUSTOMER` |
| `SAB-FIN-DRAFT-SILENCE` | A draft estimate exists and is requested explicitly; no amount/item/count is returned. Break: route the explicit-draft branch into `summarize` instead of the silent result. | `tests/agentFinanceContext.test.js` — `SAB-FIN-DRAFT-SILENCE` |
| `SAB-FIN-COMPANY-SCOPE` | Companies A+B share phone and document identifiers; A cannot read B and B stays unchanged. Break: remove the finance parent query's `company_id` predicate in the isolated real-DB fixture. | `tests/agentFinanceTenancy.db.test.js` — `SAB-FIN-COMPANY-SCOPE` |
| `SAB-FIN-ONDEMAND` | No amount-bearing variable or literal finance amount is present in any of the three assembled assistant prompts/configs. Break: add `balanceDue` to one prompt or variable reference. | `scripts/sync-vapi-finance-tools.js --check` — `SAB-FIN-ONDEMAND` |

Exact named-sabotage test commands, run once broken to observe red and again after exact restoration to observe green:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/agentFinanceContext.test.js --runInBand --testNamePattern SAB-FIN-CROSS-CUSTOMER --testPathIgnorePatterns /node_modules/
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/agentFinanceContext.test.js --runInBand --testNamePattern SAB-FIN-DRAFT-SILENCE --testPathIgnorePatterns /node_modules/
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/agentFinanceTenancy.db.test.js --runInBand --testNamePattern SAB-FIN-COMPANY-SCOPE --testPathIgnorePatterns /node_modules/
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca scripts/sync-vapi-finance-tools.js --check
```

Additional controls:

- `SAB-FIN-MULTI-DOC`: equally ranked documents return selection, never a silent newest pick.
- `SAB-FIN-FOREIGN-DOC`: foreign/nonexistent document IDs have indistinguishable amount-free refusals.
- `SAB-FIN-MCP-PARITY`: changing one projected finance schema makes registry/config parity red.
- `SAB-FIN-L1-POLICY`: both finance skills remain L1; a future L2 change makes parity tests red.
- `SAB-FIN-NO-INTERNALS`: output contains no descriptions, metadata, SKU/code, notes, or payment/card fields.
- `SAB-FIN-OUTBOUND-SPOOF`: model-provided company/job/lead/contact cannot override stored outbound attempt context.

### Results

| Date | Command/control | Result |
|---|---|---|
| 2026-07-21 | Pre-change focused `agentSkillsSensitiveReads`, `agentSkillsGate`, `agentSkillsMcp` | PASS — 3 suites, 67 tests. Confirms the starting L1 behavior. |
| 2026-07-21 | Focused implementation suite (exact command above) | PASS — 10 suites, 216 tests. Jest retained an existing async handle after reporting; the runner was explicitly closed after the pass result. |
| 2026-07-21 | Tenant-safety suite (exact command above) | PASS — 2 suites, 13 tests, including real PostgreSQL T-own/T-foreign/T-blast. |
| 2026-07-21 | Assistant projection `--check` | PASS — Sara, parts, and lead match the shared definitions; no injected finance key. |
| 2026-07-21 | `SAB-FIN-CROSS-CUSTOMER` BREAK→red→restore | PROVEN — bypassing the shared-phone subject branch made the named test fail (`ok:true` instead of `subjectAmbiguous`); exact reversal restored green. |
| 2026-07-21 | `SAB-FIN-DRAFT-SILENCE` BREAK→red→restore | PROVEN — routing a draft into `summarize` made the named test fail (`ok:true` instead of `draftPending`); exact reversal restored green. |
| 2026-07-21 | `SAB-FIN-COMPANY-SCOPE` BREAK→red→restore | PROVEN on real PostgreSQL — replacing `e.company_id = $2` with a non-scoping `$2` predicate returned company B's `$999.99` estimate and made the named test red; exact reversal restored green. |
| 2026-07-21 | `SAB-FIN-ONDEMAND` BREAK→red→restore | PROVEN — adding `balanceDue` to the parts config made `--check` exit 1 and name the parts assistant; exact reversal restored all three green. |
| 2026-07-21 | Live VAPI `--live-check` | BLOCKED before network/mutation — `VAPI_API_KEY`, `VAPI_TOOLS_SECRET`, `VAPI_OUTBOUND_ASSISTANT_ID`, and `VAPI_LEAD_CALL_ASSISTANT_ID` are absent in this worktree environment. Command exited 1 with `VAPI_API_KEY is required`. No remote assistant was changed. |

## Changelog

### 2026-07-21 — initial implementation contract

- Recorded the owner's phone-only L1 decision and accepted residual risk.
- Added a finance-only shared-phone subject guard while preserving booking take-latest behavior.
- Made draft-estimate silence absolute.
- Accepted customer-safe line-item and totals disclosure, capped at five spoken lines.
- Selected on-demand finance retrieval, three explicit VAPI allowlist updates, shared schema projection, and GET-first REST synchronization.

### 2026-07-21 — local implementation

- Extended the two existing finance skills; no duplicate skills, tables, or migrations were added.
- Added the phone-only, finance-specific subject resolver and kept the general booking resolver unchanged.
- Projected one shared finance definition into the skill registry, MCP registry, and all three explicit assistant allowlists.
- Removed parts-call `balanceDue` prompt injection and made all finance retrieval on demand.
- Added trusted outbound VAPI call-context lookup, cross-company collision refusal, safe finance summaries, deterministic document ranking, and the five-item speech cap.
- Proved all four mandatory sabotages red and restored them green. Local implementation and tenancy suites pass; live VAPI synchronization remains pending the credentials listed in Results.

## Production deploy + live VAPI patch — 2026-07-20

Deployed master `59793dd` (feature `6a4a6e4` + the accumulated OB-17..22 / inspector
tail). Migration **194** (notes dedup) applied — idempotent JSONB cleanup. Backup 89M,
rollback image `35f9d13f3539`. Backend artifact verified in the running container
(`financeDisclosure.js` present, draft-silence live); `/api/vapi-tools` answers POST 401
(signed webhook), the route exists.

**The three live VAPI assistants were patched** with `scripts/sync-vapi-finance-tools.js`,
run inside the app container (voice-agent/ is not baked into the image — `docker cp`'d in,
removed after). Method was GET-first, per the "Sara live-config drifts" lesson:

1. Backed up all three live assistant configs to `/tmp/vapi-live-*.json` on the box.
2. Diffed each live prompt against the repo desired prompt BEFORE mutating. The only
   "live-only" lines were the OLD prohibition the feature intentionally reverses
   ("Do NOT quote a repair price…") — no unrelated hand-edits were being clobbered.
   Verified the separate "no payment collection by voice" rule SURVIVES in the reworded
   prompts (payment/collect mentions: parts 2, lead 5) — enabling price quotes did not
   accidentally enable voice payment.
3. `--live-apply`: PATCH sara / parts / lead, each verified by a follow-up GET.
4. Final `--live-check`: all three `tools=match prompt=match`; getEstimateSummary and
   getInvoiceSummary confirmed present on every assistant (Sara 15 tools, parts 4, lead 5).

logout-all (3 sessions), KC force-recreated (theme changed), smoke green (api/app/well-known
200, unsigned vapi-tools 401), 0 errors in 8 minutes.
