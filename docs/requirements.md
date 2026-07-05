# Blanc Contact Center — Requirements

> Formalized feature requirements for the system.

---

## LQV2: Lead Qualifier v2 — AI Inbound Phone Assistant

**Status:** Requirements
**Priority:** P0
**Owner:** Voice / CRM
**Spec:** `voice-agent/assistants/lead-qualifier-v2-spec.md`
**Predecessor:** Lead Qualifier v1 (`48844b0e-93aa-4d32-aab9-81a3972e9502`) — greeting + basic zip check only

### 1. Description

An autonomous AI voice assistant (VAPI platform, GPT-4o, Azure/Andrew voice, persona "Alex") that handles inbound service calls end-to-end for ABC Homes Appliance Repair. The assistant qualifies leads, collects unit/problem/contact/address data, checks schedule availability, applies NLP and marketing conversion techniques, handles objections and escalations, and creates a lead in the CRM — all without human involvement.

This is a **new feature** in the `voice-agent/` domain. It extends the existing `/api/vapi-tools` backend endpoint (introduced in LQV1) with two new tool handlers. No frontend changes required.

### 2. User Scenarios

#### SC-01: Qualified call → booked slot → CRM lead
**Actor:** Inbound caller (homeowner or property manager)
**Flow:**
1. Caller dials the company's SIP number; VAPI routes to Lead Qualifier v2.
2. Alex greets: *"Hi, this is Alex from ABC Homes Appliance Repair! How can I help you today?"*
3. Caller describes an appliance problem → assistant validates appliance type eligibility.
4. Assistant asks for zip code → calls `checkServiceArea` → confirms service area.
5. Assistant explains $95 service call fee → caller agrees.
6. Assistant collects unit type, brand, approximate age, problem description.
7. Assistant may handle objections and apply marketing/NLP techniques.
8. Assistant collects full name, confirms callback phone, collects service address.
9. Assistant calls `validateAddress` → reads back standardized address for confirmation.
10. Assistant calls `checkAvailability` → offers 2–3 slots using "choice without choice".
11. Caller selects a slot.
12. Assistant calls `createLead` with full payload → CRM lead created.
13. Assistant confirms booking and closes the call.

#### SC-02: Disqualified call — wrong appliance
**Flow:** Caller describes a small countertop appliance → assistant politely disqualifies and closes. No lead created.

#### SC-03: Disqualified call — outside service area
**Flow:** Caller provides zip → `checkServiceArea` returns `inServiceArea: false` → assistant apologizes and closes. No lead created.

#### SC-04: Caller declines $95 service fee
**Flow:** Caller declines after fee explanation → assistant acknowledges with open-door statement → closes. No lead created.

#### SC-05: Caller cannot commit to a slot
**Flow:** Qualification and data collection complete, but caller cannot book now → `createLead` called with `status: pending_schedule`, Comments includes "Caller requested callback to confirm slot".

#### SC-06: Caller demands human agent
**Flow:** One retention attempt → if still insisting, confirm phone, create lead with `escalation_requested: true` in Comments, close warmly.

#### SC-07: FAQ / question call
**Flow:** Caller asks a question (pricing, warranty, service area, brands, etc.) → assistant answers from knowledge base → pivots to service intent. If unknown question → offer callback.

#### SC-08: Address validation mismatch
**Flow:** `validateAddress` returns corrected zip different from qualification zip → re-run `checkServiceArea` → if outside area, disqualify.

### 3. Functional Requirements Summary

| FR | Description | Priority |
|---|---|---|
| FR-1 | Greeting with persona "Alex", intent detection, silence handling | P0 |
| FR-2 | Lead qualification: appliance type + service area + fee agreement | P0 |
| FR-3 | Unit & problem collection (type, brand, age, description) | P0 |
| FR-4 | Objection handling (7 objection types, max 2 attempts each) | P0 |
| FR-5 | Marketing techniques (FOMO, scarcity, social proof, time-limited offer before 2PM ET) | P1 |
| FR-6 | NLP techniques (choice-without-choice, pacing, reframing, presuppositions, embedded commands, meta-model) | P1 |
| FR-7 | Contact & address collection (name, phone pre-fill, address, optional email) | P0 |
| FR-8 | Address validation via Google Maps Geocoding; zip mismatch re-check | P0 |
| FR-9 | Schedule check via Blanc scheduleService (dispatch_settings + booked items); slot offer with scarcity trigger | P0 |
| FR-10 | Lead creation in CRM with structured Comments; retry on failure; silent on error | P0 |
| FR-11 | FAQ knowledge base; always pivot to service intent | P1 |
| FR-11b | Human escalation: one retention attempt, then callback + lead with flag | P1 |
| FR-12 | Graceful disqualification and call close; 15-min duration cap | P0 |

### 4. Constraints and Non-Functional Requirements

- `maxDurationSeconds: 900` (15 min hard cap — must be set in VAPI assistant config)
- `firstResponseLatency < 1200ms`
- Tool call p95 < 2000ms
- Concurrent calls: ≥ 10 simultaneous inbound calls supported
- Uptime SLA: 99.9% (VAPI SLA + backend Fly.io SLA)
- Lead creation must never block call completion
- `VAPI_TOOLS_SECRET` header required on all tool calls (already implemented in v1 handler)
- VAPI `x-vapi-secret` validated server-side before processing any tool call
- Address validation failure must NOT block lead creation (max 2 attempts, then proceed unvalidated)
- `JobSource` always hardcoded to `"AI Phone"` — never override
- `createLead` retry: 1 retry after 2-second wait on failure; silent to caller on both attempts failing
- `/api/vapi-tools` endpoint handles multiple tool calls in a single request (toolCallList array); all results returned in one response
- **`GOOGLE_GEOCODING_KEY`** — dedicated server-side Geocoding key (Fly secret, IP-restricted). Backend `validateAddress` reads it; falls back to `VITE_GOOGLE_MAPS_API_KEY` if unset. Kept separate from the referrer-restricted frontend key.
- Phone number pre-filled from VAPI call metadata (`message.call.customer.number`), confirmed verbally with caller
- Time-limited offer (FR-5.2) requires current time context in system prompt — inject via VAPI variable or time tool; must not fire at or after 14:00 ET

### 5. Potentially Involved Modules

| Module | Role |
|---|---|
| `backend/src/routes/vapi-tools.js` | Extend: add `validateAddress` and `checkAvailability` handlers |
| `backend/src/services/scheduleService.js` | Extend: add `getAvailableSlots(companyId, opts)` |
| `backend/src/db/serviceTerritoryQueries.js` | Reuse: `search(companyId, zip)` — no changes |
| `backend/src/services/leadsService.js` | Reuse: `createLead(fields, companyId)` — no changes |
| `voice-agent/assistants/lead-qualifier-v2.json` | New: VAPI assistant config for deployment |
| `src/server.js` | Already patched (LQV1): `/api/vapi-tools` mounted without auth |

### 6. Integrations Affected

- **VAPI** — new assistant deployment via REST API / CLI
- **Google Maps Geocoding API** — new server-side usage for `validateAddress`
- **Blanc scheduleService** — `getAvailableSlots` reads `dispatch_settings` + booked items from DB

### 7. Protected Parts (DO NOT BREAK)

- `src/server.js` — mounting already done; do not re-order middleware
- `backend/src/services/leadsService.js` — signature `createLead(fields, companyId)` must remain unchanged
- `backend/src/db/serviceTerritoryQueries.js` — no schema changes
- `backend/src/routes/zip-check.js` — existing consumers (frontend) must not break
- Lead Qualifier v1 assistant (`48844b0e-...`) — must remain active until v2 is validated

---

## PF002-R2: Estimates Composer Refresh

**Status:** Requirements
**Priority:** P0
**Owner:** Finance/CRM
**Related existing specs:** `docs/specs/PF002-estimates.md`, `docs/specs/PF002-technical-design.md`

### 1. Description

Refresh the existing Estimates module into a fast estimate composer for appliance/service repair workflows. Estimates are created only from an existing Lead or Job context, edited as a client-facing document with a concise item list, previewed as a client document, and approved/declined by the company or later by the customer portal. The implementation must fix the current DB/API/UI contract drift in estimates and keep the item model compatible with future Price Book presets without exposing item type/category in the estimate UI.

This is an update to existing PF002, not a parallel feature. Existing `estimates`, `estimate_items`, `estimate_events`, estimate page/detail/editor components, and Lead/Job financial tabs must be extended rather than duplicated.

### 2. User Scenarios

#### SC-01: Create estimate from Lead or Job
**Actor:** Manager / dispatcher / estimator
**Precondition:** User is viewing a Lead or Job with company access and estimates permissions.
**Flow:**
1. User clicks `New` in the Lead/Job financial surface.
2. The estimate editor opens locally without creating a database draft yet.
3. User adds at least one custom item or adds a Summary.
4. User saves; backend creates the estimate linked to the source Lead or Job and resolved Contact.
5. Estimate number is displayed as `ESTIMATE L-{leadNumber}-1`; the sequence is scoped to the current Job when the estimate is created from a Job.

#### SC-02: Add and edit custom items quickly
**Actor:** Manager / estimator
**Flow:**
1. User clicks `Add item` at the end of the current item list.
2. `Add custom item` dialog opens with all editable fields visible.
3. Required field is `Title`; `Unit price` may be `0`.
4. Defaults are `Qty = 1` and `Service is taxable = false`.
5. User saves; item appears in the estimate list.
6. Clicking the row or pencil icon opens the same dialog for editing.
7. Trash icon removes the item.

#### SC-03: Add service report summary
**Actor:** Manager / estimator
**Flow:**
1. Empty estimates show `+ Add Summary`.
2. User opens a Summary input and adds client-facing diagnostic/report text.
3. After saving, editor shows a collapsed `Summary` section with expand/edit controls and no inline preview text.
4. Preview/PDF show Summary above items only when Summary is non-empty.

#### SC-04: Preview client-facing document
**Actor:** Internal user
**Flow:**
1. User clicks `Preview` from estimate detail/editor.
2. A modal/drawer opens with client-facing document layout.
3. Preview shows Summary if present, items, totals, and Terms & Warranty.
4. Preview does not show internal-only controls or per-item taxable badges.

#### SC-05: Approve or decline estimate internally
**Actor:** Manager acting on behalf of client
**Flow:**
1. User opens a non-archived estimate with at least one item.
2. User clicks `Approved`; backend sets status to `approved`, saves an approved snapshot/history record, and records actor/source.
3. User can click `Decline`; a dialog requires a decline reason/comment.
4. Declined estimates can later be edited; edit save resets status to `draft`.

#### SC-06: Archive and restore
**Actor:** Internal user
**Flow:**
1. User archives an estimate from any status.
2. Backend sets `archived_at` and `archived_by` while preserving the existing status.
3. Archived estimate is visible only internally, visually greyed out, read-only, and unavailable through public links.
4. In `/estimates`, filter `Only Open / All` controls whether archived estimates are visible.
5. Restoring an archived estimate clears archive fields and sets status to `draft`.

### 3. Functional Requirements

#### 3.1 Entry points and listing
- Estimate creation is allowed only from Lead or Job context.
- Global `New Estimate` on `/estimates` must be removed.
- `/estimates` remains a searchable/listing page for existing estimates.
- `/estimates` detail supports view/edit/approve/decline/archive/restore according to state.
- Archived estimates are excluded from `Only Open`, included in `All`, greyed out, and marked with an `Archived` badge.

#### 3.2 Numbering
- Estimate has a stable database identifier/UUID/id that never changes.
- Display number may change when job context appears.
- Job estimate display number format: `ESTIMATE L-{leadNumber}-{sequence}`.
- Lead-only estimate display number format: `ESTIMATE L-{leadNumber}-{sequence}`.
- P0 supports only one estimate per work/lead in UI, but sequence must be modeled for future multiple estimates.
- When a lead-only estimate becomes linked to a job, display number changes to job format.

#### 3.3 Item model and UI
- Users must not see item type/category in the estimate UI.
- Data model may store future-facing `item_type`, `category_id`, `price_book_item_id`, or metadata for Price Book defaults and analytics.
- Manual item defaults:
  - `quantity = 1`
  - `taxable = false`
  - no unit field in UI
- Required item validation:
  - `title/name` is required
  - `quantity > 0`
  - `unit_price >= 0`
- Item row in app:
  - prominent title
  - full description underneath
  - muted metadata row: `Qty x Unit price` plus `Taxable`/`Non-taxable`
  - right side: line total, pencil edit icon, trash icon
- Reorder and duplicate item are out of P0.

#### 3.4 Summary and Terms
- `Summary` is client-facing and appears before items in preview/PDF only if added.
- Empty Summary is represented by `+ Add Summary`, not by an empty collapsed section.
- `Terms & Warranty` is always present and read-only in the estimate editor.
- `Terms & Warranty` uses a hardcoded Blanc default template in P0.
- Estimate-specific Terms editor and document-template editor are out of P0.
- `Terms & Warranty` always appears in client-facing preview/PDF.

Default `Terms & Warranty` text:

```text
TERMS: Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.

WARRANTY:
- 90-day labor warranty covering workmanship and the completed repair, starting from the date the repair is finished.
- OEM parts warranty is extended to a minimum of 90 days, even if the manufacturer's standard warranty is shorter.
- A service visit during the warranty period is provided at no additional charge if the issue is related to the repaired component or workmanship.
- Warranty does not cover misuse, physical damage, power issues, water damage, improper installation, or failures unrelated to the replaced component.
```

#### 3.5 Totals and tax
- Totals block includes `Subtotal`, `Add Discount`, `Tax`, `Total`.
- Fee is out of P0.
- Tip is out of estimate scope and belongs to invoice/payment.
- Discount supports fixed amount and percentage.
- Discount cannot exceed subtotal; percentage discount cannot exceed 100%.
- There is one `tax_rate` per estimate.
- Tax applies only to taxable item subtotal after discount:
  - `taxableBase = max(taxableItemsSubtotal - discountAmount, 0)`
  - `taxAmount = taxableBase * taxRate`
  - `total = subtotal - discountAmount + taxAmount`

#### 3.6 Preview/PDF
- App detail panel is operational/internal; it is not the client preview.
- A separate `Preview` action opens a client-facing modal/drawer.
- Client-facing item rows do not show taxable badges.
- In preview/PDF, quantity can be omitted when `Qty = 1`; app detail still shows `Qty x Unit price`.
- Preview/PDF order: Summary, Items, Totals, Terms & Warranty.
- PDF generation should regenerate from the current estimate after edits.
- PDF includes the Blanc company/payment block:
  - `ABC Homes`
  - `2502 Village Rd W, Norwood, MA 02062, USA`
  - `help@bostonmasters.com`
  - `(508) 290-4442`
  - ACH: Bank Of America, routing `011000138`, account `466020155621`

#### 3.7 Status lifecycle
- Canonical statuses: `draft`, `sent`, `viewed`, `approved`, `declined`.
- Use `approved`; do not use `accepted` in new contracts.
- `expired` / `valid_until` are out of P0.
- Invoice conversion does not change estimate status; approved estimate remains `approved`.
- When an invoice exists, estimate detail shows `Invoice #...`.
- Editing `sent`, `viewed`, `approved`, or `declined` estimates resets status to `draft`.
- Editing `sent` or `approved` estimates shows a warning that the updated version should be sent to the client again.
- Approved versions must be preserved in history/snapshot before later edits reset the live estimate to draft.

#### 3.8 Approval, signature, and decline
- Internal manager can approve on behalf of client.
- Portal/customer approval can be added later using the same service contract.
- Approval is blocked when estimate has no items with error: `В эстимейте нет items`.
- `Require signature` toggle exists in editor and defaults off.
- If signature is not required, client flow is `Approve`.
- If signature is required, client flow is `Sign & Approve`.
- P0 signature is typed electronic signature: full name + consent checkbox; no drawing canvas.
- If estimate is approved without signature, signature is not requested later.
- Decline requires a non-empty reason/comment and stores it in events/history.

#### 3.9 Deposit and send
- Deposit logic is not implemented in P0.
- Editor may show read-only/disabled `Deposit required: No`.
- Deposit is not shown in preview/PDF.
- Send is a workflow stub in P0:
  - dialog asks for channel `Email` or `Text`
  - no real delivery occurs
  - status remains `draft`
  - no manual `Mark as sent` in UI

### 4. Constraints and Non-Functional Requirements

- Do not store estimates as XML. Canonical storage is relational PostgreSQL tables plus JSONB snapshots for approved history/render data.
- XML may only be used for future external export/integration, not primary persistence.
- Maintain tenant isolation with `company_id` in all estimate queries.
- Routes must use the project's auth and tenant middleware and must not depend on `req.companyId` if middleware does not provide it.
- Do not duplicate estimate/invoice item logic where shared helpers can be introduced safely.
- Price Book UI is out of P0; no disabled Price Book search should be shown.
- Future Price Book must be able to add preset item groups/categories without changing estimate item display.

### 5. Potentially Involved Modules

- Backend:
  - `backend/src/routes/estimates.js`
  - `backend/src/services/estimatesService.js`
  - `backend/src/db/estimatesQueries.js`
  - estimate-related migrations in `backend/db/migrations/`
  - invoice conversion code that reads estimate status/items
- Frontend:
  - `frontend/src/pages/EstimatesPage.tsx`
  - `frontend/src/components/estimates/EstimateEditorDialog.tsx`
  - `frontend/src/components/estimates/EstimateDetailPanel.tsx`
  - `frontend/src/components/estimates/EstimateSendDialog.tsx`
  - new estimate preview/item/decline/archive components if needed
  - `frontend/src/hooks/useEstimates.ts`
  - `frontend/src/hooks/useLeadFinancials.ts`
  - `frontend/src/hooks/useJobFinancials.ts`
  - `frontend/src/services/estimatesApi.ts`

### 6. Affected Integrations

- Direct external delivery integrations are not active in P0.
- Future SMS/email delivery must integrate with existing Twilio/email infrastructure, but P0 send is a non-mutating workflow stub.
- Future portal approval/signature should reuse client portal infrastructure rather than introducing a separate client domain model.

### 7. Protected Code

- `src/server.js` core middleware and SSE infrastructure should not be changed unless a later architecture task explicitly scopes a minimal route-mount change.
- `frontend/src/lib/authedFetch.ts` / `frontend/src/services/apiClient.ts` auth fetch behavior must not be rewritten.
- Shared auth/RBAC middleware must not be bypassed.
- Existing Lead -> Job conversion flow remains canonical and must not be replaced by estimate lifecycle.

---

## FSM-001: FSM/SCXML Workflow Editor

**Status:** Requirements
**Priority:** High
**Owner:** FSM/Platform
**Feature flags:** `fsm_editor_enabled`, `fsm_publishing_enabled`

### 1. Description

Replace hardcoded status lists (`BLANC_STATUSES`, `ALLOWED_TRANSITIONS` in `jobsService.js`) and lead status constants with a database-driven FSM model defined in SCXML. Provide an admin UI for editing, validating, versioning, and publishing workflow definitions. The editor renders a live diagram preview alongside a Monaco-based SCXML editor. Entity cards (Lead, Job) derive their action buttons from the published SCXML transitions at runtime.

### 2. User Scenarios

#### SC-01: View and edit a workflow definition
**Actor:** Admin with `fsm.editor` role
**Precondition:** User navigates to `/settings/lead-form`, selects the "Workflows" tab
**Flow:**
1. User sees a list of FSM machines (Lead, Job) with their active version and draft status.
2. User opens the Job FSM editor.
3. Split-view loads: Monaco editor (left) with current draft or published SCXML, diagram preview (right).
4. User modifies SCXML (adds a new state, changes a transition target).
5. After 300 ms debounce, the diagram preview updates to reflect changes.
6. If SCXML is malformed, an error overlay appears on the diagram pane and errors populate the Problems panel.

#### SC-02: Validate and save a draft
**Actor:** Admin with `fsm.editor` role
**Precondition:** SCXML has been modified in the editor
**Flow:**
1. User clicks "Validate". Backend returns errors (blocking) and warnings (non-blocking).
2. Errors display in the Problems panel with line/column references.
3. User fixes errors, re-validates — result is clean.
4. User clicks "Save Draft". Draft version is persisted to `fsm_versions` with status `draft`.
5. Audit log records the save action with actor identity and timestamp.

#### SC-03: Publish a workflow version
**Actor:** Admin with `fsm.publisher` role
**Precondition:** A valid draft exists with zero blocking errors
**Flow:**
1. User clicks "Publish". A confirmation modal appears requiring a change note.
2. User enters a change note and confirms.
3. Backend promotes the draft to `published`, increments `version_number`, updates `fsm_machines.active_version_id`.
4. Runtime immediately uses the new published version for transition resolution.
5. Audit log records the publish event including the change note.

#### SC-04: Perform a status transition via hot action button
**Actor:** Agent viewing a Lead or Job card
**Precondition:** Entity is in state `Submitted`; published SCXML defines transitions from `Submitted`
**Flow:**
1. Card "Actions" block renders buttons derived from transitions where `blanc:action="true"` and the user's role matches `blanc:roles`.
2. User clicks "Follow up" button.
3. Frontend calls `POST /api/fsm/job/apply` with `{ entityId, event: "TO_FOLLOW_UP" }`.
4. Backend loads active published SCXML, verifies transition exists from current state, applies transition, updates entity status.
5. If the entity has a `zenbooker_job_id` and the new status maps to an outbound Zenbooker status, the sync fires.
6. Audit log records the transition.

#### SC-05: Manual status override
**Actor:** Admin with `fsm.override` role
**Precondition:** Entity is in a state with no outgoing transition to the desired target
**Flow:**
1. User sees "Change status..." link (only visible to `fsm.override` role).
2. User selects target status from dropdown, enters a mandatory reason comment.
3. Confirmation dialog warns: "This is an override. It bypasses allowed transitions."
4. Backend applies the override, logs it as a separate audit event type (`override`).
5. Zenbooker outbound sync still fires if applicable.

#### SC-06: View version history and restore a previous version
**Actor:** Admin with `fsm.editor` role
**Flow:**
1. User clicks "View history" in the version selector.
2. Modal lists all versions with version number, status, author, date, and change note.
3. User selects a previous published version and clicks "Restore as draft".
4. The selected version's SCXML is copied into a new draft. No published version is altered.

#### SC-07: Export SCXML and generate diagrams via CLI
**Actor:** Developer
**Flow:**
1. In the editor, user clicks "Export" to download the current SCXML as a file.
2. Locally, developer runs `npm run fsm:build` which invokes `smcat` CLI to generate SVG and DOT artifacts from `./fsm/*.scxml`.
3. Artifacts are written to `./fsm/out/`.

#### SC-08: Transition with confirmation dialog
**Actor:** Agent viewing a Job card
**Precondition:** SCXML transition has `blanc:confirm="true"` and `blanc:confirmText="..."` attributes
**Flow:**
1. User clicks the action button (e.g. "Job Done").
2. A confirmation dialog appears with the configured confirmation text.
3. On confirm, the transition request proceeds as in SC-04.
4. On cancel, no action is taken.

### 3. Non-Functional Requirements

#### NFR-01: Security
- SCXML is used strictly as a declarative schema. Executable SCXML elements (`<script>`, `<invoke>`, `<send>`, `<onentry>`, `<onexit>`, `<parallel>`, `<history>`, `<datamodel>`) are forbidden and must be rejected at validation time.
- All FSM API endpoints require `authenticate` + `requireCompanyAccess` middleware.
- `company_id` is derived exclusively from `req.companyFilter?.company_id` — never from client payload.
- RBAC roles (`fsm.viewer`, `fsm.editor`, `fsm.publisher`, `fsm.override`) are enforced server-side via Keycloak.
- `blanc:roles` on transitions controls client-side button visibility and is verified server-side before applying events.

#### NFR-02: Performance
- Live preview debounce: 300 ms (configurable 250–400 ms).
- Diagram render time: < 300 ms for schemas up to 100 states / 300 transitions.
- Validation and error display must not block the editor (non-blocking async).

#### NFR-03: Audit and Versioning
- Every save, publish, transition apply, and override is logged to `fsm_audit_log` with: actor_id, actor_email, action type, machine_key, version_id, payload JSON, timestamp.
- Two version statuses coexist: one `draft` and one `published` (active) per machine per company.
- Published versions are immutable; edits always create or update a draft.

#### NFR-04: Data Integrity
- Seed SCXML for Job FSM must exactly reproduce the current hardcoded statuses: `Submitted`, `Waiting for parts`, `Follow Up with Client`, `Visit completed`, `Job is Done`, `Rescheduled`, `Canceled`.
- Seed SCXML for Job FSM must exactly reproduce the current `ALLOWED_TRANSITIONS` map, including `Rescheduled -> [Submitted, Canceled]` and `Canceled -> []` (terminal).
- Seed SCXML for Lead FSM must cover: `Submitted`, `New`, `Contacted`, `Qualified`, `Proposal Sent`, `Negotiation`, `Lost`, `Converted`.
- Migration must be backward-compatible: if no published FSM version exists, the system falls back to the existing hardcoded constants.

### 4. Affected Modules

#### 4.1 Backend Services
| Module | Change |
|--------|--------|
| `backend/src/services/jobsService.js` | Replace hardcoded `BLANC_STATUSES`, `ALLOWED_TRANSITIONS` with FSM runtime lookup from published SCXML. Preserve `OUTBOUND_MAP` for Zenbooker sync. |
| `backend/src/services/leadsService.js` | Replace hardcoded lead status transitions with FSM runtime lookup. |
| `backend/src/services/jobSyncService.js` | No direct changes — continues to use `sub_status` updates. Must remain compatible with new FSM-driven status values. |
| **New:** `backend/src/services/fsmService.js` | FSM machine CRUD, version management, SCXML parsing, validation, transition resolution, audit logging. |
| **New:** `backend/src/routes/fsm.js` | Express routes: `/api/fsm/machines`, `/api/fsm/:machineKey/*` (draft, active, validate, publish, apply, override, actions, render). |

#### 4.2 Frontend Pages & Components
| Module | Change |
|--------|--------|
| `frontend/src/pages/LeadFormSettingsPage.tsx` | Add Shadcn `Tabs` component at top level: "Settings" tab (existing content) + "Workflows" tab (new editor). |
| **New:** `frontend/src/components/workflows/WorkflowEditor.tsx` | Split-view layout: Monaco editor (left) + diagram preview (right). Toolbar with validate/save/publish/export actions. |
| **New:** `frontend/src/components/workflows/DiagramPreview.tsx` | SVG rendering via `state-machine-cat`, pan/zoom, error overlay. |
| **New:** `frontend/src/components/workflows/ProblemsPanel.tsx` | Collapsible panel showing validation errors/warnings with line references. |
| **New:** `frontend/src/components/workflows/VersionHistory.tsx` | Modal listing versions with restore-as-draft capability. |
| **New:** `frontend/src/components/workflows/ActionsBlock.tsx` | Hot action buttons rendered from published SCXML transitions. Used in Lead and Job detail cards. |
| Existing Job/Lead detail cards | Replace static status-change dropdowns with `ActionsBlock` and optional manual override (for `fsm.override`). |

#### 4.3 Database (PostgreSQL)
| Table | Description |
|-------|-------------|
| **New:** `fsm_machines` | `machine_key` (PK), `company_id`, `title`, `description`, `active_version_id`, `created_at`, `updated_at` |
| **New:** `fsm_versions` | `version_id` (PK), `machine_key` (FK), `company_id`, `version_number`, `status` (draft/published/archived), `scxml_source`, `change_note`, `created_by`, `created_at`, `published_by`, `published_at` |
| **New:** `fsm_audit_log` | `id` (PK), `company_id`, `machine_key`, `version_id`, `actor_id`, `actor_email`, `action`, `payload_json`, `created_at` |
| **New (optional):** `fsm_render_cache` | `hash` (PK), `svg`, `created_at` |

All new tables must include `company_id` column for multi-tenant isolation.

### 5. Affected Integrations

#### 5.1 Zenbooker Outbound Sync (MUST PRESERVE)
- `OUTBOUND_MAP` in `jobsService.js` maps Blanc statuses to Zenbooker API statuses (`Submitted -> scheduled`, `Waiting for parts -> complete`, `Job is Done -> complete`).
- When FSM transitions change a Job's `blanc_status`, the outbound sync to Zenbooker must continue to fire based on the same mapping logic.
- Cancel handling (special case outside `OUTBOUND_MAP`) must also be preserved.
- The Zenbooker sync logic must not depend on which statuses exist in SCXML — it maps by status name, not by FSM structure.

#### 5.2 Twilio / Front
- No direct impact. These integrations do not depend on Lead/Job status transitions.

#### 5.3 Keycloak
- New RBAC roles must be registered: `fsm.viewer`, `fsm.editor`, `fsm.publisher`, `fsm.override`.
- Role checks are enforced in FSM route middleware and in transition apply logic.

### 6. Protected Code (DO NOT MODIFY)

| File | Reason |
|------|--------|
| `src/server.js` | Core server bootstrap — changes here risk breaking all services. |
| `frontend/src/lib/authedFetch.ts` | Auth token handling — shared across all API calls. |
| `frontend/src/hooks/useRealtimeEvents.ts` | WebSocket event infrastructure — shared across all real-time features. |

### 7. Constraints

1. **Tab placement:** The workflow editor lives inside `/settings/lead-form` (LeadFormSettingsPage) as a second tab ("Workflows") via Shadcn `Tabs` component. It is NOT a standalone route.
2. **CommonJS backend:** All new backend modules must use CommonJS (`require`/`module.exports`) to match existing codebase conventions.
3. **No standalone SCXML runtime:** SCXML is used as a declarative state/transition graph only. No XState, no SCION, no runtime interpretation of executable content.
4. **Blanc namespace:** Custom metadata uses `xmlns:blanc="https://blanc.app/fsm"` namespace exclusively. No other custom namespaces.
5. **Allowed SCXML subset (MVP):** Only `<scxml>`, `<state>`, `<final>`, `<transition>` elements are permitted. All others are validation errors.
6. **Backward compatibility:** Until a company publishes their first FSM version, the system must fall back to current hardcoded `BLANC_STATUSES` and `ALLOWED_TRANSITIONS`.
7. **Multi-tenant isolation:** All FSM data (machines, versions, audit logs) is scoped by `company_id`. Queries must always filter by `company_id`.
8. **Seed data completeness:** The Job FSM seed must include ALL 7 current statuses (`Submitted`, `Waiting for parts`, `Follow Up with Client`, `Visit completed`, `Job is Done`, `Rescheduled`, `Canceled`) and ALL transitions from the current `ALLOWED_TRANSITIONS` map, including terminal states.
9. **Dependencies:** `monaco-editor` (or `@monaco-editor/react`) and `state-machine-cat` are added as project dependencies. `smcat` CLI is a devDependency for local/CI diagram generation.
10. **Feature flags:** Editor UI is gated behind `fsm_editor_enabled`. Publishing capability is gated behind `fsm_publishing_enabled`. Both flags default to `false`.

### 8. Seed SCXML Corrections

The original requirements document (section 12.2) contains a seed Job FSM that is incomplete relative to the current hardcoded data. The following discrepancies must be resolved in the final seed:

| Issue | Current hardcoded value | Seed SCXML (section 12.2) |
|-------|------------------------|--------------------------|
| Missing status `Rescheduled` | Present in `BLANC_STATUSES` and `ALLOWED_TRANSITIONS` | Absent |
| Missing status `Canceled` | Present as terminal (`Canceled: []`) with transitions from all non-terminal states | Absent |
| Missing transition `Submitted -> Canceled` | Present in `ALLOWED_TRANSITIONS` | Absent |
| Missing transition `Waiting for parts -> Canceled` | Present in `ALLOWED_TRANSITIONS` | Absent |
| Missing transition `Follow Up with Client -> Submitted` | Present in `ALLOWED_TRANSITIONS` | Absent |
| Missing transition `Visit completed -> Canceled` | Present in `ALLOWED_TRANSITIONS` | Absent |
| Missing transition `Job is Done -> Canceled` | Present in `ALLOWED_TRANSITIONS` | Absent |
| Missing transition `Rescheduled -> Submitted` | Present in `ALLOWED_TRANSITIONS` | Absent |
| Missing transition `Rescheduled -> Canceled` | Present in `ALLOWED_TRANSITIONS` | Absent |

The corrected Job FSM seed must faithfully represent all statuses and transitions from the current `ALLOWED_TRANSITIONS` map before being inserted as the initial published version during migration.

---

## IMG-001: Fullscreen Image Viewer

**Status:** Implementation
**Priority:** Medium
**Owner:** Frontend/UX

### 1. Description

Shared fullscreen image viewer (lightbox) component. Opens when user clicks on an image preview in AttachmentsSection. Enables examining small details on photos (serial numbers, receipts, documents). Supports navigation between images, 90-degree rotation, and keyboard shortcuts. UX similar to Telegram image viewer.

### 2. User Scenarios

1. **Open fullscreen** — click on image preview area opens fullscreen overlay with maximized image
2. **Navigate** — arrow keys or side buttons to switch between images; thumbnail strip at bottom
3. **Rotate** — button rotates image by -90 degrees (counter-clockwise)
4. **Close** — Escape key, backdrop click, or X button
5. **Open original** — ExternalLink opens full-size image in new tab

### 3. Non-Functional Requirements

- Frontend-only, no backend changes
- Component must be shared/reusable (not coupled to payments)
- Body scroll locked when overlay is open
- z-index high enough to overlay floating panels (z-[9999])

### 4. Affected Modules

| Module | Change |
|--------|--------|
| `frontend/src/components/shared/FullscreenImageViewer.tsx` | **New:** Shared fullscreen overlay component |
| `frontend/src/components/payments/PaymentDetailPanel.tsx` | Extract FullscreenViewer + RotatableImage to shared, import from shared |

### 5. Affected Integrations

None.

---

## SCHED-LIST-001: Schedule List View

**Status:** Requirements
**Priority:** Medium
**Owner:** Frontend/UX

### 1. Description

Add a new "List" view mode to the Schedule page. Unlike Timeline/TimelineWeek views that position items on an hourly grid, the List view renders a simple vertical list of jobs per technician column — no time axis, just stacked cards. Each job tile shows the time slot (start → end). Days are separated by date headings in the Pulse `DateSeparator` style (day name as a heading label, spacing only — no horizontal lines or borders).

### 2. User Scenarios

#### SC-01: Switch to List view
**Actor:** Dispatcher / Admin
**Precondition:** Schedule page is open in any view mode
**Flow:**
1. User selects "List" from the view mode dropdown in CalendarControls.
2. The view switches to a multi-column layout: one column per technician, plus an "Unassigned" column.
3. Within each column, items are grouped by day with a date heading (e.g. "Mon, Apr 15") separating groups.
4. Items within each day are sorted chronologically by `start_at`.
5. Each item tile shows: time slot (e.g. "9:00 AM – 11:30 AM"), title, status, customer name — same info density as existing `ScheduleItemCard`.

#### SC-02: Navigate dates in List view
**Actor:** Dispatcher
**Precondition:** List view is active
**Flow:**
1. User clicks Previous/Next to navigate by week (same as Timeline Week behavior).
2. The list shows 7 days (Mon–Sun), only rendering days that have items.
3. "Today" button jumps to current week.

#### SC-03: Click on item tile
**Actor:** Dispatcher
**Precondition:** List view is active
**Flow:**
1. User clicks a job tile — FloatingDetailPanel opens (same behavior as other views).
2. User clicks a lead/task tile — SidebarStack opens.

#### SC-04: Empty day handling
**Actor:** Dispatcher
**Flow:**
1. If a day has no items for a specific technician, no date heading or empty state is shown for that day in that column. Only days with items appear.
2. If a technician has zero items across the entire week, the column still renders with the header but no content below.

### 3. Non-Functional Requirements

#### NFR-01: Frontend-only
- No backend changes. Reuses existing `fetchScheduleItems` API and `ScheduleItem` data structure.

#### NFR-02: Performance
- Must render smoothly for up to 20 providers × 7 days × 10 items per day.

#### NFR-03: Consistency
- Reuses existing `ScheduleItemCard` component for item tiles (adds time slot display).
- Date separator follows Pulse `DateSeparator` visual pattern: heading-style label, no lines.
- Column headers follow the same provider name + color dot pattern as TimelineView/TimelineWeekView.

#### NFR-04: Responsive
- Horizontal scroll when columns exceed viewport width (same as TimelineView behavior).

### 4. Affected Modules

| Module | Change |
|--------|--------|
| `frontend/src/hooks/useScheduleData.ts` | Extend `ViewMode` union with `'list'` |
| `frontend/src/components/schedule/CalendarControls.tsx` | Add `{ value: 'list', label: 'List' }` to `VIEW_OPTIONS` |
| `frontend/src/pages/SchedulePage.tsx` | Add `case 'list'` to the view switch, import `ListView` |
| **New:** `frontend/src/components/schedule/ListView.tsx` | New list view component |

### 5. Affected Integrations

None.

### 6. Constraints

1. Reuse `ScheduleItemCard` — do not create a separate card component.
2. Time slot display (start – end) should be added to the card when used in List view context.
3. Date navigation granularity: week (7 days at a time), same as `timeline-week`.
4. Date range calculation in `useScheduleData` should reuse `timeline-week` logic for the `list` view mode.
5. Columns are sorted alphabetically by provider name, "Unassigned" always last — same as TimelineView.

---

## EMAIL-001: Gmail Shared Mailbox + Email Workspace

**Status:** Requirements
**Priority:** High
**Owner:** Messaging / Integrations
**Feature flags:** `email_workspace_enabled`, `gmail_channel_enabled`

### 1. Description

Add a company-level Gmail connection page in Settings and a separate `/email` operator workspace inspired by Front's shared inbox layout. This feature is scoped to one shared Gmail / Google Workspace mailbox per company and must cover the core email workflow inside Blanc: connect mailbox, receive emails, send new emails, reply in-thread, search, and work with attachments.

This slice is intentionally **not** an omnichannel expansion of `Pulse`. In v1, email lives in its own workspace because the desired UX is a Front-style inbox/list/thread surface, while the current `Pulse` implementation is phone/SMS-thread-first. The two areas may deep-link to each other when a contact or thread match exists, but they are not merged into one timeline in this iteration.

### 2. User Scenarios

#### SC-01: Connect the company Gmail mailbox from Settings
**Actor:** Admin with integration/company settings access
**Precondition:** User opens `/settings/email`
**Flow:**
1. User sees the current company email status: `Not connected`, `Connected`, `Reconnect required`, or `Sync error`.
2. User clicks `Connect Gmail`.
3. Google OAuth flow is started for a Gmail or Google Workspace mailbox.
4. After successful authorization, Blanc stores the connection against the current `company_id`.
5. Settings page shows the connected mailbox address, last successful sync time, and actions: `Reconnect` and `Disconnect`.

#### SC-02: Open the email workspace
**Actor:** Dispatcher / manager / agent with internal messaging access
**Precondition:** User navigates directly to `/email` or opens it from the Settings menu
**Flow:**
1. The page loads a Front-like three-pane layout:
   - left rail / mailbox navigation,
   - middle thread list,
   - right thread detail + composer pane.
2. The workspace opens on the default company mailbox, not on a personal inbox.
3. Threads are ordered by the most recent email activity.
4. If no mailbox is connected, the page shows an empty state with a CTA to `/settings/email`.

#### SC-03: Read a thread
**Actor:** Internal user with email access
**Precondition:** Company mailbox is connected and at least one thread exists
**Flow:**
1. User selects a thread from the list.
2. The right pane shows the full thread in chronological order.
3. Each message displays sender, recipients, CC, subject, timestamp, body, and attachments.
4. Opening the thread marks unread state as read for Blanc's internal workspace.

#### SC-04: Send a new email
**Actor:** Internal user with send permission
**Precondition:** Company mailbox is connected
**Flow:**
1. User clicks `Compose`.
2. User enters `To`, optional `CC`, subject, body text, and attachments/images.
3. The message is sent from the connected company mailbox.
4. A new thread is created in `/email` and becomes visible in the thread list.

#### SC-05: Reply inside an existing thread
**Actor:** Internal user with send permission
**Precondition:** Existing email thread is open
**Flow:**
1. User clicks `Reply` in the thread pane.
2. User edits recipients as allowed by normal reply semantics, adds body text and optional attachments.
3. The outbound message is stored and synced as part of the same thread.
4. Subsequent inbound replies continue to appear in the same Blanc thread.

#### SC-06: Receive inbound emails
**Actor:** Internal user with email access
**Precondition:** Company mailbox is connected
**Flow:**
1. New inbound emails synced from Gmail appear in `/email` without opening Gmail.
2. If Gmail identifies the email as part of an existing thread, Blanc attaches it to that same internal thread.
3. If it is a new conversation, Blanc creates a new thread row.
4. Thread list row shows unread state, sender, subject/snippet, timestamp, and attachment indicator when applicable.

#### SC-07: Search emails and threads
**Actor:** Internal user with email access
**Flow:**
1. User enters a search query in `/email`.
2. Blanc searches across sender/recipient addresses, CC, subject, body text, and attachment filename metadata.
3. Results are returned as threads, not as detached individual messages.
4. Selecting a result opens the matching thread and highlights the relevant message when possible.

#### SC-08: Work with attachments
**Actor:** Internal user with email access
**Flow:**
1. User can attach files and images to a new email or reply.
2. Incoming and outgoing messages display attachment chips/previews.
3. User can open or download an attachment from the thread pane.
4. Attachment visibility stays scoped to the exact email message that contains it.

### 3. Non-Functional Requirements

#### NFR-01: Security and tenancy
- All email routes require `authenticate` + `requireCompanyAccess`.
- `company_id` must be resolved only from `req.companyFilter?.company_id`.
- Gmail connection state is company-scoped; one company cannot access another company's mailbox or synced email data.
- OAuth tokens / refresh tokens must not be exposed to the frontend after initial authorization and must be stored securely.

#### NFR-02: RBAC reuse
- V1 should reuse existing permissions instead of introducing a new RBAC matrix:
  - `/settings/email` — `tenant.integrations.manage`
  - `/email` read access — `messages.view_internal`
  - send/compose/reply actions — `messages.send`
- Users without send permission may still view threads if they have read permission, but composer actions must be hidden or disabled.

#### NFR-03: Threading model
- Gmail `threadId` is the canonical thread key whenever available.
- Header-based email continuity (`Message-ID`, `In-Reply-To`, `References`) is the fallback for sync/import edge cases.
- V1 does not expose configurable threading modes in UI; threading behavior is fixed and product-controlled.

#### NFR-04: Delivery and sync model
- V1 does not require Front-level collaboration or queue orchestration features such as assignment, internal comments, shared drafts, snooze/later/done, or inbox rules.
- V1 does not require `Pulse`-grade real-time parity on day one; a reliable sync loop plus manual refresh is acceptable if Gmail push/SSE wiring is not ready yet.
- Any future realtime support must be additive and must not change the core `/email` data model.

#### NFR-05: Search and performance
- Thread list and search must be server-driven, not client-filter-only.
- Opening `/email` should render the initial thread list without loading full message history for every thread.
- Thread detail loads on demand and supports attachments without blocking the full page render.

#### NFR-06: UX direction
- `/email` should visually follow a Front-like operator workflow: mailbox navigation, thread list, thread pane, inline composer.
- This is a directional inspiration, not a 1:1 clone. V1 should not import advanced Front features that are outside the approved scope.

### 4. Affected Modules

#### 4.1 Backend Services
| Module | Change |
|--------|--------|
| **New:** `backend/src/routes/email.js` | REST API for thread list, thread detail, send, reply, search, and attachment retrieval. |
| **New:** `backend/src/routes/email-settings.js` | Company-scoped settings API for Gmail status, connect/reconnect/disconnect, and sync health. |
| **New:** `backend/src/services/emailService.js` | Gmail API wrapper, send/reply logic, MIME parsing, threading, and attachment metadata extraction. |
| **New:** `backend/src/services/emailSyncService.js` | Incremental sync/backfill worker for inbound email import and thread refresh. |
| Existing worker/runtime services | May be extended only as needed for background sync scheduling or event fan-out. No requirement to refactor Twilio/Pulse workers as part of v1. |

#### 4.2 Frontend Pages & Components
| Module | Change |
|--------|--------|
| `frontend/src/App.tsx` | Add routes for `/email` and `/settings/email`. `/email` is a standalone route; it is not added to the top navigation tabs. |
| `frontend/src/components/layout/appLayoutNavigation.tsx` | Add an `Email` entry to the Settings dropdown only. Keep top-level navigation unchanged. |
| **New:** `frontend/src/pages/EmailPage.tsx` | Front-like email workspace shell and route component. |
| **New:** `frontend/src/pages/EmailSettingsPage.tsx` | Settings page for connecting and managing the shared Gmail mailbox. |
| **New:** `frontend/src/services/emailApi.ts` | Frontend API wrapper for `/api/email` and `/api/settings/email`. |
| **New:** `frontend/src/components/email/*` | Thread list, thread row, thread pane, message item, composer, search bar, empty/error states. |

#### 4.3 Database / persistence
| Store | Description |
|-------|-------------|
| `company_settings` | Store non-secret email workspace preferences and optional UI metadata under a dedicated `setting_key`; OAuth credentials must not be stored here. |
| **New:** `email_mailboxes` | Company-scoped connected mailbox record with provider account identity, encrypted tokens, connection state, and sync health. |
| **New:** `email_threads` | Internal thread records scoped by `company_id`, keyed to Gmail thread identity and searchable in `/email`. |
| **New:** `email_messages` | Individual inbound/outbound email records with sender, recipients, body, sync metadata, and provider IDs. |
| **New:** `email_attachments` | Attachment metadata and storage references linked to `email_messages`. |
| **New:** `email_sync_state` | Sync cursor / history state per company mailbox for incremental Gmail import. |

### 5. Affected Integrations

#### 5.1 Gmail / Google Workspace
- Gmail is the only supported provider in v1.
- Connection must support Gmail and Google Workspace mailboxes through Google OAuth.
- V1 supports one shared company mailbox only.
- Personal inboxes, delegated inboxes, aliases, and multi-mailbox routing are explicitly out of scope.

#### 5.2 Existing Blanc messaging stack
- Existing SMS routes/services (`/api/messaging`, `MessagesPage`, `Pulse`) must remain functional and unchanged in behavior.
- Email must not reuse SMS-specific tables or Twilio-specific message services.
- Contact/lead/job linking may be added opportunistically, but email send/receive/search must not depend on those links being present.

#### 5.3 Keycloak / permissions
- No new Keycloak roles are required for v1 if the existing permissions listed above are sufficient.
- If later implementation discovers a real gap, it may introduce an email-specific permission as a follow-up, not as a prerequisite for this slice.

### 6. Out of Scope (v1)

1. Personal mailboxes or delegated teammate inboxes.
2. More than one connected mailbox per company.
3. Assignment, ownership queues, workload balancing, inbox rules, or routing automation.
4. Internal comments / discussions on email threads.
5. Shared drafts / collaborative drafting / draft takeover.
6. Snooze, Later, Done, ticket statuses, archive workflow parity with Front.
7. Embedding email into the current `Pulse` timeline.
8. AI-generated replies or AI email drafting.
9. Multi-provider support (Office 365, SMTP, IMAP, etc.).

### 7. Constraints

1. `/email` is a separate route and workspace, but it must not be added to the top navigation tabs in the current shell.
2. The connection UI lives in Settings as a dedicated page (`/settings/email`), not buried inside the generic integrations table.
3. V1 must assume exactly one shared mailbox per company.
4. If a mailbox is disconnected or auth expires, `/email` should fail gracefully with a reconnect CTA instead of a broken list pane.
5. Initial sync/backfill may be bounded to a recent window or a limited history import; full unlimited Gmail history import is not required for v1.
6. The feature should reuse existing project patterns where they already fit:
   - `company_settings` for company-level config,
   - `authedFetch` / typed frontend API wrappers,
   - route-level permission guards in `App.tsx`,
   - lazy-loaded detail panes and server-side search patterns.
7. `Pulse` remains the phone/SMS workspace in this phase; do not expand its current combined timeline contract to include email as part of this requirement.

---

## F014: Ads Analytics Microservice

**Status:** Requirements
**Priority:** High
**Owner:** Backend / Integrations
**Consumer:** external reporting scripts (first: ABC Homes Google Ads weekly report)

### 1. Description

Read-only HTTP surface that returns Blanc funnel data (inbound tracking calls → leads → jobs → revenue) for a requested period. Authenticated via the existing `integrationsAuth` middleware (`X-BLANC-API-KEY` + `X-BLANC-API-SECRET`) with a new scope `analytics:read` that is distinct from `leads:create`. No mutations, no PII enrichment — just aggregated funnel numbers plus raw rows for spot-checking.

### 2. User Scenarios

#### SC-01: Weekly summary for Google Ads script
**Actor:** external cron / Google Ads script holding an `analytics:read` API key
**Flow:**
1. Script calls `GET /api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22`.
2. Backend authenticates via `X-BLANC-API-KEY` + `X-BLANC-API-SECRET`, verifies `analytics:read` scope, applies rate limiter.
3. Backend aggregates calls for the tracking DID, leads created in the period, and jobs linked to those leads; returns a single summary object.
4. Script posts the numbers into the weekly ad-performance dashboard.

#### SC-02: Drill-down into raw rows
**Actor:** analyst investigating a discrepancy
**Flow:**
1. Analyst calls `/analytics/calls`, `/analytics/leads`, or `/analytics/jobs` for the same period with `limit`/`cursor` pagination.
2. Backend returns the underlying rows that back the summary (one call per `call_sid`, one lead per `serial_id`, one job per `zenbooker_job_id`).
3. Analyst reconciles numbers against the summary endpoint.

#### SC-03: Multi-DID scenario
**Actor:** script with a non-default tracking number
**Flow:** Script passes `tracking_number=+16175551234`; backend normalizes the phone and scopes the CTE to that DID. Default tracking number is `+16176444408` (ABC Homes main ad line).

#### SC-04: Reject oversized period
**Actor:** misbehaving client requesting 12 months of data at once
**Flow:** Backend rejects the request with `400 PERIOD_TOO_LARGE` when `to - from > 92 days`.

### 3. Non-Functional Requirements

#### NFR-01: Security
- All endpoints require `integrationsAuth` middleware chain (`rejectLegacyAuth → validateHeaders → authenticateIntegration → rateLimiter`).
- Per-request scope guard: `req.integrationScopes` must include `analytics:read`.
- Per-company isolation: all aggregations filter by `req.integrationCompanyId` when that column is non-null on the integration row.
- No secrets in logs; keys follow the existing peppered SHA-256 storage pattern.

#### NFR-02: Time semantics
- All dates in query params are interpreted in `America/New_York` (ABC Homes operating TZ).
- `from` and `to` are inclusive on the calendar day; server math converts them to a half-open UTC range.
- Hard cap: `to - from <= 92 days` → `PERIOD_TOO_LARGE`.

#### NFR-03: Stability of contract
- Response shape mirrors the spec at `docs/specs/F014-ads-analytics-microservice.md`; numeric fields default to 0 when empty, not missing.
- Error envelope identical to `integrations-leads`: `{ success, code, message, request_id }`.
- Cursor pagination is opaque base64url of the last row's timestamp.

### 4. Affected Modules

| Module | Change |
|--------|--------|
| **New:** `backend/db/migrations/080_seed_analytics_scope.sql` | No-op DDL; marker file documenting `analytics:read` scope in column comment. |
| **New:** `backend/src/services/analyticsService.js` | `getSummary`, `listCalls`, `listLeads`, `listJobs`; shared CTE `tracked_calls → period_leads → attributed_leads`. |
| **New:** `backend/src/routes/integrations-analytics.js` | 4 GET endpoints; mirrors middleware chain of `integrations-leads`. |
| **New:** `backend/scripts/issue-analytics-key.js` | CLI to generate and persist an `analytics:read` API key. |
| `src/server.js` | Add `require`, mount router at `/api/v1/integrations`, update boot log. |

### 5. Affected Integrations

- **Google Ads reporting script** — first consumer. Weekly cron reads `/summary`.
- **ABC Homes tracking DID** — default `+16176444408`; overridable via `tracking_number` param.
- **Zenbooker / Front / Twilio** — no integration changes; the service only reads existing Blanc tables (`calls`, `leads`, `jobs`).

### 6. Constraints

1. Reuse `integrationsAuth` middleware — no new authentication mechanism.
2. Scopes live in `api_integrations.scopes` JSONB; no schema change required.
3. CommonJS backend; SQL-heavy service with a single canonical CTE for funnel attribution.
4. No caching layer in v1; each request hits Postgres. Rate limit is the safety net.
5. Attribution window: leads created within 24h of a tracking call are attributed to that call.
6. Revenue stored in `jobs.invoice_total` as TEXT; strip `[^0-9.]` regex for numeric aggregation.

---

## TWC-001: Twilio API Client Singleton

### 1. Description
All backend modules must share a single Twilio Node SDK client instance per process rather than instantiating a new client per function call. This eliminates per-instance `https.Agent` keep-alive pools that currently accumulate ~199 idle outbound TCP sockets to Twilio CloudFront endpoints in production, and removes a class of CLOSE_WAIT socket leaks.

### 2. User scenarios
1. Stale-call reconciliation: the inbox worker fetches Twilio call status for dozens of stale calls in succession — all requests route through one shared HTTPS connection pool, no fresh TLS handshakes per call.
2. inboxWorker processes a batch of webhook events — Twilio API calls inside one iteration reuse the same pool.
3. Operator availability checks (`callAvailability`) on every inbound call use the shared client — no new TLS setup per request.
4. Phone-settings endpoint calls Twilio Numbers API — zero connection-setup overhead.
5. Production VM (1 vCPU / 1 GB on Fly) sustains 5–10 ESTABLISHED outbound HTTPS sockets to Twilio CloudFront in steady state instead of 199+, with no CLOSE_WAIT sockets caused by abandoned agents.

### 3. Non-functional requirements
- **NFR-01 (Resource):** Process must not accumulate more than ~20 concurrent ESTABLISHED HTTPS connections to Twilio API in steady state.
- **NFR-02 (Compatibility):** Public Twilio SDK surface (`client.calls`, `client.lookups`, `client.conversations`, `client.messages`, `client.api.accounts(...).incomingPhoneNumbers`, etc.) is unchanged — migration is mechanical at call-sites with no behavior change.
- **NFR-03 (Configuration):** Credentials are read from `process.env.TWILIO_ACCOUNT_SID` and `process.env.TWILIO_AUTH_TOKEN`. No new environment variables.
- **NFR-04 (Lazy init):** The shared client is initialized lazily on first access so that test runners and CLI commands without TWILIO_* env do not fail at module-load time.
- **NFR-05 (Failure mode):** If credentials are missing, the first call to the client throws a clear error rather than silently constructing a broken client.
- **NFR-06 (Multi-tenant readiness):** TWC-001 introduces only a global singleton. A future per-company credential cache (analogous to `getClientForCompany` in `zenbookerClient.js`) is allowed but out of scope here.

### 4. Affected modules
- `backend/src/services/reconcileStale.js` — currently constructs `twilio()` inside `fetchAndUpdateFromTwilio`.
- `backend/src/services/callAvailability.js` — currently constructs `twilio()` inside availability check.
- `backend/src/services/inboxWorker.js` — constructs `twilio()` per webhook event.
- `backend/src/routes/phoneSettings.js` — constructs `twilio()` per request.
- `backend/src/services/conversationsService.js`, `backend/src/services/twilioSync.js`, `backend/src/services/reconcileService.js` — already use module-level singletons; they may be refactored to use the new shared getter for uniformity.
- New module: `backend/src/services/twilioClient.js` — central lazy getter.

### 5. Affected integrations
- **Twilio** (Voice REST API, Lookups, Numbers, Conversations) — no API or behavior change; only HTTP-client lifecycle.

### 6. Protected
- `src/server.js`, TwiML routing, voice/recording behavior, webhook handling logic, reconcile semantics — unchanged.
- Existing per-module exports of services that already cache a singleton must keep their public API.


---

## F015: Document Templates Customization (Estimates first)

**Status:** Requirements
**Priority:** P0
**Owner:** CRM / Customization
**Related existing specs:** `docs/specs/PF002-R2-estimates-composer-refresh.md`, `docs/api/F015-document-templates-api.md` (TBD)

### 1. Description

Introduce a self-contained, extensible **Document Templates** module that lets a company customize the layout, branding, and free-text content of client-facing documents. The first document type is **Estimate**; the same model is designed to absorb **Invoice** and **Work Order** later by adding new `document_type` values without schema or renderer rewrites.

The current PDF renderer and the in-app HTML preview both rely on hardcoded constants in `backend/src/services/estimatePdfService.js` (`COMPANY_PROFILE`, `DEFAULT_TERMS_AND_WARRANTY`, `COLORS`) and a duplicated copy of the warranty text in `frontend/src/components/estimates/EstimatePreviewDialog.tsx`. F015 moves these values into a **versioned, JSON-encoded template descriptor** stored per company, makes them editable through a Settings page, and removes the duplication so PDF and HTML preview render from one source of truth.

This is an **additive** feature — no behavior change for tenants who do not edit their template. The first migration seeds one default template per existing company, byte-for-byte equivalent to the current hardcoded output.

### 2. User Scenarios

#### SC-01: View and edit the default Estimate template
**Actor:** Tenant admin (`tenant.integrations.manage` or new `tenant.documents.manage`)
**Flow:**
1. User opens **Settings → Document Templates**.
2. Sees a list grouped by document type with `Estimate` populated by one row labeled `Default` (the seeded template).
3. Clicks the row; an editor opens with the current template descriptor split into form fields (Brand, Sections, Terms, Footer).
4. User edits company name, accent color, ACH details, terms & warranty text.
5. Clicks **Save**; backend validates and persists; user returns to the list.
6. Next PDF/preview rendered for an estimate uses the updated template.

#### SC-02: Live preview while editing
**Actor:** Tenant admin
**Flow:**
1. In the editor, user toggles a section visibility (e.g., hide ACH).
2. The right-hand pane re-renders the in-app HTML preview using the in-progress descriptor against a fixture estimate.
3. Save commits the change; reload preserves the new state.

#### SC-03: Reset to factory default
**Actor:** Tenant admin
**Flow:**
1. User clicks **Reset to default** on a template.
2. Confirmation dialog appears.
3. On confirm, the descriptor is overwritten with the seeded factory descriptor; previous content is discarded (versioned but not user-recoverable in P0).

#### SC-04: Render uses the company's template
**Actor:** End user generating an estimate PDF
**Flow:**
1. User opens an estimate and clicks **PDF**.
2. Backend resolves `default` template for `(company_id, 'estimate')`; if none, falls back to the factory descriptor.
3. PDF is rendered using the descriptor; result is identical to the legacy hardcoded output for an unedited template.

#### SC-05: Future document types (forward-compatibility)
**Actor:** Product / engineering
**Flow:**
1. A new document type (`invoice`) is added by extending the `document_type` enum check, seeding a factory descriptor, and adding a renderer entry that knows the section semantics for invoices.
2. The Settings page automatically lists the new type because it reads document types from a registry, not a hardcoded array.

### 3. Functional Requirements

#### 3.1 Storage
- New table `document_templates`: `id, company_id, document_type, name, slug, is_default, schema_version, content (JSONB), created_at, updated_at, archived_at, created_by, updated_by`.
- Unique partial index on `(company_id, document_type)` where `is_default = true AND archived_at IS NULL` — enforces exactly one active default per `(company, type)`.
- All access scoped by `company_id` via `req.companyFilter?.company_id`.
- `document_type` constrained to `('estimate')` initially; designed to accept `'invoice', 'work_order'` later.
- `schema_version` is an integer (start at `1`); used by the renderer to dispatch to a version-specific reader.

#### 3.2 Template descriptor (JSON, schema_version=1)
The descriptor is the canonical document model, equivalent to the current hardcoded output:
```jsonc
{
  "schema_version": 1,
  "brand": {
    "name": "ABC Homes",
    "address": "...",
    "email": "...",
    "phone": "...",
    "logo_url": null,
    "ach": { "bank": "...", "routing_number": "...", "account_number": "..." }
  },
  "theme": {
    "ink": "#172033", "muted": "#5f7085", "faint": "#eef3f8",
    "surface": "#fbfcfe", "border": "#d8e0ea",
    "accent": "#2563eb", "danger": "#be123c"
  },
  "sections": [
    { "key": "header", "visible": true },
    { "key": "ach", "visible": true },
    { "key": "client_addresses", "visible": true },
    { "key": "summary", "visible": true },
    { "key": "items", "visible": true },
    { "key": "totals", "visible": true },
    { "key": "terms", "visible": true, "body_md": "TERMS: ...\n\nWARRANTY:\n- ..." }
  ],
  "footer": { "show_page_number": true, "text_md": null }
}
```
- Section `key`s are a fixed registry per `document_type`; renderer rejects unknown keys.
- Section order is the array order; the editor exposes a drag-and-drop reorder in P1 (P0 = fixed order, visibility toggles only).
- Free text fields (`terms.body_md`, `footer.text_md`, future block content) are **Markdown** (CommonMark subset: bold, lists, line breaks, no raw HTML, no images).

#### 3.3 Backend API (mounted under `/api/document-templates`)
- `GET /api/document-templates?document_type=estimate` — list templates for the company.
- `GET /api/document-templates/:id` — fetch by id (404 if cross-company).
- `POST /api/document-templates` — create (P0: only system seeds; user-create available via clone in P1).
- `PUT /api/document-templates/:id` — update name and content; validates against schema.
- `POST /api/document-templates/:id/reset` — overwrite content with the factory descriptor for the document type.
- `POST /api/document-templates/:id/preview` — server-side render of the descriptor against a fixture estimate; returns HTML descriptor JSON consumed by the frontend preview.
- `GET /api/document-templates/factory/:document_type` — returns the read-only factory descriptor.
- All endpoints require `authenticate, requireCompanyAccess`, and the new permission `tenant.documents.manage`.

#### 3.4 Renderer integration
- `estimatePdfService.renderEstimatePdf(estimate, descriptor)` accepts a descriptor parameter; when omitted, resolves the default for the company.
- A new module `documentTemplatesService.resolveTemplate(companyId, document_type)` returns the active default or, if none, the factory descriptor.
- `EstimatePreviewDialog.tsx` reads the same descriptor (via a new `/api/estimates/:id/render` JSON endpoint or via the template API + estimate data) so that PDF and preview never diverge.

#### 3.5 Settings UI
- New page at `/settings/document-templates` (linked from the Settings nav).
- List page: groups by document type; each row shows name, default badge, last updated, and an `Edit` action.
- Editor page: form-based with sections — **Brand**, **Theme** (color pickers), **Sections** (visibility toggles), **Terms & Warranty** (Markdown textarea), **Footer**. Right pane shows a live preview rendered from the in-progress descriptor.
- Reset, Save, Discard actions; unsaved-changes guard on navigation.

#### 3.6 Validation
- Server-side: JSON-schema validation (Ajv) of the descriptor; reject unknown section keys, malformed colors, body_md exceeding 8000 chars.
- Client-side: identical schema enforced by a TypeScript type derived from the same JSON Schema (single source of truth in `backend/src/services/documentTemplates/schema/v1.json`).

### 4. Non-Functional Requirements
- **Backwards compatibility:** an estimate rendered with no template change must be byte-identical to the pre-feature output (golden test).
- **Migration:** factory descriptor seeded per existing company in the same migration that creates the table.
- **Performance:** template fetch must add ≤10ms to the PDF endpoint (single indexed lookup, cached per request).
- **Security:** Markdown is rendered to PDF text (no HTML escape hatch); on the HTML preview, the Markdown is rendered with a sanitizer (allowlist).

### 5. Out of scope (P0)
- WYSIWYG / drag-drop block editor (P1).
- Multiple templates per `(company, document_type)` with switching at render time (P1).
- Invoice and Work Order document types (data-only follow-up).
- Logo upload (only `logo_url` string; upload pipeline TBD).
- Template versioning UI / restore previous version (P2).

### 6. Acceptance criteria
- AC-1: A fresh tenant has exactly one row in `document_templates` for `document_type='estimate'`, `is_default=true`, with content equal to the factory descriptor.
- AC-2: Rendering an estimate with the seeded template produces a PDF byte-equivalent to the legacy renderer (golden test).
- AC-3: Editing the company name in the template and re-rendering the same estimate reflects the new name in the PDF and HTML preview.
- AC-4: A non-admin user (`tenant.documents.manage` denied) gets `403` on all `/api/document-templates` endpoints; cross-company `:id` returns `404`.
- AC-5: Removing the `terms` section's visibility hides the section in PDF and HTML preview.
- AC-6: Adding a new `document_type` only requires (a) extending the CHECK constraint, (b) registering a factory descriptor, (c) registering a renderer adapter — no UI code change to list types.

## F016: VAPI AI — Marketplace Integration + Call Flow Gating

**Краткое описание:** Добавить VAPI AI как приложение в маркетплейс (`/settings/integrations`).
Кнопка "Enable" на плитке ведёт на **отдельную страницу настройки** `/settings/integrations/vapi-ai`,
где пользователь вводит API key, верифицирует и настраивает SIP resource.
После подключения нода `vapi_agent` становится доступной в редакторе Call Flow для групп
(`/settings/telephony/user-groups/:id/flow`). Без подключения — нода скрыта.

**Пользовательские сценарии:**
1. Пользователь открывает `/settings/integrations` → вкладка Marketplace → видит плитку "VAPI AI" со статусом "Available".
2. Нажимает "Configure" (или "Enable") → навигация на `/settings/integrations/vapi-ai` — полноценная страница настройки.
3. На странице: секция "API Connection" — поля API Key, Display Name, Environment (prod/dev), кнопка "Verify & Connect" → POST /api/vapi/connections. При успехе поля маскируются, статус меняется на "Connected".
4. После успешного подключения появляется секция "SIP Resource" — поля SIP URI, Server URL, кнопка "Save" → POST /api/vapi/resources. После сохранения показывает SIP URI в режиме просмотра.
5. После заполнения обеих секций — кнопка "Finish Setup" → POST /api/marketplace/apps/vapi-ai/install → статус installation меняется на "Connected". Пользователь может вернуться на `/settings/integrations`.
6. При ошибке верификации API key — inline error под полем, форма не очищается.
7. Если VAPI уже подключён (есть active installation) — страница показывает текущий статус и SIP URI в режиме просмотра, кнопка "Disconnect" → POST /api/marketplace/installations/:id/disconnect.
8. Пользователь открывает Call Flow Builder для группы → нода VAPI AI видна в insert picker (потому что VAPI connected). Без подключения — нода не появляется.

**Ограничения и нефункциональные требования:**
- API key никогда не показывается после сохранения (masked ••••••••).
- Call Flow Builder проверяет наличие active VAPI connection при загрузке (`GET /api/vapi/connections`).
- Стиль страницы: Blanc design system (--blanc-bg, --blanc-ink-1, --blanc-line, rounded-xl, IBM Plex Sans/Manrope). Без горизонтальных линий. Без пустых полей.
- TypeScript строгая типизация во всех новых файлах.
- Плитка VAPI в маркетплейсе: при наличии active installation кнопка меняется на "Manage" → переход на ту же страницу настройки.

**Потенциально вовлечённые модули/части системы:**
- `backend/db/migrations/088_seed_vapi_ai_marketplace_app.sql` — регистрация app в маркетплейсе
- `backend/src/db/marketplaceQueries.js` — добавить 088 миграцию в ensureMarketplaceSchema
- `frontend/src/services/vapiApi.ts` — новый типизированный API клиент
- `frontend/src/pages/VapiSettingsPage.tsx` — новая страница настройки VAPI
- `frontend/src/pages/IntegrationsPage.tsx` — кнопка "Configure"/"Manage" на плитке VAPI ведёт на страницу
- `frontend/src/App.tsx` — зарегистрировать роут `/settings/integrations/vapi-ai`
- `frontend/src/pages/telephony/CallFlowBuilderPage.tsx` — гейтинг vapi_agent ноды

**Затронутые интеграции:** Vapi (через /api/vapi/* backend)

**Защищённые части кода:**
- `frontend/src/lib/authedFetch.ts`
- `src/server.js` (только добавить роут для VapiSettingsPage если нужно — но это SPA, не нужно)
- Существующий `MarketplaceConnectDialog` в IntegrationsPage.tsx (не изменять)
- Существующая логика insert picker в CallFlowBuilderPage.tsx (расширить, не переписывать)

## F017: Согласованность Softphone и User Groups — единая система управления звонками

**Источник истины:** `docs/specs/F017-telephony-groups-softphone-consolidation.md` (полные функциональные требования, утверждены).

**Краткое описание:** Связать две независимо работающие подсистемы — Softphone и User Groups — в единую систему маршрутизации звонков. Группа становится единицей маршрутизации: номер принадлежит ровно одной группе, у группы есть call flow и агенты; входящий звонок исполняет flow группы и рингует только её доступных агентов; Softphone видит только номера и звонки своих групп.

**Ключевые продуктовые решения:**
1. Агент может состоять в нескольких группах; получает звонки из всех своих групп.
2. Доступность агента — только автоматическая: `on_call` = активный звонок, `available` = нет звонка, `offline` = Softphone закрыт.
3. Исполнение call flow при входящем звонке — приоритет №1.
4. Единственная стратегия дозвона — Simultaneous; Round Robin / Most Idle / Sequential / Weighted убираются из UI и логики.
5. Без draft/published: одна актуальная версия flow на группу, сохранение = немедленное применение.

**Проблемы текущего состояния:**
- Softphone виден всем с `phone_calls_allowed=true`, без учёта групп.
- Входящий звонок рингует ВСЕХ разрешённых, игнорируя группу/flow/расписание/стратегию.
- Caller ID picker показывает все client-номера без фильтра по группам пользователя.
- Flow Builder строит SCXML-граф, но он не исполняется при реальных звонках.
- `UserGroupDetailPage` читает mock (`userGroupsMock.ts`), а не API.
- Статус агента не синхронизирован с реальным звонком.
- Ring Strategy хранится, но не исполняется.

**Пользовательские сценарии (укрупнённо, детали в спецификации):**
1. Входящий на номер группы в рабочие часы → flow: Hours Check → Queue → рингует только available-агентов группы → агент принимает.
2. Все агенты заняты → по таймауту Queue → Voicemail.
3. Пользователь не в группах → кнопка Softphone не отображается, Twilio Device не инициализируется.
4. Пользователь в Sales и Support → Caller ID picker показывает номера обеих групп с подписями.
5. Завершение звонка → статус агента авто → `available`, SSE обновляет страницу User Groups.
6. Админ редактирует flow → Save → следующий звонок идёт по новой версии без шага публикации.
7. Привязка занятого номера к другой группе → предупреждение "already assigned to [Group]. Move it?".

**Затронутые модули:**
- Backend: `userGroups.js`, `voice.js` (blanc-numbers), `twilioWebhooks.js` (handleVoiceInbound), новый сервис исполнения flow, миграции БД, `src/server.js` (mount-only).
- Frontend: `useSoftPhoneWidget.ts`, `SoftPhoneHeaderButton.tsx`, `UserGroupsPage.tsx`, `UserGroupDetailPage.tsx` (убрать mock), `PhoneNumbersPage.tsx`, `CallFlowBuilderPage.tsx`, `OperationsDashboardPage.tsx`.

**Затронутые интеграции:** Twilio Voice (inbound webhook, Dial, Record), VAPI (SIP transfer node — уже реализован).

**Защищённые части кода (НЕЛЬЗЯ ломать):**
- `frontend/src/lib/authedFetch.ts`
- `frontend/src/hooks/useRealtimeEvents.ts`
- `src/server.js` core middleware (изменения только mount-only)
- `backend/db/` schema — менять только через задачи с явным планом миграций

**Non-goals:** hold/swap/conference, многоуровневый IVR, биллинг, UI записей звонков, RBAC на уровне групп, версионирование flow.

---

## CRM-SALES-MCP Cross-stage Requirements

**Status:** Implemented and audited

- Stage 0 CRM core exposes `/api/crm` over tenant-scoped services and SQL. Account/contact/deal cards, activities, tasks, notes, metadata, lists, pipeline, allowed writes, before/after audit, and deal history are implemented.
- Stage 1 MCP backend adapter exposes tool definitions and calls over `/api/crm/mcp`; tools are separated into read/write, arguments are runtime-validated, write tools require `sales.crm.write` and confirmation, and CRM errors map to sanitized MCP responses.
- Stage 2 transports expose the same MCP protocol through authenticated backend JSON-RPC, public token-protected HTTP, legacy SSE, and stdio. Public/stdio writes are disabled unless explicitly enabled.
- Stage 3 read-only tools expose explicit seller workflows for deal hygiene, forecast windows, account/contact follow-up, tasks, last customer-facing activity, and deal history.
- Pipeline/forecast analytics tools expose pipeline by owner/team/period, grouping by stage/forecast category, totals, changes, risky deals, and slippage.
- Stage 4 write MCP tools expose typed updates for `deal.next_step`, `deal.stage`, `deal.forecast_category`, `deal.close_date`, `deal.amount`, `deal.risk_summary`, `deal.competitor`, and `task.status`. Each write requires tenant context, `sales.crm.write`, explicit confirmation, before/after response, generated-or-propagated request id, and audit logging.
- Stage 5 Sales workflow selections expose `crm.list_sales_workflows`, generic `crm.get_sales_list`, and explicit read tools for my open deals, closing this month/quarter, deals without activity, deals without next step, risky deals, top accounts by pipeline, accounts needing follow-up, contacts missing role/title/email, and tasks due this week.
- Stage 6 testing and rollout mounts `/api/crm` and `/api/crm/mcp` behind authenticated tenant middleware, mounts public `/mcp/crm` behind token-gated MCP auth, and verifies the minimum regression suite for auth, tenant isolation, writes, audit, no delete tools, secret redaction, slippage/history, stale activity, and workflow lists.

**Cross-stage constraints:**
- `company_id` comes from `req.companyFilter?.company_id` or env-bound public/stdio context, never from client payload.
- Sales workflow calendar windows use company timezone from auth/env context, falling back to `America/New_York`.
- No MCP bulk/delete tools are registered.
- Required typed MCP arguments reject `null` unless the specific write value schema is nullable for explicit field clearing. Legacy generic deal writes validate `value` against the selected allowlisted field before dispatch.
- Current pipeline truth is `crm_deals`; changes/slippage use `crm_deal_history`; weekly snapshots are optional baselines only.

---

## ALB-100: Albusto Commercial Platform Program

**Status:** Requirements
**Priority:** P0
**Owner:** Platform / Identity / RBAC
**Date:** 2026-06-12
**Predecessor:** PF007-HARDENING-001 (provider scope, tenant isolation, deny-by-default RBAC — done)
**Decisions locked with product owner (2026-06-12):**
SMS-код 6 цифр; 2FA на новом устройстве + раз в 30 дней (trusted device);
новая компания активна сразу (super admin может suspend); отдельный платформенный
аккаунт для super_admin; кастомные страницы auth (Keycloak под капотом); онбординг —
минимум (название компании + город/zip через Google Places → таймзона выводится);
Google-вход пропускает email-верификацию, телефон обязателен до входа;
полный ребрендинг видимого UI в Albusto в этой итерации.

Программа из шести воркстримов:

### ALB-101: Self-Registration & Sign-In (Albusto Identity UX)

**Description.** Публичные экраны `app.albusto.com`: регистрация компании и вход.
Identity plane остаётся Keycloak (пользователи, пароли, Google IdP, сессии);
вся видимая поверхность — кастомные React-страницы в дизайн-системе продукта
(тёплая палитра Blanc-стиля, бренд Albusto). Backend оркестрирует Keycloak Admin API.

**Scenarios.**
- SC-01 Email-регистрация: email+пароль+имя → письмо-подтверждение (ссылка) →
  телефон (E.164, с маской) → SMS-код 6 цифр (3 попытки, TTL 5 мин, resend c
  countdown 30 сек) → онбординг-визард.
- SC-02 Google-регистрация: кнопка "Continue with Google" → Keycloak Google IdP →
  email уже подтверждён → шаг телефона + SMS-код → онбординг.
- SC-03 Вход: email/пароль или Google; если устройство не доверено или
  доверие старше 30 дней → SMS-код на привязанный номер → trusted-device cookie
  (httpOnly, 30 дней, per-device id).
- SC-04 Онбординг-визард (один экран): название компании + поле
  "City or ZIP" c Google Places autocomplete (по мере ввода — подсказки);
  выбор подсказки сохраняет city/state/zip/lat/lng и **выводит timezone**
  (Google Time Zone API) — пользователь таймзону не выбирает. Сабмит →
  POST /api/platform/companies (bootstrap: company + tenant_admin membership +
  role configs) → редирект в продукт.
- SC-05 Смена/потеря телефона: tenant_admin может сменить телефон сотрудника
  (сбрасывает trusted devices); super admin — для tenant_admin.

**Constraints.**
- Телефон обязателен до первого входа в продукт (включая Google-путь).
- OTP: 6 цифр, хранится хэш (та же pepper-схема, что api_integrations), max 3
  проверки, max 5 отправок/номер/час, TTL 5 мин; SMS через существующий Twilio.
- Rate limiting на /signup и /otp эндпоинтах; коды в audit_log не пишутся.
- Новые публичные роуты не требуют auth, но живут отдельным router'ом с
  жёсткими лимитами; никакие tenant-данные через них недоступны.
- Email-верификация — стандартный Keycloak flow (required action), Google — нет.

### ALB-102: Platform Companies API + Super Admin Panel

**Description.** PF103 §2: `POST /api/platform/companies` (self-service bootstrap,
вызывается signup-флоу без platform-роли — internal path), а также
`GET/PATCH /api/platform/companies[...]` для платформенного super admin.
SuperAdminPage получает таб Companies: список (имя, город, статус, дата,
кол-во пользователей, последняя активность), suspend/restore c reason,
карточка компании (метаданные + audit summary; НЕ бизнес-данные тенанта).

**Constraints.** Bootstrap-флоу идемпотентен (повторный сабмит не плодит
компании); company.created/suspended → domain events в audit_log;
суспенд → COMPANY_SUSPENDED на всех tenant-роутах (уже реализовано в PF007).

### ALB-103: PF007-HARDENING-002 — calls/messaging/leads/email

**Description.** Тот же метод, что HARDENING-001: аудит внутренних запросов на
tenant-фильтры + granular permissions на роутах `/api/calls`,
`/api/messaging`, `/api/conversations`, `/api/leads`, `/api/email`.
Ключи: `reports.calls.view` (звонки), `messages.view_internal/send`,
`leads.view/create/edit/convert`, email → `messages.view_client`.
Provider (assigned_only) видит звонки/сообщения только своих клиентов
(через jobs mirror, как contacts/pulse).

### ALB-104: Provider Bridge UI (Team Management)

**Description.** В карточке сотрудника CompanyUsersPage — секция Field tech:
тумблер is_provider; при включении — селект "Zenbooker team member" (ростер из
GET /api/zenbooker/team-members, поиск по имени), статус маппинга
(зелёная точка = привязан), кнопка Unlink. Сохранение через существующий
PATCH /api/users/:id (profile.zenbooker_team_member_id). После сохранения —
toast "Provider linked — N jobs now visible to this user" (счётчик из
refreshCompanyProviderMirror). Если ростер недоступен (нет Zenbooker
интеграции) — поле ручного ввода id с подсказкой.

### ALB-105: CI Tenant-Safety Sanitizer

**Description.** Jest-тест `tests/tenantSafetyLint.test.js` (без новых dev-deps):
сканирует backend/src/routes и backend/src/db на запрещённые паттерны:
`req.user?.company_id` / `req.user.company_id` в роутах (кроме allowlist
keycloakAuth/устаревших файлов с явным комментарием), `req.companyId`,
интерполяция `${...}` внутри SQL-литералов с company/user переменными,
`FROM contacts|jobs|leads|timelines...` без company-условия в новых query-файлах
(эвристика + allowlist). Падает с понятным сообщением "tenant-safety violation".

### ALB-106: super_admin Migration Completion + Albusto Rebranding

**Description.**
(a) `/api/admin/*` переводятся с requireRole('super_admin') на
requirePlatformRole('super_admin'); создаётся платформенный аккаунт
(admin@albusto.com, platform_role=super_admin, БЕЗ memberships); realm-роль
super_admin перестаёт давать доступ (фронтовый legacy-fallback в
ProtectedRoute удаляется); help@bostonmasters.com остаётся только tenant_admin.
(b) Полный ребрендинг видимых строк UI: "Blanc" → "Albusto" (шапка, тайтлы,
PWA-манифест, login/signup, письма); внутренние идентификаторы кода
(blanc-* CSS-переменные, BLANC_* env) НЕ трогаем — только пользовательские строки.

**Protected (program-wide):** src/server.js (точечные mount'ы — можно),
frontend/src/lib/authedFetch.ts, frontend/src/hooks/useRealtimeEvents.ts,
миграции 001–096, существующие Twilio webhook-флоу, integrations API (Service
Direct/rely lead flow), VAPI tools endpoint.

**Affected integrations:** Twilio (SMS OTP — новый usage), Google
(Places/Time Zone API — новый usage; OAuth IdP через Keycloak), Keycloak
(Google IdP, registration orchestration), Zenbooker (ростер — read-only).

---

## ALB-107: Multi-tenant Telephony — Twilio Subaccounts

**Status:** Requirements → In progress
**Priority:** P0 (коммерческая платформа)
**Date:** 2026-06-12
**Verified live:** Subaccounts API (create/list, auth_token в ресурсе),
AvailablePhoneNumbers search, Pricing API (US local $1.15/mo, toll-free $2.15/mo).
Ограничение Twilio: операции с субаккаунтами требуют master Account SID +
Auth Token (API Keys не работают) — подтверждено (20003 на CLI-профиле с ключом).

### Модель
Один master-аккаунт Twilio (ISV-модель) + **субаккаунт на каждую tenant-компанию**:
полная изоляция номеров, звонков, usage и (suspend) биллинга. Boston Masters
(legacy, company 0000…0001) остаётся на master-аккаунте.

### Функционал tenant-кабинета (Settings → Telephony → Phone Numbers)
1. **Connect telephony** — один клик: создаётся субаккаунт `Albusto <Company>`,
   статус подключения отображается.
2. **Поиск номеров**: по area code / городу / digits (contains), фильтры
   voice/sms; показ locality + цены ($/mo из Pricing API).
3. **Покупка номера** — в субаккаунт компании, webhooks настраиваются
   автоматически (voice-inbound/status/fallback → api.albusto.com), запись в
   phone_number_settings(company_id).
4. **Список номеров компании**: номер, friendly name (inline rename),
   город/возможности, назначенная группа/маршрут (существующий F017),
   дата покупки.
5. **Release номера** — confirm-диалог, освобождение в Twilio + удаление
   настроек.
6. **Изоляция**: tenant видит только свои номера; кросс-tenant id → 404.
7. **Suspend компании** (platform admin) → suspend субаккаунта (звонки и
   закупки блокируются Twilio-стороной).

### Маршрутизация webhooks
Все номера всех субаккаунтов указывают на одни URL. Компания определяется по
`AccountSid` из webhook payload (company_telephony lookup), fallback — по `To`
номеру (phone_number_settings). Подпись валидируется токеном соответствующего
субаккаунта.

### Phase 2 (реализовано 2026-06-12)
- **A2P 10DLC ISV-регистрация**: TrustHub secondary customer profile + A2P
  trust product + Brand (Low-Volume Standard, skipAutomaticSecVet) + tenant
  Messaging Service (пул номеров) + US A2P campaign. State machine в
  company_a2p_registrations, polling статусов; UI: баннер "SMS limited /
  registered" + wizard бизнес-данных (legal name, EIN, адрес, контакт) +
  one-click создание кампании после approve бренда.
- **Softphone per tenant**: API Key + TwiML App создаются в субаккаунте при
  подключении; /api/voice/token минтит Access Token кредами субаккаунта
  (legacy-компания остаётся на env).
- **Usage per tenant**: this-month сводка из Usage Records ($total, звонки,
  SMS, номера) — чип на странице номеров.

### Roadmap (phase 3)
- Port-in номеров (LOA-флоу), международные номера, billing-марж и инвойсинг
  поверх usage, campaign-вердикты web-hook'ом вместо polling.

### Protected
Существующий call flow (F017), webhooks контракт, master-номера Boston Masters.

---

## AUTO-001: Automation/Rules Engine — End-to-End

**Status:** Requirements · **Priority:** P1 · **Date:** 2026-06-13
**Foundation:** ADR-001 (commit 588c0d8) — eventBus, rulesEngine, ruleActions,
automation_* tables, /api/automation CRUD already exist. This feature makes it
usable end-to-end.

### Description
Превратить заложенный rules-engine в рабочую фичу: визуальный редактор правил
для tenant-админа, фоновый исполнитель agent-задач, и перенос хардкод-триггеров
(`arConfigHelper`) на правила.

### User scenarios
- **SC-01 (редактор):** Tenant-админ открывает Settings → Automation, видит
  список правил, создаёт правило мастером: выбирает триггер (событие из
  каталога ИЛИ таймер «через N после события»/cron), задаёт условия
  (field/op/value, AND/OR), добавляет действия (send_sms/email/create_task/…)
  с превью подстановки `{{...}}`, сохраняет, включает/выключает.
- **SC-02 (история):** В карточке правила — последние запуски
  (`automation_rule_runs`): статус, время, результат действий, ошибка.
- **SC-03 (agent-задача):** Правило с действием `run_agent_task` создаёт
  задачу kind=agent; фоновый worker берёт её (queued→running), вызывает
  agent-логику (включая MCP-инструменты в tenant-контексте), пишет
  output/status (succeeded/failed), эмитит `agent_task.succeeded|failed`.
- **SC-04 (миграция AR):** Существующие AR-триггеры (inbound_sms, missed_call)
  доступны как преднастроенные seed-правила; старый `arConfigHelper`-путь
  помечен к удалению (за фиче-флагом переключается на rules-engine).

### Constraints
- RBAC: всё под `tenant.company.manage`; tenant-изоляция (company_id из
  `req.companyFilter`); чужие правила/runs/задачи → 404.
- Не ломать существующий AR-флоу: миграция за флагом
  `FEATURE_RULES_ENGINE_AR` (default off), старый путь работает пока флаг off.
- Agent-worker идемпотентен (claim через UPDATE…RETURNING, без двойного
  исполнения), ошибки не валят процесс.
- Тесты обязательны (RBAC 401/403, изоляция, worker-claim, миграция AR).

### Out of scope
- Сложные visual flow-граф редакторы (форма-конструктор достаточно).
- Реальные LLM-агенты (worker вызывает существующие сервисы/MCP; LLM-агенты —
  отдельная фича).

---

## BILLING-UI: Subscription & Billing Cabinet (UX-first)

**Status:** Requirements · **Priority:** P1 · **Date:** 2026-06-13
**Foundation:** ADR-001 §2.4 (billingService, /api/billing, stripeProvider) — commit 588c0d8.

### UX intent (designed first)
Владелец компании, не разработчик. Экран `/settings/billing` отвечает на 4 вопроса
без технического шума (без id подписки/клиента/счёта):
1. В каком я состоянии? — крупный статус (Trial · N days left / Active / Past due)
   с человеческой датой окончания.
2. Сколько потратил? — usage-полоски (Text messages / Call minutes / Automations
   run) против лимитов плана; зелёный <80%, янтарный 80-100%, красный при превышении.
3. Как продолжить/апгрейдиться? — карточки планов (Pro = Most popular), кнопка →
   Stripe Checkout.
4. Где мои счета? — список: дата, статус (Paid/зелёный, Failed/красный), сумма,
   View → hosted invoice.

### Scenarios
- SC-01: Новая компания после онбординга — trial автоматически стартовал
  (14 дней), баннер «9 days left».
- SC-02: Апгрейд — клик Upgrade → Checkout redirect → возврат `?status=success`
  → подписка active (через webhook).
- SC-03: Просмотр счетов — клик View открывает hosted invoice Stripe в новой вкладке.
- SC-04: Неоплата — Stripe webhook `invoice.payment_failed` → статус past_due →
  баннер с просьбой обновить карту (через Customer Portal/Checkout).

### Constraints
- RBAC `tenant.company.manage`; tenant-изоляция; webhook — без auth, raw body,
  проверка подписи Stripe v1.
- Без технических идентификаторов в UI (дизайн-принципы CLAUDE.md).
- Trial стартует в bootstrapCompany (онбординг), идемпотентно.
- FEATURE-флаг не нужен (read-only пока нет STRIPE_SECRET_KEY: UI деградирует —
  показывает trial/usage, кнопки апгрейда disabled с подсказкой).
- Тесты: webhook-подпись, trial-старт, usage-расчёт, RBAC.

### Out of scope
- Customer Portal управление картой (фаза 2 — пока через повторный Checkout).
- Proration/downgrade-флоу.

---

## F018: Stripe Payments Marketplace — Tenant Customer Payments (Phases 1–2)

**Status:** Requirements · **Priority:** P0 · **Date:** 2026-06-14
**Источник:** `docs/specs/STRIPE-PAY-001-stripe-payments-marketplace.md`
**Статус реализации:** Phases 1–5 реализованы (2026-06-14). Исключение: on-device Tap
to Pay NFC UI заблокирован отсутствием mobile shell (web-only SPA); backend Terminal
(connection-token + card_present payment-intent + cancel) готов.

**Scope (изначальный прогон):** Phase 1 (marketplace app + Stripe Connect onboarding +
страница `/settings/integrations/stripe-payments` + readiness gating) и Phase 2
(invoice payment links, public `Pay now`, webhook → canonical ledger sync). Phases 3–5
(manual card / Payment Element, Terminal/Tap to Pay backend, refunds + disputes +
reporting source filter) добавлены следующим прогоном.

**Краткое описание:** Любая tenant-компания может подключить приём платежей Stripe
из маркетплейса Albusto и собирать оплату от своих клиентов через invoice payment
link (Stripe Checkout). Все успешные платежи попадают в canonical
`payment_transactions` (`external_source='stripe'`). Это **tenant→customer** платежи,
строго отделённые от **platform billing** (BILLING-UI / ADR-001 — оплата подписки
Albusto самой компанией).

**Связь с существующими фичами (НЕ дублирует):**
- **Расширяет PF004 (Payment Collection):** PF004 явно вынес card processing,
  provider webhooks, Tap to Pay, refunds за пределы P0 и писал только recorded/manual
  платежи в `payment_transactions`. F018 добавляет Stripe-процессор поверх того же
  ledger — не создаёт второй payment-center.
- **Переиспользует паттерн F016 (VAPI marketplace):** marketplace плитка → отдельная
  страница настройки `/settings/integrations/<app>` → `provisioning_mode='none'` seed →
  install/disconnect через существующие `/api/marketplace/*`.
- **Отдельно от BILLING-UI/ADR-001:** не трогает `billingService`, `/api/billing`,
  `stripeProvider` платформенного биллинга и его webhook `/api/billing/webhook`.

**Продуктовые решения (зафиксированы):**
1. Charge model — **direct charges**, tenant = merchant of record, **без application
   fee** (закрывает open decision §16 спеки).
2. Stripe Connect Accounts v2, по одному connected account на компанию.
3. **Tap to Pay отложен** (нет mobile shell; web-only Vite SPA). В этом прогоне — нет.
4. Manual card entry (Payment Element), refunds, reporting-фильтры — следующие прогоны.

**Пользовательские сценарии:**
1. Tenant admin: `/settings/integrations` → плитка `Stripe Payments` (статус
   `Available`) → `Configure` → `/settings/integrations/stripe-payments`.
2. Admin запускает Stripe onboarding (Connect), возвращается, видит readiness states
   (account connected / payments capability / payouts / requirements due / webhook /
   test-vs-live) и setup checklist. Плитка отражает состояние (Available / Setup
   incomplete / Connected / Action required / Payouts disabled / Disconnected).
3. Online collection заблокирован, пока нет `charges_enabled` + card capability.
4. По invoice с balance > 0 authorized user создаёт и копирует Stripe payment link
   (Checkout Session от текущего balance); повторный запрос переиспользует валидную
   сессию, не плодит дубликаты.
5. Invoice send dialog: toggle `Include payment link` (по умолчанию on при balance>0 и
   готовом Stripe), email/SMS, редактируемое тело, copy/preview, warning если не готов.
6. Public invoice page: `Pay now` → создаёт/переиспользует Checkout Session по
   opaque-токену (без internal id), redirect в Stripe.
7. После оплаты Stripe webhook идемпотентно пишет одну строку в `payment_transactions`
   и обновляет invoice `amount_paid`/`balance_due`/`status` через canonical path; failed
   attempt виден в UI, но не создаёт completed-платёж.
8. Admin может Disconnect: новые платежи выключаются, история сохраняется.

**Ограничения и нефункциональные требования:**
- Card data только через Stripe-controlled UI/SDK; Albusto не хранит/не логирует
  PAN/CVC/bank data; secrets — в env, не в tenant metadata.
- Tenant-payments webhook **отдельный** от platform billing webhook, mounted до JSON
  parsing с raw body, проверка подписи (`STRIPE_CONNECT_WEBHOOK_SECRET`).
- Каждый Stripe object проходит tenant-scope verification перед ledger mutation.
- Идемпотентность: webhook по `stripe_event_id`; ledger по `(company_id, external_id)`;
  payment initiation с idempotency keys; UI терпит webhook delay (processing state).
- Все API: `authenticate, requireCompanyAccess`; `company_id` только из
  `req.companyFilter.company_id`; все SQL фильтруют по `company_id`.
- Blanc design system на странице настройки (без `<hr>`, без пустых полей).

**Потенциально вовлечённые модули/части системы:**
- Backend: новые миграции (`stripe_connected_accounts`, `stripe_payment_sessions`,
  `stripe_webhook_events`, seed marketplace app); `backend/src/services/stripePaymentsService.js`,
  `stripeConnectProvider.js`; `backend/src/routes/stripePayments.js`,
  `stripePaymentsWebhook.js`; расширение `backend/src/routes/invoices.js`,
  `backend/src/routes/public-invoices.js`; mount в `src/server.js` (mount-only).
- Reuse: `paymentsService.createTransaction` (`external_source='stripe'`),
  `invoicesService.recordPayment`, `invoicesQueries.createEvent`, `ensurePublicLink`,
  marketplace install/disconnect, `marketplaceQueries.ensureMarketplaceSchema`.
- Frontend: `frontend/src/pages/StripePaymentsSettingsPage.tsx`,
  `frontend/src/services/stripePaymentsApi.ts`; правки `IntegrationsPage.tsx` (плитка),
  `App.tsx` (роут), `components/invoices/InvoiceDetailPanel.tsx` (Collect vs Record
  offline), invoice send dialog, public invoice page.

**Затронутые интеграции:** Stripe (Connect, Checkout Sessions, webhooks). Не Twilio/
Front/Zenbooker (SMS-отправка payment link использует существующий messaging path).

**Защищённые части кода (НЕЛЬЗЯ ломать):**
- `src/server.js` core middleware/SSE (только mount-only добавления).
- `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`.
- `backend/db/` — только новые миграции по явному плану.
- Платформенный billing: `billingService`, `/api/billing`, `stripeProvider`,
  `/api/billing/webhook` — не изменять.

### Out of scope (этот прогон)
- Manual card / Payment Element (Phase 3); Tap to Pay / Terminal (Phase 4); refunds +
  dispute visibility + расширенные reporting-фильтры (Phase 5); application-fee funds flow.

---

## NOTES-001: Unified Notes — Edit, Soft-Delete & Audit History

**Status:** Requirements · **Priority:** High · **Type:** Feature + Refactor
**Scope:** Job / Lead / Contact notes threads only (estimate "Summary" & invoice "Notes" are separate document fields — OUT of scope).

### Description
Consolidate all notes UIs onto the single shared `NotesSection` (used via `NotesHistoryTabs` in the job/lead/contact cards) and add lifecycle management: edit text, add/remove attachments on existing notes, soft-delete — every edit/delete recorded as an audit event in the History tab. Today notes are append-only JSONB arrays (`jobs.notes`, `leads.structured_notes`, `contacts.structured_notes`) with `text`, `created`, author **name**, optional `attachments` — **no stable id, no `created_by` user-id, no `deleted_at`**. Attachments link positionally (`note_attachments.note_index`) and `getEntityHistory` reads notes by array index — both break under edit/delete, so a **stable note id is mandatory**.

### Functional Requirements
- **FR-1..3 Unify:** Jobs/Leads/Contacts notes render through one `NotesSection`; delete dead `StructuredNotesSection.tsx` + `JobNotesSection.tsx`; do not touch estimate/invoice fields.
- **FR-4..6 Identity:** every note gets a stable id (unique within the array, stable across edits/reorders/ZB sync); new notes record `created_by` (req.user.sub); attachments + history key off the id, not array index.
- **FR-7..11 Edit:** per-entity edit endpoint by note id; one save can change text + remove attachments + add attachments; preserves id/created/created_by/position; emits `note_edited` (old→new text, added/removed attachment names, actor).
- **FR-12..15 Soft-delete:** per-entity delete endpoint by note id; sets `deleted_at` + actor without removing from JSONB; **every** notes/history-notes read path excludes soft-deleted notes; emits `note_deleted` that stays in History.
- **FR-16..17 Audit:** reuse `eventService.logEvent`/`domain_events` + `getEntityHistory`; render `note_edited`/`note_deleted` events; keep live (non-deleted) notes rendered from JSONB.
- **FR-18..19 UI:** edit/delete only via a per-note kebab (⋮); show only the actions the current user may perform (else no kebab).

### Permission matrix
| Note class | Tenant admin | Author (own) | Other non-admin |
|---|---|---|---|
| `created_by` = current user | Edit+Delete | Edit+Delete | none |
| `created_by` = another user | Edit+Delete | n/a | none |
| Legacy (name only, no `created_by`) | Edit+Delete | none | none |
| No author | Edit+Delete | none | none |
| Zenbooker-synced | Edit+Delete | none | none |

Admin = tenant_admin role / `membership.role_key`. Non-admin may edit/delete **only** notes whose `created_by` = their user-id. Ownership unverifiable (legacy/no-author/ZB) → **admin only**. **All checks enforced server-side** (direct API call by a non-admin on another's note → 403); kebab visibility is convenience only.

### Data & lifecycle
- **DR-1** Backfill a stable id onto every existing note (idempotent migration) so legacy notes are admin-editable.
- **DR-2** Add `created_by` to note objects; new notes set it; absent → unverifiable ownership (admin-only).
- **DR-3** Add `deleted_at` (+ deleting actor); soft-deleted notes retained in JSONB but filtered from all reads.
- **DR-4** Move attachment linkage from positional `note_index` to the stable note id (or a compat mapping).
- **DR-5** Edit/delete audit via `domain_events` (`logEvent(companyId,'job|lead|contact',entityId,'note_edited|note_deleted',{...},'user',req.user.sub)`); no new audit table.
- **DR-6** Note id stable across Zenbooker re-sync (no duplicate/resurrect/re-index).

### Constraints
Multi-tenant: company_id ONLY from `req.companyFilter`. Backwards-compatible with pre-migration notes (tolerate missing fields; no data loss). Zenbooker sync must preserve new fields + stable ids; ZB notes admin-only. New endpoints sit alongside existing `requirePermission('*.edit')` + add ownership/admin check. Reuse `eventService`. Respect `noteAttachmentsService` max-files cap (surviving + added).

### Out of scope
Estimate "Summary", invoice "Notes", hard delete, un-delete UI, rich-text/@mentions/threading, per-note privacy/pinning.

### Acceptance criteria
AC-1 one `NotesSection` for jobs/leads/contacts; legacy components deleted. AC-2 new note persists id + created_by. AC-3 non-admin edits/deletes only own; no actions on others'/legacy/ZB. AC-4 admin edits/deletes any (incl. legacy/ZB). AC-5 server rejects non-admin editing another's note (403) even bypassing the kebab. AC-6 one edit can change text + remove + add attachment, keeping id/position/created/created_by. AC-7 edit emits `note_edited` (old→new + attachment deltas) in History. AC-8 deleted note gone from thread AND every notes/history-notes response. AC-9 `note_deleted` stays in History. AC-10 editing/deleting one note doesn't corrupt another's attachments. AC-11 cross-company isolation on all ops. AC-12 pre-migration notes still render and are admin-addressable after backfill; none lost. AC-13 ZB re-sync after edit/delete doesn't duplicate/resurrect/re-index.

## SLOT-ENGINE-001 — UX polish (2026-06-25)

**Status:** Requirements · **Priority:** P0–P3 polish · **Type:** UX / consistency / copy bugfix pack over the merged SLOT-ENGINE-001.
**Scope (HARD):** frontend `frontend/src/components/conversations/CustomTimeModal.{tsx,css}` and `slot-engine/src/engine.js` (`explain()`) ONLY. No engine architecture, API contract, DB, scoring, or multi-tenant changes.
**Naming:** product is **Albusto**. New user-facing copy must contain no "Blanc". Do NOT rename `--blanc-*` CSS tokens or code identifiers (BlancBadge, etc.) — "Blanc" is internal-only.

### Description
The slot-picker side panel (`CustomTimeModal`) and the engine's `explain()` ship machine-y, partly-Russian, jargon-heavy output in an all-English UI. This pack closes the design-critique findings: clean English explanations, a single visual quality signal, consistent "Recommended/Preselected" vocabulary, a human empty state, warm Albusto tokens, reused components, and accessibility/dead-code cleanup. No behavior of the recommendation algorithm changes.

### Requirements (per finding)

**SE-UX-1 (P0) — `explain()` returns a clean English reason only.**
`engine.js` `explain()` currently returns Russian text with the typo "технік", a "Риск: …" line, and a redundant `${date}, ${win.start}-${win.end}, ${tech.name}` prefix the card already renders.
- AC-1: `explanation` is English, with no Russian characters and no "технік"/"Риск" strings anywhere in engine output.
- AC-2: `explanation` contains NO date, time/window, or technician name — only the reason (e.g. "Tech already working nearby · low added travel · comfortable schedule buffer"). Empty/short candidates yield a sensible terse English reason, never an empty string that breaks the card.
- AC-3: No engine test asserts on the literal explanation text (assert on type/shape only), so copy can evolve freely.

**SE-UX-2 (P1) — One visual quality signal (temperature mini-bar); humanized dispatch flag; no snake_case leak.**
The rec card today renders three raw machine signals: integer `score`, raw `confidence` enum, and the jargon flag "Dispatch confirm".
- AC-4: The score+confidence quality signal is shown as ONE thin vertical "temperature" mini-bar on the card edge; fill height and color map to tier (high → green, medium → blue, low → amber/muted). Minimal footprint.
- AC-5: The raw numeric score is OFF the card face — present only in a hover `title`/tooltip and/or `aria-label` for accessibility. The standalone `confidence` text chip and the raw `<span class="ctm-rec-card__score">` number are removed from the visible card.
- AC-6: "Dispatch confirm" is replaced by a separate humanized actionable flag "Approx. address — confirm" (amber), rendered ONLY when `requires_dispatch_confirmation` is true.
- AC-7: The `reason_codes?.[0]` fallback never leaks snake_case to the UI; with `explain()` fixed, the visible sub-text is always human English (humanized fallback if `explanation` is ever missing).

**SE-UX-3 (P1) — Vocabulary: engine = "Recommended", copied-tech = "Preselected".**
- AC-8: Panel header reads "Recommended times" (was "Suggested times"); the engine tech-bar pill reads "Recommended".
- AC-9: The copied-from-duplicate tech pill reads "Preselected" (was "Suggested"); related comments/labels for that lane use "Preselected", not "Suggested".

**SE-UX-4 (P2) — Human empty state when engine is enabled but returns zero recs.**
Today the panel vanishes silently when the engine is on but returns no recommendations.
- AC-10: When the marketplace app is installed/enabled and the engine returns zero recs (engine reachable, empty result — distinct from disabled/unreachable), the panel shows "No nearby openings — try another day" instead of disappearing.
- AC-11: When the app is disabled or the engine is unavailable, the panel remains absent and the modal is unchanged (no regression to current graceful behavior).

**SE-UX-5 (P2) — Warm Albusto tokens; remove dead dark fallbacks.**
Timeline/date-nav/hour-labels use cold neutral tokens.
- AC-12: `--muted-foreground` → `--blanc-ink-3` and `--border` → `--blanc-line` across the touched CSS; dead dark fallbacks (`#27303f`, `#0f172a`, and the other `#1e293b/#334155/#64748b/#94a3b8`-style cold fallbacks in the same rules) are removed.

**SE-UX-6 (P2) — Technician pagination arrows use the Button component.**
- AC-13: The technician prev/next pagination arrows use the shared `Button` component (`variant="ghost"`, `size="icon"`), matching the date-nav arrows; raw `<button>` markup for them is removed.

**SE-UX-7 (P3) — Dead CSS, keyboard accessibility, no emoji.**
- AC-14: Dead CSS rules `.ctm-timelines__dots`, `.ctm-timelines__footer`, `.ctm-timelines__legend*` (and their orphaned children) are deleted.
- AC-15: The recommendation overlay bands (currently `<div onClick>`) are keyboard-accessible (focusable, Enter/Space activate, appropriate role/aria-label).
- AC-16: The 🕓 and 🔧 emoji in the map info-window markup are removed (Albusto rule: no emoji); the underlying time/service text remains.

### Constraints
- Touch only the three named files. No changes to engine scoring, ranking, config, output contract fields, the proxy/service, DB, or any tenant-isolation logic.
- Preserve existing graceful-degradation behavior (panel absent when disabled/unreachable).
- Frontend must build green (`npm run build` / tsc -b; prod Docker build is stricter — no unused locals).
- Do not introduce any user-facing "Blanc"; do not rename `--blanc-*` tokens or code identifiers.

### Out of scope
Engine algorithm/weights/feasibility, Google Routes upgrade, multi-tech, new fields/contracts, settings/base-location UI, the proxy and `slotEngineService`, any backend/DB work, and i18n/localization of the panel.

### Affected modules
- `frontend/src/components/conversations/CustomTimeModal.tsx` + `.css` (rec cards, tech pills, panel header, empty state, tokens, pagination arrows, overlay bands, map info window).
- `slot-engine/src/engine.js` — `explain()` only.

### Affected integrations
None (no Twilio/Front/Zenbooker/Google contract changes; engine I/O contract unchanged).

### Protected (do NOT break)
Engine scoring/ranking/feasibility pipeline and output contract; `slotEngineService`/proxy gating + safe-failure; marketplace install gating; multi-tenant isolation; `--blanc-*` token names and `Blanc*` identifiers; existing pick mechanism (click rec → applies slot+tech).

---

## ONWAY-001 — On-the-way ETA notification (2026-06-26)

**Status:** Requirements · **Priority:** P1 · **Type:** Feature (technician dispatch UX + outbound SMS + new job status).
**One-liner:** From a job card in a pre-visit status, a technician taps a primary CTA, sees a device-geolocated Google travel-time ETA plus preset tiles, picks one, and taps "Notify client" → an outbound SMS (tech name + ETA) is sent to the customer, the message lands in the customer's conversation timeline, and the job flips to a new **On the way** status.

### Description
Technicians need a one-tap way to tell a customer they are en route, with a realistic arrival estimate, without leaving the job card or composing a message by hand. ETA is computed from the technician device's live geolocation (PWA) to the job's service address via Google travel-time (reusing `routeDistanceService`). The same action both notifies the customer (SMS recorded to the conversation) and advances the job into a new pre-visit-reachable status, **On the way**.

### Actors & entry point
- **Actor:** assigned technician (or dispatcher) holding the `messages.send` permission, viewing a Job card.
- **Entry:** the **"On the way"** button is the **primary CTA** on the Job card when the job is in a pre-visit status. Per the current Job FSM/`ALLOWED_TRANSITIONS`, the pre-visit set is **Submitted**, **Rescheduled** (and, where applicable, a future **Scheduled** status if introduced by the FSM seed). "Waiting for parts" / "Follow Up with Client" / terminal states do not show it as primary. The exact reachable-from set is whatever the published Job FSM defines as transitions into **On the way**; the hardcoded fallback map must mirror it.

### User scenarios

#### SC-01 — Happy path with geolocation (mobile PWA)
1. Technician opens a job in **Submitted**/**Rescheduled** and taps the primary **"On the way"** CTA.
2. Modal opens and immediately requests `navigator.geolocation.getCurrentPosition`.
3. Permission is granted and a fix is returned → frontend asks the backend to compute travel time from `{lat,lng}` (device) → job service address, reusing `routeDistanceService.computePair` (driving, no live traffic).
4. The computed Google ETA (rounded minutes) is shown pre-selected at the top; preset tiles **10 / 15 / 20 / 30 / 45 / 60** and a **"Set custom time"** row are also offered.
5. Technician keeps the Google value (or picks a tile / custom) and taps **"Notify client"**.
6. Backend sends the SMS via `conversationsService` (getOrCreateConversation + sendMessage) to the customer phone; the outbound message appears in the customer's conversation timeline; the job status is set to **On the way**.
7. Modal shows success and closes; the job card now reflects **On the way** and the CTA is no longer primary.

#### SC-02 — No geolocation / denied / desktop (fallback)
1. Technician (or desktop dispatcher) opens the modal; geolocation is unavailable, denied, or times out.
2. **No Google call is made.** The modal shows a placeholder such as **"ETA unavailable — location is off"** and offers only the preset tiles + **"Set custom time"**.
3. Technician picks a tile or custom value and taps **"Notify client"** → SMS sent with the chosen minutes; status set to **On the way** (same as SC-01 steps 6–7).

#### SC-03 — No customer phone
1. Technician taps the CTA / "Notify client" but the job's contact has no phone.
2. SMS cannot be sent; the action is blocked with a clear message ("No phone number on file for this customer"). **Status is NOT changed** (no silent "On the way" without a notification). No partial side effects.

#### SC-04 — No service address (ETA only)
1. Job has no usable service address / no `lat,lng` and cannot be geocoded.
2. Google ETA is not computed (placeholder shown, same as SC-02), but the flow still works via preset/custom tiles. Address absence blocks only the Google ETA, not the notification or the status change.

#### SC-05 — Wallet-blocked (insufficient balance)
1. Technician taps **"Notify client"**; the company wallet is at/below the grace floor (`walletService.assertServiceActive` throws inside `sendMessage`).
2. The SMS is rejected; the modal surfaces a wallet/billing message ("Messaging is paused — top up your balance"). **Status is NOT changed** (SMS is the primary success; status follows it).

#### SC-06 — SMS send failure (Twilio/transient)
1. Technician taps **"Notify client"**; `sendMessage` fails for a non-wallet reason (Twilio error, network).
2. The action reports failure and **does not** change the job status. Technician may retry. No duplicate status flip, no orphaned "On the way".

### Requirements & acceptance criteria

**OW-R1 — Primary CTA placement & gating.**
- AC-1: The **"On the way"** button renders as the **primary CTA** on the Job card only for jobs whose current status has a defined transition into **On the way** in the active Job workflow (pre-visit: **Submitted**, **Rescheduled**, future **Scheduled**). It is hidden (or non-primary) otherwise and never shown for terminal states.
- AC-2: The button/modal is available only to users with the required dispatch/messaging permission (`messages.send`); a user lacking it neither sees the action nor can call the endpoint (403).

**OW-R2 — Device-geolocation ETA.**
- AC-3: On modal open the client calls `navigator.geolocation.getCurrentPosition`. If a fix is obtained AND the job has a usable address, the backend computes travel-time from device coords → job address by reusing `routeDistanceService` (driving, no `departure_time`/traffic); the rounded-minute result is shown pre-selected.
- AC-4: If geolocation is unavailable, denied, errors, or no address exists, **no Google request is made** and the modal shows the **"ETA unavailable — location is off"** placeholder with preset tiles + custom only. (No live/continuous tracking — a single `getCurrentPosition` per open.)

**OW-R3 — ETA selection model.**
- AC-5: The technician can choose exactly one ETA value from: the Google ETA (when present), a preset tile (**10/15/20/30/45/60**), or a **"Set custom time"** manual minute entry. Custom accepts a positive integer minute value; the chosen value is what is sent in the SMS.

**OW-R4 — Notify = SMS + status, in that priority order.**
- AC-6: "Notify client" sends the SMS via `conversationsService` (`getOrCreateConversation` with the customer phone + company proxy/DID resolved server-side, then `sendMessage`), recording it as an **outbound** message in the customer's conversation/timeline.
- AC-7: After a successful SMS, the job status is set to **On the way**. **Ordering:** SMS first; the SMS is the primary success signal. If the status set fails after a successful send, the API still returns success for the notification and surfaces a non-blocking warning that the status did not advance (no rollback of the sent SMS). If the SMS fails (incl. wallet block, SC-05/SC-06), the status is **not** changed.
- AC-8: No phone (SC-03) → blocked before send, status unchanged, clear error. No double-send and no double status-flip on retry/double-click (idempotent on the success path).

**OW-R5 — SMS template (English, exact).**
- AC-9: The message body is exactly:
  `Hi! Your technician {tech} from {company} is on the way and should arrive in about {eta} minutes.`
  where `{tech}` = assigned technician display name (from the job's assignment), `{company}` = company name, `{eta}` = chosen minutes (integer). All copy/UI is English.

**OW-R6 — New "On the way" job status.**
- AC-10: **On the way** is added as a NEW status to the Job workflow — to the hardcoded `BLANC_STATUSES`/`ALLOWED_TRANSITIONS` fallback in `jobsService.js` **and** to the Job FSM SCXML seed (FSM-001), as a non-terminal state reachable from the pre-visit statuses, with sensible onward transitions (e.g. → Visit completed / Canceled). The fallback map and the seed must stay consistent.
- AC-11: The status is rendered in the standard Job status UI (status tags / list) like any other status; the standard transition/audit path records the change.

**OW-R7 — Multi-tenant & security.**
- AC-12: `company_id` is taken ONLY from `req.companyFilter` (never from client payload). The customer phone is derived from job → contact server-side. The proxy/company DID is resolved server-side. The endpoint enforces `requirePermission` (dispatch/messaging) + company scoping; a job from another tenant returns 404/403.

### Constraints / NFRs
- **Reuse, don't reinvent:** ETA via `backend/src/services/routeDistanceService.js` (`computePair`); SMS via existing `conversationsService.getOrCreateConversation` + `sendMessage` (wallet gate already enforced inside `sendMessage`). No new Twilio send path.
- **CommonJS backend**, English-only copy, Albusto design system (no user-facing "Blanc").
- **PWA geolocation only** for origin; desktop/no-permission degrades gracefully to tiles.
- Google travel-time call is **driving, no traffic** (consistent with SCHED-ROUTE-001) and only fired on cache-miss with a valid key; a missing key behaves like SC-02 (no ETA, tiles only).

### Affected modules
- **Backend:** `services/jobsService.js` (new status in `BLANC_STATUSES` + `ALLOWED_TRANSITIONS`; status-set on notify); `services/routeDistanceService.js` (reused for device→job ETA); `services/conversationsService.js` (reused send path); a route (e.g. under `routes/jobs.js` or `routes/messaging.js`) for "notify on the way" (compute ETA + send + set status); Job FSM SCXML seed (FSM-001) — add **On the way** state + transitions.
- **Frontend:** Job-card CTA in `components/jobs/JobStatusTags.tsx` (JobOpsSection, where the action bar now lives) + a new "On the way" modal component (geolocation request, ETA display, preset tiles, custom time, Notify button); `services/jobsApi.ts` for the new endpoint.

### Affected integrations
- **Twilio** (outbound SMS via Conversations — already wired through `conversationsService`).
- **Google Distance Matrix** (travel-time via `routeDistanceService`; key from env, never to browser).
- **Zenbooker:** the new **On the way** status is Blanc-internal; it must NOT regress the existing outbound ZB status sync (only sync if/when an explicit ZB mapping is defined — otherwise no outbound ZB call for this status).

### Protected (do NOT break)
- The existing `sendMessage` wallet gate (`walletService.assertServiceActive`) — it must remain the single enforcement point for outbound SMS cost.
- Existing Job FSM transitions/seed completeness (FSM-001 §8) and the hardcoded fallback — adding **On the way** must not drop or alter existing statuses/transitions.
- Existing outbound Zenbooker sync behavior on the current statuses.
- `frontend/src/lib/authedFetch.ts`, `useRealtimeEvents.ts`, `server.js` (shared infra, per FSM-001 protected list).

### Out of scope
- Live / continuous technician tracking (only a single `getCurrentPosition` per modal open — no streaming location, no map breadcrumb).
- Recurring or automatic ETA recomputation / auto-resend; no scheduled "running late" follow-ups.
- ETA accuracy beyond Google's single estimate (no traffic/`departure_time`, no multi-leg routing).
- Customer-facing live ETA page / link; inbound reply handling beyond the normal conversation flow.
- Localization/i18n of the SMS or modal (English only this pass).

---

## REC-SETTINGS-001 — configurable recommendation settings (2026-06-26)

**Status:** Requirements · **Priority:** P1 · **Type:** New feature (per-company configuration over the merged SLOT-ENGINE-001).

**Краткое описание:** Replace the hardcoded `config_override` in `backend/src/services/slotEngineService.js` with **per-company settings** a dispatcher edits in the UI. The slot engine already accepts a `config_override` (deep-merged over `slot-engine/src/config.js` `DEFAULT_CONFIG`), so the only change is *where the override comes from* — there is **NO engine redeploy**. Exactly **5** parameters are exposed in a "Recommendation settings" block on the Settings → Technicians page (`frontend/src/pages/TechnicianPhotosPage.tsx`); two further values are always applied but never shown.

### Пользовательские сценарии

1. **View settings (first run / no row).** A dispatcher with `tenant.company.manage` opens Settings → Technicians. The "Recommendation settings" block shows the 5 fields populated with the **documented defaults** (Max distance 10 mi, Allow overlap 0 min, Min buffer 15 min, Planning horizon 3 days, Recommendations shown 3) even though no DB row exists yet. Behavior is well-defined for every company before anyone saves.
2. **Edit + save.** The dispatcher changes one or more fields (e.g. Max distance 10 → 15, Recommendations shown 3 → 5) and saves. The values are validated, persisted to the company's row, and the block reflects the saved values on reload.
3. **Recommendations use the saved values.** On the next slot-recommendation request for that company, `slotEngineService` reads the company's saved settings, builds the engine `config_override` from them (plus the two fixed values), and the returned recommendations reflect the new settings (e.g. a wider radius surfaces farther technicians; `top_n` controls how many cards return).
4. **Reset to defaults.** Clearing the form / restoring defaults and saving writes a config equal to the documented defaults; recommendations behave exactly as the untouched first-run case.

### Пользовательские параметры (exactly these 5)

Each maps to one or more engine `config_override` keys (deep-merged over `DEFAULT_CONFIG`).

| # | UI label | Control | Default | Validation | Engine config key(s) |
|---|----------|---------|---------|-----------|----------------------|
| 1 | **Max distance (mi)** | number input | **10** | integer **1–100** | `geography.max_distance_from_existing_job_miles` **AND** `geography.max_distance_from_base_if_empty_day_miles` (ONE radius → BOTH keys) |
| 2 | **Allow overlap (min)** | picker {0, 30, 60, custom} | **0** (no overlap) | integer **0–240** | `overlap.max_timeframe_overlap_minutes` |
| 3 | **Min buffer between jobs (min)** | picker {0, 30, 60, custom} | **15** | integer **0–240** | `feasibility.min_required_slack_minutes` |
| 4 | **Planning horizon (days)** | number input | **3** | integer **1–14** | `planning.horizon_days` |
| 5 | **Recommendations shown** | number input | **3** | integer **1–10** | `ranking.top_n` |

### Fixed values (ALWAYS applied in the built config_override, NOT in the UI)

- `geography.allow_empty_day_candidates = true`
- `workload.max_day_utilization = 0.95`

### Acceptance criteria

**RS-R1 — Storage / schema.**
- AC-1: A new table `slot_engine_settings(company_id uuid PRIMARY KEY REFERENCES company, config jsonb NOT NULL, created_at timestamptz, updated_at timestamptz)` is created via a migration. `company_id` is both PK and FK (one row per company).
- AC-2: `config` (jsonb) stores the 5 user-set parameter values. The two fixed values may be persisted or injected at build time, but they are ALWAYS present in the `config_override` the service sends to the engine regardless of stored content.

**RS-R2 — Defaults when no row (well-defined for every company).**
- AC-3: When a company has no `slot_engine_settings` row, GET returns the documented defaults (10 / 0 / 15 / 3 / 3) and `slotEngineService` builds the `config_override` from those same defaults plus the two fixed values. No request is ever sent with an undefined/partial parameter.

**RS-R3 — slotEngineService consumes saved settings (replaces hardcode).**
- AC-4: The hardcoded `config_override: { geography: { allow_empty_day_candidates: true, max_distance_from_base_if_empty_day_miles: 40 } }` in `getRecommendations` is REMOVED. The service instead reads the company's row (or defaults) and assembles `config_override` mapping each of the 5 parameters to the engine key(s) in the table above, plus the two fixed values.
- AC-5: `HORIZON_DAYS` (currently the local constant `2` used for `latest_allowed_date`) is driven by the **Planning horizon (days)** setting (i.e. `planning.horizon_days`), so the snapshot window and the engine config agree.
- AC-6: No change to `slot-engine/` is required; the engine receives the override and deep-merges it as today (no redeploy).

**RS-R4 — CRUD endpoints (GET + PUT only).**
- AC-7: `GET` returns the company's settings (or documented defaults when no row). `PUT` upserts the company's row with the validated 5 parameters.
- AC-8: Both endpoints enforce `requirePermission('tenant.company.manage')`.
- AC-9: `company_id` is taken **ONLY** from `req.companyFilter` — never from the client payload. A request without a resolvable company scope is rejected; a caller can never read or write another tenant's settings.

**RS-R5 — Validation (per parameter, server-enforced; the UI mirrors the same ranges).**
- AC-10: **Max distance** integer 1–100 mi; **Allow overlap** integer 0–240 min; **Min buffer** integer 0–240 min; **Planning horizon** integer 1–14 days; **Recommendations shown** integer 1–10. Out-of-range, non-integer, or missing values are rejected (422) on PUT — no partial save.
- AC-11: For pickers (2, 3) the {0,30,60} options and the **custom** path both resolve to an integer that must satisfy the 0–240 range; "custom" cannot bypass validation.

**RS-R6 — UI (English, Albusto tokens, follows design canon).**
- AC-12: The "Recommendation settings" block lives on the Settings → Technicians page (`frontend/src/pages/TechnicianPhotosPage.tsx`), English copy, Albusto design tokens (`--blanc-*`, no user-facing "Blanc"). It shows exactly the 5 controls — the two fixed values are not surfaced. Section header uses the `.blanc-eyebrow` style; no horizontal separators.

### Ограничения и нефункциональные требования
- **No engine redeploy / no engine code change.** The engine `config_override` contract (`slot-engine/src/config.js` deep-merge) is reused unchanged.
- **Multi-tenant isolation:** `company_id` only from `req.companyFilter`; one row per company; cross-tenant read/write impossible.
- **RBAC:** all access under `requirePermission('tenant.company.manage')`.
- **English-only** copy, **Albusto** design system; CommonJS backend (consistent with `slotEngineService.js`).
- **Safe-failure preserved:** existing slot-engine safe-failure behavior in `slotEngineService` (empty, flagged result on any engine fault / missing `SLOT_ENGINE_URL`) must not regress; settings load failure must degrade to documented defaults rather than throw.

### Потенциально вовлечённые модули/части системы
- **Backend:** `backend/src/services/slotEngineService.js` (build `config_override` from settings; drop hardcode; drive horizon); a new settings service/queries for `slot_engine_settings`; a route exposing `GET`/`PUT` (alongside the existing `/api/settings/technician-base-locations` routes); a migration for the new table.
- **Frontend:** `frontend/src/pages/TechnicianPhotosPage.tsx` (the "Recommendation settings" block); a small settings API client (alongside the technician-base-locations client).

### Затронутые интеграции
- **Slot engine** (`slot-engine/`) — consumes the built `config_override`; **no redeploy**.
- Twilio / Front / Zenbooker / Google: **none** (Zenbooker still supplies the technician roster for recommendations, but is unaffected by this feature).

### Защищённые части кода (НЕЛЬЗЯ ломать)
- The slot-engine `config_override` deep-merge contract and `DEFAULT_CONFIG` (`slot-engine/src/config.js`) — do not change engine defaults or merge semantics.
- `slotEngineService` safe-failure path (empty/flagged result on engine fault) and the snapshot-building logic (technicians, scheduled jobs, coverage).
- The existing `technician_base_locations` table, its settings screen, and its `GET/PUT/DELETE` routes — REC-SETTINGS adds a sibling, it must not alter base-location behavior.
- Multi-tenant `company_id` resolution via `req.companyFilter` and the `tenant.company.manage` permission convention.

### Out of scope
- **Any of the engine's internal parameters not in the 5 exposed** — explicitly: the travel model (`travel.*` — `model`, `average_city_speed_mph`, multipliers, edge limits, `geo_uncertainty_beta`), scoring weights and thetas (`scoring.*`), geo-confidence threshold (`geography.min_geo_confidence_for_auto_recommendation`), candidate time-frames / workday windows (`candidate_timeframes`, `workday.*`), durations (`durations.*`), and the other ranking/diversity caps (`ranking.max_recommendations_per_technician`, `ranking.max_recommendations_per_same_timeframe`). None are exposed or editable.
- Per-technician or per-territory overrides (settings are per-company only).
- Engine redeploy, engine algorithm/weights/feasibility changes, or any change to the engine API contract.
- Localization/i18n of the settings UI (English only this pass).
- Versioning/audit history of settings changes, and import/export of configs.

---

## REC-SETTINGS-002 — make `max_distance_miles` the effective empty-day coverage radius (2026-06-26)

**Status:** Requirements · **Priority:** P1 · **Type:** Follow-up to REC-SETTINGS-001 (no new UI, no engine change).
**Predecessor:** REC-SETTINGS-001 (`docs/specs/REC-SETTINGS-001.md`).

### Problem (verified on prod)

In REC-SETTINGS-001 the **Max distance (mi)** setting (`max_distance_miles`) is mapped to the engine's GEO pre-filter only — both `geography.max_distance_from_existing_job_miles` and `geography.max_distance_from_base_if_empty_day_miles`. Those gates decide *which* candidates are **generated**. But an empty-day candidate (base → new job → base) is then independently re-checked by the engine's **TRAVEL-FEASIBILITY** gates (`travel.max_edge_travel_minutes`, `travel.max_extra_travel_minutes`), which are left at their `DEFAULT_CONFIG` values. With those defaults the empty-day extra-travel gate cuts off at **~4.5–5 mi straight-line from base** (empirically: a job at a tech base → recommendations; a job 5.4 mi away → 0 feasible) **regardless of how large `max_distance_miles` is set**. So a dispatcher who sets Max distance to 25 mi still effectively gets ~5 mi of empty-day coverage.

### Binding decisions (from the customer — fixed, not re-litigated here)

1. The radius (`max_distance_miles`) is the **effective coverage limit**. The natural upper bound is the technician workday (the engine's existing route / workday-fit checks). **No** additional hard drive-time ceiling.
2. The travel caps must **scale from `max_distance_miles`** with enough headroom that the **GEO gate (not travel) binds** for a job at exactly the radius on an empty day.
3. **No engine change / redeploy** — `config_override` already deep-merges `travel.*`. **No UI change.** The existing `geography.*` mapping (both keys = `max_distance_miles`) stays exactly as-is.

### Solution summary

`buildConfigOverride(settings)` (in `backend/src/services/slotEngineSettingsService.js`) additionally emits a `travel` block whose two empty-day-relevant caps are **derived from `max_distance_miles`** using the engine's own travel-time constants, plus a small headroom, so the geo radius becomes the binding constraint. Everything else (the 5 mapped params, the 2 fixed values, the geography mapping) is unchanged.

### Acceptance criteria

- **AC-1 (travel caps emitted from radius).** `buildConfigOverride` returns a `travel` object containing `max_edge_travel_minutes` and `max_extra_travel_minutes`, both computed from `max_distance_miles` via the documented formula (see `docs/specs/REC-SETTINGS-002.md`). No other `travel.*` key is emitted (the rest stay at engine defaults via deep-merge).
- **AC-2 (radius binds on an empty day).** For a job at exactly `max_distance_miles` straight-line from a tech base on an otherwise empty day, both travel gates pass with margin, so the candidate is rejected (if at all) only by the GEO gate / workday-fit — i.e. the geo radius is what bounds coverage, not travel. At the default 10 mi, empty-day coverage reaches ~10 mi (not ~5 mi).
- **AC-3 (never more restrictive than today).** The emitted `max_edge_travel_minutes` is always **≥ the engine default of 45**; the emitted `max_extra_travel_minutes` is always **≥ the engine default of 35** (both monotonically non-decreasing in `max_distance_miles`). The change can only ever *widen* feasibility versus the previous REC-SETTINGS-001 output, never narrow it.
- **AC-4 (existing-job + geography mapping unchanged).** The geography mapping (one radius → both geography keys + `allow_empty_day_candidates=true`), the `overlap`/`feasibility`/`planning`/`ranking` mappings, and `workload.max_day_utilization=0.95` are byte-for-byte unchanged from REC-SETTINGS-001. The travel caps also govern existing-job edges (the engine applies the same `travel.*` gates to non-empty routes); scaling them up cannot reject any edge the old defaults accepted (caps only grow).
- **AC-5 (defaults still safe).** With the documented defaults (`max_distance_miles=10`) the emitted caps make ~10 mi of empty-day coverage reachable rather than ~5 mi, while the workday/route-fit checks still bound long routes (a 10-mi empty-day round trip is well within the workday).
- **AC-6 (no engine / UI change).** No file under `slot-engine/` changes; no redeploy. No frontend file changes. Only `buildConfigOverride` (and its unit tests) change. Saved settings rows are untouched; a company with no row still resolves to DEFAULTS (10 mi) and now reaches ~10 mi empty-day coverage.

### Constraints / non-functional

- The formula's constants (`average_city_speed_mph`, `travel_time_multiplier`, `operational_buffer_minutes`, the engine edge/extra defaults 45/35) are **read from `slot-engine/src/config.js` DEFAULT_CONFIG and the `slot-engine/src/geo.js` travel model** — they are mirrored as documented literals in `slotEngineSettingsService.js`, NOT imported from the engine package (backend does not depend on `slot-engine/`).
- Safe-failure parity preserved: `resolve`→DEFAULTS on DB error still yields a complete, well-defined override (now including the travel block).

### Out of scope

- Any UI surface for the travel caps (they remain derived, never user-edited).
- A separate hard drive-time ceiling, per-technician travel tuning, or exposing `average_city_speed_mph` / multipliers.
- Changing `slot-engine/` defaults or merge semantics; any engine redeploy.
- Re-mapping the geography keys or adding a 6th user parameter.

### Protected (must not break)

- The REC-SETTINGS-001 `buildConfigOverride` mapping for the 5 params + 2 fixed values (extended, not altered).
- `slot-engine/` `DEFAULT_CONFIG` + `mergeConfig` deep-merge contract.
- `slotEngineService` consumption path and its safe-failure behavior.

---

## EMAIL-TIMELINE-001 — Email in the contact timeline (send + receive), on a mail-provider abstraction (2026-06-26)

### Problem statement

The contact timeline (Pulse, `GET /api/pulse/timeline/:contactId`) is the single place an agent works a client: it shows **calls + SMS + financial events** chronologically and lets the agent reply over SMS inline. But **email is invisible there.** The existing Gmail integration (**EMAIL-001**) syncs the company's shared mailbox into a *separate* inbox (`/email`), with no link from an email to the contact it belongs to and no presence in the timeline. So an agent who calls and texts a client in Pulse must leave for a different screen to see — and cannot at all *send* — that client's email. Email and the rest of the relationship live in two disconnected surfaces.

This feature wires **email into the same timeline**: inbound email from a known contact appears as a timeline message and raises unread exactly like an inbound SMS; the agent can **reply by email or initiate a new email thread** from the same composer that today sends SMS, choosing the channel by picking a phone or an email address in the "To" selector. It deliberately **reuses EMAIL-001** (Gmail OAuth, token storage/refresh, MIME send/reply, history sync, the `email_*` tables) rather than rebuilding any of it, and introduces a **mail-provider abstraction** so the timeline/exchange logic depends on a provider interface (Gmail today, IMAP/other later) and not on Gmail directly.

### Goals

- Inbound email from an address that maps to a contact shows in that contact's Pulse timeline as an **inbound message**, in chronological order with calls/SMS, and raises the same **unread** signals SMS does.
- Inbound is **near real-time** (Gmail `users.watch` → Google Pub/Sub push), not only the existing 5-minute poll.
- The agent can **reply to** an inbound email thread and **initiate** a brand-new email thread to a contact, from the Pulse composer, with **no subject field** (auto/`Re:` subject).
- The composer "To" selector offers the contact's **phone(s) and email(s)**; phone → SMS, email → email; the default channel mirrors the **last inbound channel**.
- When the company has **no connected Gmail mailbox**, the email option(s) render a **connect CTA** (conversion path to the email settings page) instead of silently failing.
- The mail layer is behind a **`MailProvider` interface**; a future provider plugs in without touching timeline/exchange code.
- **Multi-tenant + permission-gated**, and the **standalone EMAIL-001 inbox keeps working unchanged**.

### Non-goals / out of scope (v1)

- **Attachments on timeline email** (inbound or outbound) — text only in the timeline. (The standalone inbox keeps its attachment support.)
- **HTML rendering** in the timeline — plain text only.
- Per-user / personal mailboxes (EMAIL-001 is one **shared** mailbox per company; unchanged).
- Auto-creating a contact from an unknown sender; merging duplicate contacts; any change to contact dedupe.
- A second mail provider implementation (IMAP) — only the **interface + Gmail impl** ship now.
- CC/BCC selection UI, read receipts, or threading multiple contacts onto one email thread.

### Reused (existing — do NOT rebuild)

- **EMAIL-001** (`## EMAIL-001` above): `emailMailboxService` (OAuth, encrypted tokens, refresh, `getValidAccessToken`), `emailSyncService` (`importGmailThread`, `syncIncrementalHistory`, scheduler), `emailService` (`sendEmail`, `replyToThread`, `buildMimeMessage`), `emailQueries`, tables `email_threads/email_messages/email_attachments/email_mailboxes/email_sync_state` (migration `079`), routes `email.js / email-oauth.js / email-settings.js`, frontend `emailApi.ts` + `components/email/*`.
- **Timeline/SMS**: `buildTimeline` in `backend/src/routes/pulse.js`; `sms_messages` + `conversationsService`; unread triplet (`sms_conversations.has_unread`, `contacts.has_unread`, `timelines.has_unread`); `findContactByPhoneOrSecondary` + `markContactUnread` + `markTimelineUnread`.
- **Composer**: `frontend/src/components/pulse/SmsForm.tsx` ("To" dropdown), `usePulsePage.ts` (`handleSendMessage`, last-used-phone), `PulseTimeline.tsx` + `SmsListItem.tsx`.
- **Provider-style precedent**: raw-body, signature-verified webhook mounted before `express.json` — `stripePaymentsWebhook.js` mounted at `src/server.js:75` — is the pattern for the Pub/Sub push endpoint.

### User stories

1. **Inbound → timeline.** As an agent viewing a contact in Pulse, when that contact emails our shared mailbox, I see their email appear in the timeline as an inbound message within seconds, and the contact is flagged unread — without leaving Pulse.
2. **Reply by email.** As an agent, when the contact's last inbound touch was an email, I open Pulse, the composer defaults to **Email**, I type a body and send, and my reply goes out **in the same email thread** (correct `Re:` subject + threading) and immediately appears outbound in the timeline.
3. **Initiate email.** As an agent for a contact I've only ever called, I pick the contact's email in the "To" selector and send the first email; a **new thread** is created with an auto subject, and it appears in the timeline.
4. **Channel choice.** As an agent, the "To" selector lists the contact's phone(s) and email(s); choosing a phone sends SMS, choosing an email sends email — one composer, explicit target.
5. **Not connected → convert.** As an agent at a company that hasn't connected Gmail, when I open the "To" selector the email entry shows "Google email not connected — connect to message clients by email" and links me to the email settings page.
6. **Inbox unaffected.** As an existing EMAIL-001 user, my standalone `/email` inbox, search, threads, and attachments work exactly as before; timeline wiring adds to it, nothing is removed.

### Functional requirements

**Inbound receive (real-time) — `FR-IN`**

- **FR-IN-1.** The system registers a Gmail **`users.watch`** for each connected mailbox (topic = configured Pub/Sub topic, `labelIds: ['INBOX']`) and stores the returned `historyId` + `watch_expiration`.
- **FR-IN-2.** A **push endpoint** receives Google Pub/Sub notifications, **verifies** the push (OIDC bearer token from Pub/Sub, audience check; or a shared `?token=` secret as configured), resolves the target mailbox by the notification's `emailAddress`, and triggers an **incremental history sync** for that company. It returns 2xx quickly; processing is idempotent.
- **FR-IN-3.** History processing **only creates timeline activity for INBOX messages from external senders.** Messages whose Gmail `labelIds` include `SENT` or `DRAFT`, or whose `from` equals the mailbox address (`direction='outbound'`), **MUST NOT** create a timeline entry or unread. **Editing a Gmail draft MUST NOT** produce timeline activity.
- **FR-IN-4.** For each qualifying inbound message, the system resolves the sender via `from_email` against `contacts.email` **and** `contact_emails.email_normalized`, **company-scoped**. On a match it links the message to that contact and **adds it to the contact's timeline** as an inbound message.
- **FR-IN-5.** On a contact match for inbound email, the system raises **unread** mirroring SMS: `contacts.has_unread` (via `markContactUnread`) and the contact's `timelines.has_unread` (via `markTimelineUnread`), and emits the SSE/`messageAdded`-equivalent so an open Pulse refreshes live. Action-Required follows the same per-company `inbound_*` trigger config used for SMS.
- **FR-IN-6.** **No contact match → NOT added to any timeline.** The message remains visible only in the standalone EMAIL-001 inbox (unchanged). No contact is created.
- **FR-IN-7.** A **watch-renewal scheduler** re-arms each mailbox's `users.watch` before its ≤7-day expiry. The existing 5-minute poll (`emailSyncService` scheduler) is **kept as reconciliation** so a missed/failed push is recovered within 5 minutes.
- **FR-IN-8.** **Quote/signature handling for the timeline projection:** the timeline body strips quoted reply history (`On … wrote:` headers, `>`-prefixed lines, and known client thread markers) and keeps the new body text + signature. Plain text only (derived from `body_text`; never HTML). The original full `email_messages.body_text/html` is retained intact for the inbox.

**Outbound send — `FR-OUT`**

- **FR-OUT-1.** From the Pulse composer the agent can **send an email** to a selected contact email address: **reply** when an inbound email thread exists for that contact, or **initiate** a new thread otherwise.
- **FR-OUT-2.** **No subject field** in the composer. Reply → `Re: <thread subject>` (reuses `emailService.replyToThread`'s subject default). Initiate → an auto subject (e.g. `Message from <Company Name>`), no user input.
- **FR-OUT-3.** Reply **threads correctly**: it goes out via Gmail with the thread's `provider_thread_id` and `In-Reply-To`/`References` set from the thread's last message (existing `replyToThread` behavior). Initiate starts a **new** Gmail thread (`sendEmail`).
- **FR-OUT-4.** A sent timeline email is **hydrated and appears outbound** in the timeline immediately after send (reusing `importGmailThread` hydration in `emailService`), and is linked to the same contact.
- **FR-OUT-5.** Outbound email is gated by the **`messages.send`** permission (same as SMS-send and the existing email compose/reply routes) and tenant-scoped by `req.companyFilter.company_id`.
- **FR-OUT-6.** v1 outbound from the timeline is **text only** (no attachment upload in the Pulse composer email path).

**Channel routing + composer — `FR-UI`**

- **FR-UI-1.** The composer "To" selector lists the contact's **phone(s)** (primary + secondary, as today) **and email(s)** (from `contacts.email` + `contact_emails`). Selecting a phone routes to the **SMS** send path; selecting an email routes to the **email** send path.
- **FR-UI-2.** The **default selected channel/target** is the **last inbound channel**: if the contact's most recent inbound activity was an email → default to that email; if SMS → default to the SMS path (existing last-used-phone logic). With no inbound email, behavior is unchanged from today.
- **FR-UI-3.** If the company has **no connected mailbox** (or status ≠ `connected`), email entries in the selector render a **CTA state** — label "Google email not connected — connect to message clients by email" — that links to the email settings/connect page and is **not selectable as a send target**.
- **FR-UI-4.** Email timeline items render as **chat bubbles** consistent with SMS (inbound left / outbound right), plain text, with timestamp; a small affordance distinguishes email from SMS (e.g. a mail glyph / "Email" label). No HTML, no attachment chips in v1.

**Provider abstraction — `FR-PROV`**

- **FR-PROV-1.** A **`MailProvider`** interface defines the provider-facing contract: at minimum `getConnectionStatus(companyId)`, `fetch/parseMessages` (history-driven), `sendMessage({to, subject, body, inReplyTo, references, threadId})`, `startWatch/stopWatch/renewWatch(companyId)`, and `handlePushNotification(payload)`. A **`GmailProvider`** implements it by delegating to the existing EMAIL-001 services.
- **FR-PROV-2.** The **timeline/exchange layer depends only on the interface** — it never imports `googleapis` or Gmail-specific services directly. Adding a future provider (e.g. IMAP) requires implementing `MailProvider` + registering it, with **no change** to the timeline/exchange/contact-matching code.

**Multi-tenant / permissions — `FR-SEC`**

- **FR-SEC-1.** Every email read/write is scoped by `company_id` from `req.companyFilter?.company_id`; cross-company email never appears in another company's timeline or inbox.
- **FR-SEC-2.** Timeline email read follows existing Pulse gating (`pulse.view`, provider `assigned_only` visibility); outbound requires `messages.send`. The Pub/Sub push endpoint is **unauthenticated by user** but authenticated by **push-token/OIDC verification** (no `company_id` from a session — resolved from the notification payload).

### Acceptance criteria

- **AC-1 (inbound external email lands on the timeline + unread).** Given a connected mailbox and a contact whose `email`/`contact_emails` includes `alice@x.com`, when Alice sends a new email to the shared mailbox and the push (or poll) is processed, then a new `inbound` item appears in Alice's Pulse timeline in chronological position, `contacts.has_unread` and her `timelines.has_unread` become true, and an open Pulse updates live. The same email is **not** duplicated if the push and the 5-min poll both process it.
- **AC-2 (draft/sent/own excluded — no push storm).** Given the agent composes and **saves a Gmail draft** (and later edits it) addressed to a contact, when the resulting `messagesAdded`/`labelsAdded` history is processed, then **no timeline entry and no unread** are produced for that contact. A message with `labelIds` containing `SENT` or whose `from` = the mailbox address never creates an inbound timeline entry.
- **AC-3 (no-match stays in inbox only).** Given an inbound email from `nobody@unknown.com` that matches **no** contact in the company, when processed, then it appears in the standalone EMAIL-001 inbox and **no** timeline entry / unread / contact is created.
- **AC-4 (quote stripping).** Given an inbound reply whose body contains the new line `Sounds good, Tuesday works` followed by `On Mon, … <agent@co.com> wrote:` and `>`-quoted prior thread, then the **timeline** shows `Sounds good, Tuesday works` (+ signature if present) and **not** the quoted history; the full original remains intact in the inbox view.
- **AC-5 (reply threads correctly).** Given a contact with an existing inbound email thread, when the agent replies from the Pulse composer with the email target selected, then Gmail sends in the **same thread** (`threadId` + `In-Reply-To`/`References` set), the subject is `Re: <thread subject>`, and the outbound message appears in the timeline linked to that contact.
- **AC-6 (initiate new thread).** Given a contact with **no** prior email thread, when the agent selects the contact's email and sends, then a **new** Gmail thread is created with an auto subject (no subject field shown), and the outbound email appears in the timeline.
- **AC-7 (channel selection).** In the "To" selector, choosing a phone sends **SMS** (unchanged path) and choosing an email sends **email**; the two never cross. With no email selected/available, the composer behaves exactly as today (SMS-only).
- **AC-8 (default channel = last inbound).** Given the contact's most recent inbound activity is an email, the composer opens with the **email** target preselected; given it is an SMS, it opens with the SMS target (existing last-used-phone). 
- **AC-9 (not-connected CTA).** Given the company has no connected mailbox, the email entry in the selector shows the connect CTA copy, is not a selectable send target, and links to the email settings/connect page; selecting a phone still sends SMS normally.
- **AC-10 (permissions + tenancy).** A user lacking `messages.send` cannot send timeline email (403, mirroring SMS/compose). An inbound email for company A never appears in company B's timeline or inbox. The push endpoint rejects a notification with a missing/invalid token (4xx, no processing).
- **AC-11 (watch lifecycle + poll fallback).** A mailbox's `users.watch` is renewed before its expiry by the renewal scheduler; if a single push is dropped, the next 5-minute poll reconciles the missed inbound message into the timeline (idempotently, no duplicate).
- **AC-12 (provider seam).** `buildTimeline` and the inbound contact-matching/exchange service contain **no** `googleapis`/Gmail-specific imports — they call the `MailProvider`/exchange abstraction. Gmail specifics live only in `GmailProvider` + EMAIL-001 services.
- **AC-13 (backwards-compat).** The standalone `/email` inbox (list, thread detail, search, attachments, compose/reply, settings, OAuth) is byte-for-behavior unchanged; EMAIL-001 acceptance criteria still hold. The 5-minute scheduler still runs. No SMS/calls/financial timeline behavior changes.

### Constraints / non-functional

- **Idempotency** is mandatory: Pub/Sub delivers **at-least-once** and the poll overlaps it; inbound→timeline linkage and unread must be safe under duplicate/redelivered/reordered history (keyed on `(company_id, provider_message_id)`).
- Push endpoint must **ack fast** (return 2xx within Pub/Sub's deadline) and do sync work async, to avoid Pub/Sub retry storms.
- Gmail `users.watch` **expires ≤7 days**; renewal cadence must be well inside that (≤24h interval).
- Plain-text-only + quote-stripping must be **deterministic** and must not mutate the stored `email_messages` body (inbox parity).
- No regression to EMAIL-001 token-refresh, sync-state, or scheduler behavior.

### Affected modules

- **Backend:** new mail-provider abstraction + Gmail impl; new email-timeline exchange/contact-matching service; new Pub/Sub push route (raw-body, verified, mounted before `express.json`); watch + renewal lifecycle; `buildTimeline` extension in `backend/src/routes/pulse.js`; new outbound timeline-email route; `emailSyncService` history hook to invoke contact-matching; `emailQueries` additions.
- **Frontend:** `SmsForm.tsx` "To" selector (phones + emails + CTA), `usePulsePage.ts` channel routing + default-channel, `messagingApi/emailApi` email-send-from-timeline call, new email timeline item type + bubble in `PulseTimeline.tsx`/`SmsListItem.tsx`.
- **DB:** migration `129` linking email messages to a contact/timeline + the projection `buildTimeline` reads; watch-lifecycle columns on `email_mailboxes`.

### Affected integrations

- **Google / Gmail API** (`users.watch`, `users.history.list`, `users.messages.send` — all already used by EMAIL-001) + **Google Cloud Pub/Sub** (new: topic + push subscription to our endpoint). No Twilio/Front/Zenbooker/Stripe change.

### Protected (must not break)

- **EMAIL-001 standalone inbox** — `email.js` routes, `components/email/*`, `EmailPage`, search, attachments, OAuth, settings, the 5-minute scheduler.
- **EMAIL-001 services** — do not alter `getValidAccessToken`/token-refresh, `importGmailThread` thread-upsert semantics, or `email_sync_state` checkpointing in a way that breaks the inbox; extend via hooks/new functions.
- **SMS/calls/financial timeline** — existing `buildTimeline` outputs (`calls`, `messages`, `conversations`, `financial_events`) and SMS send path stay intact; email is **additive**.
- **slot-engine**, `src/server.js` core boot, `authedFetch.ts`, `useRealtimeEvents.ts`, and `backend/db/` existing migrations (079 etc.) — unchanged (new migration only).
- Multi-tenant isolation: no query may drop the `company_id` filter.

---

# SEND-DOC-001 — Send Estimate & Invoice by Email/SMS + Gmail-as-Marketplace-App

> Status: requirements (Product 01). Two coupled parts. **PART A** = actually deliver Estimates & Invoices to the client (today both "send" actions are stubs / record-only — no email or SMS ever leaves the system). **PART B** = move the Gmail connect/disconnect UI out of `/settings/email` and into a first-class **marketplace app** ("Google Email"), and retire the standalone settings page.

## 1. Problem

Operators can build a polished Estimate or Invoice (line items, branded PDF, "Preview PDF") but **cannot get it to the customer from inside Albusto**. Concretely:

- **Estimate "Send"** opens a stub dialog that only picks a channel and calls `estimatesService.sendEstimate`, which logs a `send_stub_requested` event and changes **nothing** — no status change, no email, no SMS, no public link. There is **no public estimate page** at all (estimates have no `public_token`, no public route, no view page).
- **Invoice "Send"** has a fully-built dialog (channel, editable recipient, message, "include payment link") and flips the invoice to `sent`/`sent_at`, but the service comment says it plainly: *"MVP: record the delivery, no actual sending."* No email or SMS is dispatched. The customer never receives anything.
- All the **delivery infrastructure already exists but is unwired**: `emailService.sendEmail` (multipart Gmail send with PDF attachments), `conversationsService.getOrCreateConversation` + `sendMessage` (wallet-gated Twilio SMS), `generatePdf` for both docs, and `ensurePublicLink` + the branded pay page (`/pay/:token`) for invoices.
- Separately, **Gmail connection lives in its own settings page** (`/settings/email` + a nav item) that duplicates what the marketplace is for. Other apps (`mail-secretary`) already depend on a connected Gmail and deep-link to `/settings/email`. The customer wants Gmail managed like every other integration (in the marketplace) and the standalone page removed.

The result: the sales→delivery loop is broken at the last step, and integration settings are inconsistent.

## 2. Goals / Non-goals

**Goals**
- Send an Estimate or Invoice to the client by **Email** (PDF attached + link to the online doc) or **SMS** (text + link, no attachment), from the existing detail panels.
- Give estimates the same **public, tokenized, branded online page** invoices have — a **view-only** estimate page at `/e/<token>` plus a public PDF endpoint.
- **Actually dispatch**: wire `sendEstimate`/`sendInvoice` to `emailService.sendEmail` (email) and `conversationsService` SMS; flip status → `sent` + `sent_at`; record the send event; ensure the activity lands on the **contact timeline**.
- Enforce correct **gating**: doc authority (`estimates.send`/`invoices.send`), a connected Gmail mailbox for email (else a clear "connect" path), an active wallet + a company Twilio number for SMS, and a present recipient.
- Move Gmail connect/disconnect/status into a new **"Google Email" marketplace app** that **reuses the existing Google OAuth backend**, and **remove the `/settings/email` route and nav item**; update the OAuth callback redirect and every `/settings/email` reference (incl. `mail-secretary`'s `dependency_cta`) to the new destination.

**Non-goals (v1)**
- Estimate **Accept/Decline from the public page** (the page is view-only in v1; approve/decline stays operator-side). The public estimate page is structured to add it later.
- Online payment **on the estimate page** (payment stays an invoice concept via the existing `/pay/:token`).
- Rewriting the Google OAuth flow, the email inbox (EMAIL-001), or the timeline projection (EMAIL-TIMELINE-001) — those are **reused**, only the entry point and a thin dispatch/stamp call are added.
- Scheduled/automated sending, delivery-receipt tracking beyond what Twilio/Gmail already record, multi-recipient/CC UI.

## 3. User stories

- **US-1** As an operator, from the Estimate detail panel I click **Send**, pick **Email** or **SMS**, confirm/edit the recipient and a prefilled message, and the customer receives the estimate (email: branded PDF + link; SMS: text + link).
- **US-2** As an operator, the same works for an Invoice (it already has the richer dialog), and an "include payment link" choice controls whether the pay link is embedded.
- **US-3** As a customer, I receive a link and open a **branded online estimate page** (or the existing invoice pay page) without logging in.
- **US-4** As an operator, after I send, the doc shows **Sent** with a timestamp, and the send appears on the **contact's timeline** (the email I sent / the SMS I sent), so the whole team sees it.
- **US-5** As an operator without a connected mailbox, when I try to send by email I get a clear message and a **one-click path to connect Google Email** (the marketplace app), not a dead end.
- **US-6** As an operator without wallet balance or without a company sending number, SMS send fails with a clear, specific reason and **no** false "Sent" state.
- **US-7** As an admin, I connect/disconnect **Google Email from the marketplace** (`/settings/integrations`), like Stripe or VAPI; the standalone `/settings/email` page is gone, and old links/bookmarks redirect to the marketplace.
- **US-8** As an admin, the "Google Email" app shows **Connected** with the actual mailbox address only when a Gmail mailbox is truly connected (derived from the real mailbox status, not just an install row).

## 4. Functional requirements

### PART A — Send Estimate/Invoice

**FR-A1 Estimate public link + page.**
- Add `estimates.public_token` (nullable TEXT, unique partial index), minted lazily by `estimatesService.ensurePublicLink(companyId, id)` (mirror invoice: `crypto.randomBytes(8).toString('base64url')`, idempotent).
- Public, unauthenticated routes (token is the credential): view-data `GET /api/public/estimates/:token`, PDF `GET /api/public/estimates/:token/pdf`, and a short alias `GET /e/:token` (302 → the React page, mirroring how `/i/:token` and `/pay/:token` are served). The link embedded in messages is `(PUBLIC_APP_URL||APP_URL)/e/<token>`.
- A **branded, view-only** React page at `/e/:token` (`PublicEstimateViewPage`, mirroring `PublicInvoicePayPage`): company name, estimate number, line items/totals, status, a "Download PDF" action. No Accept/Decline, no payment in v1.

**FR-A2 Channel semantics.**
- **Email** = the document **PDF attached** + a **link to the online doc** in the body (estimate → `/e/<token>`; invoice → `/pay/<token>`).
- **SMS** = a short text **+ the link** (no attachment); wallet-gated.

**FR-A3 Send dialog (estimate parity).**
- Upgrade `EstimateSendDialog` to match the built `InvoiceSendDialog`: channel **email | SMS** toggle, editable recipient (email vs phone), required message prefilled from contact + a default per-doc/per-channel template, and the public link minted on open (`ensureEstimatePublicLink`). Invoice keeps its dialog (incl. "include payment link").
- `EstimateSendData` extends to `{ channel: 'email'|'sms', recipient: string, message: string }` (today it is only `{ channel }`).

**FR-A4 Real dispatch + status + timeline.**
- `sendEstimate`/`sendInvoice` accept `{ channel, recipient, message }`, then:
  - **Email**: `generatePdf` → `ensurePublicLink` → `emailService.sendEmail(companyId, { to: recipient, subject, body(html, incl. link), files:[{ originalname, mimetype:'application/pdf', buffer }], userId, userEmail })`. After send, **stamp the contact timeline** by linking the returned `provider_message_id` to the doc's contact (the EMAIL-TIMELINE-001 outbound linking — `emailQueries.linkMessageToContact(provider_message_id, companyId, { contact_id, timeline_id, on_timeline:true })`).
  - **SMS**: resolve `proxyE164` (company Twilio number) → `getOrCreateConversation(customerE164, proxyE164, companyId)` → `sendMessage(convId, { body: text+link, author:'agent' })` (wallet gate is inside `sendMessage`; `conversationsService` already records the message and projects SMS to the timeline).
- On success: flip status → `sent` and set `sent_at` (estimate gains this; invoice already does), and record the existing send **event** (`sent`) with channel/recipient. On any dispatch failure: status is **not** changed.

**FR-A5 Gating & errors (exact contracts).**
- Authority: `estimates.send` / `invoices.send` (unchanged route perms).
- **Recipient missing** → `400` (block) with a clear message; dialog disables Send when empty (already the invoice behavior).
- **Email, mailbox not connected** → `409 MAILBOX_NOT_CONNECTED` (derive from mailbox status before sending; `emailService.sendEmail` itself throws `409` on `reconnect_required`). UI surfaces the **connect CTA → the Google Email marketplace app** (FR-A6), not `/settings/email`.
- **SMS, wallet blocked** → `402` (`WALLET_BLOCKED` from `assertServiceActive`) surfaced as "Messaging is paused — top up your balance."
- **SMS, no company Twilio number** (`resolveCompanyProxyE164` → null) → `422 NO_PROXY` "No sending number configured for your company." (mirror the ETA-notify contract); no side effects.
- **SMS, no/invalid customer phone** → `422 NO_PHONE`.

**FR-A6 Connect CTA target.** When email send is blocked for "not connected", the surfaced hint/link points to the **new Google Email marketplace app** (its setup path under `/settings/integrations`), never to the removed `/settings/email`.

**FR-A7 Financials-tab reuse fix.** `JobFinancialsTab` and `LeadFinancialsTab` currently call `sendInvoice(id, { channel:'email', recipient:'' })` directly from `InvoiceDetailPanel.onSend`, **bypassing the dialog** (empty recipient → would now fail FR-A5). Route these through `InvoiceSendDialog` (and `EstimateSendDialog` for estimates) so the operator always confirms recipient/message.

### PART B — Gmail connect → marketplace app

**FR-B1 New marketplace app.** Seed a published `marketplace_apps` row, key **`google-email`**, name **"Google Email"** (category `communication`/`ai`, `app_type` `internal`, `provisioning_mode` `none`), with `metadata.setup_path` pointing at its destination under `/settings/integrations` (mirror the Stripe/VAPI seed pattern). The app represents the company's Gmail connection.

**FR-B2 Connect via existing OAuth.** The app's "Connect" action triggers the **existing** Google OAuth (`POST /api/settings/email/google/start` → Google consent → `GET /api/email/oauth/google/callback`). The OAuth backend (`email-settings.js`, `email-oauth.js`, `emailMailboxService`) is **reused unchanged** — only the frontend entry point and the post-callback redirect move.

**FR-B3 Connected-state derived from the real mailbox.** The "Google Email" app's connected state and the displayed address **derive from the actual Gmail mailbox** (the same source as `GET /api/email/timeline/mailbox-status` → `{ connected, email_address }` / `getMailboxSettings` → `{ provider:'gmail', status:'connected', email_address }`), **not** merely from a `marketplace_installations` row. (The marketplace list query/resolver must overlay mailbox status for this app so "Connected ✓ name@domain" reflects reality.)

**FR-B4 Disconnect.** The app supports disconnect, which calls the existing `POST /api/settings/email/disconnect` (tears down the Gmail watch, nulls tokens, preserves synced history) — reused, not reimplemented.

**FR-B5 Remove the standalone page.** Delete the `/settings/email` **route** (App.tsx:142) and the **nav item** (`appLayoutNavigation.tsx:96`). The connect/disconnect/status UI lives in the marketplace (a dedicated app detail/setup surface under `/settings/integrations`, mirroring Stripe/VAPI setup pages, OR the existing `MarketplaceConnectDialog` "connect Gmail" pattern). Old `/settings/email` URLs (bookmarks, the OAuth callback) must **redirect** to the new destination, not 404.

**FR-B6 Update callback redirect + all references.** Change the OAuth callback redirect (`email-oauth.js`: `/settings/email?...` success/`?error=`/`?email_error=...`) to the new marketplace destination (with equivalent success/error query flags). Update `mail-secretary`'s `metadata.dependency_cta.path` (currently `/settings/email`) and every other `/settings/email` reference in the frontend (`appLayoutNavigation`, `SmsForm`, `EmailThreadPane`, `EmailPage`, `IntegrationsPage`, `emailApi`) to the new app path.

**FR-B7 Status source for the send dialog is unchanged.** The send-dialog connection check still uses `getTimelineMailboxStatus` (`{ connected, email_address }`) — no behavior change there; only the **CTA destination** changes (FR-A6).

## 5. Acceptance criteria

**PART A**
- **AC-1** From the Estimate detail panel, **Send → Email** with a valid recipient delivers a Gmail email **with the estimate PDF attached** and a body containing the `/e/<token>` link; the estimate flips to **Sent** with `sent_at`; a `sent` event is recorded; the sent email appears on the **contact timeline**.
- **AC-2** From the Estimate panel, **Send → SMS** with a valid phone sends a Twilio SMS containing the `/e/<token>` link (no attachment); status → **Sent**; the SMS appears on the contact timeline.
- **AC-3** Opening `/e/<token>` in a fresh browser (no auth) renders the **branded, view-only** estimate (number, items, totals) and a working **Download PDF**; `GET /api/public/estimates/:token/pdf` returns the PDF; `GET /e/:badtoken` (malformed) returns 404.
- **AC-4** Invoice **Send → Email** delivers the invoice **PDF + `/pay/<token>` link**; **Send → SMS** sends text + link; "include payment link" toggles whether the link is embedded; status → **Sent**; activity lands on the timeline. (`sendInvoice` no longer merely records.)
- **AC-5** Email send with **no connected mailbox** returns `409 MAILBOX_NOT_CONNECTED`; the UI shows a connect hint linking to the **Google Email marketplace app** (not `/settings/email`); status is unchanged.
- **AC-6** SMS send with **wallet blocked** → `402`; with **no company Twilio number** → `422 NO_PROXY`; with **no/invalid recipient phone** → `422 NO_PHONE`. In every failure the doc is **not** marked Sent.
- **AC-7** Sending with an **empty recipient** is blocked (Send disabled; backend `400` if forced) for both docs.
- **AC-8** `JobFinancialsTab` / `LeadFinancialsTab` open the proper **send dialog** (recipient prefilled from `contact_email`/`contact_phone`) instead of calling `sendInvoice` with an empty recipient; sending from a job/lead works end-to-end.

**PART B**
- **AC-9** `/settings/integrations` lists a **"Google Email"** app. With no mailbox connected it shows **Not connected** + a Connect action; clicking Connect runs the existing Google OAuth and returns to the marketplace.
- **AC-10** After OAuth, the "Google Email" app shows **Connected** with the **actual mailbox address**, derived from the real mailbox status (disconnecting the mailbox flips it back to Not connected even though an install row may exist).
- **AC-11** **Disconnect** from the app calls the existing disconnect endpoint (watch torn down, tokens nulled, history preserved) and the app returns to Not connected.
- **AC-12** The **`/settings/email` nav item is gone** and the route no longer renders the old page; navigating to `/settings/email` (old bookmark) **redirects** to the new marketplace destination.
- **AC-13** The OAuth **callback redirect** lands on the new marketplace destination (with success/error flags preserved); `mail-secretary`'s `dependency_cta` and all other `/settings/email` references now point to the new app.
- **AC-14** `mail-secretary`'s "Connect Gmail before enabling…" gate still works, now resolving connected-state from the same mailbox source and linking to the new app.

**Regression / protected**
- **AC-15** EMAIL-TIMELINE-001 inbound/outbound email projection and the standalone `/email` inbox are byte-for-behavior unchanged; the Google OAuth backend (`email-settings.js`, `email-oauth.js`, `emailMailboxService`, token refresh, Gmail watch) is unchanged except the callback redirect URL.
- **AC-16** The existing **invoice pay page** (`/pay/:token`), `ensureInvoicePublicLink`, `/i/:token`, and Stripe public-pay routes are unchanged; the new estimate public routes are **additive** (new `/api/public/estimates/*` + `/e/:token`), not a refactor of the invoice ones.
- **AC-17** Multi-tenant isolation holds: public token lookups are unscoped-by-design (token is the credential) but resolve a single row; all authenticated paths keep the `company_id` filter.

## 6. Protected / do-not-break

- **EMAIL-TIMELINE-001** send/receive + timeline projection; **EMAIL-001** inbox, search, attachments, the 5-min scheduler.
- The **Google OAuth backend** (`routes/email-settings.js`, `routes/email-oauth.js`, `services/emailMailboxService.js`) — reuse; only the callback redirect string changes.
- The **invoice pay page** + invoice public token/route/short-link + Stripe public-pay endpoints.
- `crypto.randomBytes` token scheme + the unique partial index pattern (mirror, don't alter, the invoice one).
- Wallet gating (`walletService.assertServiceActive`) and `resolveCompanyProxyE164` contract (422 on missing proxy).
- `src/server.js` public-router mount order (auth-skipping `/api/public/*` + `/i/:token`); the new estimate public router mounts alongside the same way.

---

## GOOGLE-SSO-FIX-001: "Continue with Google" fix + account-architecture hardening

**Status:** Implemented (pending deploy) · **Priority:** P0 · **Area:** Auth (Keycloak) / Frontend / Onboarding
**Spec:** `Docs/specs/GOOGLE-SSO-FIX-001.md`

### Description
Fix the non-working **Continue with Google** button on `/signup` (console
`TypeError … reading 'login'`). Root cause is the frontend calling Keycloak
`login()` on an uninitialized instance (no adapter, no PKCE) — the prod `google`
IdP itself works. Also: pull full name + email (and split given/family) from Google,
codify the drifted Keycloak IdP config in git, auto-link on verified email, and add
the Google button to the sign-in page.

### User scenarios
1. New user clicks **Continue with Google** on `/signup` → redirected to Google →
   returns to `/onboarding` authenticated; `crm_users` gets `full_name`+`email` from Google.
2. Google user whose email already has a password account → auto-linked (no manual prompt).
3. Existing user clicks **Continue with Google** on the sign-in page → logs in.
4. Google user completes onboarding: phone → SMS OTP (kept) → company creation.

### Constraints / non-functional
- No DB migration (given/family live in Keycloak; no avatar column). `picture`/`locale` not consumed.
- Secrets never in git — realm export uses `${GOOGLE_IDP_CLIENT_ID/SECRET}`.
- Realm import does not reconfigure the existing prod realm → apply via `scripts/setup-google-idp.sh`.
- Email/password signup + existing password sign-in unchanged.

### Involved modules
- Frontend: `auth/AuthProvider.tsx`, `pages/auth/SignupPage.tsx` (`OnboardingPage.tsx` verified, unchanged).
- Keycloak: `keycloak/realm-export.json`, `keycloak-themes/albusto/login/{login.ftl,resources/css/albusto-login.css}`, `scripts/setup-google-idp.sh`.
- Backend (unchanged, relied upon): `middleware/keycloakAuth.js` → `services/userService.findOrCreateUser`, `routes/onboarding.js`.

### Integrations
- Google OIDC (via Keycloak broker). No Twilio/Front/Zenbooker impact (SMS OTP path reused as-is).

### Protected parts (must not break)
- `src/server.js`, `frontend/src/lib/authedFetch.ts`, `useRealtimeEvents.ts`, `backend/db/` — untouched.
- JIT provisioning contract in `userService.findOrCreateUser` (upsert by `keycloak_sub`) — relied upon, not modified.

---

## ONBOARD-FIX-001: tenant-isolation leak + onboarding access + phone mask + theme audit

**Status:** Implemented (pending deploy) · **Priority:** P0 (SEC) · **Area:** Auth / Frontend onboarding / Keycloak theme
**Spec:** `Docs/specs/ONBOARD-FIX-001.md` · Follow-up to GOOGLE-SSO-FIX-001

### Description
Four parts: (SEC) close a cross-tenant leak where a user with no active membership resolved
to the seed company via the `crm_users.company_id` shadow fallback + a mig-012 backfill;
(A) fix onboarding landing on "You don't have access here" + a redirect flicker (stale authz
context after company creation); (B) mask the onboarding phone field like the New Lead card;
(C) theme the reachable Keycloak pages that fell back to unstyled base markup.

### User scenarios
1. New user finishes onboarding → lands on THEIR company's Pulse, no flicker, no false 403.
2. A user with no active membership can NOT read any other company's data (403).
3. Onboarding phone masks to `(617) 555-0142`; OTP sent/verified in E.164.
4. OTP / method-picker / password-reset / error / review-profile pages render branded.

### Constraints / non-functional
- Tenant scope is membership-only; `crm_users.company_id` is not consulted for access.
- Dev auth bypass must fail closed in production.
- Migration 140 is idempotent and logs the affected row count.
- No token-shape change; `refreshAuthz` avoids a hard reload (keeps the 401→2FA-loop guard).

### Involved modules
- Backend: `middleware/keycloakAuth.js` (`requireCompanyAccess`, `authenticate`), migration 140. Verify-only: `authorizationService.resolveAuthzContext`, `platformCompanyService.bootstrapCompany`.
- Frontend: `auth/AuthProvider.tsx` (`refreshAuthz`), `pages/auth/OnboardingPage.tsx`. Reuse: `components/ui/PhoneInput` (`formatUSPhone`/`toE164`).
- Keycloak theme: 6 new `.ftl` templates.

### Integrations
- SMS OTP (phone now E.164). No Twilio/Front/Zenbooker behavior change.

### Protected parts
- `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts` untouched. `backend/db/` only via migration 140 (additive/idempotent, per plan).

---

## LEADS-NEW-BADGE-001: "new leads" counter badge in navigation

**Status:** Implemented (pending deploy) · **Priority:** P1 · **Area:** Frontend nav + Leads backend
**Spec:** `Docs/specs/LEADS-NEW-BADGE-001.md`

### Description
Badge (number in a circle, like the Pulse new-events badge) on the Leads nav item = company's count
of new/unactioned leads (`status ∈ {Submitted, New, Review}`, `lead_lost=false`). No read/unread —
status-derived, persists until leads are actioned. Company-scoped; hybrid freshness (mount +
route-change + 60s poll + SSE `lead.created`/`lead.updated`).

### User scenarios
1. New lead created (any path) → Leads badge increments live for that company.
2. Lead actioned (contacted/lost/converted) → badge decrements.
3. Opening Leads does NOT clear the badge.

### Constraints
- Company-scoped count; visibility follows `leads.view`. SSE payload PII-free; client filters by company_id.
- No migration (indexes + `lead_lost` exist). No new permission.
- `/new-count` route MUST precede `/:uuid`.

### Involved modules
- `leadsService` (`countNewLeads`, `NEW_LEAD_STATUSES`, emits), `routes/leads.js`, `realtimeService`.
- `AppLayout.tsx`, `appLayoutNavigation.tsx`, `useRealtimeEvents.ts` (additive), `AppLayout.css`.

### Protected parts
- `useRealtimeEvents.ts` touched **additively** (two event types added to the generic channel), per approved plan. No backend/db schema change.

---

## PRICEBOOK-001: Price Book (Category → Group → Item)

**Status:** Implemented (pending deploy) · **Area:** Estimates/Invoices catalog / Settings · **Spec:** `Docs/specs/PRICEBOOK-001.md`

### Description
A 3-level catalog for estimate/invoice line items: Categories (grouping only), Groups (expand into
their Items when added to a doc), Items (`estimate_item_presets` extended). Standalone
**Settings → Price Book** editor + picker integration (pick a group → its items are inserted).

### User scenarios
1. Manage Items/Groups/Categories in Settings → Price Book (create/edit/archive).
2. A group holds several items with per-item quantities; selecting it in an estimate/invoice inserts all items.
3. Items and groups can be organized under categories.

### Constraints
- Manage = admin+manager (`price_book.manage`); use = any doc-editing role (`price_book.view`).
- Company-scoped; snapshot semantics; group expansion skips archived items. Migration 141.

### Involved modules
- Backend: migration 141, `priceBookQueries`/`priceBookService`, extended `estimateItemPresets*`, `routes/price-book.js`, bulk endpoints on estimates/invoices, `permissionCatalog.js`, `050`.
- Frontend: `PriceBookPage`, `priceBookApi`, extended `ItemPresetSearchCombobox` + Estimate/Invoice panels, nav/route/dev-perms.

### Protected parts
- No protected file broken. `backend/db/` only via migration 141 (idempotent, additive).

## PRICEBOOK-002: Items grid — inline spreadsheet editing

**Status:** Implemented (verified local; pending deploy) · **Area:** Settings → Price Book / Items tab · **Spec:** `Docs/specs/PRICEBOOK-002.md`

### Description
Replace the "list row + right-side slide-over editor per item" model on the **Items & products** tab with a
**spreadsheet-style editable grid**: every cell of every item is edited inline (Name, Description, Code/SKU,
Unit, Unit Price, Taxable, Category), a **"+" row** pinned at the end starts a new empty item, and the whole
table is persisted at once via a **single Save button** (atomic bulk save). No per-item slide-over on this tab.
Groups and Categories tabs are unchanged.

### User scenarios
1. Manager opens Settings → Price Book → Items and sees all items as an editable grid.
2. She edits several cells across several rows (price, taxable, category, name…) without opening any panel.
3. She clicks the "+" at the end of the list, a blank row appears, she types a new item inline.
4. She marks a row for deletion with a per-row trash icon (undo-able before saving).
5. She clicks **Save changes** once; all creates/edits/deletes commit atomically; the grid re-hydrates.
6. She types in Search to filter the visible rows client-side; her unsaved edits are preserved.
7. If she navigates away with unsaved changes, she is warned.

### Functional requirements
- Inline-editable cells for all 7 item fields; Description is a single-line cell that expands to ≥3 lines
  (or fits content) on focus and collapses on blur; Taxable is a checkbox;
  Category is an inline select of existing (non-archived) categories.
- Trailing "+ add row" affordance always visible; adds a blank draft row.
- Single **Save changes** button, enabled only when the grid is dirty; a **Discard** reverts to server state.
- Atomic bulk persistence via `PUT /api/price-book/items/bulk` (create/update/archive in one transaction);
  all-or-nothing — a validation error rejects the whole save with a per-row reason and commits nothing.
- Validation: name required on every non-deleted row; price numeric ≥ 0; category must belong to the company
  or be empty; fully-empty new rows are ignored (not an error).
- Client-side Search filters loaded rows only (no refetch); dirty edits survive filtering.

### Constraints
- Manage-only (`price_book.manage`); company-scoped on every statement; a row id from another company must
  not be updatable/deletable (foreign id → rejected). No new migration (reuses `estimate_item_presets`).
- Bulk update must NOT clobber columns the grid doesn't edit; archiving here must not break the estimate/invoice
  inline item picker that shares `estimate_item_presets`.
- **Documented exception to the "right-side layer" canon**: inline table editing is allowed here, but Blanc
  tokens / fonts / "no decorative horizontal separators" still apply.

### Involved modules
- Backend: `estimateItemPresetsService` (new `bulkSaveItems`), `estimateItemPresetsQueries` (tx helper),
  `routes/price-book.js` (`PUT /items/bulk`). No migration, no new permission.
- Frontend: `PriceBookPage` (`ItemsTab` rewritten to a grid; `ItemPanel` dropped from the Items flow),
  `priceBookApi` (`bulkSaveItems`).

### Protected parts
- No protected file touched. No `backend/db/` change.

---

## Фича ONBTEL-001: Онбординг новой компании → Marketplace-приложение «Telephony — Twilio» → фиксы изоляции Twilio

**Status:** Requirements · **Priority:** P0 · **Date:** 2026-07-02 · **Owner:** Platform / Telephony / Billing
**Тип:** одна зонтичная фича из трёх связанных частей (A/B/C). Продукт для пользователя — **Albusto** (никакого "Blanc" в UI-тексте).
**Решения владельца зафиксированы интервью и являются ОБЯЗАТЕЛЬНЫМИ** (не пересматривать на этапах Architect/Planner).

**Краткое описание:** Первый пользователь новой tenant-компании (владелец, `role_key='tenant_admin'`) после регистрации видит на `/pulse` расширяемый чеклист-онбординг с единственным пока пунктом «Подключить телефонию»; сам процесс подключения телефонии переезжает из прямого входа `/settings/telephony` в Marketplace-приложение «Telephony — Twilio» с трёхшаговым Connect-визардом (субаккаунт → тариф, включая НОВЫЙ поминутный план Pay-as-you-go → покупка номера); параллельно закрываются все 5 найденных аудитом дыр изоляции Twilio (unknown-number reject, NOT NULL/UNIQUE в схеме номеров, wallet-гейт до роутинга, fail-closed softphone token).

### Проверка на дублирование (результат)

Дублей нет — ONBTEL-001 **расширяет** существующие фичи, а не повторяет их:

- **ALB-107 (Multi-tenant Telephony — Twilio Subaccounts)** — уже даёт connect-субаккаунт / поиск / покупку / release номеров и webhook-маршрутизацию по `AccountSid`→`To`. Часть B **переносит точку входа** в Marketplace и добавляет шаг тарифа; сами API переиспользуются. Часть C — фиксы изоляции внутри той же подсистемы. Расширение, не дубль.
- **F016 (VAPI marketplace) / F018 (Stripe Payments marketplace) / SEND-DOC-001 Part B (Google Email marketplace)** — канон «плитка → отдельная страница настройки `/settings/integrations/<app>` → seed в `marketplace_apps` → install/disconnect через `/api/marketplace/*`». Часть B добавляет **новое** приложение по этому канону; канон не меняется.
- **BILLING-UI / ADR-001 (платформенный биллинг)** — планы trial/starter/pro/huge, Stripe checkout, wallet (миграции 101/103/107/108/109) существуют. Часть B добавляет **новый план** «Pay-as-you-go» поверх существующей модели планов/кошелька и переиспользует существующий checkout для пакетов. Расширение, не дубль.
- **ALB-101 / ONBOARD-FIX-001 (signup/онбординг)** — signup → `/onboarding` → `POST /api/onboarding` → `bootstrapCompany` не меняется; Часть A добавляет чеклист **после** этого флоу. Чеклиста/флага «свежая компания» сегодня не существует (проверено).
- **F017 (call flow) и TELEPHONY-AUTONOMOUS-MODE-001** — не изменяются, попадают в защищённые части.
- Существующих аналогов нет: в системе нет ни онбординг-чеклиста на `/pulse`, ни marketplace-приложения телефонии (сегодня 5 приложений: mail-secretary, vapi-ai, stripe-payments, call-qa-agent, lead-generator), ни поминутного плана, ни Reject для неизвестных номеров.

### Часть A — Онбординг-чеклист новой tenant-компании на `/pulse`

**Описание:** Большая карточка-чеклист **на всю ширину, В ПОТОКЕ страницы** `/pulse` (сдвигает контент вниз; НЕ оверлей/модалка). Пока один пункт: «Подключить телефонию» → ведёт на карточку/визард Marketplace-приложения «Telephony — Twilio». Чеклист — **данные, не хардкод** (расширяемая модель пунктов). Видна только `tenant_admin`. Живёт до выполнения всех пунктов; допускается свернуть (collapse), но полностью скрыть нельзя. Пункт телефонии считается выполненным, когда у компании есть **≥1 активный купленный номер**. Email-пункт НЕ делать.

**Пользовательские сценарии:**
1. Владелец новой компании завершает регистрацию и онбординг (`/signup` → `/onboarding` → `POST /api/onboarding` → `bootstrapCompany`) и попадает на `/pulse`: вверху страницы — полноширинная карточка-чеклист с пунктом «Подключить телефонию» (не выполнен) и переходом в Marketplace-приложение «Telephony — Twilio»; контент Pulse сдвинут вниз, ничего не перекрыто.
2. Владелец сворачивает чеклист: карточка складывается в компактную строку (заголовок + прогресс), состояние сохраняется между визитами/сессиями; полного скрытия/dismiss нет, пока пункты не выполнены.
3. Владелец проходит визард Части B и покупает номер: при следующем открытии `/pulse` пункт отмечен выполненным автоматически (derived-статус, не ручная галочка); когда все пункты выполнены — карточка исчезает насовсем.
4. Сотрудник той же компании с ролью manager/dispatcher/provider открывает `/pulse` — чеклист не отображается вовсе (гейт по `tenant_admin` и на фронте через `useAuthz().isTenantAdmin()`, и на backend-эндпоинте состояния).
5. Пользователь существующей компании с уже купленными номерами (в т.ч. Boston Masters, seed 00000000-0000-0000-0000-000000000001) открывает `/pulse` — чеклист не отображается (критерий выполнен по данным), поведение страницы не меняется.

### Часть B — Marketplace-приложение «Telephony — Twilio» (Connect-визард с шагом тарифа)

**Описание:** Подключение телефонии переезжает из прямого `/settings/telephony`-входа в Marketplace (Settings → Integrations): новая плитка приложения → Connect-**визард** из трёх шагов: (1) создание Twilio-субаккаунта — существующий флоу `POST /api/telephony/numbers/connect` (`company_telephony`, mig 098); (2) **шаг тарифа**: «Поминутно (Pay-as-you-go)» = **новый** billing-план ($0/мес, 0 включённых минут, списание с кошелька по ставкам владельца: $0.04/мин звонки, $0.03/SMS) ИЛИ «Пакет» = выбор существующих планов starter/pro/huge через существующий Stripe checkout — выбор **реально применяется** к биллингу компании через существующий `billingService`; (3) поиск и покупка номера — существующие search/buy API (лимит номеров по плану). Существующий раздел Settings → Telephony **остаётся** как управление уже подключённой телефонией (номера, группы, флоу). Существующие компании считаются connected — их поведение не меняется.

**Пользовательские сценарии:**
1. `tenant_admin` открывает Settings → Integrations, видит плитку «Telephony — Twilio» (Available), нажимает Connect/Configure и попадает на страницу-визард `/settings/integrations/telephony-twilio` (по канону страниц VAPI/Stripe Payments).
2. Шаг 1 «Подключение»: создаётся Twilio-субаккаунт через существующий connect-флоу; статус отображается; повторный вход в визард после успешного подключения не создаёт второй субаккаунт (идемпотентность существующего флоу сохраняется, подкреплена UNIQUE из Части C).
3. Шаг 2 «Тариф»: выбор «Поминутно (Pay-as-you-go)» применяет к компании новый план ($0/мес, 0 включённых минут; звонки $0.04/мин, SMS $0.03 — списываются с существующего кошелька, mig 109: мин. пополнение $10, floor −$5); выбор «Пакет» (starter $49 / pro $149 / huge $289) запускает существующий Stripe checkout и после возврата подписка активна. Выбор фиксируется в биллинге компании — это не декоративный шаг.
4. Шаг 3 «Номер»: поиск по area code/городу/digits с фильтрами voice/sms (существующий GET search), покупка (существующий POST buy с лимитом номеров по плану), номер записывается в `phone_number_settings` компании с webhooks; визард показывает завершение; состояние приложения — Connected; пункт чеклиста Части A автоматически выполняется.
5. Компания с уже подключённой телефонией (есть `company_telephony`, включая Boston Masters): плитка отображается как Connected (состояние **выводится из фактического подключения**, по паттерну «connected-state derived from the real mailbox» из SEND-DOC-001 D.3 — без обязательного ретроактивного install), кнопка Manage ведёт в существующий Settings → Telephony; повторный визард не навязывается. Для НЕподключённой компании прямой заход в Settings → Telephony отправляет подключаться в Marketplace-визард (connect-флоу не дублируется в двух местах).

### Часть C — Фиксы изоляции Twilio (аудит проведён; чинить ВСЕ 5)

**Описание:** Закрыть все пять вердиктов аудита изоляции: (1) входящий звонок на неизвестный/бесхозный номер → TwiML Reject + структурный лог (сейчас — generic voicemail без company-контекста, `backend/src/webhooks/twilioWebhooks.js:345-360`); (2) `phone_number_settings.company_id` → NOT NULL + backfill (mig 091 допускает orphan); (3) UNIQUE на `phone_number_settings.phone_number` и `company_telephony.twilio_subaccount_sid`; (4) wallet-гейт ДО роутинга звонка (сейчас обходится при null company); (5) softphone token fail-closed для не-дефолтных компаний (сейчас тихий фолбэк на master env creds, `backend/src/services/voiceService.js:61-77`).

**Пользовательские сценарии (негативные/проверочные):**
1. Входящий звонок на номер, не принадлежащий ни одной компании (company не определяется ни по `AccountSid`, ни по `To` — `companyIdForNumber`, `twilioWebhooks.js:9-16`): звонок отклоняется (Reject), в лог пишется структурная запись с CallSid/AccountSid/To и причиной; generic voicemail без company-контекста больше не исполняется.
2. После миграции все существующие строки `phone_number_settings` с NULL `company_id` забэкфиллены (по субаккаунту/seed-правилу), колонка NOT NULL; создать «бесхозный» номер невозможно.
3. Попытка вставить второй ряд с тем же `phone_number` (или второй `company_telephony` с тем же `twilio_subaccount_sid`) отклоняется на уровне БД; миграция предварительно выявляет и разрешает существующие дубликаты (иначе UNIQUE не встанет).
4. Входящий звонок компании с заблокированным кошельком (баланс на/ниже floor) отклоняется **до** исполнения call flow; сценарий «company=null → гейт обойдён» невозможен (такой звонок отклонён фиксом 1 ещё раньше).
5. Запрос softphone-токена компанией без собственных субаккаунт-кредов (любая, кроме дефолтной seed-компании) получает явную ошибку (fail-closed), а не тихий токен на master env creds; Boston Masters продолжает работать на master env как раньше.

### Ограничения и нефункциональные требования

**Безопасность (обязательные правила проекта, повторены):**
- Все новые/изменяемые API: `authenticate` + `requireCompanyAccess`; `company_id` берётся ТОЛЬКО из `req.companyFilter?.company_id` (никогда из payload клиента).
- Каждый SQL фильтрует по `company_id`; чужой id → 404.
- Обязательные тесты: 401/403 на каждый новый эндпоинт + тесты tenant-изоляции (кросс-tenant чтение/запись невозможны).
- Webhook-пути остаются на существующей модели ALB-107: компания по `AccountSid` (fallback `To`), подпись — токеном соответствующего субаккаунта.

**Часть A:**
- Чеклист — расширяемая data-модель пунктов (хранилище выберет архитектор: кандидаты — `companies.settings` JSONB (mig 010) или новая таблица/колонки); «выполнено» для пункта телефонии — вычисляемое условие «у компании ≥1 активный купленный номер», без ручной отметки.
- Карточка: full-width, в потоке (сдвигает контент), не оверлей; collapse-состояние персистентно; полное скрытие до выполнения невозможно; после выполнения всех пунктов не показывается никогда.
- Только `tenant_admin` (фронт + backend). Email-пункт — вне скоупа.
- Дизайн: канон CLAUDE.md (Blanc-токены `--blanc-*`, без `<hr>`, `.blanc-eyebrow`), user-facing имя продукта — Albusto.

**Часть B:**
- Новое приложение по канону marketplace: seed-миграция в `marketplace_apps`, install lifecycle и per-company state в `marketplace_installations` (+`metadata` JSONB), гейтинг через `findActiveInstallation`; core marketplace не переписывается.
- Новый план Pay-as-you-go выражается через существующую модель планов (`billing_plans` + included units mig 103 + per-plan limits/ставки mig 107/108): $0/мес, 0 включённых минут, ставки списания с кошелька $0.04/мин звонки и $0.03/SMS (дефолт владельца). Лимит номеров плана (`max_phone_numbers`) = **1** (решение владельца, интервью 2026-07-02: как trial; нужно больше номеров — апсел в пакетные планы). Аренда номеров отдельно не тарифицируется (как и в существующих планах).
- Активация Pay-as-you-go не требует принудительного пополнения кошелька на шаге визарда; действует существующий wallet-гейт (`walletService`) при исчерпании.
- Пакетные планы — строго существующий Stripe checkout / `billingService`; платформенный billing webhook не меняется.
- Идемпотентность: повторные проходы визарда не плодят субаккаунты/планы/installations.
- Существующие компании (в первую очередь Boston Masters) — нулевые изменения поведения; connected-состояние приложения выводится из фактического `company_telephony`.

**Часть C:**
- Все фиксы — fail-closed; Reject сопровождается структурным логом (CallSid, AccountSid, To, причина) для диагностики.
- Миграции идемпотентны; backfill логирует число затронутых строк (паттерн mig 140); перед UNIQUE — детект/разрешение дубликатов.
- Фиксы не должны изменить маршрутизацию легитимных звонков: существующий call flow (F017 `callFlowRuntime`), autonomous mode override (mig 142, чтение флага fail-open) и все текущие сценарии Boston Masters работают как прежде.
- Fail-closed для softphone — только для не-дефолтных компаний; дефолтная seed-компания остаётся на master env creds.

**Общие:**
- Backend — CommonJS; фронт собирается `npm run build` (tsc -b, prod-сборка строже).
- Нумерация новых миграций: фактический максимум в `backend/db/migrations` на 2026-07-02 — **144** (`144_rehome_orphan_open_tasks.sql`), новые начинаются со **145**; перепроверить максимум непосредственно перед созданием (параллельные ветки).
- Деплой в прод — только по явному подтверждению владельца.

### Потенциально вовлечённые модули/части системы (по architecture.md)

**Backend:**
- `backend/src/routes/onboarding.js` + `platformCompanyService.bootstrapCompany` (ALB-100 identity plane) — контекст создания компании/tenant_admin; менять минимально или не менять (чеклист derived).
- Новый/расширенный эндпоинт состояния онбординг-чеклиста (роутер определит архитектор; company-scoped, tenant_admin-only).
- `backend/src/db/marketplaceQueries.js` (`ensureMarketplaceSchema` += новая seed-миграция), `backend/src/services/marketplaceService.js`, `backend/src/routes/marketplace.js` — reuse install/disconnect/findActiveInstallation (канон F016/F018).
- `backend/src/routes/telephonyNumbers.js` (connect/search/buy/release, softphone/setup) — reuse; возможен статус-эндпоинт для визарда.
- `backend/src/services/telephonyTenantService.js` (`getClientForCompany`, `getSoftphoneCreds`/`ensureSoftphoneSetup`) и `backend/src/services/voiceService.js` — фикс C5.
- `backend/src/webhooks/twilioWebhooks.js` (`handleVoiceInbound`, `companyIdForNumber`) — фиксы C1 и C4.
- `backend/src/services/billingService.js` + `backend/src/routes/billing.js` — seed/применение плана Pay-as-you-go, применение выбора тарифа из визарда; `walletService` — reuse ставок/гейта.
- Миграции 145+: seed marketplace-приложения; seed billing-плана PAYG; NOT NULL + backfill `phone_number_settings.company_id`; UNIQUE ×2.

**Frontend:**
- Страница Pulse (`usePulsePage.ts` + layout-компонент страницы) — новая карточка `OnboardingChecklistCard` в потоке; `frontend/src/hooks/useAuthz.ts` (`isTenantAdmin`) — reuse.
- `frontend/src/pages/IntegrationsPage.tsx` + `frontend/src/services/marketplaceApi.ts` — плитка нового приложения.
- Новая страница-визард `/settings/integrations/telephony-twilio` (по образцу `VapiSettingsPage.tsx` / `StripePaymentsSettingsPage.tsx`) + API-клиент; роут в `frontend/src/App.tsx`.
- Существующие `/settings/telephony/*` (TelephonyLayout: RouteManagerOverview, PhoneNumbers, ProviderSettings, UserGroups) — остаются; для неподключённой компании — отсылка в Marketplace-визард вместо локального connect.

### Затронутые интеграции

- **Twilio** — Subaccounts (существующий connect), AvailablePhoneNumbers search / purchase, Voice inbound webhooks (Reject-фикс), Access Token softphone (fail-closed). Новых типов Twilio-вызовов нет — меняется гейтинг/поведение существующих.
- **Stripe** — только существующий checkout для пакетных планов (платформенный биллинг); новых Stripe-поверхностей нет; PAYG идёт через wallet.
- **Keycloak** — без изменений (роль `tenant_admin` уже есть).
- **Front / Zenbooker / Google** — не затронуты.

### Защищённые части кода (НЕЛЬЗЯ ломать)

- `src/server.js` (только mount-only при явной необходимости), `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`.
- `backend/db/` — существующие миграции не трогать; изменения только новыми миграциями 145+ по явному плану.
- **Boston Masters (seed 00000000-0000-0000-0000-000000000001):** номера на master-аккаунте, softphone на env creds, маршрутизация звонков — поведение байт-в-байт как сейчас.
- Существующий контракт webhooks ALB-107 (определение компании по `AccountSid`→`To`, per-subaccount подпись) и исполнение call flow F017 (`callFlowRuntime`), включая TELEPHONY-AUTONOMOUS-MODE-001 (`autonomous_mode`, fail-open чтение).
- Платформенный биллинг: `billingService` контракты, `/api/billing/webhook` (raw-body mount), Stripe checkout/portal, BillingScheduler; wallet-леджер (mig 109); `walletService.assertServiceActive` остаётся единственной точкой сервис-гейта исходящих SMS (на неё завязаны SEND-DOC-001 и ONWAY-001).
- Marketplace core: `/api/marketplace/*` lifecycle, существующие 5 приложений и их страницы, `MarketplaceConnectDialog` (protected ещё с F016).
- Существующие страницы Settings → Telephony (номера/группы/флоу) — остаются рабочими для подключённых компаний.
- Идемпотентность и транзакция `platformCompanyService.bootstrapCompany`; `POST /api/onboarding` (authenticate-only — так задумано).

### Out of scope

- Email-пункт чеклиста и любые другие новые пункты (модель расширяемая, но сейчас ровно один пункт).
- Изменение существующих цен/лимитов планов trial/starter/pro/huge; proration/downgrade-флоу; авто-пополнение кошелька.
- Port-in номеров, международные номера, A2P-изменения (ALB-107 Phase 2/3 — как есть).
- Изменение call flow/групп/softphone-функциональности (F017) сверх фиксов изоляции C.
- Ретроактивная миграция существующих компаний на новые планы.

---

## EMAIL-OUTBOUND-001: outbound-first email threads surface in the Pulse unified list

**Status:** Requirements · **Priority:** P1 · **Date:** 2026-07-03 · **Owner:** Pulse / Email
**Type:** behavior change, backend-only (one SQL surfacing change + tests; NO new UI — icons already shipped in EMAIL-UNREAD-001, commit d455c52). Owner decisions D1–D4 fixed by interview, binding.

### Duplication check (result)

Not a duplicate — this closes a visibility gap between three shipped features:

- **EMAIL-TIMELINE-001 / EMAIL-UNREAD-001** already ingest and link outbound email (CRM composer `sendForContact`, email-workspace composer, and Gmail-direct sends recipient-matched by `linkOutboundMessage`): `email_messages.contact_id / timeline_id / on_timeline=true` (mig 129) are written, the contact's **timeline detail** shows the outbound bubble, and the list icons `email_inbound`/`email_outbound` (Mail / MailCheck) are live in `PulseContactItem`.
- **LIST-PAGINATION-001** built the unified list query (`getUnifiedTimelinePage`), whose `email_by_contact` CTE resolves contact→email-thread **only via INBOUND messages** (`JOIN contact_emails ON email_normalized = lower(trim(em.from_email)) … AND em.direction='inbound'`).
- Net effect (the bug): a thread the dispatcher **initiated** that has no reply yet is fully linked in the data and visible in the timeline detail, but the contact's row **never appears in the unified list**. Only the list CTE is blind; nothing else needs building.

### Description

When a dispatcher writes the FIRST email to a contact (email-only leads/clients are common) and there is no reply yet, the contact must still appear in the Pulse unified by-contact list: ordered by the thread's last message time like any other channel event, showing the outbound-email icon (MailCheck), and NOT marked unread (the dispatcher wrote it). Fix = make the `email_by_contact` resolution direction-agnostic so a contact's latest email thread is found whether its messages are inbound-matched or outbound-linked. The list's surfacing predicate already includes `eml.email_thread_id IS NOT NULL`, so a correct CTE automatically surfaces the row — no route/response-shape change.

### User scenarios

1. **Email-only lead outreach (CRM composer).** A lead has an email address but no phone activity. The dispatcher opens the contact and sends the first email from the Pulse composer (or the email workspace). On the next list fetch the contact appears in the unified list, positioned by the email's time, with the MailCheck (outbound) icon, and is NOT unread and NOT in the Action-Required band.
2. **Dispatcher writes from Gmail directly.** The dispatcher sends the first email to a known contact from the shared Gmail mailbox itself (no CRM involved). The send is push-ingested and recipient-matched (`linkOutboundMessage`), and the contact surfaces in the unified list exactly as in scenario 1 — no CRM action required. A saved/edited Gmail DRAFT never surfaces anything (existing guard).
3. **Reply arrives → inbound-latest.** The contact later replies. The same row re-orders by the reply time, flips to the Mail (inbound) icon, and becomes unread (thread `unread_count` > 0 → unread tier), exactly like an inbound-first thread; Pulse mark-read clears it (EMAIL-UNREAD-001 route).
4. **Mixed-channel contact.** A contact with existing calls/SMS receives a first-touch outbound email that is now their latest interaction: their existing row re-orders by the email time (`last_interaction_at` = greatest of call/SMS/email) and shows the outbound-email icon. No duplicate row appears.
5. **Two threads, one row.** A contact has an older inbound-matched thread and a newer dispatcher-initiated thread: the list shows ONE row for the contact reflecting the most recent thread (by `last_message_at` across BOTH directions). An outbound email whose recipients match no contact surfaces nothing (stays workspace-only; no contact auto-create).

### Functional requirements

- **FR-1.** `email_by_contact` in `getUnifiedTimelinePage` (`backend/src/db/timelinesQueries.js`) resolves a contact's single most-recent email thread across **both** inbound-matched and outbound-linked messages, keeping the DISTINCT-one-thread-per-contact semantics and the exposed columns (`email_thread_id`, `email_subject`, `last_message_at`, `last_message_direction`, `unread_count`) unchanged in shape.
- **FR-2.** An outbound-only thread surfaces its contact's row via the existing predicate (`eml.email_thread_id IS NOT NULL`), ordered by the standard `GREATEST(call, SMS, email)` recency, in the normal (non-AR, non-unread) tier.
- **FR-3.** Unread semantics unchanged: outbound-first rows have `any_unread = false` (thread `unread_count` grows only on inbound; `linkOutboundMessage` even clears it on outbound). Must be asserted by test, not assumed.
- **FR-4.** All three send paths surface: Pulse composer (`emailTimelineService.sendForContact`), email-workspace composer, Gmail-direct (push → `linkOutboundMessage`). No changes to those services — they already link; the list just reads.
- **FR-5.** **Historical parity:** outbound-first threads sent BEFORE this fix must surface too (D1 parity with inbound, which text-matches all history). If the CTE reads the persisted link (mig 129 columns) rather than re-matching recipient text, an idempotent backfill migration must link historical outbound messages (recipient-match per `linkOutboundMessage` rules, company-scoped, logged row-count — mig 140/144/154 pattern).
- **FR-6.** Subject search keeps working and now also matches outbound-first threads (search predicate already reads `eml.email_subject` — alias must not change, see LIST-PAGINATION-001 search fix d56db8f).

### Acceptance criteria

- **AC-1.** Contact with zero calls/SMS/inbound email + one outbound email → appears in the unified list with `email_last_message_direction='outbound'` (→ MailCheck icon), correct recency position, `any_unread=false`, not pinned to AR.
- **AC-2.** Same outcome when the first email is sent from Gmail directly (ingested via push); DRAFT-labeled messages never surface a row.
- **AC-3.** After an inbound reply, the row shows inbound direction + unread, and re-orders by the reply time; Pulse mark-read clears it. Existing inbound-first behavior is byte-for-byte unchanged (regression suite).
- **AC-4.** One row per contact with multiple threads (newest thread wins across directions); page size, `total_count`, offset pagination, AR band pinning, and orphan-shadow dedup invariants all hold.
- **AC-5.** Tenancy: an outbound-first thread surfaces ONLY in the sending company's list; every new/changed predicate carries `company_id = $1` scoping (both `email_messages` and `email_threads`, as today).
- **AC-6.** Performance: `EXPLAIN (ANALYZE, BUFFERS)` of the real `getUnifiedTimelinePage` against a prod-sized DB copy shows no plan regression — no per-row Seq Scan over `email_messages`, page latency comparable to the current ~0.3s baseline (PULSE-PERF-001 discipline). Any new predicate is exactly index-backed (new migration if needed).

### Constraints / non-functional

- **PERFORMANCE IS CRITICAL — this is THE hot Pulse query** (PULSE-PERF-001 history: 8.4s→0.3s). Mandatory methodology: time the real function in the app container + `EXPLAIN ANALYZE` on a prod copy BEFORE deploy; index expression must be an exact copy of the predicate. Existing supports: mig 143 functional index `email_messages (company_id, (lower(trim(from_email))))` (inbound leg — keep using it) and mig 129 partial index `email_messages (company_id, contact_id, gmail_internal_at) WHERE contact_id IS NOT NULL` (outbound-linked leg candidate).
- **Recipient text-matching in the hot query is effectively ruled out by data shape:** outbound recipients live in `email_messages.to_recipients_json` (JSONB array, mig 079) — per-row JSON expansion in the list query is not acceptable. The performant source for the outbound leg is the persisted link (mig 129 `contact_id`/`on_timeline`); the Architect picks the exact predicate, but AC-6 gates it.
- **Mocked jest is not enough** (LIST-PAGINATION-001 lesson: mocks validate the SQL string only) — run the REAL query against a prod-DB copy before deploy; cover: outbound-only thread, inbound+outbound mix, two-threads-newest-wins, no-match, draft, cross-tenant.
- `company_id` scoping is mandatory on every leg of the CTE (security rule; the SMS cross-tenant leak closed in LIST-PAGINATION-001 is the cautionary precedent).
- Response shape of `getUnifiedTimelinePage` rows must not change (frontend `PulseContactItem` mapping of `email_last_message_direction` → Mail/MailCheck shipped in d455c52 keys off existing fields).
- Unread rules must not change: `unread_count` increments only on inbound; no code path may mark unread on send. D2 is a verification requirement, not a change.
- Pagination invariants (LIST-PAGINATION-001): dedup/surfacing decided in SQL BEFORE `LIMIT`; a page is never shrunk post-query; `total_count` window count stays consistent.
- New migrations start at **155** (current max = 154 `154_backfill_contact_emails.sql`); re-verify the max immediately before creating (parallel branches). Any backfill: idempotent + logs affected row count + rollback file. Backend is CommonJS.
- Deploy to prod only with explicit owner consent (standing rule).

### Involved modules

- **Backend:** `backend/src/db/timelinesQueries.js` — `getUnifiedTimelinePage`, the `email_by_contact` CTE (the ONLY behavioral change point). Optional migration 155+ (index for the outbound leg and/or historical-link backfill) strictly as EXPLAIN/FR-5 dictate.
- **Tests:** backend jest for the query builder + tenancy/unread assertions; real-query verification vs prod-copy (documented in the PR).
- **Frontend:** none (icons + unread rendering already shipped; behavior verified, not modified).

### Integrations

- **Google / Gmail** — no API-surface change (ingest, push, linking all exist). **Twilio / Front / Zenbooker / Stripe** — untouched.

### Protected parts (must not break)

- `emailTimelineService` semantics: `linkOutboundMessage` (recipient match, DRAFT guard, idempotent re-link, SSE-only/no-unread), `sendForContact`, `markThreadRead`-on-outbound (EMAIL-UNREAD-001).
- The contact **timeline detail** projection (`GET /api/pulse/timeline/:contactId`, `buildTimeline`) — already correct for outbound email; zero changes.
- EMAIL-001 standalone `/email` workspace: inbox, threads, composer, sync/scheduler, Pub/Sub push pipeline.
- Unified-list invariants in `getUnifiedTimelinePage`: AR band pinning (open_task tier), unread tier, `GREATEST` ordering, orphan-shadow dedup (SQL before LIMIT), search predicate incl. the `eml.email_subject` alias, SMS lateral company scoping, `total_count` envelope.
- Existing migrations (079, 129, 130, 143, 154) and the mig 143 index; `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`.
- Unread model: inbound-only unread growth; Pulse mark-read route behavior (timeline+contact+SMS+email clearing) from EMAIL-UNREAD-001.

### Out of scope

- Any new UI (icons/labels shipped in d455c52); email workspace changes; contact auto-creation from unknown recipients; CC/BCC matching changes; unread-model changes; surfacing outbound email on **orphan** (contactless) timelines — outbound links are contact-rooted by definition.

---

## TASKS-COUNT-BADGE-001: "open tasks" counter badge in navigation

**Status:** Requirements · **Priority:** P2 · **Date:** 2026-07-03 · **Owner:** Tasks / Frontend nav
**Type:** feature · backend (count route) + frontend (nav badge, hybrid SSE+poll). Direct clone of LEADS-NEW-BADGE-001, applied to Tasks. Owner decision (interview) binding: the badge counts **ALL OPEN tasks VISIBLE TO THE CURRENT USER** — exactly the set the user sees on `/tasks` with the "Only Open" filter. Not overdue-only, not today-only — the full open backlog visible to that user.

### Duplication check (result)

Not a duplicate. **LEADS-NEW-BADGE-001** is the pattern to mirror (a status-derived nav badge), but it counts *leads* by lead status and is company-wide. This feature counts *tasks* and is **RBAC-scoped per user** (managers see all company open tasks; everyone else sees only their own), so it needs its own count route reusing the Tasks visibility model, not the leads one. The Tasks section itself (**AR-TASK-UNIFY-001 / TASKS-001**) has no nav badge today — the `tasks` nav item (`appLayoutNavigation.tsx` line ~18, `ListChecks` icon, perm `tasks.view`) renders bare.

### Description

A count badge (number in a circle — the same `pulse-unread-badge` used by the Pulse and Leads badges) on the **Tasks** nav item = the number of **open tasks visible to the current user**, i.e. the exact row count `GET /api/tasks?status=open` returns for that user. Visibility follows the Tasks model verbatim: a user with `tasks.manage` sees every open company task; every other role sees only tasks they own (`owner_user_id = their crm_users.id`). Not read/unread — it is derived from live task state and persists until tasks are completed (or reassigned away from the user). Company-scoped. Hybrid freshness like the Leads badge: refetch on mount + on route change + a 60s poll fallback, plus (if the Architect adds task realtime events) an SSE-triggered refetch filtered by `company_id`.

### User scenarios

1. **Manager sees the full company backlog.** A user with `tasks.manage` (tenant_admin / manager) has the Tasks badge showing the count of ALL open tasks in the company — identical to the number of rows in their `/tasks` "Only Open" view.
2. **Provider / dispatcher sees only their own.** A non-manager (provider, dispatcher) sees the count of only the open tasks assigned to them (`owner_user_id` = their `crm_users.id`). Another user's open tasks never contribute to their badge.
3. **Create → increments.** A new open task is created (any path — timeline "Action Required", `/tasks` composer, in-card stack) and, for every user to whom it is visible, the Tasks badge increments to reflect it.
4. **Complete → decrements.** A task is marked done → the badge decrements for everyone who could see it.
5. **Reopen → increments.** A previously-completed task is reopened (status back to `open`) → the badge increments again for its visible audience.
6. **Reassign → moves between users.** A task's owner is changed → it leaves the old owner's badge and (unless the recipient is a manager who already counted it company-wide) enters the new owner's badge. Manager badges are unaffected by reassignment (still one open company task).
7. **Zero is silent.** When a user has no visible open tasks, the badge is not rendered at all (no "0" circle).
8. **9+ cap.** A visible open count above 9 renders as `9+` (desktop and mobile), matching the Pulse/Leads badges exactly.
9. **Opening Tasks does not clear it.** Navigating to `/tasks` does not zero or dismiss the badge — it is state-derived, not a read-marker; it only changes when the underlying open tasks change.

### Functional requirements

- **FR-1.** New backend count endpoint (e.g. `GET /api/tasks/count` or `/open-count`) gated by `requirePermission('tasks.view')`, returning the LEADS-NEW-BADGE-001 response shape `{ ok: true, data: { count } }` (matching the existing Tasks routes' `{ ok, data }` envelope and the leads badge contract).
- **FR-2.** The count MUST be produced by the **same visibility logic as `GET /api/tasks`** with `status='open'`: reuse `tasksQueries` so the predicate is `t.company_id = $companyId` **AND `HAS_ENTITY_PARENT`** (the exact `tasksQueries.js` expression: has a `job_id/lead_id/estimate_id/invoice_id/contact_id`, OR a `thread_id` with `created_by IN ('user','agent')`) **AND `t.status='open'`** AND — for non-managers — `t.owner_user_id = actorId(req)`; managers (`canManage` / `tasks.manage`) omit the owner scope. Prefer a `COUNT(*)` variant of `listTasks` (or `listTasks(...).length`) so the two can never diverge. `actorId(req)` = `req.user.crmUser.id`, `companyId(req)` = `req.companyFilter.company_id` — as in `routes/tasks.js`.
- **FR-3.** Frontend: thread an `openTasksCount` (naming parallel to `leadsNewCount`) through `AppLayout.tsx` → `appLayoutNavigation.tsx`; render the badge on the `tasks` nav item in **both** `AppNavTabs` (desktop) and `BottomNavBar` (mobile) using the existing `pulse-unread-badge` span with the `count > 9 ? '9+' : count` rule and a `title` like `"{n} open tasks"`; render nothing when `count === 0`.
- **FR-4.** Freshness = the Leads badge recipe: fetch on mount, on route change, and on a 60s interval poll fallback. **Realtime is an OPEN DESIGN CHOICE for the Architect, NOT decided here:** Tasks currently emit **no** SSE events (the event catalog has only `agent_task.succeeded/failed`), so either (a) introduce minimal PII-free `task.*` events (`created` / `updated` / `completed`, carrying at most `company_id` + `owner_user_id` + `id`/`status`) and wire them additively into `useRealtimeEvents.ts` `genericEventTypes` AND `sseManager.ts` `namedEvents` (both lists, per LEADS-NEW-BADGE-001), refetching filtered by `company_id`; **or** (b) ship poll-only for v1 and defer events. The Architect decides; this requirement only mandates that whichever path is chosen, the badge is eventually consistent within the 60s poll window.

### Acceptance criteria

- **AC-1.** For a `tasks.manage` user, the badge value **equals** the number of rows `GET /api/tasks?status=open` returns for that user (whole-company open set). Verified by comparing the count endpoint's result to the list length for the same session.
- **AC-2.** For a non-manager, the badge value equals `GET /api/tasks?status=open` for that user (own open set only), and a task owned by a different user never changes it.
- **AC-3.** The badge count **never exceeds** what `/tasks` lists for the same user (the count and the list share one predicate — including `HAS_ENTITY_PARENT`, so agent-generated/shadow timeline tasks that `/tasks` hides are excluded from the count too).
- **AC-4.** Create → badge +1; complete → badge −1; reopen → badge +1; reassign → moves between the correct owners; all reflected within the 60s poll window (immediately if SSE is chosen).
- **AC-5.** Badge is absent at count 0; renders `9+` above 9; identical markup/behavior on desktop (`AppNavTabs`) and mobile (`BottomNavBar`).
- **AC-6.** Tenancy: the count is scoped by `company_id = $1`; a user in company A never sees tasks from company B contribute to the badge (same guarantee the Tasks routes already enforce).

### Constraints / non-functional

- **The count predicate MUST equal the `/api/tasks` open-list predicate exactly** — same `tasksQueries` source, same `HAS_ENTITY_PARENT` filter, same manager-vs-owner scoping, same `status='open'`. This is the load-bearing invariant (AC-1..AC-3); implement the count as a `COUNT`/length over the existing `listTasks` filter set, never a hand-rewritten WHERE, so drift is structurally impossible.
- **Route order:** if the endpoint is a bare segment under `/api/tasks` (e.g. `/count`, `/open-count`), it MUST be mounted **above** any `/:id` route in `routes/tasks.js` (mirror of the `/new-count`-before-`/:uuid` caveat in `leads.js:162`), or Express matches the literal as an `:id`.
- **Permission:** `tasks.view` only (same gate as the list). No new permission, no migration — this is a read over existing task rows.
- **SSE payload (if events are added) must be PII-free** — at most `company_id`, `owner_user_id`, `id`, `status`; the client filters by `company_id` (LEADS-NEW-BADGE-001 discipline). Any new event name goes in **both** `useRealtimeEvents.ts` and `sseManager.ts` (a name in only one is silently dead).
- **`useRealtimeEvents.ts` may be touched only additively** (append event type(s) to the generic channel), per the LEADS-NEW-BADGE-001 precedent — no restructuring of the realtime layer.
- Count query must stay cheap (indexed `company_id` + `status` + `owner_user_id`); it runs on every mount/route-change/poll and, if events are added, on each task event — do not introduce a per-row scan.
- Deploy to prod only with explicit owner consent (standing rule).

### Involved modules

- **Backend:** `backend/src/routes/tasks.js` (new count route, above `/:id`), `backend/src/db/tasksQueries.js` (add a count/length helper over the `listTasks` filter set — or reuse `listTasks` and take `.length`), and — only if realtime is chosen — the task event emit path + `eventCatalog` (currently `agent_task.succeeded/failed` only), `realtimeService`/`sseManager.ts`.
- **Frontend:** `AppLayout.tsx` (state `openTasksCount` + `fetchOpenTasksCount` + mount/route-change/60s-poll, mirroring `fetchLeadsNewCount`), `appLayoutNavigation.tsx` (`AppNavTabs` + `BottomNavBar` badge on the `tasks` item), `useRealtimeEvents.ts` + `sseManager.ts` (additive, only if events chosen), `AppLayout.css` (reuses existing `pulse-unread-badge`; no new class expected).

### Integrations

- None. **Twilio / Front / Zenbooker / Google / Stripe** — untouched. This is an internal read over the tasks table plus a nav-badge render.

### Protected parts (must not break)

- **`GET /api/tasks` list behavior and its visibility model** (`routes/tasks.js:41-64`, `tasksQueries.listTasks`, `HAS_ENTITY_PARENT`, `canManage`/`scopeOwnerId`) — the count reuses it and must not alter it; the AR-TASK-UNIFY-001 "open task = Action Required" timeline coupling stays intact.
- **RBAC gates** `tasks.view` / `tasks.manage` and `actorId = req.user.crmUser.id` semantics (created_by-FK-crm-user-id rule) — the count must resolve identity the same way, no fallback to `sub`.
- **LEADS-NEW-BADGE-001 wiring** (`leadsNewCount`, `/new-count` route, its SSE event types) — the Tasks badge is added **alongside**, threading a separate `openTasksCount`; the Leads/Pulse badges and their `pulse-unread-badge` markup must keep working unchanged.
- **`useRealtimeEvents.ts` / `sseManager.ts`** touched additively only; the existing Pulse/Leads realtime channels must not regress.

### Out of scope

- Any change to the Tasks visibility rules, the `/tasks` page, task filters, or the `HAS_ENTITY_PARENT` definition.
- Overdue-only / due-today-only counting, per-parent-type breakdowns, or a badge on any surface other than the `tasks` nav item.
- New task realtime events are **optional** (Architect's call under FR-4) — if deferred, poll-only is acceptable for v1; introducing them is not required by this requirement.
- Read/unread or "seen" state for tasks (the badge is state-derived, never dismissed by viewing).

---

## CONTACT-EMAIL-MERGE-001: adding an email to a contact merges that address's existing correspondence (email analogue of the phone-merge)

**Status:** Requirements · **Priority:** P1 · **Date:** 2026-07-04 · **Owner:** Contacts / Pulse / Email
**Type:** feature — frontend (multi-email editor) + backend (PATCH route writes `contact_emails`; new email-merge service). The email counterpart of the shipped phone-merge (`mergeOrphanTimelines`). Owner decisions D1–D3 (interview) binding.

### Duplication check (result)

Not a duplicate — it closes a real gap. Three shipped features around it, none of which do this:

- **Phone side (the pattern to mirror):** editing a contact's `phone_e164`/`secondary_phone` fires `mergeOrphanTimelines(contactId, [phone, secondary_phone])` async from `PATCH /api/contacts/:id` (`backend/src/routes/contacts.js` ~line 232-240), which re-points orphan (contactless) timelines + their calls + open tasks onto the contact, adopting/merging/deleting orphan timelines. **There is no email equivalent.**
- **`contact_emails` model exists (mig 025):** `(contact_id, email, email_normalized, is_primary, UNIQUE(contact_id, email_normalized), ON DELETE CASCADE)`; `contactDedupeService.enrichEmail(contactId, emailNorm)` already writes it idempotently (sets primary if the contact has none, else additional; `ON CONFLICT DO NOTHING`); `emailQueries.findEmailContact` resolves an address to a contact via `contacts.email OR contact_emails.email_normalized`; `emailQueries.linkMessageToContact(providerMessageId, companyId, {contact_id, timeline_id, on_timeline})` idempotently projects an `email_messages` row onto a contact/timeline.
- **The list already reads `contact_emails` (EMAIL-OUTBOUND-001 / LIST-PAGINATION-001):** `getUnifiedTimelinePage`'s `email_by_contact` CTE resolves contact→email-thread via `contact_emails.email_normalized` (both inbound-matched and outbound-linked legs). So once an added address lands in `contact_emails` and its messages are linked, the contact's row surfaces automatically — no list change needed.
- **The bug this closes:** `PATCH /api/contacts/:id` currently updates only the `contacts.email` scalar column and **never writes `contact_emails`** (pre-existing gap — the allowed-fields loop at ~line 172 sets `email` on the row and stops). So even a primary email typed in the editor is invisible to every `contact_emails`-keyed join, and no correspondence is ever merged. This feature must (a) persist emails to `contact_emails`, (b) support a multi-email list, and (c) merge each added address's existing correspondence.

### Description

The contact editor gains a **multi-email list** (one primary + any number of additional emails) — the exact analogue of the secondary-phone model — persisted to `contact_emails`. When an email is added to a contact (via the new editor, on create, or via any path that adds a `contact_emails` row) and that address **already has email correspondence in the same company**, that correspondence merges into THIS contact's timeline so it becomes part of the conversation and surfaces in the Pulse unified list. "Already has correspondence" resolves into three cases (owner D1–D3):

- **Inbox-only (no contact at all):** `email_messages` for that address with `contact_id IS NULL` / not on any timeline → **link** them onto this contact's timeline (they surface + join the conversation). [D3]
- **Owned by an EMAIL-ONLY auto-contact** (a contact that exists ONLY because an inbound email auto-created it — no phone, no business entities): **FULL MERGE** — re-point that contact's emails / tasks / timeline / everything onto THIS contact, then DELETE the now-empty contact. [D2a]
- **Owned by a contact WITH its own identity/data** (has a phone OR any business entity — job/lead/estimate/invoice/payment): **do NOT delete it** — re-point ONLY the `email_messages` (and their thread linkage) for the added address onto this contact's timeline; the other contact stays intact and keeps its own identity. [D2b]

If the added address has **no** correspondence anywhere, it is simply recorded in `contact_emails` (nothing to merge). Multiple emails may be added at once or over time; each is resolved independently. The merge runs on the same seam as the phone-merge (async from the PATCH route by default) and is idempotent.

### User scenarios

1. **Add an email that has inbox-only correspondence → linked.** A contact has a phone but the dispatcher knows their email; that address has two inbound emails sitting in the shared inbox with no contact attached (`contact_id NULL`). The dispatcher adds the email in the contact editor and Saves. The two messages are linked onto this contact's timeline (`emailQueries.linkMessageToContact`, `on_timeline=true`), the thread is attached, and the contact's row now reflects that email thread in the Pulse unified list (via the existing `email_by_contact` CTE). The email history is visible in the contact's timeline detail.
2. **Add an email owned by an email-only auto-contact → full merge + delete.** Address `x@acme.com` earlier arrived as an inbound email that auto-created a bare contact (no name/phone, no jobs/leads/estimates/invoices/payments — it exists solely to hold that email thread). The dispatcher adds `x@acme.com` to a real contact "Jane Smith". On Save: that auto-contact's email messages, email thread, its timeline, and any open tasks are re-pointed onto Jane's timeline; the emptied auto-contact is deleted. Jane's list row and timeline now own the whole thread; the duplicate contact is gone.
3. **Add an email owned by a contact WITH a phone/job → re-point emails only, keep the contact.** Address `bob@acme.com` belongs to contact "Bob" who also has a phone number and an open job. The dispatcher adds `bob@acme.com` to a different contact "Acme Billing". On Save: only the `email_messages` for `bob@acme.com` (and their thread link) are re-pointed onto Acme Billing's timeline; **Bob is NOT deleted** and keeps his phone, job, calls, and his own timeline. (Owner-accepted consequence: that email correspondence now lives under Acme Billing; Bob's non-email history is untouched.)
4. **Add an email with no correspondence anywhere → just recorded.** The dispatcher adds a brand-new email that has never appeared in any message. It is written to `contact_emails` (primary if the contact had none, else additional). No merge, no timeline change, no list change beyond the address now being on file (and future inbound/outbound for it will resolve to this contact).
5. **Multiple emails on one contact.** A contact legitimately has several addresses (personal + work). The editor lists the primary and all additional emails, allows adding several, and marks exactly one primary. Each added address independently runs its own resolution (link / full-merge / re-point / record). Re-saving with the same set is a no-op (idempotent; `UNIQUE(contact_id, email_normalized)` + `ON CONFLICT DO NOTHING`).
6. **Editing the primary email persists to `contact_emails` (closes the pre-existing gap).** Simply changing the primary email in the editor (the case that does nothing today) now writes/updates the `contact_emails` primary row so the address is visible to all `contact_emails`-keyed joins, and triggers the same merge resolution for the new address.
7. **Removing an email (scope decision — see FR-8 / constraints).** Deleting an address from the list removes the `contact_emails` row. Whether removal also **un-links** the previously-merged messages (reverse the merge) or **only stops future resolution** (leaves already-merged history in place) is a product/architect decision flagged below — the safe default is: remove the `contact_emails` row and leave already-linked history on the timeline (no destructive un-merge), and this scenario is a candidate to defer entirely if it complicates v1.

### Functional requirements

- **FR-1.** The contact editor renders a **multi-email list**: one primary email + zero-or-more additional emails, add/remove rows, exactly one primary. Follows FORM-CANON (floating-label filled fields, right-side panel) and mirrors the secondary-phone UX. Emails are validated (basic email shape) before Save.
- **FR-2.** `PATCH /api/contacts/:id` (and the create path) **persists the full email set to `contact_emails`**, not just the `contacts.email` scalar: upsert each address (`email`, `email_normalized = lower(trim(email))`, `is_primary`) with `ON CONFLICT (contact_id, email_normalized) DO NOTHING`, keep the scalar `contacts.email` in sync with the primary (existing consumers still read it), and enforce a single `is_primary=true` row. Reuse `contactDedupeService.enrichEmail` semantics rather than hand-rolling the insert. The request contract for emails (shape of the emails payload) is an architect detail; the route must accept and durably store the list.
- **FR-3.** After persisting, for **each newly-added** address the backend runs an **email-merge resolution** (new service, the email analogue of `timelineMergeService.mergeOrphanTimelines`) scoped to the contact's `company_id`:
  - resolve the address to an owning contact via `email_normalized` (like `findEmailContact`) within the same company;
  - **no owner (inbox-only):** link every `email_messages` row for that address (and its thread) onto this contact's timeline via `linkMessageToContact` (`on_timeline=true`), creating/adopting the contact's timeline with `timelinesQueries.findOrCreateTimelineByContact` (which already re-homes shadow-orphan open tasks); [D3]
  - **owner is EMAIL-ONLY (empty):** FULL MERGE — re-point that contact's `email_messages` / email threads / tasks / timeline (+ `contact_emails`, addresses M2M with NOT-EXISTS guards) onto this contact respecting FK order (tasks → timelines → contact), then DELETE the emptied contact; [D2a]
  - **owner HAS identity/data:** re-point ONLY the `email_messages` (+ thread link) for that address onto this contact's timeline; leave the other contact and all its non-email data intact (no delete). [D2b]
- **FR-4.** **"Email-only / empty" predicate (the D2a↔D2b decision gate)** = the owning contact has NO `phone_e164` AND NO `secondary_phone` AND no referencing rows in the business-entity tables (`jobs`, `leads`, `estimates`, `invoices`, `payments`) AND no independent tasks — i.e. it exists only to hold email(s). The **exact** table list and predicate are an **architect decision** (must enumerate every table with a `contact_id` FK so nothing that constitutes "identity/data" is missed); FR-4 fixes the intent (delete only when the contact is truly nothing-but-email), the architect fixes the SQL.
- **FR-5.** The merge is **idempotent**: re-running for the same address/contact produces no duplicate links, no double-move, and no error; `linkMessageToContact` is a no-op re-link, `contact_emails` upserts `ON CONFLICT DO NOTHING`, and a full-merge whose source is already gone is a clean no-op.
- **FR-6.** The merge is **company-scoped**: it only ever resolves/moves messages, threads, contacts, and timelines within the editing contact's `company_id`. No cross-tenant resolution or deletion is possible (address collisions across companies are independent).
- **FR-7.** Once `contact_emails` holds the address and messages are linked, the **Pulse unified list surfaces the contact's email thread with no list-code change** (the `email_by_contact` CTE already resolves via `contact_emails.email_normalized`, both directions — EMAIL-OUTBOUND-001). Timeline detail shows the merged email history.
- **FR-8.** **Email removal (scope-flagged).** Removing an address deletes its `contact_emails` row. Whether removal also reverses a prior merge (un-links messages) is DEFERRED unless the architect/owner rules otherwise; default v1 behavior = remove the row, keep already-linked history in place (non-destructive). This FR exists to force an explicit decision, not to mandate un-merge.

### Acceptance criteria

- **AC-1.** Adding an email whose only footprint is inbox-only messages links those messages onto the contact's timeline (`on_timeline=true`, contact's timeline id, thread attached); the contact then appears in the unified list positioned by the thread's last-message time with the correct email icon, and the thread shows in timeline detail. Re-saving is a no-op.
- **AC-2.** Adding an email owned by an email-only auto-contact re-homes all of its email messages/threads/tasks/timeline onto the target contact and DELETES the auto-contact (`findEmailContact` for that address afterwards returns the target contact; the old contact id no longer exists; no orphaned `email_messages` / `contact_emails` / open tasks remain).
- **AC-3.** Adding an email owned by a contact that has a phone or any business entity re-points ONLY that address's email messages onto the target's timeline and **leaves the other contact intact** (its phone, calls, jobs/leads/estimates/invoices/payments, and its own timeline all still present; it is NOT deleted).
- **AC-4.** Adding an email with no correspondence writes exactly one `contact_emails` row (primary if the contact had none, else additional), performs no timeline/list change, and subsequent inbound/outbound for that address resolves to this contact.
- **AC-5.** Editing ONLY the primary email (no other change) now writes/updates the `contact_emails` primary row (regression against the current gap) and runs resolution for the new address; the scalar `contacts.email` stays in sync.
- **AC-6.** Tenancy: an address that also exists in another company is never touched; no message, thread, contact, or timeline outside the editing contact's `company_id` is read, moved, or deleted. Verified against a two-company fixture.
- **AC-7.** Idempotency / integrity: running the merge twice yields identical state; FK order is respected (no CASCADE destroys an open task — ORPHAN-TASK-REHOME-001 discipline); a full-merge deletes the source contact only after all its data is re-pointed.
- **AC-8.** The real query/merge is verified against a **prod-sized DB copy**, not just mocked jest (LIST-PAGINATION-001 lesson): cover inbox-only, empty-auto-contact full merge, has-identity re-point, no-correspondence, multi-email, cross-tenant isolation.

### Constraints / non-functional

- **Must write `contact_emails`.** The load-bearing fix: emails added via the new UI (including the primary) MUST land in `contact_emails` (`email_normalized = lower(trim(email))`), or the `email_by_contact` CTE and `findEmailContact` never see them and nothing merges or surfaces. Keep the scalar `contacts.email` in sync with the primary for existing consumers.
- **Async vs synchronous merge — ARCHITECT DECISION (flagged).** The phone-merge runs **async, non-blocking** after the PATCH responds (fire-and-forget with a caught, logged error). Mirroring that keeps Save latency low and is the default. BUT a delete-and-re-point merge has stronger consistency needs than the phone-merge's re-point-only; the architect must decide async (like phones) vs synchronous-in-request (or a transaction) — weighing Save latency vs the window where the UI shows a just-added email whose merge hasn't completed. Whichever is chosen: idempotent, and a failure must not corrupt state or lose the `contact_emails` write.
- **Idempotent** end to end (re-save, push redelivery, double-fire): `linkMessageToContact` no-op re-link, `contact_emails` `ON CONFLICT DO NOTHING`, full-merge no-op when the source is already merged/gone.
- **Company scoping is mandatory on every leg** — resolution, message re-point, thread re-point, contact delete — all filtered by the editing contact's `company_id`. **No cross-tenant merge or delete.** (The SMS cross-tenant leak closed in LIST-PAGINATION-001 and the ZB-ISO-001 leak are the cautionary precedents.)
- **Deletion only when truly empty (D2).** A contact is deleted ONLY when it is email-only per the FR-4 predicate; any phone or business entity makes it re-point-only. The emptiness predicate must enumerate every `contact_id`-referencing table (architect) so "identity/data" is never under-counted and a real contact is never destroyed.
- **FK order / no silent task loss.** Re-point open tasks off a to-be-deleted timeline/contact BEFORE deleting (tasks.thread_id is `ON DELETE CASCADE` — the exact trap fixed in ORPHAN-TASK-REHOME-001); order = tasks → timelines → contact; M2M rows (`contact_emails`, addresses) moved with NOT-EXISTS guards to avoid unique-constraint collisions.
- **No general contact-merge service exists** — the full-merge path must be built (the owner's prior dedup was ad-hoc SQL). Build it as a reusable, tested service (email analogue of `timelineMergeService`), not inline route SQL.
- **Reuse existing primitives**, don't re-implement: `contactDedupeService.enrichEmail` (write `contact_emails`), `emailQueries.findEmailContact` (resolve owner), `emailQueries.linkMessageToContact` (project message onto contact/timeline), `timelinesQueries.findOrCreateTimelineByContact` (+ its `reassignShadowOrphanOpenTasks`).
- **The list needs no change** — `email_by_contact` already resolves via `contact_emails.email_normalized` (EMAIL-OUTBOUND-001). Do not touch `getUnifiedTimelinePage` unless a new index is required; if so, follow PULSE-PERF-001 (EXPLAIN on prod copy, index expression = exact predicate copy).
- **Mocked jest is not enough** (LIST-PAGINATION-001) — run the REAL merge against a prod-DB copy before deploy.
- **Migrations (if any) start at 156** — current max is `155_backfill_outbound_email_links.sql` (EMAIL-OUTBOUND-001 already claimed 155); re-verify the max immediately before creating (parallel branches). Any backfill: idempotent + logs affected row count + rollback file. Backend is CommonJS. Note: this feature may need **no** new migration (mig 025 `contact_emails` + mig 079/129 `email_messages` columns suffice) — add one only for a required index or a one-time historical resolution backfill.
- **Email removal semantics (FR-8)** must be explicitly decided (default: non-destructive) before implementation; do not ship a silent destructive un-merge.
- Deploy to prod only with explicit owner consent (standing rule).

### Involved modules

- **Backend:** `backend/src/routes/contacts.js` — `PATCH /:id` (persist `contact_emails`; trigger email-merge) and the create path; a **new email-merge service** (`backend/src/services/` — analogue of `timelineMergeService.js`); `backend/src/services/contactDedupeService.js` (`enrichEmail`, `getAdditionalEmails` — reuse/extend); `backend/src/db/emailQueries.js` (`findEmailContact`, `linkMessageToContact`, and likely a new company-scoped "list messages for address" helper); `backend/src/db/timelinesQueries.js` (`findOrCreateTimelineByContact`, `reassignShadowOrphanOpenTasks`).
- **Frontend:** the contact editor panel (multi-email list UI, mirroring the secondary-phone control) + its contacts API client for the emails payload.
- **Tests:** backend jest for the merge service (all D1–D3 branches, idempotency, tenancy, FK/task-safety) + real-query verification vs a prod-DB copy (documented in the PR).

### Integrations

- **Google / Gmail** — reuses the existing ingest/link seam (`linkMessageToContact`); no Gmail API-surface change. **Twilio / Front / Zenbooker / Stripe** — untouched (contact-email edits do not push to ZB email; the existing ZB contact sync on PATCH is unchanged).

### Protected parts (must not break)

- **Phone-merge** (`timelineMergeService.mergeOrphanTimelines`, its async trigger in `PATCH /:id`, ORPHAN-TASK-REHOME-001 task re-home) — the email path is added ALONGSIDE it; the phone path must keep working byte-for-byte.
- **`email_by_contact` CTE / `getUnifiedTimelinePage`** (EMAIL-OUTBOUND-001, LIST-PAGINATION-001) — do not change its shape/semantics; it should surface merged threads automatically.
- **`emailQueries.linkMessageToContact`** idempotent-re-link + DRAFT/unread semantics (EMAIL-UNREAD-001), and `findEmailContact` resolution — reused unchanged.
- **`contact_emails` invariants** (mig 025): `UNIQUE(contact_id, email_normalized)`, `ON DELETE CASCADE`, single primary; and the scalar `contacts.email` consumers.
- **Contact→leads cascade** in `PATCH /:id` (updates linked `leads` fields) and the async ZB contact sync — must keep firing; the new email logic is additive.
- Existing migrations (025, 079, 129, 130, 143, 154, 155) and their indexes.
- Tenancy guarantees (ONBOARD-FIX-001 / ZB-ISO-001): all reads/writes scoped by `company_id`; the merge introduces no cross-tenant path.

### Out of scope

- Any change to the unified-list query shape or the Pulse timeline-detail projection (they already surface `contact_emails`-linked threads).
- Auto-creating contacts from unknown email recipients (existing behavior stays); CC/BCC-based merge (resolution is on the added address only); phone-side behavior.
- A general-purpose "merge two arbitrary contacts" UI (this feature merges only via the email-add action, per D2's constrained rules); manual conflict-resolution UI.
- Destructive email removal / reverse-merge (FR-8) unless explicitly chosen; changes to the unread model or ZB email push.

---

## EMAIL-LEAD-ORIGIN-001: email-only Pulse timelines are first-class — show the contact card and let a lead be born from an email (phone optional)

**Status:** Requirements · **Priority:** P1 · **Date:** 2026-07-04 · **Owner:** Pulse / Leads / Contacts / Email
**Type:** feature — frontend (ungate the Pulse detail card + phoneless-panel robustness + email-origin lead wizard) + backend (POST /api/leads accepts email/contact_id origin with phone optional; new lead-by-contact_id lookup). Two parts: **PART A** (show the contact card for phoneless timelines) + **PART B** (create a LEAD from an email, phone OPTIONAL). **Binding owner decisions (stated explicitly, no further questions):** the contact card MUST appear for email-only contacts; a lead MUST be creatable from an email; **phone is OPTIONAL** for such leads.

### Duplication check (result)

Not a duplicate — it makes an existing-but-invisible state usable. Adjacent shipped features, none of which cover this:

- **EMAIL-TIMELINE-001 / EMAIL-OUTBOUND-001 / LIST-PAGINATION-001** already surface an email-only conversation in the Pulse unified list (via the email signal / `email_by_contact` CTE), and the contact may already exist (auto-created from an inbound email, or via CONTACT-EMAIL-MERGE-001). But the **Pulse detail card is phone-gated**: `PulsePage.tsx` (~line 361) renders the whole Lead/Contact/Wizard tri-state only when `!isAnonTimeline && (p.contactId || p.timelineId) && p.phone` — and `p.phone` is `''` for an email-only timeline, so an email-only contact shows **no card at all** (no identity, no actions, no way to create a lead). That is the PART A gap.
- **Leads are phone-born.** `CreateLeadJobWizard` (the Pulse "New Lead" wizard) takes a mandatory `phone` prop, initializes its phone field from it, and puts `Phone: toE164(phoneNumber)` into the create payload (and hardcodes `phone` into the ZB customer payload on the with-job leg). `CreateLeadDialog` (the manual reference form) has an Email field but marks `Phone` `required` and validates on it. There is **no way to create a lead from an email without a phone**. That is the PART B gap.
- **Schema is already ready — no storage migration needed.** `leads.phone` is NULLABLE (mig 004), `leads.email` exists (VARCHAR 200), `leads.contact_id` + `idx_leads_contact_id` exist (mig 023). A phoneless, email-origin lead is **storable today**; only the write-path validation, the create wizard, and the lookup block it.

## MAIL-MUTE-001: excluding a sender in Mail Secretary also mutes that sender's EMAIL signal in the Pulse timeline (email channel only; calls/SMS unaffected)

**Status:** Requirements · **Priority:** P1 · **Date:** 2026-07-05 · **Owner:** Mail Secretary / Pulse / Email
**Type:** feature — backend-only (extend the inbound-email link path to skip Pulse contribution when a sender matches an existing Mail Secretary exclusion rule; make the Pulse unified-list SQL suppress the EMAIL contribution — surfacing, ordering, unread — for muted senders while leaving CALL and SMS contributions intact). **No new user-facing list, no new input type, no new settings field.** The *existing* Mail Secretary exclusion list is the single source of truth; this feature only widens what a match *means*.

### Problem (owner, verbatim intent)

Adding a sender to the Mail Secretary exclusion list today only stops **task creation**. The inbound email is **still linked** to the sender's contact timeline: it marks the timeline **unread** and **bumps it to the top** of the Pulse list. Vendor/no-reply senders (e.g. `customerservice@relyhome.com` → timeline `/pulse/timeline/2915`) therefore keep cluttering the Pulse list even though the operator has explicitly said "ignore this sender."

### BINDING clarified decisions (from the customer interview — these OVERRIDE any conflicting assumption below)

1. **Granularity = the exclusion DSL's `from:` rule, unchanged.** A muted sender is an exact address (`customerservice@relyhome.com`) OR a domain (`@relyhome.com` / `relyhome.com`). This is already how the `from:` rule works (case-insensitive substring match against `"from_name <from_email>"`; both exact and domain-substring already supported). **No new user input type.**
2. **ONE unified list (critical).** There is **NO** separate "muted senders" list. The **existing** `mail_agent_settings.exclusion_rules` list is the single user-facing list. We EXTEND its meaning: a matching inbound email now ALSO does not update the Pulse timeline (no link / no unread / no bump / no email surfacing), **in addition to** today's "no task."
3. **Channel-specific (critical).** Muting suppresses **only the EMAIL channel**. The same contact's timeline still surfaces AND bumps on inbound **CALLS** and **SMS** normally. For a phone+email contact, the email signal is suppressed in the list but call/SMS signals remain; for an email-only contact (relyhome / timeline 2915) the only signal is email → the timeline drops out of the list.
4. **Existing threads auto-hide.** An already-linked timeline of a now-muted sender is hidden from the list automatically (by suppressing the email contribution in the *list query*), and is reversible when the sender is un-excluded. **No separate manual cleanup** ships as part of this feature; historical `email_messages`/`email_threads` rows are **retained, not deleted** (open in the detail view if navigated to directly).
5. **Agent contact-creation stays blocked for muted senders.** A muted/excluded sender must NOT get a contact auto-created (else the timeline reappears). Already satisfied by the unified approach: the agent returns `skipped_excluded` before its create-contact-for-unknown path.
6. **Reversible & per-company.** Removing the sender from exclusions restores normal email linking/surfacing. All evaluation and suppression are scoped by `company_id`.

### Duplication check (result)

**Not a duplicate — it is a deliberate cross-cut over two shipped features.** Adjacent features and why none of them cover this:

- **MAIL-AGENT-001 (Mail Secretary, deployed prod 2026-07-03, mig 152)** owns the exclusion list and the DSL (`mailAgentRules`: `from:`/`subject:`/`body:`/`any`, substring or `/regex/i`, `-` negation, quotes, `#` comments). `mailAgentService.reviewInboundEmail` (`backend/src/services/mailAgentService.js` l.99–145) evaluates rules via `safeParseRules(settings.exclusion_rules)` + `matchEmail(...)` and returns `{verdict:'skipped_excluded'}` on a hit — **but that verdict ONLY gates task creation.** It does NOT change linking. This feature reuses that exact match to ALSO gate Pulse contribution.
- **EMAIL-TIMELINE-001 / EMAIL-OUTBOUND-001 / CONTACT-EMAIL-MERGE-001 / EMAIL-LEAD-ORIGIN-001** make an email conversation a first-class Pulse citizen (`emailTimelineService.linkInboundMessage`, `email_by_contact` CTE, unread + bump). They deliberately *surface* email — none of them provides a per-sender suppression. This feature adds the missing "suppress this sender's email contribution" seam.
- **LIST-PAGINATION-001** built the single `getUnifiedTimelinePage` query whose email contribution (surfacing predicate, `last_interaction_at`, `any_unread`) is exactly what must become suppressible-per-contact here — without touching the call/SMS contributions it also owns.

There is **no existing "mute" / "suppress sender" feature**; `grep` for `MAIL-MUTE` across `docs/` returns nothing.

### User stories / use cases

1. **US-1 (vendor no-reply, email-only).** As an operator, when I add `customerservice@relyhome.com` (or `@relyhome.com`) to the Mail Secretary exclusion list, future emails from that sender must stop appearing in my Pulse list, and the existing relyhome timeline (2915) must drop out of the list — because its only signal is email.
2. **US-2 (phone+email contact — keep the human channels).** As an operator, if a contact I do business with by phone/SMS *also* receives muted vendor email at their address, muting must remove only the email clutter: their timeline must still surface and bump when they **call** or **text**.
3. **US-3 (un-exclude restores).** As an operator, when I remove a sender from the exclusion list, their emails link and surface normally again, and their previously-hidden email-only timeline reappears in the list.
4. **US-4 (domain vs exact).** As an operator, I can mute one exact address without muting the whole domain, or mute the whole domain — using the same `from:` rule I already use to stop tasks.
5. **US-5 (no accidental contact spawn).** As an operator, muting a previously-unknown sender must not cause a contact/timeline to be auto-created for them by the agent.

### Functional requirements

- **FR-1 — Reuse the existing exclusion match; no new list/field.** Muting is driven entirely by `mail_agent_settings.exclusion_rules` via the existing `mailAgentRules` `from:` semantics. No new column, no new UI list, no new input type is introduced for the *user*. (A derived, queryable representation MAY be added for the SQL path — see Constraint C-1 — but it is not user-facing.)
- **FR-2 — Suppress inbound email→timeline link for muted senders.** In `emailTimelineService.linkInboundMessage` (`backend/src/services/email/emailTimelineService.js` l.89–235), when the sender matches an active exclusion rule for that `companyId`, add an early return of the same shape as the existing branches (e.g. `{skipped:'muted_sender'}`) **before** `findOrCreateTimelineByContact` / `markContactUnread` / `markTimelineUnread`. No link row for the email, no unread flip, no bump.
- **FR-3 — Do not auto-create a contact for muted senders.** Ensure the agent's create-contact-for-unknown-sender path is not reached for a muted sender (already guaranteed by `skipped_excluded` preceding contact creation — verify and keep). A muted first-time sender must NOT materialize a contact/timeline.
- **FR-4 — Suppress ONLY the EMAIL contribution in the Pulse unified list.** In `getUnifiedTimelinePage` (`backend/src/db/timelinesQueries.js`, ~l.381–580), the EMAIL contribution must be suppressed **per contact** for muted senders while CALL and SMS contributions remain: (a) drop `eml.email_thread_id IS NOT NULL` from the surfacing predicate (l.547–551) for muted contacts; (b) exclude the email term from `last_interaction_at = GREATEST(latest_call.started_at, sms.last_message_at, eml.last_message_at)` (l.499) for muted contacts; (c) exclude `COALESCE(eml.unread_count,0) > 0` from `any_unread` (l.500–501) for muted contacts. Calls (`latest_call`), SMS (`sms` lateral), open tasks, `is_action_required`, and `tl.has_unread` contributions are **untouched**.
- **FR-5 — Channel-specific drop-out for email-only timelines.** A timeline whose ONLY signal is email from a muted sender must not satisfy the surfacing predicate → it does not appear in the list. A timeline that also has a call/SMS/open-task/`has_unread` signal remains, ranked by its non-email signals only.
- **FR-6 — Reversible.** Removing the sender from `exclusion_rules` immediately (subject to the settings/derived-set refresh, see C-1) restores link-on-inbound and list surfacing; the historical timeline reappears because its retained email rows again contribute.
- **FR-7 — Per-company scoping.** Exclusion evaluation and list suppression MUST be scoped by `company_id`. A mute in company A never suppresses email in company B (the Pulse query is already `WHERE tl.company_id = $1`; the muted-sender set MUST be company-scoped too).
- **FR-8 — Idempotency / redelivery.** A redelivered or duplicate inbound email for a muted sender must remain suppressed (no link, no unread) and must not create a contact — consistent with the existing provider-message-id dedup; muting must not weaken dedup.
- **FR-9 — Historical rows are retained, not deleted.** Suppression is a *query-time* hide, not a data mutation. Existing `email_messages`/`email_threads`/link rows for a now-muted sender are preserved and remain reachable in the detail view if opened directly; only *list* surfacing/unread/bump are suppressed.
- **FR-10 — Fail-open on mute evaluation.** If the muted-sender check fails (parse error, missing settings, DB error), the pipeline MUST behave as today (link + surface as normal) rather than dropping or erroring the email — mirroring MAIL-AGENT-001's "never throw from the link pipeline" contract. Muting is best-effort clutter-reduction, never a delivery/data-loss risk.

### Edge cases (explicit)

- **Phone+email contact** → email suppressed in list; **call/SMS still surface and bump** (FR-4/FR-5). ✔
- **Email-only contact (relyhome / 2915)** → drops out of the list entirely while muted (FR-5). ✔
- **Un-exclude** → normal linking/surfacing restored, historical timeline reappears (FR-6). ✔
- **Domain vs exact** → `@relyhome.com` mutes all `*@relyhome.com`; `customerservice@relyhome.com` mutes only that address (FR-1). ✔
- **Negation / complex DSL** → a sender matched by a `from:` rule but rescued by a `-` negation on the SAME line is NOT muted (mute follows `matchEmail`'s final `excluded` verdict exactly — no divergent mute logic). ✔
- **Multi-tenant** → mute is company-scoped; no cross-tenant suppression (FR-7). ✔
- **Redelivery/duplicate** → stays suppressed, no contact spawned (FR-8). ✔
- **Outbound reply to a muted sender** → out of scope for suppression; the existing outbound/`draft_or_sent` branches already govern the agent-side projection. If an operator emails a muted address, that is a human action; this feature does not force-surface or force-hide it beyond current EMAIL-OUTBOUND-001 behavior. (Flag for Architect to confirm desired outbound posture — see Open questions OQ-MM-2.)
- **Mid-thread mute** → older emails already linked stay in history (FR-9) but stop contributing to the list once muted; new inbound stops linking (FR-2).

### Non-functional requirements

- **NFR-1 — No Pulse-list latency regression.** `getUnifiedTimelinePage` is the hot Pulse path (PULSE-PERF-001: it was tuned from 8.4s→0.3s with digit indexes). The muted-sender suppression MUST be added without reintroducing a Seq Scan or a per-row regex/CTE blow-up; verify with `EXPLAIN` against a prod-DB copy (methodology per PULSE-PERF-001), not mocked jest.
- **NFR-2 — Bounded per-email overhead.** The mute check on the inbound path must reuse the already-cached settings (`mailAgentService.getActiveState` caches settings ~60s per company) rather than re-reading `mail_agent_settings` on every email.
- **NFR-3 — Data-safe.** No destructive migration on historical email data; suppression is reversible and query-time (FR-9).
- **NFR-4 — Consistency between the two seams.** The inbound-link suppression (JS/DSL) and the list suppression (SQL) MUST agree on "who is muted" for a given company, so a sender never links-but-hides or hides-but-links inconsistently.

### Constraints & dependencies (for the Architect — DO NOT solve here)

- **C-1 (the core tension — flagged as a dependency).** Exclusion rules are evaluated in **JS** (`mailAgentRules` DSL), but the Pulse surfacing is **SQL** (`getUnifiedTimelinePage`). Suppressing the email contribution in SQL based on a JS-DSL requires a **derived, queryable "muted-sender" representation** (e.g. a materialized/derived set of muted email addresses or domains per company kept in sync from `exclusion_rules`, or a per-email `muted` marker stamped at link time on the email/link row). Which representation, how it stays in sync with `exclusion_rules` edits (FR-6 reversibility), and whether it needs migration **156** (next available; latest in repo = **155**) is an **Architect decision** — do not solve in requirements. This is the single biggest design risk; call it out first.
- **C-2 — Reuse `matchEmail`, don't fork mute logic.** The mute decision MUST be the exact `excluded` verdict from `mailAgentRules.matchEmail` (including negation/regex/quotes), so behavior can never diverge from what the operator sees the exclusion list doing for tasks.
- **C-3 — Migration numbering.** IF a derived-set/marker needs schema, next migration = **156** (with matching `rollback_156_*.sql`); latest present = **155**.
- **C-4 — Gate on Mail Secretary being connected.** Muting semantics only apply when the `mail-secretary` marketplace app is connected/enabled for the company (the exclusion list only exists then). When not connected, behavior is exactly today's (email links & surfaces normally).

### Involved modules (per architecture.md)

- **`backend/src/services/email/emailTimelineService.js`** — `linkInboundMessage` gains a `muted_sender` early return (FR-2/FR-3).
- **`backend/src/services/mailAgentService.js`** + **`backend/src/services/mailAgentRules.js`** — source of the mute verdict (`safeParseRules` + `matchEmail`); possibly the place that maintains the derived muted-sender set (C-1).
- **`backend/src/db/timelinesQueries.js`** — `getUnifiedTimelinePage` email-contribution suppression (FR-4/FR-5) + the mark-unread helpers must not flip unread for muted inbound.
- **`backend/src/db/mailAgentQueries.js`** / **`mail_agent_settings`** (mig 152) — settings/`exclusion_rules` source; any derived-set persistence.
- **`backend/db/migrations/156_*.sql`** — only if C-1's representation needs schema.

### Integrations affected

- **Email providers (Gmail Pub/Sub push / IMAP via the MailProvider seam)** — the inbound path that feeds `linkInboundMessage`; behavior narrows (muted senders skip linking) but the provider contract is unchanged.
- **Twilio / telephony (calls & SMS)** — **explicitly UNAFFECTED**; this feature must leave the call and SMS contributions to the Pulse list untouched (the whole point of "channel-specific").
- **Zenbooker / Front / Stripe / VAPI** — untouched.

### Protected parts (MUST NOT break)

- **The `linkInboundMessage` contract & its existing skip branches** (`no_message`/`outbound`/`draft_or_sent`/`no_contact`) and its "never break the pipeline" posture — the mute return is additive and must not throw (FR-10).
- **MAIL-AGENT-001 exclusion semantics** — the DSL, `matchEmail`, and today's `skipped_excluded` task-gating behavior stay intact; mute reuses them, never redefines them.
- **CALL and SMS contributions to `getUnifiedTimelinePage`** — `latest_call`, the `sms` lateral, `open_task`, `is_action_required`, `tl.has_unread`, the orphan-shadow dedup, and pagination correctness (page stays ≤ limit; PULSE-PERF-001 indexes) MUST be preserved exactly.
- **EMAIL-OUTBOUND-001 / EMAIL-LEAD-ORIGIN-001** surfacing for **non-muted** senders — unchanged.
- **Tenant isolation** — the muted-sender set and all suppression stay `company_id`-scoped (no cross-tenant leak).
- **Historical email data** — no deletion/mutation (FR-9); reversibility preserved (FR-6).

### Verification posture

Verify against a **real prod-DB copy**, not mocked jest (LIST-PAGINATION-001 / PULSE-PERF-001 lessons): (a) mute relyhome → confirm timeline 2915 disappears from `getUnifiedTimelinePage` and reappears on un-mute; (b) for a phone+email contact, confirm a new **call/SMS** still surfaces & bumps while a new **email** does not; (c) `EXPLAIN` the modified list query for no Seq-Scan/regex regression; (d) redelivery of a muted email creates no contact and no unread.

### Open questions (for Architect / SpecWriter)

- **OQ-MM-1 — Derived muted-sender representation (C-1).** Materialized set synced from `exclusion_rules`, vs. a `muted` marker stamped on the email/link row at link time, vs. an inline company-scoped address/domain lookup in the SQL. Picks the sync strategy for reversibility (FR-6) and the latency budget (NFR-1). **DECISION OWNER: Architect.**
- **OQ-MM-2 — Outbound-to-muted-sender posture.** Does an operator's outbound email to a muted address surface the timeline (today's EMAIL-OUTBOUND-001) or stay hidden? Default assumption: leave outbound behavior as-is (mute governs the INBOUND email signal only). **Confirm with Product/Architect.**
- **OQ-MM-3 — Snooze/refresh latency on rule edits.** Acceptable staleness between editing `exclusion_rules` and the list reflecting it, given the ~60s settings cache (NFR-2). Assumption: ≤ ~60s is fine (matches task-gating today). **Confirm with Product.**
- **No lead-by-contact_id lookup exists.** Leads are looked up ONLY by phone digits: frontend `useLeadByPhone` / `useLeadsByPhones` (enabled only when a phone is present), backend `leadsService.getLeadByPhone` / `getLeadsByPhones`, routes `GET /api/leads/by-phone/:phone` + `POST /api/leads/by-phones`. So a phoneless contact card **cannot tell whether a lead already exists** for it → it would wrongly offer "create lead" and risk duplicate leads. That is the reason B2 (lead-by-contact_id lookup) is in scope, not optional.

### Description

Make **email-only Pulse timelines** (a contact exists — or is resolvable — but has **no phone**) first-class in two parts.

**PART A — show the contact card for phoneless timelines.** Ungate the Pulse detail card so an email-only timeline shows the same Lead / Contact / "create lead" tri-state a phone timeline shows, driven by contact/timeline identity rather than by a phone. The contact panel and the lead-detail panel must render without a phone and must hide/disable phone-only affordances (the `tel:` link, `ClickToCallButton`, `OpenTimelineButton`, the SMS composer) instead of emitting `tel:`/dialing with an empty string. Email affordances (the `mailto:` link, the email composer) stay.

**PART B — let a lead be born from an email, phone OPTIONAL.** From an email-only contact card, if **no** lead is linked, offer **"create lead from email"**: a lead created with **email + name**, phone **optional/blank**, `contact_id` carried as the origin. The write path (`POST /api/leads`) must accept an **email/contact_id origin** when phone is absent (today it hard-requires phone ≥ 5 chars and its contact-dedup resolves by phone). Because leads can't currently be looked up without a phone, add a **lead-by-contact_id lookup** so the card can detect an already-linked lead and show it (LeadDetailPanel) instead of re-offering the wizard — **preventing duplicate leads**. A lead created email-origin then appears on the **Leads page** (it lists leads independently of phone) and on the **contact** (via `leads.contact_id`), and its Pulse-sidebar signal already surfaces through the email thread.

Phone-origin leads and phone timelines are **unchanged** — this is purely additive: the phone stays optional (nullable) and every existing phone path keeps working.

### User scenarios

1. **Open an email-only timeline → see the contact card.** A dispatcher opens a Pulse conversation that is an email thread whose contact has no phone. Today: no card renders. Now: the detail card appears, showing the contact's name and email (identity), with phone-only actions (call, SMS, dial-timeline) absent — not broken `tel:` links. The email thread and the email composer remain.
2. **The card shows an existing lead if one is linked by contact_id.** The email-only contact already has a lead (created earlier, or email-origin). The card detects it via the new lead-by-contact_id lookup and renders **LeadDetailPanel** (status, actions), exactly as a phone contact with a lead would — it does NOT offer "create lead" again.
3. **No lead yet → offer "create lead from email."** The email-only contact has no linked lead. The card shows the "create lead" affordance (the wizard's email-origin mode), pre-filled from the contact (name + email), phone field blank/optional.
4. **Create a lead from an email with email + name, phone optional.** The dispatcher fills name (email pre-filled), leaves phone blank, and creates. `POST /api/leads` accepts the email/contact_id origin with no phone, stores a lead with `phone` NULL, `email` set, `contact_id` set. No validation error, no fabricated phone.
5. **The phoneless contact panel does not crash and hides/disables phone-only actions.** Rendering `PulseContactPanel` (and `LeadDetailPanel`) for a contact with `phone_e164` NULL does not throw and does not emit `tel:`/`ClickToCall`/`OpenTimeline` with an empty phone; the primary-phone row is omitted (like the already-guarded secondary-phone row); the SMS composer is hidden/disabled; the email row and composer render normally.
6. **A lead created email-origin appears on the Leads page and on the contact.** After creation, the new lead shows on the Leads list (which lists leads independently of phone) and is associated to the contact via `leads.contact_id`; opening the same Pulse timeline now shows LeadDetailPanel (scenario 2). The Pulse-sidebar row for the conversation continues to surface via its **email** signal (no phone signal is expected).

### Functional requirements

- **FR-A1 (ungate the card).** Ungate the Pulse detail-card tri-state so it renders on **identity** (`!isAnonTimeline && (p.contactId || p.timelineId)`) rather than requiring `p.phone`. For an email-only timeline the same branch resolves to LeadDetailPanel (if a lead is linked — see FR-B2) → PulseContactPanel (contact, no lead) → "create lead from email" (no contact-lead). Anonymous timelines stay excluded.
- **FR-A2 (phoneless-panel robustness).** `PulseContactPanel` and `LeadDetailPanel` must render with `phone_e164` NULL/empty without crashing and **must not emit phone-only affordances with an empty value**: the primary-phone row (`tel:` link + `ClickToCallButton` + `OpenTimelineButton`) is omitted when there is no primary phone (mirroring the existing secondary-phone guard); the SMS composer (`SmsForm`) is hidden or disabled when there is no phone target. Email affordances (`mailto:` + email composer, which already resolves the target by contact id) remain. No `tel:`/dial with `''`.
- **FR-B1 (email/contact_id-origin create).** `POST /api/leads` accepts a lead-create with **phone absent** when an **email and/or `selected_contact_id`** origin is present: replace the unconditional "Phone is required (min 5 chars)" rule with "**phone OR email OR contact_id** must be present" (name still required per existing rules), and the contact-resolution step must resolve/attach by **email or contact_id** when phone is absent (it takes phone as mandatory today). The stored lead has `phone` NULL (or blank), `email` set, `contact_id` set. Existing phone-origin creates are unchanged.
- **FR-B2 (lead-by-contact_id lookup).** Add a **lead-by-contact_id** lookup — backend (`leadsService` function + a `GET /api/leads/by-contact/:contactId` route, permission-gated like `by-phone`) and a frontend hook — so the Pulse card can detect an already-linked lead for a phoneless contact and render LeadDetailPanel instead of re-offering the wizard. This lookup drives duplicate-prevention (a lead exists → do not offer "create"). It should mirror the phone-lookup's "actionable/open lead" semantics (the phone lookups already filter out leads whose contact has a job) so the same "is there an open lead" question is answered consistently for email-origin contacts.
- **FR-B3 (wizard phone-optional).** The Pulse "New Lead" creation surface supports an **email-origin mode**: phone becomes **optional** (no mandatory `phone` prop, no required phone field, phone omitted from the payload and from the ZB customer payload when blank); it accepts a `contactId` + email + name origin, pre-fills from the contact, and creates via FR-B1. The existing phone-origin invocation (with a phone) keeps working unchanged. (The manual `CreateLeadDialog` — which already has an Email field and defaults `Status: 'Submitted'` — is the reference for the email-origin field set; whether the same relaxation is applied there is an architect/scoping call, but the Pulse wizard is in scope.)
- **FR-B4 (OPTIONAL — architect's call): Pulse-sidebar lead-signal by contact_id.** An email-origin lead (phone NULL) adds no phone-matched signal to `getUnifiedTimelinePage`'s lead EXISTS subquery (which matches leads by phone digits only). The conversation **already** surfaces via its email signal, and the Leads page lists leads independently, so a contact_id-based lead signal in the sidebar query is **likely unnecessary for v1** and is **flagged for the Architect to decide**. If pursued, it touches the **HOT** `getUnifiedTimelinePage` query (PULSE-PERF-001) and must follow that discipline (EXPLAIN on a prod copy; any index expression = exact predicate copy) — do NOT casually modify it.

### Acceptance criteria

- **AC-1.** Opening an email-only timeline (contact exists, `phone_e164` NULL) renders the detail card (not a blank space); the card shows contact identity (name + email) with no `tel:`/call/SMS affordances present and no console error / thrown render.
- **AC-2.** For an email-only contact **with** a linked lead, the card renders LeadDetailPanel (resolved via lead-by-contact_id) and does **not** show the "create lead" affordance; for one **without** a lead, it shows "create lead from email".
- **AC-3.** `POST /api/leads` with a body carrying email + name + `selected_contact_id` and **no phone** returns success and stores a lead with `phone` NULL, `email` set, `contact_id` set (verified in DB). The same request with none of phone/email/contact_id still fails validation.
- **AC-4.** Creating a lead from the Pulse email-origin wizard with a blank phone does not send a phone in the create payload or the ZB customer payload and does not fabricate one; the created lead appears on the **Leads page** and is linked to the contact (`leads.contact_id`).
- **AC-5.** `GET /api/leads/by-contact/:contactId` returns the linked (open) lead for a contact or an empty result when none, company-scoped, permission-gated; the frontend hook drives the card's lead-vs-create decision.
- **AC-6.** Regression: a phone timeline / phone-origin lead behaves exactly as before (card renders, phone actions present, `useLeadByPhone` path intact, `POST /api/leads` with a phone unchanged); no duplicate lead is created for an email-only contact that already has one.
- **AC-7.** Back-compat + tenancy: `leads.phone` stays nullable; all new reads/writes (by-contact lookup, email-origin create) are scoped by `company_id`; no cross-tenant lead read or attach.

### Constraints / non-functional

- **Company scoping is mandatory** on every new leg — the lead-by-contact_id lookup, the email/contact_id-origin resolution, and the create — all filtered by the request's `company_id` (ONBOARD-FIX-001 / ZB-ISO-001 precedents). No cross-tenant lead read, attach, or create.
- **Do NOT casually touch the hot `getUnifiedTimelinePage`** (PULSE-PERF-001). FR-B4 (sidebar lead-signal by contact_id) is optional and the Architect's call; if pursued, follow PULSE-PERF-001 discipline (EXPLAIN on a prod copy; index expression = exact predicate copy). The conversation already surfaces via its email signal, so v1 need not modify the list query.
- **`leads.phone` stays nullable** — no schema change for storage (mig 004 already NULLABLE; mig 023 `contact_id` + `idx_leads_contact_id` present). A migration is expected **only** if the Architect adds a supporting index for the by-contact lookup (there already is `idx_leads_contact_id`, so likely none). Re-verify the current max migration number immediately before creating any (parallel branches); any backfill idempotent + logs affected rows + rollback file; backend is CommonJS.
- **No duplicate-lead creation.** The card MUST check for an existing lead **by contact_id** (FR-B2) before offering the wizard; "create lead from email" is offered only when no (open) lead is linked. The email-origin create path must not create a second lead when one already exists for the contact.
- **Back-compat: phone-origin leads unchanged.** The phone create path, `useLeadByPhone`/`by-phone`/`by-phones`, the existing wizard invocation with a phone, and phone timelines all keep working byte-for-byte; the email-origin behavior is strictly additive (relax "phone required" to "phone OR email OR contact_id", don't remove the phone path).
- **Phoneless robustness, not phone-faking.** Do not synthesize a placeholder phone to satisfy old code paths; omit phone-only UI and omit phone from payloads instead. Empty-string phones must never reach `tel:`, `ClickToCallButton`, `OpenTimelineButton`, or the ZB customer payload.
- **Contact-resolution reuse.** The email/contact_id-origin resolution should reuse the existing contact-dedup/attach primitives (extended to resolve by email or contact_id when phone is absent) rather than a parallel ad-hoc path, keeping the `selected_contact_id` / `contact_update_mode` create semantics intact.
- **Verify against a real DB, not just mocked jest** (LIST-PAGINATION-001 / created_by-FK lessons — jest mocks the DB, so a phoneless-insert or by-contact query bug hides): run the real by-contact lookup and the phoneless create against a prod-DB copy before deploy.
- Deploy to prod only with explicit owner consent (standing rule).

### Involved modules

- **Frontend:** `frontend/src/pages/PulsePage.tsx` (ungate the tri-state at ~line 361; email-origin wizard branch); `frontend/src/hooks/usePulsePage.ts` (drive `lead` for phoneless via lead-by-contact_id instead of `useLeadByPhone`-only; `phone` may be `''`); `frontend/src/components/contacts/PulseContactPanel.tsx` (null-guard the primary-phone row — `tel:` + `ClickToCallButton` + `OpenTimelineButton`); `frontend/src/components/leads/LeadDetailPanel.tsx` (phoneless robustness if it assumes a phone); `frontend/src/components/conversations/CreateLeadJobWizard.tsx` (phone optional / email-origin) with `CreateLeadDialog.tsx` as the email-field reference; a new lead-by-contact_id hook (alongside `useLeadByPhone.ts`); the leads API client; and the SMS composer gating on the Pulse page (hide/disable when no phone).
- **Backend:** `backend/src/routes/leads.js` — `POST /` (validation ~line 202 "Phone is required"; email/contact_id-origin resolution) + a new `GET /api/leads/by-contact/:contactId` route (permission-gated like `by-phone`); `backend/src/services/leadsService.js` — new `getLeadByContact` (mirroring `getLeadByPhone`'s open-lead filter); `backend/src/services/contactDedupeService.js` (`resolveContact` — allow email/contact_id origin when phone absent).
- **Tests:** backend jest for by-contact lookup + phoneless email-origin create (validation branches, company scoping, no-duplicate) **plus** a real-query verification vs a prod-DB copy (documented in the PR); frontend render checks for the phoneless card/panel.

### Integrations

- **Google / Gmail** — the email-only timeline/contact originates from the existing email ingest seam (EMAIL-TIMELINE-001); no Gmail API-surface change. **Zenbooker** — the with-job leg of lead creation must OMIT phone from the ZB customer payload when blank (do not send an empty phone); existing phone-carrying ZB creates unchanged; ZB job creation still needs address.state where applicable (existing behavior). **Twilio / Front / Stripe** — untouched.

### Protected parts (must not break)

- **`getUnifiedTimelinePage` / `email_by_contact` CTE** (PULSE-PERF-001, LIST-PAGINATION-001, EMAIL-OUTBOUND-001) — do not change its shape/semantics; FR-B4 (any sidebar lead-signal by contact_id) is optional and, if done, must follow PULSE-PERF-001 discipline.
- **Phone lead path:** `useLeadByPhone` / `useLeadsByPhones`, `leadsService.getLeadByPhone` / `getLeadsByPhones`, `GET /api/leads/by-phone/:phone` + `POST /api/leads/by-phones`, and the wizard's existing phone invocation — all unchanged; the by-contact lookup is added alongside.
- **`leads.phone` nullable invariant + `leads.contact_id` / `idx_leads_contact_id`** (migs 004, 023) — relied on for storage; no destructive schema change.
- **`POST /api/leads` phone-origin contract** (existing required-field rules for name; `selected_contact_id` / `contact_update_mode` resolution; the async contact→lead cascade and ZB sync) — kept firing; only the phone-mandatory rule is relaxed to phone-OR-email-OR-contact_id.
- **Anonymous-timeline handling** — anon timelines (`isAnonTimeline`) stay excluded from the detail card; ungating keys on contact/timeline identity, not on removing the anon guard.
- **LEADS-NEW-BADGE-001** — the new-leads nav badge counts by status/`lead_lost`, independent of phone; an email-origin lead with a "new" status must be counted the same way (do not regress the badge's status/SSE logic).
- Tenancy guarantees (ONBOARD-FIX-001 / ZB-ISO-001): all new reads/writes scoped by `company_id`.

### Dependencies

- **LEADS-NEW-BADGE-001** — the Leads nav badge / new-count must treat an email-origin lead the same as a phone-origin one (status-based, phone-independent).
- **CONTACT-EMAIL-MERGE-001** — supplies/normalizes the email-only contact (`contact_emails`, `findEmailContact`) that this feature shows a card for and creates a lead from; the email-origin contact this feature resolves against is the one merge produces.
- **EMAIL-TIMELINE-001** (and EMAIL-OUTBOUND-001 / LIST-PAGINATION-001) — provide the email-only timeline and its Pulse-list surfacing (the email signal) that this feature adds a card + lead to.
- **mig 023** (`leads.contact_id` + `idx_leads_contact_id`) — the storage + index the by-contact lookup and email-origin `contact_id` linkage rely on (already present; no new migration expected for storage).

### Out of scope

- Any change to the unified-list query shape / Pulse timeline-detail projection beyond the optional FR-B4 (which is deferred to the Architect and, if taken, is index-only per PULSE-PERF-001).
- A schema/storage migration for phoneless leads (already supported) — a migration only if the Architect adds a supporting index.
- Reworking the manual `CreateLeadDialog` to be phone-optional (the in-scope creation surface is the Pulse email-origin wizard; extending the manual dialog is a separate scoping call).
- Making the browser softphone / SMS work for a phoneless contact (there is no phone target — the affordances are hidden/disabled, not re-engineered); mobile-softphone rules unchanged.
- Auto-creating a lead from an email without a dispatcher action (creation stays explicit via "create lead from email").

## VAPI-SLOT-ENGINE-001: the voice agent (Sara) offers engine-ranked time slots on the call, and the caller's pick becomes a schedule-blocking hold on the lead

**Status:** Requirements · **Priority:** P1 · **Date:** 2026-07-04 · **Owner:** Voice / Schedule / Leads
**Type:** feature — backend (new VAPI tool → `slotEngineService` directly, gated + safe-fail; `createLead` persists the chosen structured slot to `lead_date_time`/`lead_end_date_time`; the engine's occupancy snapshot includes open held leads) + repo config (`voice-agent/assistants/lead-qualifier-v2.json`: new slot tool-def + scheduling-prompt rewrite). **No frontend change, no migration, no new hold entity, no schedule-render change.** **Binding owner decisions (interview done — stated explicitly, no further questions):** **D1** — offer **2–3 ranked** slots; the caller's chosen slot is saved on the created **LEAD** as a **schedule-blocking hold** (the lead shows in the Schedule at that time and occupies it), **NOT** an auto-created Zenbooker job; a dispatcher **CONFIRMS** (convert lead→job, which carries the slot) or **CANCELS/LOSES** the lead (which frees the slot). **D2** — if **none** of the offered slots suit the caller, the agent goes **deeper** (the tool supports a "give me more / different" mode: exclude already-offered slots and/or extend the date window). **D3** — the location for the slot calc is the **validated address (lat/lng)** if collected during the call, else the **zip** (geocoded to a centroid); if the engine is unavailable **or** the `smart-slot-engine` marketplace app is not connected, **fall back gracefully** to the current behavior (generic windows / callback) and **never crash the call**.

### Duplication check (result)

Not a duplicate — it upgrades one step of an existing, shipped flow and closes a discard. Adjacent features, none of which cover engine-ranked concrete windows offered live + persisted as a hold:

- **LQV2 (Lead Qualifier v2)** already has the `checkAvailability` tool, but it calls `scheduleService.getAvailableSlots(DEFAULT_COMPANY_ID, …)` (`backend/src/routes/vapi-tools.js:126`) — the generic "morning/next-window" path from `dispatch_settings` + booked items, **not** the location-aware ranking engine. LQV2's `createLead` **discards** the caller's pick: `preferredSlot` is only rendered into a text line (`Slot: ${preferredSlot || 'pending callback'}`, `buildCallSummary`, `vapi-tools.js:139/146/170`) in the Comments summary — **no** `lead_date_time`/`lead_end_date_time` is ever set, so the chosen slot never becomes a schedule hold. This feature swaps the engine in and persists the pick.
- **SLOT-ENGINE-001** built the ranking engine (`slot-engine/` service + `slotEngineService.getRecommendations` + the `POST /api/schedule/slot-recommendations` proxy + the `smart-slot-engine` marketplace app, mig 126) — but it is consumed only by the dispatcher UI (`CustomTimeModal` cards), behind auth + `schedule.dispatch`. It has **never** been reachable from the VAPI (server-to-server, no session) call path.
- **Leads-in-Schedule already exists.** Leads carry `lead_date_time` + `lead_end_date_time` (mig 004) and the Schedule grid already UNION-renders leads whose status is not terminal — so setting those two columns makes a lead show as a hold with **no** schedule-render change. This feature only needs to *write* those columns from the VAPI path and add held leads to the *engine's* occupancy (the generic path already subtracts leads).

### Description

Make the VAPI voice agent (**Sara / Lead-Qualifier-v2**) offer the caller **2–3 concrete, engine-ranked arrival windows** during the call — computed by the existing SLOT-ENGINE-001 recommendation engine from the caller's location — instead of the current generic "we have something in the morning" answer. When the caller **picks** a window, the created **lead** is stamped with that structured slot (`lead_date_time` / `lead_end_date_time`), which makes the lead appear on the **Schedule** at that time as a **HOLD that blocks the slot** (leads already render on the grid; open held leads are also added to the engine's occupancy so the same slot is not re-offered to the next caller). The hold persists until a **dispatcher** either **confirms** it (converts the lead → job, which carries the slot into the job's start/end) or **cancels/loses** the lead — both of which drop the lead out of the Schedule and the engine occupancy via the **existing** terminal-status filter, freeing the slot with **no teardown code**.

Concretely: add a **new VAPI tool** (e.g. `recommendSlots` / `getAvailableSlots`) in `backend/src/routes/vapi-tools.js` that calls `slotEngineService.getRecommendations(DEFAULT_COMPANY_ID, { new_job: { … } })` **directly** (the auth'd proxy route cannot be reused), gated on `marketplaceService.isAppConnected(DEFAULT_COMPANY_ID, 'smart-slot-engine')` exactly like the proxy, with the engine's own safe-failure (`recommendations: [], engine_status: 'unavailable'`) mapped to a graceful fallback so the call never breaks. The tool supports a **"deeper"** mode (exclude already-offered slots and/or extend the window) for "none of these work." The existing `createLead` tool is changed to **persist** the caller's chosen structured slot into `lead_date_time`/`lead_end_date_time` (instead of only a Comments label). The **repo** assistant JSON (`voice-agent/assistants/lead-qualifier-v2.json`) gains the tool definition and a rewritten scheduling-prompt section (offer top 2–3, handle "none suit → deeper," pass the chosen structured slot into `createLead`). Pushing the **live** assistant (PATCH `api.vapi.ai`, assistant `30e85a87`) is a **separate, owner-consent-gated prod step**, like a deploy — this pipeline updates only the repo JSON.

### User scenarios

1. **Caller gives a zip/address → agent offers 2–3 concrete ranked windows.** A caller describes an appliance problem and gives their service address (or just a zip). After qualification, the agent calls the new slot tool; the engine returns ranked windows for that location; the agent reads back the **top 2–3** as concrete windows (e.g. *"Tuesday between 10am and 1pm, or Wednesday 1 to 4"*) — not a vague "morning."
2. **Caller picks a window → lead created with the slot as a schedule-blocking hold.** The caller chooses one window. The agent calls `createLead` carrying the **structured** chosen slot; the lead is stored with `lead_date_time`/`lead_end_date_time` set (plus the usual name/problem/address/source). The lead now appears on the **Schedule** at that time as a hold and occupies the slot.
3. **Caller rejects all offered windows → agent goes deeper.** None of the 2–3 suit the caller ("nothing that week"). The agent re-invokes the slot tool in **deeper** mode — excluding the already-offered slots and/or extending the date window — and offers a fresh 2–3. This can repeat until the caller picks one or the flow ends with a callback.
4. **Engine down / app not connected → graceful fallback, call continues.** The `smart-slot-engine` app is not connected, or the engine returns its safe-failure (`engine_status:'unavailable'` / empty). The tool returns a fallback signal; the agent falls back to the current behavior (generic windows via the existing availability path, or offer a callback) and completes the call and the lead normally. The call **never** crashes on an engine error.
5. **Dispatcher confirms the hold → job takes the slot, hold clears.** A dispatcher reviews the held lead and **converts** it to a job. The slot flows into the job's `start_date`/`end_date` (existing convert behavior); the (now `converted`) lead drops out of the Schedule + engine occupancy via the terminal-status filter, and the job occupies that time — the hold is seamlessly replaced by the booking.
6. **Dispatcher cancels/loses the lead → slot frees.** A dispatcher marks the held lead **lost** (or cancels it). The lead drops out of the Schedule + engine occupancy via the same terminal-status filter, freeing the slot for other callers/jobs. No explicit hold-teardown runs.
7. **Two callers, same window.** Caller A holds Tuesday 10–1. Caller B calls shortly after; because the open held lead is now in the engine's occupancy snapshot, that Tuesday 10–1 window is **not** re-offered to Caller B (or is de-prioritized), preventing a double-hold on the same slot.

### Functional requirements

- **FR-1 (new VAPI slot tool → engine, gated, safe-fail).** Add a new tool handler in `backend/src/routes/vapi-tools.js` (e.g. `recommendSlots`) that calls **`slotEngineService.getRecommendations(DEFAULT_COMPANY_ID, { new_job: { … } })` directly** (NOT the `POST /api/schedule/slot-recommendations` proxy — that needs `authenticate` + `schedule.dispatch`). It is **gated** on `marketplaceService.isAppConnected(DEFAULT_COMPANY_ID, marketplaceService.SMART_SLOT_ENGINE_APP_KEY)` (the app key resolves to `smart-slot-engine`; same gate the proxy applies at `schedule.js:203`); when the app is not connected, or the engine returns its safe-failure shape (`{ recommendations: [], summary: null, engine_status: 'unavailable', coverage }`), the tool returns a **fallback** result the assistant can act on (e.g. `{ slots: [], fallback: true }` or the generic-window slots) rather than an error — the call must never break. On success the engine returns `engine_status: 'ok'` with `recommendations`. The tool offers at most **2–3** slots (respect the engine's own `recommendations_shown`/`settings.horizon_days` and cap to 3), each carrying the fields the assistant needs to (a) speak the window and (b) pass a structured slot back into `createLead`.
- **FR-2 (location = validated address else zip centroid).** The tool builds `new_job` from the **validated address (lat/lng)** when collected during the call, else from the **zip** (the engine geocodes an address / accepts lat/lng and can fall to a zip centroid). It sets a sane `job_type` + `duration_minutes` (reuse the LQV2 appointment-duration constant / engine defaults) and an `earliest_allowed_date`/`latest_allowed_date` window. `exclude_job_id` is N/A (there is no existing job for a prospective caller).
- **FR-3 ("deeper" / more-slots mode).** The tool accepts a **"give me more / different"** mode so that, when the caller rejects the offered set, it returns a fresh 2–3 by **excluding already-offered slots** (the assistant passes back what was already offered — e.g. offered date+window keys — to be filtered out) **and/or extending the date window** (later `latest_allowed_date` / a later `earliest_allowed_date`). Repeatable within the call. The exact "exclude" contract (what the assistant echoes back and how the tool filters) is pinned by the Architect/Spec.
- **FR-4 (`createLead` persists the chosen structured slot as a hold).** The `createLead` handler (`vapi-tools.js`) must, when the caller has chosen a slot, **persist** the chosen structured slot into the lead's **`lead_date_time`** and **`lead_end_date_time`** columns (mig 004) — replacing today's behavior where `preferredSlot` is only rendered into the Comments summary text. The chosen slot is passed as **structured** data (start/end derived from the recommendation's `date` + window), not a free-text label. When the caller did **not** pick a concrete slot (callback / fallback), the columns stay NULL (today's Comments-label behavior may remain for context). Setting these columns is what makes the lead a schedule-blocking hold — **no** new hold entity, **no** schedule-render change.
- **FR-5 (engine occupancy includes open held leads).** The engine's occupancy/busy snapshot — `slotEngineService.buildScheduledJobs(companyId, startDate, endDate, tz, excludeJobId)` (today built from **jobs only**, via `jobsService.listJobs`, `slotEngineService.js:112`) — must **also** include **open leads that carry a `lead_date_time`** and are **not** in a terminal status (the **same** `status NOT IN ('converted','lost','spam')` filter the leads-in-Schedule UNION uses — `scheduleQueries.js:136`, **lowercase, verbatim**), mapped into the engine's `lat`/`lng`/window/`duration_minutes`/status shape (derive `duration_minutes` from `lead_date_time`→`lead_end_date_time`), so a caller's hold **blocks re-offering** that window to the next caller. (The generic `scheduleService.getAvailableSlots` path already subtracts leads+tasks — only the **engine** path needs this add.) Confirmed/lost leads fall out of this snapshot automatically via the status filter. Note a lead needs `latitude`/`longitude` (or a geocodable address) to enter the geo-occupancy — a hold with no coordinates cannot participate; the Architect decides whether to geocode-on-hold or accept that gap for v1.
- **FR-6 (repo assistant tool-def + scheduling-prompt rewrite).** In `voice-agent/assistants/lead-qualifier-v2.json`: add the new slot tool to `model.tools[]` in the **same shape** as the existing tools (`function: { name, description, parameters }`, `server: { url, secret }`), and **rewrite** the scheduling section of the system prompt so the agent (a) calls the new engine tool instead of the generic `checkAvailability` path, (b) offers the **top 2–3** concrete windows, (c) on "none suit," re-invokes the tool in **deeper** mode, (d) on fallback/engine-down, degrades to generic windows / callback, and (e) passes the **chosen structured slot** into `createLead`. This updates **only the repo JSON**; see the constraint on the live push.

### Acceptance criteria

- **AC-1.** With `smart-slot-engine` **connected**, a slot-tool call for a valid location returns **≤ 3** engine-ranked slots, each with enough structure to both speak the window and reconstruct a start/end for the lead; the assistant offers the top 2–3.
- **AC-2.** After the caller picks a slot and `createLead` runs, the created lead row has **`lead_date_time` and `lead_end_date_time` set** (verified in DB) to the chosen window, and the lead **appears on the Schedule** at that time (existing lead-render), occupying the slot. No fabricated/placeholder slot when the caller did not pick one (columns NULL).
- **AC-3.** A **deeper** call (caller rejected the first set) returns a fresh set that **excludes** the previously-offered slots and/or covers a **later** window; the same already-offered slot is not returned twice.
- **AC-4.** With `smart-slot-engine` **not connected** — or when the engine returns its safe-failure (`engine_status:'unavailable'` / empty) — the tool returns a **fallback** (never throws), the assistant degrades to generic windows / callback, and **the call completes** and a lead is still created (slot columns NULL). No unhandled error reaches the call.
- **AC-5.** With a held lead (carrying coordinates) occupying a window, a **second** slot-tool call for an overlapping location/time does **not** re-offer that same window (the open held lead is in the engine occupancy). Once the held lead is **converted** or **lost**, a subsequent call **can** offer that window again (it left the occupancy via the `NOT IN ('converted','lost','spam')` filter).
- **AC-6.** Dispatcher **converts** the held lead → the job carries the slot into `start_date`/`end_date` (existing convert), the lead leaves the Schedule/occupancy, the job occupies the time. Dispatcher **loses/cancels** → the slot frees. Neither requires any new hold-teardown code.
- **AC-7.** `voice-agent/assistants/lead-qualifier-v2.json` in the repo contains the new tool in `model.tools[]` (correct `function`/`server` shape) and a scheduling prompt that offers top 2–3 + deeper + fallback + structured-slot-into-`createLead`. The **live** assistant is unchanged by this pipeline (push is a separate owner-gated step).
- **AC-8.** Single-tenant + auth invariants hold: the new tool and the `createLead` slot write use `DEFAULT_COMPANY_ID` (seed …0001) like the other VAPI tools; the endpoint stays behind `x-vapi-secret` (fail-closed) and is **not** exposed via the auth'd proxy.

### Constraints / non-functional

- **No migration, no new hold entity, no schedule-render change.** `lead_date_time`/`lead_end_date_time` (mig 004) already exist and the Schedule grid already UNION-renders non-terminal leads; the hold is **just a lead with those columns set**. (If the Architect adds a supporting index for the leads-in-occupancy read, re-verify the current max migration number immediately before creating it — parallel branches; backfill idempotent + logs rows + rollback file; backend is CommonJS. None is expected — `lead_date_time` reads are date-windowed and small.)
- **Do NOT reuse the auth'd proxy.** `POST /api/schedule/slot-recommendations` requires `authenticate` + `requireCompanyAccess` + `schedule.dispatch`; VAPI is server-to-server with no session. The new tool calls `slotEngineService.getRecommendations` **directly** and re-implements the **same** `isAppConnected(…, 'smart-slot-engine')` gate the proxy applies. Do not weaken the proxy's auth to share it.
- **Company hardwired to the seed, like the other VAPI tools.** The new tool and the slot-persisting `createLead` use the existing `DEFAULT_COMPANY_ID` constant (seed UUID ending `0001`) — single-tenant at the vapi-tools layer, consistent with `checkServiceArea`/`validateAddress`/`checkAvailability`/`createLead`. Tenant context is the VAPI assistant assignment, not a session (do not add per-request company inference here).
- **Safe-failure never crashes the call.** Map the engine's `{ recommendations: [], engine_status: 'unavailable' }` (and the not-connected gate, and any thrown error) to a **fallback** tool result; the assistant degrades to generic windows / callback. Lead creation must never be blocked by the slot tool (LQV2 rule: lead creation never blocks call completion). Tool p95 target unchanged (< 2000ms); the engine call must respect a timeout and fall back on slowness.
- **The hold is a lead in a non-terminal status carrying `lead_date_time`; confirm/cancel free it via existing status filters.** Do not build hold lifecycle/teardown: a converted lead (via `convertLead`, which already carries `zb_job_payload.timeslot.start/end` → the job's `start_date`/`end_date`, `leadsService.js:757/631`) or a lost/cancelled lead leaves both the Schedule render and the engine occupancy through the **same** terminal-status filter. Mirror the **exact** leads-in-Schedule set **verbatim** — `status NOT IN ('converted','lost','spam')` (lowercase, `scheduleQueries.js:136`) — in the occupancy add; do **not** use the capitalized `('Lost','Converted')` set from the lead-by-phone/contact lookups (a different code path) or invent a different set, or a lead will render as a hold but not block re-offering (or vice-versa).
- **Persist a structured slot, not a text label.** The chosen slot must reach `lead_date_time`/`lead_end_date_time` as real timestamps derived from the recommendation's `date` + window (company-local), **not** a free-text "Slot: …" string. The Comments summary line may remain for human context, but it is **not** the source of the hold.
- **Engine output shape must be pinned before implementation.** The raw engine (`slot-engine/src/engine.js:184`) returns each recommendation as `{ rank, candidate_id, date, techId, techName, time_frame:{start,end}, feasible_arrival_interval:{start,end}, metrics, score, confidence, requires_dispatch_confirmation?, reason_codes, explanation }` (windows are company-local `HH:MM`); the load-bearing per-slot fields for a hold are **`date` + `time_frame.{start,end}`** (compose `lead_date_time`/`lead_end_date_time` from `date` + window in the company timezone). The `slotEngineService.getRecommendations` **wrapper** returns `{ recommendations, summary, engine_status:'ok'|'unavailable', coverage }` (`slotEngineService.js:150/228`) and may reshape each recommendation; the Architect/Spec must **pin the wrapper's exact per-slot output** by reading the service + the frontend `slotRecommendationsApi` / `CustomTimeModal` cards that consume it — the tool maps from that wrapper shape, not the raw engine directly.
- **Live VAPI push is a separate owner-gated prod step.** Editing the live assistant (`30e85a87`) via `PATCH api.vapi.ai` is a prod change requiring explicit owner consent per deploy (like any deploy). Follow the VAPI-edit discipline: `get` first (the live agent **drifts**), edit via REST PATCH (the CLI `update` panics), and re-inject `VAPI_TOOLS_SECRET` into every `model.tools[].server` on any model write. Keep `answerOnBridge="true"` on the Dial (unrelated but a known foot-gun). This pipeline changes **only** the repo JSON.
- **Verify against a real DB / real engine, not just mocked jest.** Jest mocks the DB (LIST-PAGINATION-001 / created_by-FK lessons — a slot-persist or occupancy-read bug hides): run the **real** `createLead` slot write and the **real** engine-with-held-leads occupancy against a prod-DB copy, and exercise the tool end-to-end against the real slot engine, before any deploy.
- Deploy to prod (and the live VAPI push) only with explicit owner consent (standing rule).

### Involved modules

- **Backend:** `backend/src/routes/vapi-tools.js` — new slot-tool handler (`recommendSlots`, gated + safe-fail + deeper mode) + dispatcher routing; `createLead` handler changed to persist the chosen structured slot to `lead_date_time`/`lead_end_date_time` (drop the discard-into-Comments-only behavior for the pick). `backend/src/services/slotEngineService.js` — reused via `getRecommendations` for a prospective caller (no existing job); **`buildScheduledJobs` extended** to include open non-terminal leads carrying `lead_date_time` in the occupancy snapshot (the only occupancy change). `backend/src/services/marketplaceService.js` — reused (`isAppConnected(…, 'smart-slot-engine')` gate). `backend/src/services/leadsService.js` — the create/convert path that stores `lead_date_time`/`lead_end_date_time` and (on convert) carries the slot into the job start/end (reused; `convertLead` already carries the slot). `backend/src/services/scheduleService.js` — unchanged (its `getAvailableSlots` stays the fallback path and already subtracts leads).
- **Occupancy/schedule read:** the leads-in-Schedule UNION (`backend/src/db/scheduleQueries.js`) is the **reference** for the exact non-terminal lead-status filter to mirror in the occupancy add — read it, don't guess.
- **Repo config:** `voice-agent/assistants/lead-qualifier-v2.json` — `model.tools[]` (add the slot tool, same `function`/`server` shape) + system-prompt scheduling section rewrite.
- **Tests:** backend jest for the slot tool (gated / safe-fail / deeper), the `createLead` slot-persist, and the occupancy-includes-held-leads read (validation + company scope) **plus** a real-DB-copy + real-engine verification documented in the PR.

### Integrations

- **VAPI** — the live assistant (`30e85a87`) gains the slot tool + scheduling prompt, but **only via the separate owner-gated `PATCH api.vapi.ai` step**; this pipeline touches only the repo JSON. **SLOT-ENGINE-001 / `smart-slot-engine`** — the recommendation engine + its marketplace-connected gate are the new dependency the tool calls (directly, not via the proxy). **Zenbooker** — untouched by the tool; only the **existing** convert path (`convertLead`) carries the slot into the ZB/job payload → `start_date`/`end_date` (existing behavior, and ZB job-create still needs a phone + `address.state` where applicable). **Google Maps Geocoding** — reused by the engine to turn an address/zip into coordinates (existing engine behavior; the LQV2 `validateAddress` already provides the validated address). **Twilio / Front / Stripe** — untouched.

### Protected parts (must not break)

- **VAPI tool auth + envelope + single-tenant contract** — `x-vapi-secret` vs `VAPI_TOOLS_SECRET` (fail-closed), the `message.toolCallList[].function {name, arguments-JSON}` → `{results:[{toolCallId, result-JSON}]}` envelope, and the hardwired `DEFAULT_COMPANY_ID` — the new tool follows all three exactly; do not add auth/session to `/api/vapi-tools` or expose the slot engine via the auth'd proxy.
- **Existing VAPI tools** (`checkServiceArea`, `validateAddress`, `checkAvailability`, `createLead`) — keep working; `checkAvailability` stays as the **fallback** availability path (its `scheduleService.getAvailableSlots` behavior unchanged); `createLead`'s existing fields/summary/retry/"never block the call" semantics are preserved — the **only** `createLead` change is adding the structured-slot write to `lead_date_time`/`lead_end_date_time`.
- **`slot-engine/` service + `slotEngineService.getRecommendations` I/O contract + the `POST /api/schedule/slot-recommendations` proxy + `CustomTimeModal`** — the engine's algorithm/output contract and the dispatcher UI path are untouched; the **only** service change is `buildScheduledJobs` adding held leads to occupancy (an occupancy input, not a contract/scoring change) — do not alter scoring, ranking, config, or the recommendation output fields.
- **`leads.lead_date_time` / `lead_end_date_time` (mig 004) + the leads-in-Schedule UNION render + its non-terminal status filter** — relied on for the hold; no schema change, no render change; mirror the existing status filter verbatim in the occupancy add.
- **`convertLead` slot-carry + terminal-status drop-out** — convert already carries the slot into the job and a `converted`/`lost` lead already leaves the Schedule; do not add teardown that could double-handle it.
- **Live VAPI assistant `30e85a87`** — not modified by this pipeline; any live change is the separate owner-gated PATCH with the `get`-first / re-inject-`VAPI_TOOLS_SECRET` / keep-`answerOnBridge` discipline.
- Tenancy/isolation posture — the tool operates only within `DEFAULT_COMPANY_ID`; no cross-tenant read/write is introduced.

### Dependencies

- **SLOT-ENGINE-001** — the recommendation engine (`slot-engine/` + `slotEngineService.getRecommendations` + the `smart-slot-engine` marketplace app, mig 126) the new tool calls directly; its wrapper output shape + safe-failure (`{ recommendations:[], summary:null, engine_status:'unavailable', coverage }`) must be pinned by the Architect/Spec. **Merged on master** (Phase 1–3); this feature's worktree branch already contains it.
- **LQV2 (Lead Qualifier v2 assistant)** — the assistant this feature extends (the scheduling tool + prompt, `createLead`, the `DEFAULT_COMPANY_ID` + `x-vapi-secret` conventions, the appointment-duration constant); the repo JSON is `voice-agent/assistants/lead-qualifier-v2.json`, the live agent is `30e85a87`.
- **`smart-slot-engine` marketplace app** — the connected-state gate (`isAppConnected`) that must be present for the tool to use the engine; not-connected ⇒ graceful fallback.
- **mig 004 (leads scheduling columns `lead_date_time` / `lead_end_date_time`)** — the storage the hold is written to (already present; no new migration expected).

### Out of scope

- Auto-creating a Zenbooker **job** from the call (D1: the call creates only a **held lead**; a dispatcher's convert makes the job).
- Any change to the Schedule render, a new "hold" entity/table, or a migration for holds (the hold is a lead with `lead_date_time` set).
- Changing the slot engine's scoring/ranking/config or its recommendation output contract (only its occupancy **input** gains held leads).
- The **live** VAPI push (separate owner-gated prod step) and any change to other VAPI tools beyond the `createLead` slot-write.
- Reworking the generic `scheduleService.getAvailableSlots` / `checkAvailability` path (it remains the untouched fallback) and the dispatcher-facing `CustomTimeModal` / proxy path.
- Multi-technician team holds, and any frontend change (this feature is backend + repo-config only).

---

## AGENT-SKILLS-001: Agent-agnostic CRM skill layer + existing-customer voice skills (P1–P3) + MCP surface

**Status:** Requirements · **Priority:** P1 · **Date:** 2026-07-04 · **Owner:** Voice / CRM / Platform
**Type:** feature — backend (a NEW provider-neutral CRM **skill/capability layer** holding all skill logic + server-side verification gating; the existing `/api/vapi-tools` refactored into a THIN adapter; a NEW MCP surface exposing the same skills; write-through to Zenbooker for reschedule/cancel; audit note on every write) + repo config (`voice-agent/assistants/lead-qualifier-v2.json` scheduling/routing prompt so Sara branches existing-vs-new). **No frontend change and no new data model are required for the skills themselves** (P1–P3 are a read/route layer + two guarded writes over existing services); the Architect confirms whether any supporting index/migration is needed (none is expected).
**Source of truth for the skills:** `voice-agent/assistants/lead-qualifier-v3-crm-roadmap.md` (carries FR-C1…FR-C8, the L0/L1/L2 verification model, `status_map`, the security rules, and the P1/P2/P3 phasing — all restated and superseded where the interview decided otherwise).

**Binding owner decisions (interview done — these OVERRIDE any conflicting roadmap assumption):**
- **D1 — Scope = ALL skills.** P1 (`identifyCaller` enhance, `getCustomerOverview`, `getJobStatus`, `getAppointments`) + P2 (`rescheduleAppointment`, `cancelAppointment` retention-gated) + P3 (`getJobHistory`, `getEstimateSummary`, `getInvoiceSummary`). Ship in phase order (P1 first — highest value, lowest risk), but all are in scope for this feature.
- **D2 — THE core architectural principle: the voice agent must be SWAPPABLE for any other agent, and everything keeps working — therefore ALL skill logic lives INSIDE the CRM application, not in the voice agent.** Concretely: a provider-neutral CRM **skill/capability layer** (services holding the logic + verification gating), exposed via TWO thin adapters built in this feature — (a) a provider-neutral REST surface, with the existing `/api/vapi-tools` refactored into a **thin adapter** that only translates VAPI's envelope to/from the skill layer; and (b) a **NEW MCP server** exposing the SAME skills, so any MCP-capable agent connects without re-implementing anything. VAPI/Sara is ONE consumer among several. **No business logic in the VAPI adapter or the MCP adapter — both call the same skill layer.**
- **D3 — Write skills write to the Albusto schedule AND push to Zenbooker** (ZB is still master for jobs), mirroring the existing "`scheduleService`→ZB push" pattern already used by `cancelJob` and `reassignItem`. **Every write records an audit note attributed to "AI Phone".**
- **D4 — Verification is enforced SERVER-SIDE in the skill layer, NEVER trusted to the LLM.** L0 (no match → new-lead flow), L1 (phone match → low-sensitivity reads: next appointment window, job-status phrase), L2 (confirmed name AND ZIP/address → writes + sensitive reads: history, estimate/invoice summaries). **No payment capture by voice, ever** (offer secure link or human). **Company isolation** (scope every query to the caller's company; the voice/MCP surface hardwires `DEFAULT_COMPANY_ID`) is a **P0 invariant** — any cross-customer / cross-company disclosure is a **P0 defect**.
- **D5 — Naming.** The internal system is now called **Albusto** (not "Blanc"). Code identifiers (`blanc_status`, `BLANC_STATUSES`, `--blanc-*`) stay as-is; prose/user-facing/spoken text uses "Albusto".

### Duplication check (result)

**Not a duplicate; it is a refactor + extension that unifies three existing pieces and adds one new surface.** Adjacent features:

- **LQV2 (`## LQV2`)** introduced `/api/vapi-tools` (`vapiSecretAuth`, `x-vapi-secret`/`VAPI_TOOLS_SECRET` fail-closed, hardwired `DEFAULT_COMPANY_ID`, the `toolCallList → results` envelope) and the live tools `checkServiceArea`/`validateAddress`/`checkAvailability`/`createLead`. This feature **refactors that endpoint into a thin adapter** and moves logic into the skill layer — it does NOT re-implement those tools' behavior, only relocates the seam.
- **VAPI-SLOT-ENGINE-001 (`## VAPI-SLOT-ENGINE-001`)** added `recommendSlots` (VAPI tool → `slotEngineService.getRecommendations` directly, gated on `isAppConnected(…, 'smart-slot-engine')`, safe-fail) and the `createLead` slot-persist. Its conventions (direct-service call, marketplace gate, graceful fallback, single-tenant hardwire, live-push-is-owner-gated) are the exact precedent this feature follows.
- **`identifyCaller` is specified in the v3 roadmap but is NOT yet implemented** in `backend/src/routes/vapi-tools.js` (current live handlers: `checkServiceArea`, `validateAddress`, `checkAvailability`, `recommendSlots`, `createLead`; the roadmap header's `live_tools` also omits it). So `identifyCaller` is **introduced** by this feature as a skill (built on `leadsService.getLeadByPhone`/`getLeadsByPhones` + a contacts/timeline phone match) — there is no duplicate handler to remove; the brief's "already exists" is imprecise. (Note: `leadsService.getLeadByPhone` today returns `null` when the matched contact already has a job — precisely the existing-customer case — so identity resolution for the skill must NOT reuse that "open-lead-only" filter verbatim; the Architect resolves identity across leads **and** contacts/jobs. See Constraints.)
- **CRM-SALES-MCP (`## CRM-SALES-MCP Cross-stage Requirements`, Status: Implemented and audited)** already ships a **working, hand-rolled JSON-RPC MCP server** in the repo (`backend/src/routes/crmMcp.js` authenticated JSON-RPC at `/api/crm/mcp`; `backend/src/routes/crmMcpPublic.js` token-gated public HTTP + legacy SSE at `/mcp/crm`; `backend/src/cli/crmMcpStdio.js` stdio) built from a reusable stack: `crmMcpToolRegistry` (read/write tool defs, `requiresConfirmation`, `requiredPermission`), `crmMcpSchemaValidator` (runtime arg validation), `crmMcpToolExecutor` (`buildContext` → companyId from `req.companyFilter.company_id`, write-permission + confirmation gates, dispatch to services), `crmMcpResponse` (sanitized MCP responses + error→HTTP mapping), `crmMcpProtocolService` (JSON-RPC), `crmMcpPublicAuth` (bearer token + env-bound company context, writes disabled unless explicitly enabled). **The new MCP surface (AR-3) MUST reuse this established pattern (a parallel voice/CRM tool registry + executor over the SAME skill layer), NOT invent a second MCP framework.** This is a strong reuse target, not a duplicate: CRM-SALES-MCP exposes the *sales* CRM (accounts/deals/pipeline); AGENT-SKILLS exposes the *service* CRM skills (identify/status/appointments/reschedule/cancel/estimate/invoice).

### 1. Problem

~50% of inbound calls are **existing customers** — asking about a job's status, an appointment window, a reschedule or cancel, or "how much was my estimate / what's my balance." Today the voice agent (Sara / Lead-Qualifier-v2) has only the new-lead qualification flow, so it **mis-qualifies existing customers as new leads** (re-collecting appliance/ZIP/fee on someone who already has an open job) — wrong, slow, and erosive of trust. Separately, all of Sara's call logic that touches the CRM lives (or would live) in VAPI tool handlers, which **couples the CRM to one voice provider**: if Sara is swapped for another agent, the capabilities would have to be re-implemented.

### 2. Goals / Non-goals

**Goals**
- Recognize an existing caller and branch into a CRM-aware flow (status/appointments/reschedule/cancel/estimate/invoice) instead of the new-lead flow, with server-side verification gating.
- Put **all** skill logic in a **provider-neutral CRM skill layer** so the voice agent is swappable and any MCP-capable agent gets the same capabilities.
- Refactor `/api/vapi-tools` into a **thin adapter** (envelope translation only) over the skill layer, preserving its auth/envelope/single-tenant contract.
- Add a **new MCP surface** (reusing the `crmMcp*` pattern) exposing the same skills.
- Write skills reschedule/cancel **write Albusto + push Zenbooker** and **record an "AI Phone" audit note** every time.

**Non-goals (out of scope)**
- Taking a card / capturing payment by voice — **ever** (offer a secure link or a human).
- Creating estimates/invoices by voice; auto-creating a Zenbooker **job** by voice.
- Multi-company / multi-tenant routing at the voice/MCP layer (single-company: `DEFAULT_COMPANY_ID`).
- Warm transfer to a human with context (tracked separately); outbound calls (different assistant type).
- Any change to the slot engine's scoring/ranking, the dispatcher UI, or the generic `checkAvailability` fallback path.
- Reworking the CRM-SALES-MCP sales tools; this feature adds a **parallel** service-CRM tool set over the same MCP framework.

### 3. User stories

1. **Existing customer, phone matches (L1).** A known customer calls from a number on file; the agent silently identifies them, greets by name, and answers "where's my appointment / what's the status" from L1 reads — without new-lead qualification.
2. **Existing customer, masked/spoofed number.** The number doesn't match (lead-gen masking). The agent asks name + service ZIP/street, resolves the customer within ~2 questions, and (with confirmed name AND ZIP) reaches L2 for writes/sensitive reads.
3. **Truly new caller (L0).** No match → the agent runs the existing v2 new-lead flow (`createLead → Review`) unchanged.
4. **Reschedule (L2 write).** A verified customer moves their appointment; the agent offers 2–3 windows, confirms old→new, and the change writes to the Albusto schedule **and** pushes to Zenbooker, with an "AI Phone" audit note; it appears on the dispatcher schedule immediately.
5. **Cancel (L2 write, retention-gated).** A verified customer wants to cancel; the agent captures a reason, makes exactly **one** genuine save attempt, and only then cancels (Albusto + ZB), recording the reason as an "AI Phone" audit note.
6. **Estimate/invoice (L2 sensitive read).** A verified customer asks "how much was my estimate / what's my balance"; the agent speaks a **summary** (status, total, balance), offers to text a secure link, and never reads line items or takes a card.
7. **Swap the agent.** The voice provider is replaced (or an internal MCP-capable agent is added); because all logic is in the skill layer exposed over MCP, the new agent gets identify/status/appointments/reschedule/cancel/estimate/invoice with **no CRM code changes** — only a new thin adapter/connection.
8. **Error on any skill.** A CRM read/write errors internally; the skill returns a safe "let me have a teammate follow up" shape (never an internal error/stack/PII), the call continues, and nothing is disclosed.

### 4. Functional requirements

#### 4.1 Architecture requirements

- **AR-1 — Provider-neutral CRM skill layer (all logic + server-side verification).** Introduce a CRM **skill/capability layer** (one or more services, e.g. a `voiceSkills`/`agentSkills` service module) that holds **all** skill logic and the **server-side** verification gating (L0/L1/L2). Each skill is a plain async function `skill(companyId, args, context)` that (a) enforces its required verification level against a server-derived `verification`/`context` (NOT an LLM-asserted flag), (b) scopes every query to `companyId`, (c) calls the existing services (§Constraints), and (d) returns a **provider-neutral, speech-safe result object** (no raw PII dumps, no internal codes, no stack traces). The layer is the SINGLE source of truth; both adapters (AR-2, AR-3) call it. No skill trusts the caller/LLM for verification, company, or entity ownership.
- **AR-2 — `/api/vapi-tools` refactored to a THIN adapter (ZERO business logic).** Refactor `backend/src/routes/vapi-tools.js` so each tool handler only: parse the VAPI envelope (`message.toolCallList[].function {name, arguments-JSON}`), map arguments to the skill's inputs, call the corresponding **skill-layer** function with `DEFAULT_COMPANY_ID` + a server-built context, and map the skill's result back into `{results:[{toolCallId, result-JSON}]}`. **No CRM logic, no verification decision, no SQL, no service composition remains in the adapter.** The endpoint keeps its exact contract: `vapiSecretAuth` / `x-vapi-secret` vs `VAPI_TOOLS_SECRET` (fail-closed — 503 unconfigured, 401 mismatch), multi-tool `toolCallList` handling, hardwired `DEFAULT_COMPANY_ID` (`vapi-tools.js` line 27), mounted without `authenticate`/`requireCompanyAccess` (`src/server.js` ~line 219). Existing tools (`checkServiceArea`, `validateAddress`, `checkAvailability`, `recommendSlots`, `createLead`) are moved onto the skill layer without behavior change (their existing "never block the call" / retry / fallback semantics preserved).
- **AR-3 — NEW MCP server exposing the SAME skills (reuse the `crmMcp*` pattern).** Add an MCP surface for the service-CRM skills, **modeled on the existing, audited CRM-SALES-MCP stack** — a parallel tool **registry** (skill tool defs with `kind` read/write, `requiresConfirmation` on writes, per-tool required verification level), the **schema validator** (runtime arg validation), an **executor** that builds a company/verification context and dispatches to the **same skill-layer functions** (NOT to a copy of the logic), the **response** sanitizer (error→sanitized-MCP mapping), and the **protocol** service (JSON-RPC). Expose it over the same transport shapes the CRM MCP uses: an authenticated JSON-RPC route and a **token-gated public transport with env-bound company context** (`crmMcpPublicAuth`-style: bearer token, `*_ENABLED`/`*_WRITE_ENABLED` flags, **writes disabled unless explicitly enabled**), plus stdio if warranted. **No business logic in this adapter.** Company context comes from the env-bound/config context (never client payload), consistent with the CRM MCP's `req.companyFilter.company_id` rule. (Whether this is a new mount like `/api/agent-skills/mcp` + `/mcp/agent-skills`, or additional tools registered under the existing surface, is the Architect's call — but the framework and its tenant/auth/write/confirmation/sanitization contracts are reused, not reinvented.)
- **AR-4 — Write-through to Zenbooker for reschedule/cancel.** Reschedule and cancel write the Albusto schedule/job **and** push to Zenbooker (ZB remains master for jobs), mirroring the existing push pattern. **Cancel already pushes to ZB** (`jobsService.cancelJob` → `zenbookerClient.cancelJob(zenbooker_job_id)` with `forceSyncOnZbError` recovery, line 1225) — the cancel skill reuses it. **Reschedule is a GAP that must be closed:** `scheduleService.rescheduleItem` (lines 141–186) today writes only the Albusto DB + an internal `job_rescheduled` provider push and does **NOT** call Zenbooker, even though `zenbookerClient.rescheduleJob(id, data)` (POST `/jobs/{id}/reschedule`, line 372) exists. The Architect must wire the ZB reschedule push into the reschedule path (mirroring `cancelJob`'s pre-check + `forceSyncOnZbError` discipline, and the `reassignItem`→`zenbookerClient.assignProviders` best-effort pattern). ZB writes target the default company's ZB account (`getClient()` bound to `ZENBOOKER_DEFAULT_COMPANY_ID` = seed …0001, same as `DEFAULT_COMPANY_ID`; `getClientForCompany` returns null for non-default tenants — ZB-ISO-001).
- **AR-5 — Audit note on every write.** Every write skill (reschedule, cancel; and any note the flow records) writes an **audit note attributed to "AI Phone"** on the job, via `jobsService.addNote(jobId, text, attachments=[], author='AI Phone', createdBy='AI Phone')` (which also mirrors the note text to ZB when the job is linked). Additionally emit a domain event via `eventService.logEvent(companyId, 'job', jobId, <event>, {…}, actorType='system')` so the write is auditable in entity history. The cancel note MUST include the captured reason and record that a retention attempt was made.
- **AR-6 — Company isolation + verification enforced server-side (P0).** Every skill scopes all reads/writes to `companyId` (all reused services already accept `companyId`; pass the hardwired `DEFAULT_COMPANY_ID` for the voice/MCP surface). Verification (L0/L1/L2) is decided **in the skill layer** from server-derived signals (a real phone match; a server-confirmed name+ZIP/address), **never** from an LLM/caller-supplied "verified: true". Sensitive reads and all writes MUST re-check the required level server-side on each call. A cross-customer or cross-company disclosure/mutation is a **P0 defect**.

#### 4.2 Per-skill functional requirements (one FR per tool)

Each skill states: inputs → outputs, **required verification level**, the **CRM service(s) it reuses**, and its **guardrails** (from the roadmap). All outputs are provider-neutral and speech-safe; internal `blanc_status` is never returned raw (always mapped via `status_map`).

- **FR-S1 — `identifyCaller` (read, L0→resolves level).** *(roadmap FR-C1)*
  - **Inputs:** `phone?`, `name?`, `zip?`, `street?`. **Outputs:** `matchType ∈ new|existing|ambiguous`, `contactId?`, `customerName?`, `verificationLevel (L0|L1|L2)`, `ambiguousCount?`. Never a raw PII dump.
  - **Reuses:** `leadsService.getLeadByPhone` / `getLeadsByPhones`; contacts + timeline phone match (`contactsService`, timelines phone lookup) to resolve **existing customers with jobs** (do NOT rely on `getLeadByPhone` alone — it returns null once a job exists). Resolution order: (1) silent phone lookup from call metadata; (2) if no match/masked, ask name + ZIP/street and look up; (3) disambiguate multiple matches (e.g. by last appointment date / address).
  - **Verification produced:** phone-only match ⇒ **L1**; confirmed name AND (ZIP or street) ⇒ **L2**; no match ⇒ **L0** (new-lead flow). The level is computed and returned by the server; downstream skills re-verify.
  - **Guardrails:** masked number → ask name+ZIP rather than assume new; ambiguous → disambiguate before proceeding; identity lookup tolerant of masked/spoofed numbers and fuzzy name / normalized phone+ZIP.
- **FR-S2 — `getCustomerOverview` (read, L1).** *(FR-C2)* **In:** `contactId`. **Out:** `openJobsCount`, `nextAppointment` (window), `lastJobStatus` (phrase), `hasOpenEstimate`, `hasUnpaidInvoice` — **no amounts, no addresses.** **Reuses:** `jobsService.listJobs({contactId, onlyOpen})`, `scheduleService.getScheduleItems`. **Guardrails:** one-line snapshot to route the call; multiple open jobs → ask which appliance/service to scope.
- **FR-S3 — `getJobStatus` (read, L1).** *(FR-C3)* **In:** `contactId`, `jobId?`. **Out:** `jobId`, `serviceName`, `statusLabel` (mapped phrase), `statusStage`, `appointmentWindow`, `technicianEtaText`. **Reuses:** `jobsService.getJobById`/`listJobs`, `BLANC_STATUSES` (line 25) mapped to a caller phrase via `status_map`; optionally `getJobTransitions` to drive the next offer. **Guardrails:** never read internal `blanc_status` aloud; drive next action from stage (Scheduled→offer reschedule; On-the-way/Enroute→ETA "the tech will text before arriving"; Waiting for parts→set expectation; Done→offer review/new job).
- **FR-S4 — `getAppointments` (read, L1).** *(FR-C8)* **In:** `contactId`. **Out:** `appointments[] = {jobId, serviceName, date, window, statusLabel}`. **Reuses:** `scheduleService.getScheduleItems` + `jobsService.listJobs`. **Guardrails:** window stated as a **range**; never promise an exact minute.
- **FR-S5 — `rescheduleAppointment` (write, L2).** *(FR-C6)* **In:** `contactId`, `jobId`, `newPreferredSlot`. **Out:** `success`, `newWindow`, `conflict?`. **Reuses (read):** `scheduleService.getAvailableSlots` (or the `recommendSlots`/engine path) to offer 2–3 windows. **Reuses (write):** `scheduleService.rescheduleItem('job', jobId, start, end)` **+ ZB push (AR-4 gap to close)** + `jobsService.addNote(author='AI Phone')` (AR-5). **Guardrails:** confirm old→new **before** writing (no write without explicit confirmation of the new window); on conflict offer the next window; reschedule must appear on the dispatcher schedule immediately.
- **FR-S6 — `cancelAppointment` (write, L2, retention-gated).** *(FR-C7)* **In:** `contactId`, `jobId`, `reason`, `retentionAttempted`. **Out:** `success`, `status`. **Reuses:** `jobsService.cancelJob(jobId)` (already ZB-pushing) + `jobsService.addNote(reason, author='AI Phone')` (AR-5). **Guardrails (mandatory order):** acknowledge + **require a reason**; make **exactly one** genuine save attempt matched to the reason (timing→offer a better/sooner window via reschedule; price→restate the \$95-credit / no-full-prepayment protection; found-someone→trust/anti-scam framing + soonest slot; fixed-itself→note/easy rebook); only if they still insist → cancel with `retentionAttempted=true`. **Never cancel on first ask**; reason captured on the job note every time; state any cancellation-policy/fee wording **before** writing (see OQ-V3-2, still open). Cancel reflected in CRM + dispatcher schedule.
- **FR-S7 — `getJobHistory` (read, L2).** *(FR-C4)* **In:** `contactId`, `jobId`. **Out:** `timeline[] = {date, event, note_summary}` — summarized for speech. **Reuses:** `jobsService` notes + `eventService.getEntityHistory(companyId,'job',jobId, notes)`. **Guardrails:** **redact internal-only / technician-private notes**; summarize, don't read raw; L1 callers must verify to L2 before any history is shared.
- **FR-S8 — `getEstimateSummary` (read, L2).** *(FR-C5)* **In:** `contactId`, `jobId?`, `estimateId?`. **Out:** `estimateNumber`, `status`, `total`, `itemCount`, `summaryText`. **Reuses:** `estimatesService.listEstimates(companyId, …)` / `getEstimate(companyId, id)`. **Guardrails:** spoken **summary** only; **do not read every line item**; offer to text a secure link (sender/number = OQ-V3-4, still open); amounts only after **L2**.
- **FR-S9 — `getInvoiceSummary` (read, L2).** *(FR-C5)* **In:** `contactId`, `invoiceId?`. **Out:** `invoiceNumber`, `status`, `total`, `amountPaid`, `balanceDue`. **Reuses:** `invoicesService.listInvoices(companyId, …)` / `getInvoice(companyId, id)`. **Guardrails:** state balance + status; **for payment, hand off to a secure link or a human — never collect a card by voice**; amounts only after **L2**.

**`status_map` (internal `BLANC_STATUSES` → caller-friendly phrase; carry from roadmap; never read codes aloud):** `Submitted`→"We've got your request and are getting it scheduled." · `Review`→"Our team is reviewing the details and will confirm shortly." · `Scheduled`→"You're scheduled — a technician is set for your window." · `Enroute`/`On the way`→"Your technician is on the way." · `In Progress`→"The technician is working on it now." · `Waiting for parts`→"We're waiting on a part to finish the repair." · `Job is Done`→"The job is complete." · `Canceled`→"That appointment is canceled." (Architect reconciles this map against the ACTUAL `BLANC_STATUSES` in `jobsService.js` line 25 — `['Submitted','Waiting for parts','Follow Up with Client','Visit completed','Job is Done','Rescheduled','Canceled','On the way']` — which differs from the roadmap's illustrative set; add phrases for `Follow Up with Client`, `Visit completed`, `Rescheduled` and map any ZB substatus like `en-route`.)

### 5. Non-functional requirements

- **Latency:** skill/tool round-trip **p95 < 2000 ms** (CRM reads are heavier than v2; index `contactId`/phone lookups; the engine/ZB calls must respect a timeout and fall back on slowness).
- **Graceful degradation:** on ANY error, a skill returns a safe result ("let me have a teammate follow up") — **never** an internal error, stack, SQL, or PII; the call continues; lead creation / call completion is never blocked (LQV2 rule). Mirror `crmMcpResponse`'s sanitized-error mapping on the MCP surface.
- **Identity tolerance:** identity lookup is fast and tolerant of masked/spoofed numbers — fuzzy name, normalized phone/ZIP; a masked-number existing customer is found via name+ZIP within ~2 questions.
- **Security/privacy (hard rules):** verification gates enforced **server-side** in the skill layer; **no payment capture by voice, ever**; address/PII is **confirm-only** ("is this still the Walpole Street address?" → yes/no), never read the full address back unprompted; every write logs an "AI Phone" audit note + domain event; **company isolation is absolute** (a cross-customer/cross-company incident is P0). Public MCP transport keeps **writes disabled unless explicitly enabled** and is bearer-token + env-bound-company gated (CRM-MCP precedent).
- **Availability:** ≥ the existing VAPI/backend posture; concurrent inbound calls ≥ 10 (LQV2).

### 6. Acceptance criteria (carry the roadmap's checkboxes)

- **AC-1 (FR-C1):** A caller with an open job is **never** pushed through new-lead qualification; a truly new caller still flows to v2 (`createLead → Review`); a masked-number existing customer is found via name+ZIP within 2 questions.
- **AC-2 (FR-C2/C3):** Internal `blanc_status` is **never** read aloud (always mapped via `status_map`); with multiple open jobs the agent asks which appliance/service to scope; each status yields a correct phrase + sensible next action.
- **AC-3 (FR-C8):** Appointment window is stated as a **range**; ETA is framed as "the tech will text before arriving."
- **AC-4 (FR-C6):** No reschedule write occurs without explicit confirmation of the new window; the reschedule writes Albusto **and** pushes to Zenbooker and appears on the dispatcher schedule immediately; an "AI Phone" audit note is recorded.
- **AC-5 (FR-C7):** Exactly **one** retention attempt precedes any cancel; a **reason is captured** on the job note every time; `retentionAttempted=true`; cancel is reflected in CRM + dispatcher schedule + ZB; an "AI Phone" audit note (with reason) is recorded.
- **AC-6 (FR-C4):** Internal/technician-private notes are **never** read aloud; L1 callers are asked to verify (to L2) before any history is shared.
- **AC-7 (FR-C5):** **No** card/payment capture by voice under any path; estimate/invoice **amounts only after L2**; the agent offers a text-a-link instead of reading line items.
- **AC-8 (verification, server-side):** A skill call asserting `verified:true` from the client/LLM without a server-side match+confirmation is **rejected** for L2 reads/writes (verification is not client-trusted).
- **AC-9 (isolation, P0):** Every skill call is scoped to `DEFAULT_COMPANY_ID`; no skill can read or mutate another customer's or another company's data (verified with a cross-tenant attempt test).
- **AC-10 (swappability / MCP):** The same skills are reachable over BOTH the refactored `/api/vapi-tools` thin adapter and the new MCP surface, producing equivalent results; the MCP surface reuses the `crmMcp*` framework (registry/validator/executor/response/protocol) and its tenant/auth/write/confirmation/sanitization contracts; public MCP writes are disabled unless explicitly enabled.
- **AC-11 (thin adapter):** `backend/src/routes/vapi-tools.js` contains **no** CRM business logic, verification decisions, or SQL after the refactor — each handler only translates the envelope and calls a skill-layer function; existing tools keep their behavior (regression-tested).
- **AC-12 (graceful degradation):** Injecting an error into any skill yields a safe "teammate will follow up" tool result (no internal detail leaked) and the call continues.
- **AC-13 (repo config):** `voice-agent/assistants/lead-qualifier-v2.json` (repo) routes existing-vs-new correctly (identify first, branch), offers the new skills, and passes only skill-shaped arguments; the **live** assistant is unchanged by this pipeline (live PATCH = separate owner-gated step).

### 7. Constraints & dependencies

**Reuse these existing services (do NOT re-implement their logic in the skill layer — call them; all accept `companyId`):**
- `leadsService` (`backend/src/services/leadsService.js`) — `getLeadByPhone(phone, companyId)` (l.1104), `getLeadsByPhones(phones, companyId)` (l.1041), `createLead(fields, companyId)` (l.312), `convertLead(uuid, overrides, companyId)` (l.704), `getLeadById(id, companyId)` (l.283). **Caveat:** `getLeadByPhone` returns `null` when the matched contact already has a job — so identity for existing customers must resolve across **contacts/jobs**, not just open leads.
- `contactsService` (`backend/src/services/contactsService.js`) — `listContacts({search, companyId, providerScope})` (l.50), `getContactById(id, companyId, providerScope)` (l.128), `getContactLeads(contactId, companyId)` (l.169), `getContactEmails(contactId, primaryEmail)` (l.195). (No native phone getter — use leads/timeline phone match to bridge phone→contact.)
- `jobsService` (`backend/src/services/jobsService.js`) — `listJobs({contactId, onlyOpen, companyId, …})` (l.622), `getJobById(id, companyId, providerScope)` (l.589), `addNote(jobId, text, attachments, author, createdBy, noteId)` (l.1157; ZB-mirrors text when linked), `cancelJob(jobId)` (l.1225; **already ZB-pushes**), `updateBlancStatus(jobId, newStatus, companyId)` (l.849), `getJobTransitions(companyId, currentState, userRoles)` (l.1369); constants `BLANC_STATUSES` (l.25), `ALLOWED_TRANSITIONS` (l.37). **Do not remove/alter statuses, `OUTBOUND_MAP`, or the Zenbooker sync block** (FSM dual-source; jobsService is authoritative fallback).
- `scheduleService` (`backend/src/services/scheduleService.js`) — `getScheduleItems(companyId, filters, providerScope)` (l.74), `getAvailableSlots(companyId, {…})` (l.407), `rescheduleItem(companyId, entityType, entityId, newStartAt, newEndAt)` (l.141 — **does NOT push to ZB today; AR-4 gap**), `reassignItem(companyId, entityType, entityId, assignees)` (l.202 — pushes to ZB via `zenbookerClient.assignProviders`, the write-through precedent).
- `estimatesService` — `listEstimates(companyId, filters)` (l.106), `getEstimate(companyId, id)` (l.110). `invoicesService` — `listInvoices(companyId, filters)` (l.33), `getInvoice(companyId, id)` (l.40).
- `eventService` (`backend/src/services/eventService.js`) — `logEvent(companyId, aggregateType, aggregateId, eventType, eventData, actorType='system', actorId)` (l.21), `getEntityHistory(companyId, aggregateType, aggregateId, entityNotes)` (l.74), `actorName(req)`.
- `zenbookerClient` (`backend/src/services/zenbookerClient.js`) — `rescheduleJob(id, data)` (l.372, POST `/jobs/{id}/reschedule` — **to be wired into the reschedule path**), `cancelJob(id)` (l.362, already used), `addJobNote(id, {text})` (l.392), `assignProviders(id, data)` (l.382); `getClient()` bound to `ZENBOOKER_DEFAULT_COMPANY_ID` (l.36 = seed …0001), `getClientForCompany(companyId)` returns null for non-default tenants (ZB-ISO-001).
- `marketplaceService` (`backend/src/services/marketplaceService.js`) — `isAppConnected(companyId, appKey)` (l.93); app keys `SMART_SLOT_ENGINE_APP_KEY='smart-slot-engine'` (l.19), `TELEPHONY_TWILIO_APP_KEY='telephony-twilio'` (l.64), `GOOGLE_EMAIL_APP_KEY='google-email'` (l.25). Architect decides the marketplace gate for the voice-skill surface (e.g. telephony-connected), following the `recommendSlots`→`smart-slot-engine` gate precedent + graceful fallback when not connected.

**Reuse the existing MCP framework (AR-3) — do NOT build a second one:** `backend/src/routes/crmMcp.js`, `crmMcpPublic.js`, `backend/src/cli/crmMcpStdio.js`, and services `crmMcpToolRegistry.js`, `crmMcpSchemaValidator.js`, `crmMcpToolExecutor.js`, `crmMcpResponse.js`, `crmMcpProtocolService.js`, `crmMcpPublicAuth.js` (CRM-SALES-MCP, Status: Implemented and audited; 16 suites / 105 tests). Mirror their read/write kinds, `requiresConfirmation`, per-tool `requiredPermission`/verification, tenant-from-context (`req.companyFilter.company_id`, never client), sanitized errors, and public-transport write-disabled-by-default posture.

**Repo config (this pipeline updates the repo JSON only):** `voice-agent/assistants/lead-qualifier-v2.json` — add the new skill tool-defs to `model.tools[]` (same `function`/`server` shape as the existing five, `server.url` = `https://api.albusto.com/api/vapi-tools`, secret placeholder injected at push) and rewrite the routing/scheduling prompt so Sara identifies first and branches existing-vs-new. The **live** assistant (`30e85a87`) is a **separate owner-consent-gated PATCH** (get-first; live agent drifts; CLI `update` panics — use REST PATCH; re-inject `VAPI_TOOLS_SECRET` into every `model.tools[].server`; keep `answerOnBridge="true"`).

**Integrations affected:** **VAPI** (Sara is one consumer; live push owner-gated). **Zenbooker** (reschedule/cancel write-through + note mirror; default-company ZB account only; ZB job-create/reschedule needs `address.state` where applicable). **Twilio / telephony-twilio** (the inbound call path + marketplace gate candidate). **Google Maps Geocoding** (reused by `validateAddress`/engine for masked-number ZIP/address resolution). **MCP clients** (any MCP-capable agent connects to the new surface). **Front / Stripe** — untouched (payment stays a secure-link/human handoff).

**Protected parts (must not break):**
- VAPI tool **auth + envelope + single-tenant contract** — `vapiSecretAuth`/`x-vapi-secret` vs `VAPI_TOOLS_SECRET` (fail-closed), the `toolCallList → results` envelope, hardwired `DEFAULT_COMPANY_ID`, endpoint mounted without session auth. The refactor relocates logic but preserves every one of these.
- Existing VAPI tools (`checkServiceArea`, `validateAddress`, `checkAvailability`, `recommendSlots`, `createLead`) — behavior preserved (moved onto the skill layer without semantic change; `recommendSlots` gate + safe-fail and `createLead` retry/slot-persist unchanged).
- The **CRM-SALES-MCP** stack and its `/api/crm/mcp` + `/mcp/crm` contracts — reused, not modified; the new surface is additive.
- `jobsService` FSM constants + `OUTBOUND_MAP` + Zenbooker sync/pass-through actions; `scheduleService` generic availability path; `leadsService.createLead(fields, companyId)` signature; ZB-ISO-001 (default-company ZB binding).
- Tenancy/isolation posture — the skills operate only within `DEFAULT_COMPANY_ID`; no cross-tenant read/write is introduced.

**Verify against a real DB / real ZB — not just mocked jest** (LIST-PAGINATION-001 / created_by-FK lessons): run the real identity lookup, the real reschedule (Albusto write + ZB push) and cancel, and the real estimate/invoice reads against a prod-DB copy, and exercise both adapters (VAPI envelope + MCP JSON-RPC) end-to-end, before any deploy. **Prod deploy and the live VAPI push are owner-consent-gated (standing rule).**

### 8. Open questions (roadmap OQ-V3-1…5) — DECIDED vs still OPEN

- **OQ-V3-1 — Verification strength for L2 writes.** **DECIDED (interview):** L2 = confirmed **name AND (ZIP or address)**; no last-4/booking-code required. Enforced server-side.
- **OQ-V3-2 — Cancellation policy/fee wording the bot must state before canceling.** **STILL OPEN** (Ops) — for the Architect/SpecWriter to pin the exact policy/fee text (if any) the cancel skill states before writing.
- **OQ-V3-3 — Reschedule write-target while Zenbooker is live.** **DECIDED (interview):** reschedule writes Albusto **AND pushes to Zenbooker** (ZB still master). Note the implementation **gap**: `scheduleService.rescheduleItem` must be extended to call `zenbookerClient.rescheduleJob` (AR-4).
- **OQ-V3-4 — Secure-link texting for estimates/invoices (which sender/number).** **PARTIALLY OPEN** — DECIDED that **no payment/card is taken by voice** (offer a secure link or a human); **still OPEN** which sender/number sends the link (Ops/Eng), for the Architect/SpecWriter.
- **OQ-V3-5 — Whether an existing-customer status/reschedule call ever creates a Review lead (vs only updating the job).** **STILL OPEN** (Product) — default posture is "update the job, do not spawn a Review lead," but the final rule is for the Architect/SpecWriter/Product to confirm.

### 9. Involved modules (summary)

- **New:** provider-neutral CRM **skill/capability layer** service(s) (AR-1); a **service-CRM MCP surface** reusing the `crmMcp*` framework (AR-3) — registry + executor + transport(s) over the same skills.
- **Refactor:** `backend/src/routes/vapi-tools.js` → thin adapter (AR-2). `backend/src/services/scheduleService.js` `rescheduleItem` → add ZB reschedule push (AR-4).
- **Reused unchanged (called by the skill layer):** `leadsService`, `contactsService`, `jobsService`, `estimatesService`, `invoicesService`, `eventService`, `scheduleService` (reads), `zenbookerClient`, `marketplaceService`, and the `crmMcp*` framework services.
- **Repo config:** `voice-agent/assistants/lead-qualifier-v2.json` (routing/scheduling prompt + tool-defs; live push separate/owner-gated).

