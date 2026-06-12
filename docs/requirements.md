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
