# Blanc Contact Center — Architecture

> Architectural decisions and module structure for the project.

---

## LQV2: Lead Qualifier v2 — AI Inbound Phone Assistant

**Status:** Architecture
**Feature:** VAPI inbound call assistant — lead qualification, booking, CRM creation
**Related requirements:** `LQV2` in `Docs/requirements.md`
**Spec:** `voice-agent/assistants/lead-qualifier-v2-spec.md`

### 1. System Overview

```
Inbound SIP call
       │
       ▼
  VAPI Platform (GPT-4o, Azure/Andrew voice, persona "Alex")
       │
       ├─ tool: checkServiceArea ──────────────────────────────────────┐
       ├─ tool: validateAddress  ──────────────────────────────────────┤
       ├─ tool: checkAvailability ─────────────────────────────────────┤
       └─ tool: createLead ────────────────────────────────────────────┤
                                                                       │
                POST /api/vapi-tools (x-vapi-secret header)            │
                         │◄──────────────────────────────────────────-─┘
                         ▼
              vapi-tools.js route (vapiSecretAuth)
                         │
          ┌──────────────┬──────────────┬──────────────┐
          ▼              ▼              ▼              ▼
  serviceTerritory   Google Maps    scheduleService  leadsService
  Queries.search()   Geocoding API  .getAvailable    .createLead()
  (checkServiceArea) (validateAddr)  Slots()          (createLead)
          │              │           (checkAvail)         │
          ▼              ▼              ▼                  ▼
   service_territories  maps.googleapis  dispatch_settings  leads
   (PostgreSQL)         .com/geocode     + booked items     (PostgreSQL)
                                         (PostgreSQL)
```

The endpoint `/api/vapi-tools` is already mounted in `src/server.js` without `authenticate`/`requireCompanyAccess` middleware (intentional — VAPI is server-to-server, secured by `x-vapi-secret`). It uses a hardcoded `DEFAULT_COMPANY_ID` because tenant context is determined by the VAPI assistant assignment, not by session.

### 2. Existing Functionality to Extend

| Module | Decision |
|---|---|
| `backend/src/routes/vapi-tools.js` | **Extend.** Add `handleValidateAddress` and `handleCheckAvailability` handlers. Add routing for new tool names in the dispatcher. |
| `backend/src/services/scheduleService.js` | **Extend.** Add `getAvailableSlots(companyId, opts)` — reads `dispatch_settings` + booked schedule items. |
| `backend/src/db/serviceTerritoryQueries.js` | **Reuse as-is.** `search(companyId, zip)` already handles zip → area/city lookup. |
| `backend/src/services/leadsService.js` | **Reuse as-is.** `createLead(fields, companyId)` signature unchanged. |
| `backend/src/routes/zip-check.js` | **No change.** Already returns `city`/`state` (updated in LQV1). |
| `src/server.js` | **No change.** `/api/vapi-tools` mount already exists. |

### 3. New Components

#### Backend

**`backend/src/routes/vapi-tools.js`** — extend with two new handlers:

- `handleValidateAddress({ street, apt, city, state, zip })` — calls Google Maps Geocoding API server-side using `VITE_GOOGLE_MAPS_API_KEY` env var. Returns `{ valid, standardized, correctedZip, lat, lng }`. On error or not-found → returns `{ valid: false }`, never throws.

- `handleCheckAvailability({ zip, unitType, days })` — calls `scheduleService.getAvailableSlots(DEFAULT_COMPANY_ID, { days, slotDurationMin: 120, maxSlots: 3 })`. Reads Blanc's own `dispatch_settings` + booked items. Returns `{ slots: [{ date, label, start, end }] }` — max 3 slots formatted for speech (e.g. "Tuesday, June 10th between 10am and 1pm").

#### Voice Agent Config

**`voice-agent/assistants/lead-qualifier-v2.json`** — complete VAPI assistant config for deployment:
- Model: `openai/gpt-4o`, temp 0.5, max tokens 400
- Voice: `azure/andrew`
- System prompt: full conversation instructions from spec (FR-1 through FR-12)
- Tools: all 4 tools with `server.url` and `server.secret`
- `firstMessage`, `endCallMessage`, `maxDurationSeconds: 900`
- `metadata.slug: lead_qualifier_v2`, `metadata.stage: 2`

#### Env vars (no new secrets needed)

| Var | Purpose |
|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | Reused from existing frontend key — already set on Fly.io, read on backend via `process.env` |
| `VAPI_TOOLS_SECRET` | Already added in LQV1 |

### 4. Files to Modify / Create

| File | Action | Notes |
|---|---|---|
| `backend/src/routes/vapi-tools.js` | **Modify** | Add `handleValidateAddress`, `handleCheckAvailability`, update dispatcher |
| `voice-agent/assistants/lead-qualifier-v2.json` | **Create** | VAPI assistant config for CLI deploy |
| `.env.example` | **Modify** | Add `VITE_GOOGLE_MAPS_API_KEY` |

### 5. Files NOT to Touch

| File | Reason |
|---|---|
| `src/server.js` | Route already mounted; middleware chain correct |
| `backend/src/services/leadsService.js` | Signature used by vapi-tools and UI leads; do not modify |
| `backend/src/db/serviceTerritoryQueries.js` | No schema change needed |
| `backend/src/routes/zip-check.js` | Frontend consumers depend on current contract |
| `frontend/src/` | No frontend changes required for LQV2 |

### 6. API Contracts (new tool handlers)

**`validateAddress` tool call** (invoked by VAPI, handled in `vapi-tools.js`):
```
Input:  { street: string, apt?: string, city?: string, state?: string, zip?: string }
Output: { valid: boolean, standardized?: string, correctedZip?: string, lat?: number, lng?: number }
Errors: always returns object — never throws to caller
```

**`checkAvailability` tool call**:
```
Input:  { zip: string, unitType?: string, days?: number }
Output: { slots: [{ date: string, label: string, start: string, end: string }], error?: string }
        slots[].label — human-readable e.g. "Tuesday, June 10th between 10am and 1pm"
        max 3 slots returned
Errors: { slots: [], error: "No availability found" }
```

### 7. Security Notes

- `/api/vapi-tools` is intentionally public (no `authenticate`/`requireCompanyAccess`)
- Protected by `VAPI_TOOLS_SECRET` header check (`x-vapi-secret`)
- `GOOGLE_GEOCODING_KEY` — dedicated server-side key (Fly secret, IP-restricted, Geocoding API only). Falls back to `VITE_GOOGLE_MAPS_API_KEY` if unset. Kept separate from the frontend key, which is HTTP-referrer-restricted and can't serve server-side calls.
- All DB calls inside tool handlers use hardcoded `DEFAULT_COMPANY_ID` — single-tenant deployment

---

## PF002-R2: Estimates Composer Refresh

**Status:** Architecture
**Feature:** Repair-focused estimate composer and lifecycle correction
**Related requirements:** `PF002-R2` in `docs/requirements.md`

### 1. System Overview

PF002-R2 extends the existing estimates domain rather than creating a new estimate subsystem. The current route/service/query stack remains canonical:

```
LeadFinancialsTab / JobFinancialsTab / EstimatesPage
        │
        ▼
EstimateEditorDialog ──► estimatesApi.ts ──► /api/estimates
        │                                      │
        ▼                                      ▼
EstimatePreviewDialog                  estimatesService.js
                                               │
                                               ▼
                                      estimatesQueries.js
                                               │
                                               ▼
                          estimates / estimate_items / estimate_events
                          estimate_revisions (approved snapshots only)
```

The app detail panel is an operational view. Client-facing document rendering is a separate preview modal/drawer that reads the same estimate payload and default Terms & Warranty template.

### 2. Existing Functionality to Extend

| Existing module | Decision |
|-----------------|----------|
| `backend/src/routes/estimates.js` | Extend. Fix tenant context to `req.companyFilter?.company_id`; add archive/restore/decline reason endpoints; keep route mounted under existing authenticated `/api/estimates`. |
| `backend/src/services/estimatesService.js` | Extend. Own validation, status reset rules, approved snapshots, archive/restore, non-mutating send stub, and conversion to invoice. |
| `backend/src/db/estimatesQueries.js` | Extend. Align SQL with real schema/migration; add item upsert/replace, taxable totals, archive fields, summary, signature, display number support. |
| `frontend/src/components/estimates/EstimateEditorDialog.tsx` | Refactor. Keep as canonical editor, but switch from inline cards to item-list + add/edit item dialog. |
| `frontend/src/components/estimates/EstimateDetailPanel.tsx` | Extend. Add Preview, Archive/Restore, decline reason, approved status, invoice badge. Disable actions when archived. |
| `frontend/src/pages/EstimatesPage.tsx` | Extend. Remove global create, add `Only Open / All` archive filter. |
| `frontend/src/hooks/useLeadFinancials.ts`, `useJobFinancials.ts` | Extend. Continue as Lead/Job entry points for creation. |
| `frontend/src/services/estimatesApi.ts` | Extend typed API contract. |

No new parallel estimate store or XML document model is introduced.

### 3. Database Changes

Add a new migration after the current highest migration number.

#### `estimates`

Add/align:

- `summary TEXT`
- `discount_type VARCHAR(20) CHECK (discount_type IN ('fixed','percentage'))`
- `discount_value NUMERIC(12,2) NOT NULL DEFAULT 0`
- keep `discount_amount NUMERIC(12,2)` as calculated amount
- `estimate_sequence INTEGER NOT NULL DEFAULT 1`
- `archived_at TIMESTAMPTZ`
- `archived_by UUID REFERENCES crm_users(id) ON DELETE SET NULL`
- `approved_snapshot JSONB`
- `signature_name TEXT`
- `signature_consented_at TIMESTAMPTZ`
- status check must use `approved`, not `accepted`

Remove from P0 behavior, but columns may remain for compatibility:

- `valid_until`
- deposit columns

#### `estimate_items`

Add future-compatible optional fields:

- `item_type TEXT`
- `category_id BIGINT`
- `price_book_item_id BIGINT`

Existing `name`, `description`, `quantity`, `unit_price`, `taxable`, `metadata` remain canonical. `unit` stays nullable for future imports but is not shown in the P0 UI.

### 4. Backend Service Contracts

Core service methods:

- `listEstimates(companyId, filters)` supports `includeArchived`.
- `getEstimate(companyId, id)` returns estimate with items and invoice reference if available.
- `createEstimate(companyId, userId, data)` validates Lead/Job context, resolves contact from job/lead, computes display number, creates items in one operation, recalculates totals.
- `updateEstimate(companyId, userId, id, data)` replaces editable document fields/items, validates discount/qty/title, resets status to `draft` when editing `sent`, `viewed`, `approved`, or `declined`.
- `approveEstimate(companyId, id, actorType, actorId, signatureData)` requires at least one item, sets `approved`, writes `approved_snapshot`, creates event.
- `declineEstimate(companyId, id, actorType, actorId, reason)` requires non-empty reason, sets `declined`, creates event.
- `archiveEstimate(companyId, id, userId)` sets `archived_at`, `archived_by`, creates event.
- `restoreEstimate(companyId, id, userId)` clears archive fields, sets status `draft`, creates event.
- `sendEstimate(...)` is P0 non-mutating stub: validates payload/channel, creates optional event if needed, but does not change status.

Totals are recalculated server-side from item rows:

```
subtotal = sum(item.amount)
discount_amount = fixed amount or subtotal * percentage / 100
taxable_base = max(sum(taxable item.amount) - discount_amount, 0)
tax_amount = taxable_base * tax_rate / 100
total = subtotal - discount_amount + tax_amount
```

### 5. API Endpoints

Existing endpoint names remain unless noted:

- `GET /api/estimates?include_archived=true|false`
- `POST /api/estimates`
- `GET /api/estimates/:id`
- `PUT /api/estimates/:id`
- `POST /api/estimates/:id/send` — P0 workflow stub, no status mutation
- `POST /api/estimates/:id/approve`
- `POST /api/estimates/:id/decline` — requires `{ reason }`
- `POST /api/estimates/:id/archive`
- `POST /api/estimates/:id/restore`
- `POST /api/estimates/:id/convert`
- `GET /api/estimates/:id/events`
- `GET /api/estimates/:id/revisions`

Route handlers must derive company id from:

```js
const companyId = req.companyFilter?.company_id || req.user?.company_id;
```

All query-layer access by id must include `company_id` checks through the parent estimate row. Foreign ids return 404.

### 6. Frontend Components

New or refactored components:

- `EstimateEditorDialog` — document-level editor with Summary, item list, discount/tax, signature toggle, read-only deposit.
- `EstimateItemDialog` — add/edit custom item; title required, qty > 0, taxable default false.
- `EstimatePreviewDialog` — client-facing preview modal/drawer.
- `EstimateDeclineDialog` — reason required.

Listing and detail:

- `EstimatesPage` removes global create and adds `Only Open / All`.
- Archived rows are greyed and show `Archived`.
- `EstimateDetailPanel` disables edit/approve/decline/archive actions when archived and exposes restore.

### 7. Security and Isolation

- No new route mount is required; `/api/estimates` is already mounted with `authenticate, requireCompanyAccess`.
- Existing `req.companyId` usage in estimates route is an architecture violation and must be fixed.
- All DB operations must scope by `company_id`.
- No XML primary persistence.
- No real email/SMS delivery in P0.

---

## FSM-001: FSM/SCXML Workflow Editor

**Status:** Architecture
**Feature:** Database-driven FSM replacing hardcoded status constants
**Migration range:** 072-074
**New npm packages:** `fast-xml-parser`, `@monaco-editor/react`, `state-machine-cat`

---

### 1. System Overview

The FSM subsystem introduces a declarative, SCXML-based workflow engine that replaces the hardcoded `BLANC_STATUSES`, `ALLOWED_TRANSITIONS` in `jobsService.js` and the implicit lead status logic in `leadsService.js`.

```
                          ┌─────────────────────────────┐
                          │   LeadFormSettingsPage.tsx   │
                          │   Tab: "Settings" | "Workflows"│
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
                          │     WorkflowEditor.tsx       │
                          │  Monaco (left) + Diagram (right)│
                          └──────────┬──────────────────┘
                                     │ authedFetch
                          ┌──────────▼──────────────────┐
                          │   /api/fsm/* (fsm.js route)  │
                          │   authenticate + requireCompanyAccess│
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
                          │     fsmService.js            │
                          │  CRUD, parse, validate, apply│
                          │  In-memory graph cache       │
                          └──────────┬──────────────────┘
                                     │
                  ┌──────────────────┼──────────────────┐
                  │                  │                  │
          ┌───────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
          │ fsm_machines │  │ fsm_versions │  │fsm_audit_log │
          └──────────────┘  └──────────────┘  └──────────────┘

Runtime integration:
  jobsService.updateBlancStatus()  ──► fsmService.resolveTransition()
  leadsService.updateLead()        ──► fsmService.resolveTransition()
  Entity cards (ActionsBlock.tsx)  ◄── fsmService.getAvailableActions()
```

**Feature flag fallback:** When no published FSM version exists for a `(company_id, machine_key)` pair, the runtime falls back to the current hardcoded constants (`BLANC_STATUSES`, `ALLOWED_TRANSITIONS`). This ensures zero-downtime deployment.

---

### 2. New Files

#### 2.1 Backend

| File | Responsibility | Key Exports |
|------|---------------|-------------|
| `backend/src/services/fsmService.js` | Core FSM engine: SCXML parsing (fast-xml-parser), validation, graph caching, transition resolution, version CRUD, audit logging | `parseSCXML(xml)`, `validateSCXML(xml)`, `resolveTransition(companyId, machineKey, currentState, eventOrTarget)`, `getAvailableActions(companyId, machineKey, currentState, userRoles)`, `getDraft(companyId, machineKey)`, `getActiveVersion(companyId, machineKey)`, `saveDraft(companyId, machineKey, scxml, userId, email)`, `publishDraft(companyId, machineKey, changeNote, userId, email)`, `listVersions(companyId, machineKey)`, `restoreVersion(companyId, machineKey, versionId, userId, email)`, `listMachines(companyId)`, `invalidateCache(companyId, machineKey)`, `logAudit(...)` |
| `backend/src/routes/fsm.js` | Express router for all FSM API endpoints | Default export: `router` |
| `backend/db/migrations/072_create_fsm_tables.sql` | Creates `fsm_machines`, `fsm_versions`, `fsm_audit_log` tables | DDL |
| `backend/db/migrations/073_seed_fsm_machines.sql` | Seeds Job FSM and Lead FSM machines with initial published SCXML versions | DML |
| `backend/db/migrations/074_add_fsm_permissions.sql` | Inserts `fsm.viewer`, `fsm.editor`, `fsm.publisher`, `fsm.override` into role_config permission tables | DML |

#### 2.2 Frontend

| File | Responsibility |
|------|---------------|
| `frontend/src/components/workflows/WorkflowEditor.tsx` | Split-view layout: Monaco editor (left pane) + DiagramPreview (right pane). Toolbar: Validate, Save Draft, Publish, Export, Version History. Manages SCXML draft state, debounced preview updates (300ms). |
| `frontend/src/components/workflows/DiagramPreview.tsx` | Renders SVG from SCXML via `state-machine-cat` in the browser. Pan/zoom support. Error overlay when SCXML is malformed. |
| `frontend/src/components/workflows/ProblemsPanel.tsx` | Collapsible panel below editor. Displays validation errors (blocking) and warnings (non-blocking) with line/column references. Click-to-navigate to error in Monaco. |
| `frontend/src/components/workflows/VersionHistory.tsx` | Modal dialog. Lists all versions with version_number, status, author, date, change_note. "Restore as draft" action copies selected version SCXML into a new draft. |
| `frontend/src/components/workflows/MachineList.tsx` | List of FSM machines (Lead, Job) with active version badge and draft indicator. Clicking a machine opens WorkflowEditor. |
| `frontend/src/components/workflows/PublishDialog.tsx` | Confirmation modal requiring a change note before publishing. |
| `frontend/src/components/workflows/ActionsBlock.tsx` | Renders hot action buttons derived from published SCXML transitions. Used inside Lead and Job detail cards. Fetches available actions via `GET /api/fsm/:machineKey/actions?state=X`. Handles `blanc:confirm` transitions with confirmation dialog. |
| `frontend/src/hooks/useFsmEditor.ts` | React Query hook for editor operations: load draft, save draft, validate, publish. Manages editor dirty state and optimistic updates. |
| `frontend/src/hooks/useFsmActions.ts` | React Query hook for runtime: fetch available actions for an entity, apply transition via `POST /api/fsm/:machineKey/apply`. |

---

### 3. Modified Files

#### 3.1 Backend

| File | Change | What to Preserve |
|------|--------|-----------------|
| `backend/src/services/jobsService.js` | **`updateBlancStatus()`**: Add FSM-aware path. Try `fsmService.resolveTransition(companyId, 'job', currentState, newStatus)` first. If no published FSM version exists, fall back to current `ALLOWED_TRANSITIONS` check. Keep `BLANC_STATUSES` and `ALLOWED_TRANSITIONS` as fallback constants (do NOT remove). Keep `OUTBOUND_MAP` and all Zenbooker sync logic unchanged. Export new function `getJobTransitions(companyId, currentState, userRoles)` that delegates to fsmService or falls back to hardcoded map. | `OUTBOUND_MAP`, `computeBlancStatusFromZb()`, `syncFromZenbooker()`, `cancelJob()`, `markEnroute()`, `markInProgress()`, `markComplete()`, all Zenbooker pass-through actions, `zbJobToColumns()` |
| `backend/src/services/leadsService.js` | **`updateLead()`**: When `Status` field changes, validate via `fsmService.resolveTransition(companyId, 'lead', currentStatus, newStatus)` if published FSM exists, otherwise allow current implicit behavior. Add export `getLeadTransitions(companyId, currentStatus, userRoles)`. | All existing CRUD, `convertLead()`, `markLost()`, `activateLead()`, phone normalization, metadata extraction |
| `src/server.js` | Add one line to mount the FSM router: `app.use('/api/fsm', authenticate, requireCompanyAccess, fsmRouter);`. Place it in the "Auth + tenant-scoped CRM API routes" section alongside other authenticated routes. Import `fsmRouter` at the top with other route requires. | Everything else. This is a protected file; only the mount line is added. |

#### 3.2 Frontend

| File | Change | What to Preserve |
|------|--------|-----------------|
| `frontend/src/pages/LeadFormSettingsPage.tsx` | Wrap current content in Shadcn `Tabs` component. Tab "Settings" = existing content (unchanged). Tab "Workflows" = `<MachineList />` which leads into `<WorkflowEditor />`. Import `Tabs, TabsList, TabsTrigger, TabsContent` from shadcn/ui. The component currently returns a `<div className="lfsp-page">` — this becomes the content of `TabsContent value="settings"`. | All existing state, handlers, DnD logic, sections (Job Types, Metadata Fields, Job Tags). No changes to existing functionality. |
| Job detail card components | Replace hardcoded status-change dropdown with `<ActionsBlock machineKey="job" entityId={job.id} currentState={job.blanc_status} />`. Add manual override link visible only to `fsm.override` role. | All other card content, layout, styling |
| Lead detail card components | Replace hardcoded status-change dropdown with `<ActionsBlock machineKey="lead" entityId={lead.ClientId} currentState={lead.Status} />`. | All other card content |

---

### 4. Database Schema

#### Migration 072: `072_create_fsm_tables.sql`

```sql
-- FSM Machines: one row per workflow type per company
CREATE TABLE IF NOT EXISTS fsm_machines (
    id              SERIAL PRIMARY KEY,
    machine_key     TEXT NOT NULL,               -- 'job', 'lead'
    company_id      UUID NOT NULL REFERENCES companies(id),
    title           TEXT NOT NULL,                -- 'Job Workflow', 'Lead Workflow'
    description     TEXT,
    active_version_id INTEGER,                   -- FK to fsm_versions.id (set after first publish)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (company_id, machine_key)
);

CREATE INDEX idx_fsm_machines_company ON fsm_machines(company_id);

-- FSM Versions: SCXML snapshots with draft/published/archived lifecycle
CREATE TABLE IF NOT EXISTS fsm_versions (
    id              SERIAL PRIMARY KEY,
    machine_id      INTEGER NOT NULL REFERENCES fsm_machines(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id),
    version_number  INTEGER NOT NULL DEFAULT 0,  -- 0 = draft, incremented on publish
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published', 'archived')),
    scxml_source    TEXT NOT NULL,                -- raw SCXML XML string
    change_note     TEXT,
    created_by      TEXT,                         -- user email or ID
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_by    TEXT,
    published_at    TIMESTAMPTZ
);

CREATE INDEX idx_fsm_versions_machine ON fsm_versions(machine_id);
CREATE INDEX idx_fsm_versions_company ON fsm_versions(company_id);
CREATE INDEX idx_fsm_versions_status ON fsm_versions(company_id, status);

-- Add FK from fsm_machines.active_version_id -> fsm_versions.id
ALTER TABLE fsm_machines
    ADD CONSTRAINT fk_fsm_machines_active_version
    FOREIGN KEY (active_version_id) REFERENCES fsm_versions(id);

-- FSM Audit Log: every editor and runtime action
CREATE TABLE IF NOT EXISTS fsm_audit_log (
    id              SERIAL PRIMARY KEY,
    company_id      UUID NOT NULL,
    machine_key     TEXT NOT NULL,
    version_id      INTEGER,                     -- nullable for runtime events
    actor_id        TEXT,
    actor_email     TEXT,
    action          TEXT NOT NULL,                -- 'save_draft', 'publish', 'apply', 'override', 'restore'
    payload_json    JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fsm_audit_company ON fsm_audit_log(company_id);
CREATE INDEX idx_fsm_audit_machine ON fsm_audit_log(company_id, machine_key);
CREATE INDEX idx_fsm_audit_created ON fsm_audit_log(created_at);
```

#### Migration 073: `073_seed_fsm_machines.sql`

This migration is a function that runs per-company to seed initial machines. For MVP, it seeds for the default company. The seed SCXML for Job FSM exactly reproduces the hardcoded `ALLOWED_TRANSITIONS`:

```sql
-- Seed function: creates FSM machines + initial published version for a company.
-- Called once per existing company during migration, and by application code for new companies.

DO $$
DECLARE
    comp RECORD;
    machine_id_job INTEGER;
    machine_id_lead INTEGER;
    version_id_job INTEGER;
    version_id_lead INTEGER;
    job_scxml TEXT;
    lead_scxml TEXT;
BEGIN
    job_scxml := '<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       version="1.0"
       initial="Submitted"
       blanc:machine="job"
       blanc:title="Job Workflow">

  <state id="Submitted" blanc:label="Submitted">
    <transition event="TO_FOLLOW_UP" target="Follow_Up_with_Client" blanc:action="true" blanc:label="Follow up" />
    <transition event="TO_WAITING_PARTS" target="Waiting_for_parts" blanc:action="true" blanc:label="Waiting for parts" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>

  <state id="Waiting_for_parts" blanc:label="Waiting for parts" blanc:statusName="Waiting for parts">
    <transition event="TO_SUBMITTED" target="Submitted" blanc:action="true" blanc:label="Back to Submitted" />
    <transition event="TO_FOLLOW_UP" target="Follow_Up_with_Client" blanc:action="true" blanc:label="Follow up" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>

  <state id="Follow_Up_with_Client" blanc:label="Follow Up with Client" blanc:statusName="Follow Up with Client">
    <transition event="TO_WAITING_PARTS" target="Waiting_for_parts" blanc:action="true" blanc:label="Waiting for parts" />
    <transition event="TO_SUBMITTED" target="Submitted" blanc:action="true" blanc:label="Back to Submitted" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>

  <state id="Visit_completed" blanc:label="Visit completed" blanc:statusName="Visit completed">
    <transition event="TO_FOLLOW_UP" target="Follow_Up_with_Client" blanc:action="true" blanc:label="Follow up" />
    <transition event="TO_JOB_DONE" target="Job_is_Done" blanc:action="true" blanc:label="Job Done" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>

  <state id="Job_is_Done" blanc:label="Job is Done" blanc:statusName="Job is Done">
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this completed job?" />
  </state>

  <state id="Rescheduled" blanc:label="Rescheduled">
    <transition event="TO_SUBMITTED" target="Submitted" blanc:action="true" blanc:label="Back to Submitted" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>

  <final id="Canceled" blanc:label="Canceled" />

</scxml>';

    lead_scxml := '<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       version="1.0"
       initial="Submitted"
       blanc:machine="lead"
       blanc:title="Lead Workflow">

  <state id="Submitted" blanc:label="Submitted">
    <transition event="TO_NEW" target="New" blanc:action="true" blanc:label="Mark New" />
    <transition event="TO_CONTACTED" target="Contacted" blanc:action="true" blanc:label="Contacted" />
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" blanc:confirm="true" />
    <transition event="TO_CONVERTED" target="Converted" blanc:action="true" blanc:label="Convert" />
  </state>

  <state id="New" blanc:label="New">
    <transition event="TO_CONTACTED" target="Contacted" blanc:action="true" blanc:label="Contacted" />
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" blanc:confirm="true" />
    <transition event="TO_CONVERTED" target="Converted" blanc:action="true" blanc:label="Convert" />
  </state>

  <state id="Contacted" blanc:label="Contacted">
    <transition event="TO_QUALIFIED" target="Qualified" blanc:action="true" blanc:label="Qualified" />
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" blanc:confirm="true" />
    <transition event="TO_CONVERTED" target="Converted" blanc:action="true" blanc:label="Convert" />
  </state>

  <state id="Qualified" blanc:label="Qualified">
    <transition event="TO_PROPOSAL_SENT" target="Proposal_Sent" blanc:action="true" blanc:label="Proposal Sent" />
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" blanc:confirm="true" />
    <transition event="TO_CONVERTED" target="Converted" blanc:action="true" blanc:label="Convert" />
  </state>

  <state id="Proposal_Sent" blanc:label="Proposal Sent" blanc:statusName="Proposal Sent">
    <transition event="TO_NEGOTIATION" target="Negotiation" blanc:action="true" blanc:label="Negotiation" />
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" blanc:confirm="true" />
    <transition event="TO_CONVERTED" target="Converted" blanc:action="true" blanc:label="Convert" />
  </state>

  <state id="Negotiation" blanc:label="Negotiation">
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" blanc:confirm="true" />
    <transition event="TO_CONVERTED" target="Converted" blanc:action="true" blanc:label="Convert" />
  </state>

  <final id="Lost" blanc:label="Lost" />
  <final id="Converted" blanc:label="Converted" />

</scxml>';

    FOR comp IN SELECT id FROM companies LOOP
        -- Create Job machine
        INSERT INTO fsm_machines (machine_key, company_id, title, description)
        VALUES ('job', comp.id, 'Job Workflow', 'Status transitions for jobs')
        ON CONFLICT (company_id, machine_key) DO NOTHING
        RETURNING id INTO machine_id_job;

        IF machine_id_job IS NOT NULL THEN
            INSERT INTO fsm_versions (machine_id, company_id, version_number, status, scxml_source, change_note, created_by, published_by, published_at)
            VALUES (machine_id_job, comp.id, 1, 'published', job_scxml, 'Initial seed from hardcoded ALLOWED_TRANSITIONS', 'system', 'system', NOW())
            RETURNING id INTO version_id_job;

            UPDATE fsm_machines SET active_version_id = version_id_job WHERE id = machine_id_job;
        END IF;

        -- Create Lead machine
        INSERT INTO fsm_machines (machine_key, company_id, title, description)
        VALUES ('lead', comp.id, 'Lead Workflow', 'Status transitions for leads')
        ON CONFLICT (company_id, machine_key) DO NOTHING
        RETURNING id INTO machine_id_lead;

        IF machine_id_lead IS NOT NULL THEN
            INSERT INTO fsm_versions (machine_id, company_id, version_number, status, scxml_source, change_note, created_by, published_by, published_at)
            VALUES (machine_id_lead, comp.id, 1, 'published', lead_scxml, 'Initial seed for lead workflow', 'system', 'system', NOW())
            RETURNING id INTO version_id_lead;

            UPDATE fsm_machines SET active_version_id = version_id_lead WHERE id = machine_id_lead;
        END IF;
    END LOOP;
END $$;
```

#### Migration 074: `074_add_fsm_permissions.sql`

```sql
-- Add FSM permission keys to the role_config system.
-- These map to Keycloak roles: fsm.viewer, fsm.editor, fsm.publisher, fsm.override
INSERT INTO role_permissions (role_key, permission_key)
SELECT 'admin', p
FROM unnest(ARRAY['fsm.viewer', 'fsm.editor', 'fsm.publisher', 'fsm.override']) AS p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_key, permission_key)
SELECT 'manager', p
FROM unnest(ARRAY['fsm.viewer']) AS p
ON CONFLICT DO NOTHING;
```

---

### 5. API Design

All endpoints are mounted under `app.use('/api/fsm', authenticate, requireCompanyAccess, fsmRouter)`.

`company_id` is always obtained from `req.companyFilter?.company_id`. Never from request body.

| Method | Path | Permission | Request Body | Response | Description |
|--------|------|-----------|-------------|----------|-------------|
| `GET` | `/api/fsm/machines` | `fsm.viewer` | - | `{ ok, data: [{ machine_key, title, description, active_version: { version_number, published_at }, has_draft }] }` | List all FSM machines for the company |
| `GET` | `/api/fsm/:machineKey/active` | `fsm.viewer` | - | `{ ok, data: { version_id, version_number, scxml_source, published_at, published_by } }` | Get active published version SCXML |
| `GET` | `/api/fsm/:machineKey/draft` | `fsm.editor` | - | `{ ok, data: { version_id, scxml_source, created_at, created_by } }` or `{ ok, data: null }` | Get current draft (or null if none) |
| `PUT` | `/api/fsm/:machineKey/draft` | `fsm.editor` | `{ scxml_source: string }` | `{ ok, data: { version_id } }` | Save (create or update) draft |
| `POST` | `/api/fsm/:machineKey/validate` | `fsm.editor` | `{ scxml_source: string }` | `{ ok, data: { valid: bool, errors: [{line, col, message, severity}], warnings: [...] } }` | Validate SCXML without saving |
| `POST` | `/api/fsm/:machineKey/publish` | `fsm.publisher` | `{ change_note: string }` | `{ ok, data: { version_id, version_number } }` | Promote current draft to published |
| `GET` | `/api/fsm/:machineKey/versions` | `fsm.viewer` | - | `{ ok, data: [{ version_id, version_number, status, created_by, created_at, published_by, published_at, change_note }] }` | List all versions (paginated) |
| `POST` | `/api/fsm/:machineKey/versions/:versionId/restore` | `fsm.editor` | - | `{ ok, data: { version_id } }` | Copy version SCXML as new draft |
| `GET` | `/api/fsm/:machineKey/actions` | (any authenticated) | Query: `?state=X&roles=a,b` | `{ ok, data: [{ event, target, label, confirm, confirmText }] }` | Get available actions for a state (used by ActionsBlock) |
| `POST` | `/api/fsm/:machineKey/apply` | (any authenticated) | `{ entityId: number, event: string }` | `{ ok, data: { previousState, newState, entityId } }` | Apply a transition event to an entity |
| `POST` | `/api/fsm/:machineKey/override` | `fsm.override` | `{ entityId: number, targetState: string, reason: string }` | `{ ok, data: { previousState, newState, entityId } }` | Force status change bypassing FSM |
| `GET` | `/api/fsm/:machineKey/render` | `fsm.viewer` | Query: `?format=svg` | SVG string or JSON smcat output | Server-side render (optional, for export/CLI) |

**Permission enforcement pattern** (inside `backend/src/routes/fsm.js`):

```javascript
const { requirePermission } = require('../middleware/authorization');

// Example: publish requires fsm.publisher
router.post('/:machineKey/publish',
    requirePermission('fsm.publisher'),
    async (req, res) => { ... }
);
```

---

### 6. Frontend Component Tree

```
LeadFormSettingsPage.tsx
├── <Tabs defaultValue="settings">
│   ├── <TabsList>
│   │   ├── <TabsTrigger value="settings">Settings</TabsTrigger>
│   │   └── <TabsTrigger value="workflows">Workflows</TabsTrigger>  (feature flag: fsm_editor_enabled)
│   ├── <TabsContent value="settings">
│   │   └── [existing content: Job Types, Metadata Fields, Job Tags sections — unchanged]
│   └── <TabsContent value="workflows">
│       └── <MachineList />                    ← list of machines (Job, Lead)
│           └── [on select] <WorkflowEditor machineKey="job" />
│               ├── Toolbar: Validate | Save Draft | Publish | Export | History
│               ├── <SplitPane>
│               │   ├── <MonacoEditor />       ← SCXML editing, 300ms debounce
│               │   └── <DiagramPreview />     ← state-machine-cat SVG render
│               ├── <ProblemsPanel />          ← validation errors/warnings
│               ├── <PublishDialog />          ← modal with change note
│               └── <VersionHistory />         ← modal with version list
```

**ActionsBlock placement in entity cards:**

```
JobDetailCard.tsx (existing)
├── ... existing fields ...
├── <ActionsBlock machineKey="job" entityId={job.id} currentState={job.blanc_status} />
│   ├── [button per available transition with blanc:action="true"]
│   └── [if user has fsm.override] "Change status..." link → override dropdown
```

---

### 7. Data Flow

#### 7.1 Editor: Edit -> Save -> Publish

```
1. User modifies SCXML in Monaco editor
2. After 300ms debounce, frontend parses SCXML locally via state-machine-cat
   → DiagramPreview updates SVG (client-side only, no server call)
   → If parse error, error overlay shown on diagram

3. User clicks "Save Draft"
   → PUT /api/fsm/:machineKey/draft { scxml_source }
   → fsmService.saveDraft():
     a. Validate SCXML (parseSCXML → check allowed elements, no executable content)
     b. If errors: return 400 with error list
     c. Upsert into fsm_versions with status='draft'
     d. Log to fsm_audit_log (action='save_draft')
     e. Return version_id

4. User clicks "Publish"
   → PublishDialog opens, user enters change_note
   → POST /api/fsm/:machineKey/publish { change_note }
   → fsmService.publishDraft():
     a. Re-validate SCXML (must pass with zero blocking errors)
     b. BEGIN transaction:
        - Archive current published version (status → 'archived')
        - Update draft: status → 'published', version_number = prev + 1, published_by, published_at
        - Update fsm_machines.active_version_id
     c. COMMIT
     d. Invalidate in-memory cache for (company_id, machine_key)
     e. Log to fsm_audit_log (action='publish')
     f. Return { version_id, version_number }
```

#### 7.2 Runtime: Entity Card -> Action Button -> Transition

```
1. Entity card mounts <ActionsBlock machineKey="job" entityId={123} currentState="Submitted" />

2. ActionsBlock calls: GET /api/fsm/job/actions?state=Submitted&roles=agent
   → fsmService.getAvailableActions(companyId, 'job', 'Submitted', ['agent']):
     a. Load published SCXML from cache (or DB → parse → cache)
     b. Find <state id="Submitted"> in parsed graph
     c. Filter transitions: blanc:action="true" AND (no blanc:roles OR user role matches)
     d. Return [{event: "TO_FOLLOW_UP", target: "Follow_Up_with_Client", label: "Follow up", confirm: false}, ...]
     e. If no published version exists: fall back to ALLOWED_TRANSITIONS hardcoded map

3. User clicks "Follow up" button
   → If transition has blanc:confirm="true": show confirmation dialog first
   → POST /api/fsm/job/apply { entityId: 123, event: "TO_FOLLOW_UP" }
   → fsmService.resolveTransition(companyId, 'job', 'Submitted', 'TO_FOLLOW_UP'):
     a. Load published SCXML graph (cached)
     b. Verify transition exists from current state matching event name
     c. Get target state name (resolve blanc:statusName or id)
     d. Return { targetState: 'Follow Up with Client', valid: true }
   → Route handler:
     a. Call jobsService.updateBlancStatus(entityId, targetState)
        → This updates DB + triggers Zenbooker outbound sync
     b. Log to fsm_audit_log (action='apply', payload: {from, to, event})
     c. Return { previousState, newState, entityId }

4. Frontend receives success → invalidates React Query cache → card re-renders with new state
```

#### 7.3 Fallback (No Published FSM)

```
fsmService.resolveTransition(companyId, machineKey, currentState, eventOrTarget):
  1. Try to load active published version from fsm_versions WHERE company_id AND machine_key AND status='published'
  2. If no row found:
     - For machineKey='job': use hardcoded ALLOWED_TRANSITIONS from jobsService.js
     - For machineKey='lead': allow any status change (current implicit behavior)
  3. If found: use SCXML graph for validation
```

---

### 8. Integration Points

#### 8.1 Zenbooker Outbound Sync (PRESERVED)

The `OUTBOUND_MAP` in `jobsService.js` is **not** moved into SCXML. It remains hardcoded because Zenbooker sync is a side-effect of status changes, not part of the FSM state model.

```
jobsService.updateBlancStatus(jobId, newStatus)
  ├── [FSM validation via fsmService — NEW]
  ├── UPDATE jobs SET blanc_status = newStatus — UNCHANGED
  ├── if (OUTBOUND_MAP[newStatus]) → zenbookerClient sync — UNCHANGED
  └── if (newStatus === 'Canceled') → zenbookerClient.cancelJob() — UNCHANGED
```

The runtime service (`fsmService.resolveTransition`) only validates that a transition is allowed. The actual status update and all Zenbooker sync logic remains in `jobsService.updateBlancStatus()`. This separation ensures:
- Zenbooker mapping is independent of SCXML structure
- `OUTBOUND_MAP` maps by status **name**, not by FSM event
- Cancel handling (special case outside `OUTBOUND_MAP`) is preserved
- `computeBlancStatusFromZb()` inbound mapping is unchanged

#### 8.2 Inbound Zenbooker Sync

`jobsService.syncFromZenbooker()` computes `blanc_status` via `computeBlancStatusFromZb()`. This function does **not** go through FSM validation because inbound sync is a system-level operation, not a user-initiated transition. No changes needed.

#### 8.3 Twilio / Front

No impact. These integrations do not depend on status transitions.

#### 8.4 Keycloak RBAC

New roles registered in Keycloak (manual setup or Terraform):
- `fsm.viewer` — can view workflows and version history
- `fsm.editor` — can edit and save drafts
- `fsm.publisher` — can publish drafts (also requires `fsm.editor`)
- `fsm.override` — can force status changes bypassing FSM

These are checked via `requirePermission()` middleware (from `backend/src/middleware/authorization.js`) on each FSM route.

---

### 9. Dependencies

#### Backend (added to root `package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `fast-xml-parser` | `^4.5.0` | Parse SCXML XML to JS object. Lightweight, no native deps, CommonJS-compatible. Used in `fsmService.parseSCXML()`. |

#### Frontend (added to `frontend/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `@monaco-editor/react` | `^4.6.0` | Monaco editor React wrapper for SCXML editing in WorkflowEditor. |
| `state-machine-cat` | `^12.0.0` | Browser-side state machine diagram rendering (SCXML/smcat → SVG). Used in DiagramPreview. |

#### DevDependencies (added to root `package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `state-machine-cat` | `^12.0.0` | `smcat` CLI for `npm run fsm:build` — generates SVG/DOT artifacts from `./fsm/*.scxml` for CI/local. |

---

### 10. In-Memory Cache Design

`fsmService.js` maintains a `Map<string, ParsedGraph>` keyed by `"${company_id}:${machine_key}"`.

```javascript
// Cache structure
const graphCache = new Map();  // key: "companyId:machineKey" → { graph, version_id, parsed_at }

// Cache lifecycle:
// 1. On first getAvailableActions() or resolveTransition() call: load from DB, parse, cache
// 2. On publish: invalidateCache(companyId, machineKey) — delete cache entry
// 3. TTL: none (invalidated on publish only)
// 4. Cache miss: load from DB → parse → store
```

The parsed graph contains:
- `states`: Map of state ID → `{ id, label, statusName, transitions: [...] }`
- `transitions`: Array of `{ source, target, event, action, label, confirm, confirmText, roles }`
- `initialState`: string
- `finalStates`: Set of state IDs

---

### 11. SCXML Validation Rules

`fsmService.validateSCXML(xml)` checks:

| Rule | Severity | Description |
|------|----------|-------------|
| Well-formed XML | error | XML must parse without errors |
| Root element `<scxml>` | error | Must have `<scxml>` as root with correct namespace |
| Allowed elements only | error | Only `<scxml>`, `<state>`, `<final>`, `<transition>` permitted. Reject `<script>`, `<invoke>`, `<send>`, `<onentry>`, `<onexit>`, `<parallel>`, `<history>`, `<datamodel>` |
| Blanc namespace | error | Custom attributes must use `xmlns:blanc="https://blanc.app/fsm"` |
| Unique state IDs | error | No duplicate state IDs within a machine |
| Transition targets exist | error | Every `transition.target` must reference an existing state ID |
| Initial state exists | error | `<scxml initial="X">` must reference an existing state |
| No orphan states | warning | States with no incoming transitions (except initial) |
| Terminal states | warning | `<final>` states with outgoing transitions |
| Reachability | warning | All states reachable from initial |

---

### 12. Existing Functions: Extend vs. Do Not Duplicate

#### Extend (modify in place)

| Function | File | How |
|----------|------|-----|
| `updateBlancStatus()` | `jobsService.js` | Add FSM validation call before status update. Keep fallback to hardcoded map. |
| `updateLead()` | `leadsService.js` | Add FSM validation when Status field changes. Keep fallback to implicit behavior. |
| `LeadFormSettingsPage` | `LeadFormSettingsPage.tsx` | Wrap in Tabs. Existing content untouched inside TabsContent. |

#### Do NOT Duplicate

| Function/Module | File | Reason |
|----------------|------|--------|
| `OUTBOUND_MAP` + Zenbooker sync | `jobsService.js` | Must remain in jobsService. FSM does not own outbound side-effects. |
| `computeBlancStatusFromZb()` | `jobsService.js` | Inbound sync bypasses FSM entirely. |
| `authedFetch` | `apiClient.ts` | All FSM API calls use existing `authedFetch`. No new fetch wrapper. |
| `requirePermission()` | `authorization.js` | Reuse existing middleware for FSM route permission checks. |
| `authenticate` / `requireCompanyAccess` | `keycloakAuth.js` | Reuse for FSM route mounting in server.js. |
| React Query patterns | various hooks | New `useFsmEditor` and `useFsmActions` follow same `useQuery`/`useMutation` patterns. |

---

## IMG-001: Fullscreen Image Viewer

**Status:** Architecture
**Feature:** Shared fullscreen lightbox for image attachments

### 1. Overview

Extract the inline `FullscreenViewer` and `RotatableImage` from `PaymentDetailPanel.tsx` into a shared component. This enables reuse across `NoteAttachmentDisplay`, `MessageThread`, and any future attachment UI.

### 2. New Files

| File | Responsibility |
|------|---------------|
| `frontend/src/components/shared/FullscreenImageViewer.tsx` | Exported components: `FullscreenImageViewer` (overlay with navigation, rotation, thumbnails, keyboard shortcuts), `RotatableImage` (image with CSS rotation + scale compensation). Generic interface accepts `{url, filename}[]`. |

### 3. Modified Files

| File | Change | What to Preserve |
|------|--------|-----------------|
| `frontend/src/components/payments/PaymentDetailPanel.tsx` | Remove inline `FullscreenViewer` and `RotatableImage`. Import from shared. `AttachmentsSection` uses shared `FullscreenImageViewer`. | All other sections (header, invoice, metadata, etc.), `AttachmentsSection` thumbnail strip and inline preview. |

### 4. Anti-Duplication

| Existing | Reuse |
|----------|-------|
| `RotatableImage` in PaymentDetailPanel | Extract to shared, import back |
| `NoteAttachmentDisplay` | Future consumer — currently opens in new tab, can later use `FullscreenImageViewer` |

### 5. Component Interface

```typescript
interface FullscreenImageViewerProps {
    images: { url: string; filename: string }[];
    initialIndex?: number;
    initialRotation?: number;
    onClose: () => void;
    onIndexChange?: (index: number) => void;
    onRotationChange?: (rotation: number) => void;
}
```

---

## SCHED-LIST-001: Schedule List View

**Status:** Architecture
**Feature:** New "List" view mode for Schedule page — vertical job lists per technician column with date headings

---

### 1. System Overview

Frontend-only feature. No backend/database changes. Reuses existing `fetchScheduleItems` API and all Schedule infrastructure.

```
SchedulePage.tsx
├── CalendarControls.tsx  ← add 'list' to VIEW_OPTIONS
├── useScheduleData.ts   ← add 'list' to ViewMode union + dateRange/navigation
└── switch(viewMode)
    ├── ...existing views...
    └── case 'list' → <ListView />  ← NEW
```

### 2. New Files

| File | Responsibility |
|------|---------------|
| `frontend/src/components/schedule/ListView.tsx` | Multi-column list view. Provider columns (same grouping logic as TimelineWeekView). Within each column: items grouped by day with DateSeparator-style headings (Pulse pattern). Items rendered via existing `ScheduleItemCard` (non-compact, showing time slot). Supports DnD reassign between columns. |

### 3. Modified Files

| File | Change | What to Preserve |
|------|--------|-----------------|
| `frontend/src/hooks/useScheduleData.ts` | Add `'list'` to `ViewMode` union type. Add `'list'` to `dateRange` switch (same week range as `'timeline-week'`). Add `'list'` to `navigateDate` (week-like navigation). | All existing state, fetching, SSE, sidebar, filter logic. |
| `frontend/src/components/schedule/CalendarControls.tsx` | Add `{ value: 'list', label: 'List' }` to `VIEW_OPTIONS` array. | All existing controls, filters, date formatting. |
| `frontend/src/pages/SchedulePage.tsx` | Add `case 'list'` to `renderCalendarView()` switch. Import `ListView`. | All existing view rendering, sidebar, job detail, AI assistant. |

### 4. Reused Components (NO duplication)

| Component | How Reused |
|-----------|-----------|
| `ScheduleItemCard` | Renders each item tile. `compact={false}` so time slot is visible. |
| `DateSeparator` (from `frontend/src/components/pulse/DateSeparator.tsx`) | Imported for day headings — same visual as Pulse timeline. |
| `getProviderColor` | Column header color dots — same as TimelineView. |
| `dateKeyInTZ`, `formatTimeInTZ` | Timezone-aware date grouping and time display. |
| `setDragData`, `getDragData`, `hasDragData` | DnD reassign between columns — same pattern as TimelineWeekView. |

### 5. ListView Component Design

```
<div className="flex flex-col overflow-auto" style={schedSurface}>
  {/* Sticky header: provider column headers */}
  <div className="grid sticky top-0" style={gridCols}>
    {providerGroups.map(group => <ProviderHeader />)}
  </div>

  {/* Body: grid of provider columns */}
  <div className="grid flex-1" style={gridCols}>
    {providerGroups.map(group => (
      <div className="column">
        {days.map(day => {
          const dayItems = group.items.filter(byDay);
          if (dayItems.length === 0) return null;  // skip empty days
          return (
            <>
              <DateSeparator date={formatDay} />
              {dayItems.sort(byStartAt).map(item => (
                <ScheduleItemCard item={item} onClick={onSelectItem} timezone={tz} />
              ))}
            </>
          );
        })}
      </div>
    ))}
  </div>
</div>
```

Props: same as `TimelineWeekViewProps` (currentDate, items, settings, allProviders, onSelectItem, onReassign, onCreateFromSlot).

## EMAIL-001: Gmail Shared Mailbox + Email Workspace

**Status:** Architecture
**Feature:** One shared Gmail mailbox per company, managed in Settings and operated from a separate `/email` workspace with a Front-like list/thread/composer layout

---

### 1. System Overview

`EMAIL-001` is intentionally **not** an extension of the current `Pulse` contract. The existing `Pulse` stack is timeline-first for calls/SMS/voicemail, while email v1 needs a shared inbox workflow with mailbox settings, server-driven thread list queries, thread detail, and inline compose/reply.

The implementation should reuse the existing Blanc patterns:
- tenant scoping through `authenticate + requireCompanyAccess`
- company-level settings patterns already used by `/api/settings/*`
- React Query + typed frontend service wrappers
- background sync services running in the backend process

```
EmailSettingsPage.tsx
└── emailApi.getMailboxStatus()
    └── /api/settings/email                ← tenant-scoped settings route
        └── emailMailboxService
            ├── emailQueries.getMailbox()
            └── company_settings (UI prefs only)

Connect Gmail button
└── POST /api/settings/email/google/start
    └── emailMailboxService.buildAuthUrl()
        └── Google OAuth consent
            └── GET /api/email/oauth/google/callback
                └── emailMailboxService.exchangeCode()
                    ├── email_mailboxes (encrypted tokens + mailbox state)
                    └── emailSyncService.enqueueInitialSync()

EmailPage.tsx
├── useQuery(['email-mailbox'])      → GET /api/email/mailbox
├── useQuery(['email-threads', ...]) → GET /api/email/threads
├── useQuery(['email-thread', id])   → GET /api/email/threads/:id
└── compose / reply mutations        → POST /api/email/threads/compose | /reply

Background sync loop
└── emailSyncService.startScheduler()
    └── listDueMailboxes()
        └── Gmail History API / Threads API
            └── email_threads + email_messages + email_attachments + email_sync_state
```

V1 delivery model:
- backend scheduler performs incremental Gmail sync on an interval
- `/email` supports manual refresh
- SSE/realtime notifications are optional and explicitly not required for the first slice

### 2. New Files

#### 2.1 Backend

| File | Responsibility |
|------|----------------|
| `backend/src/db/emailQueries.js` | Canonical query layer for mailbox state, thread list/detail reads, idempotent upserts for threads/messages/attachments, sync checkpoints. |
| `backend/src/routes/email.js` | Tenant-scoped email workspace API: thread list, thread detail, mark read, compose, reply, attachment download proxy. |
| `backend/src/routes/email-settings.js` | Tenant-scoped settings API for mailbox status, connect/reconnect start, manual sync, disconnect. |
| `backend/src/routes/email-oauth.js` | Public Google OAuth callback route. Validates state, exchanges code, persists mailbox credentials, redirects back to `/settings/email`. |
| `backend/src/services/emailMailboxService.js` | OAuth URL generation, state signing/validation, token exchange, encrypted token persistence, mailbox lifecycle (`connected`, `reconnect_required`, `sync_error`, `disconnected`). |
| `backend/src/services/emailService.js` | Gmail API client factory, raw MIME send/reply, thread hydration after send, attachment proxy/download, body extraction helpers. |
| `backend/src/services/emailSyncService.js` | Initial backfill + incremental history sync + interval scheduler. Responsible for importing Gmail threads/messages into local tables idempotently. |

#### 2.2 Frontend

| File | Responsibility |
|------|----------------|
| `frontend/src/pages/EmailPage.tsx` | Main `/email` route. Orchestrates mailbox status, thread list, thread detail, compose/reply flows, empty/error states. |
| `frontend/src/pages/EmailSettingsPage.tsx` | Settings page for mailbox connection status, connect/reconnect/disconnect, manual sync, and sync health. |
| `frontend/src/services/emailApi.ts` | Typed frontend wrapper for `/api/settings/email` and `/api/email`. Uses existing auth-aware transport. |
| `frontend/src/components/email/MailboxRail.tsx` | Left rail: connected mailbox card, view filters, sync action, reconnect CTA if needed. |
| `frontend/src/components/email/EmailThreadList.tsx` | Middle pane: server-driven thread list with search, selected state, loading/error/empty handling. |
| `frontend/src/components/email/EmailThreadRow.tsx` | Thread preview row (sender, subject, preview, timestamp, unread, attachment indicator). |
| `frontend/src/components/email/EmailThreadPane.tsx` | Right pane shell: thread header, message stack, reply state, empty placeholders. |
| `frontend/src/components/email/EmailMessageItem.tsx` | Single message card with participants, body, attachment strip, inbound/outbound styling. |
| `frontend/src/components/email/EmailComposer.tsx` | New email / reply composer with To, CC, Subject, body, file attachments, send state. |

### 3. Modified Files

#### 3.1 Backend

| File | Change | What to Preserve |
|------|--------|------------------|
| `src/server.js` | Mount `/api/settings/email`, `/api/email`, and `/api/email/oauth/google/callback`; start the email sync scheduler at boot. | All existing route mounts, auth middleware, SSE infrastructure, and current workers. No changes to Twilio/Pulse route behavior. |

#### 3.2 Frontend

| File | Change | What to Preserve |
|------|--------|------------------|
| `frontend/src/App.tsx` | Add routes for `/settings/email` and `/email` with existing `ProtectedRoute` permission model. | Existing top-level navigation, default route, and current page routing. `/email` must not become a top-nav tab. |
| `frontend/src/components/layout/appLayoutNavigation.tsx` | Add `Email` to the Settings dropdown only. | Existing top nav tabs remain unchanged (`Pulse`, `Leads`, `Jobs`, `Schedule`, `Contacts`, `Payments`). |

### 4. Database Schema

#### Migration 079: `079_create_email_tables.sql`

**New table:** `email_mailboxes`

Purpose: one shared provider mailbox per company with encrypted OAuth credentials and mailbox sync state.

| Column | Type | Notes |
|--------|------|------|
| `id` | UUID PK | `gen_random_uuid()` |
| `company_id` | UUID FK | `REFERENCES companies(id) ON DELETE CASCADE` |
| `provider` | TEXT | CHECK = `gmail` |
| `email_address` | TEXT | Connected company mailbox address |
| `display_name` | TEXT | Optional display name from Google profile |
| `provider_account_id` | TEXT | Stable Google account identifier when available |
| `status` | TEXT | `connected`, `reconnect_required`, `sync_error`, `disconnected` |
| `access_token_encrypted` | TEXT | AES-256-GCM encrypted |
| `refresh_token_encrypted` | TEXT | AES-256-GCM encrypted |
| `token_expires_at` | TIMESTAMPTZ | For proactive refresh |
| `history_id` | TEXT | Last known Gmail history checkpoint |
| `last_synced_at` | TIMESTAMPTZ | Last successful sync |
| `last_sync_status` | TEXT | `ok`, `running`, `error`, `backfill_required` |
| `last_sync_error` | TEXT | Last sync failure message |
| `created_by` | TEXT | user id/email |
| `updated_by` | TEXT | user id/email |
| `created_at` | TIMESTAMPTZ | default now() |
| `updated_at` | TIMESTAMPTZ | default now() |

Constraints / indexes:
- UNIQUE (`company_id`, `provider`)
- INDEX on (`status`, `last_synced_at`)
- V1 invariant: max one Gmail mailbox per company

**New table:** `email_threads`

Purpose: local searchable thread index for `/email`.

| Column | Type | Notes |
|--------|------|------|
| `id` | BIGSERIAL PK | Local thread id used by API/frontend |
| `company_id` | UUID FK | Tenant isolation |
| `mailbox_id` | UUID FK | `REFERENCES email_mailboxes(id) ON DELETE CASCADE` |
| `provider_thread_id` | TEXT | Gmail thread id |
| `subject` | TEXT | Normalized display subject |
| `participants_json` | JSONB | Cached participants for list rendering |
| `last_message_at` | TIMESTAMPTZ | Sort key for thread list |
| `last_message_preview` | TEXT | Snippet for middle pane |
| `last_message_direction` | TEXT | `inbound` / `outbound` |
| `last_message_from` | TEXT | Cached sender display |
| `unread_count` | INTEGER | Internal unread state |
| `has_attachments` | BOOLEAN | Cached rollup |
| `message_count` | INTEGER | Cached rollup |
| `created_at` | TIMESTAMPTZ | default now() |
| `updated_at` | TIMESTAMPTZ | default now() |

Constraints / indexes:
- UNIQUE (`company_id`, `provider_thread_id`)
- INDEX on (`company_id`, `last_message_at DESC`)
- INDEX on (`company_id`, `unread_count`)
- INDEX on (`company_id`, `has_attachments`)

**New table:** `email_messages`

Purpose: normalized inbound/outbound messages inside each synced thread.

| Column | Type | Notes |
|--------|------|------|
| `id` | BIGSERIAL PK | Local message id |
| `company_id` | UUID FK | Tenant isolation |
| `mailbox_id` | UUID FK | Shared mailbox owner |
| `thread_id` | BIGINT FK | `REFERENCES email_threads(id) ON DELETE CASCADE` |
| `provider_message_id` | TEXT | Gmail message id |
| `provider_thread_id` | TEXT | Redundant but useful for sync |
| `message_id_header` | TEXT | RFC 5322 `Message-ID` |
| `in_reply_to_header` | TEXT | Header for fallback threading |
| `references_header` | TEXT | Raw references string |
| `direction` | TEXT | `inbound` / `outbound` |
| `from_name` | TEXT | Parsed sender name |
| `from_email` | TEXT | Parsed sender email |
| `to_recipients_json` | JSONB | Array of `{name,email}` |
| `cc_recipients_json` | JSONB | Array of `{name,email}` |
| `subject` | TEXT | Message subject |
| `snippet` | TEXT | Gmail snippet |
| `body_text` | TEXT | Plain text body |
| `body_html` | TEXT | HTML body (nullable) |
| `has_attachments` | BOOLEAN | Cached flag |
| `gmail_internal_at` | TIMESTAMPTZ | Provider message timestamp |
| `sent_by_user_id` | TEXT | Blanc actor for outbound messages |
| `sent_by_user_email` | TEXT | Blanc actor email for outbound messages |
| `created_at` | TIMESTAMPTZ | default now() |
| `updated_at` | TIMESTAMPTZ | default now() |

Constraints / indexes:
- UNIQUE (`company_id`, `provider_message_id`)
- INDEX on (`thread_id`, `gmail_internal_at`)
- INDEX on (`company_id`, `from_email`)

**New table:** `email_attachments`

Purpose: attachment metadata for per-message rendering and download proxying.

| Column | Type | Notes |
|--------|------|------|
| `id` | BIGSERIAL PK | Local attachment id |
| `company_id` | UUID FK | Tenant isolation |
| `message_id` | BIGINT FK | `REFERENCES email_messages(id) ON DELETE CASCADE` |
| `provider_attachment_id` | TEXT | Gmail attachment id |
| `part_id` | TEXT | Gmail MIME part id |
| `file_name` | TEXT | Display name |
| `content_type` | TEXT | MIME type |
| `file_size` | INTEGER | Size in bytes |
| `is_inline` | BOOLEAN | Inline image vs file attachment |
| `content_id` | TEXT | Inline CID when present |
| `sort_order` | INTEGER | Stable display order |
| `created_at` | TIMESTAMPTZ | default now() |

Indexes:
- INDEX on (`message_id`, `sort_order`)
- INDEX on (`company_id`, `content_type`)

**New table:** `email_sync_state`

Purpose: sync bookkeeping decoupled from mailbox credentials.

| Column | Type | Notes |
|--------|------|------|
| `mailbox_id` | UUID PK/FK | `REFERENCES email_mailboxes(id) ON DELETE CASCADE` |
| `company_id` | UUID FK | Tenant isolation |
| `last_history_id` | TEXT | Successful Gmail history checkpoint |
| `initial_backfill_completed_at` | TIMESTAMPTZ | nullable |
| `last_sync_started_at` | TIMESTAMPTZ | nullable |
| `last_sync_finished_at` | TIMESTAMPTZ | nullable |
| `last_sync_error` | TEXT | nullable |
| `updated_at` | TIMESTAMPTZ | default now() |

Additional note:
- `company_settings` may store non-secret email workspace preferences (e.g. default list view), but OAuth secrets must live only in `email_mailboxes`.

### 5. API Design

#### 5.1 Settings + OAuth

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/settings/email` | `tenant.integrations.manage` | Returns mailbox status, connected email, sync health, and whether `/email` should show reconnect CTA. |
| `POST /api/settings/email/google/start` | `tenant.integrations.manage` | Returns `{ ok, data: { auth_url } }` for browser redirect to Google OAuth. |
| `POST /api/settings/email/disconnect` | `tenant.integrations.manage` | Revokes/disables the current mailbox and marks it `disconnected`. |
| `POST /api/settings/email/sync` | `tenant.integrations.manage` | Triggers an immediate sync for the connected mailbox. |
| `GET /api/email/oauth/google/callback` | public | Handles Google redirect, validates signed `state`, persists mailbox, then redirects to `/settings/email?connected=1` or `?error=...`. |

`GET /api/settings/email` response shape:

```json
{
  "ok": true,
  "data": {
    "mailbox": {
      "provider": "gmail",
      "email_address": "support@company.com",
      "status": "connected",
      "last_synced_at": "2026-04-17T14:20:00Z",
      "last_sync_status": "ok",
      "last_sync_error": null
    }
  }
}
```

#### 5.2 Email workspace

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/email/threads` | `messages.view_internal` | Server-driven thread list with `view`, `q`, `cursor`, `limit`. |
| `GET /api/email/mailbox` | `messages.view_internal` | Returns non-secret mailbox state needed by `/email` (connected/reconnect_required/sync_error/disconnected). |
| `GET /api/email/threads/:threadId` | `messages.view_internal` | Full thread detail + messages + attachments. |
| `POST /api/email/threads/:threadId/read` | `messages.view_internal` | Marks a thread as read in Blanc local state. |
| `POST /api/email/threads/compose` | `messages.send` | Sends a new email from the shared mailbox. |
| `POST /api/email/threads/:threadId/reply` | `messages.send` | Sends a reply in an existing Gmail thread. |
| `GET /api/email/attachments/:attachmentId/download` | `messages.view_internal` | Streams/downloads the attachment through the backend. |

Thread list query contract:
- `view=all|inbox|sent|unread|attachments`
- `q` = free-text search
- `cursor` = opaque pagination value based on `last_message_at` + `id`
- sorted by `last_message_at DESC`

Compose/reply requests use `multipart/form-data`:
- `to[]`, `cc[]`, `subject`, `body`, `files[]`
- reply endpoint derives Gmail thread context from `threadId`

#### 5.3 Error semantics

- `400` for malformed recipients, invalid attachment payload, or compose/reply requests with missing required fields
- `401/403` through existing auth middleware
- `404` for missing mailbox, thread, or attachment in the current company scope
- `409` for mailbox state conflicts (e.g. trying to send while mailbox is `reconnect_required`)
- `502` for Gmail API failures that cannot be mapped to a local validation error

### 6. Frontend Component Tree

```
EmailPage
├── MailboxRail
│   ├── ConnectedMailboxCard
│   ├── ViewFilterList
│   └── ManualSyncButton
├── EmailThreadList
│   └── EmailThreadRow
└── EmailThreadPane
    ├── EmailThreadHeader
    ├── EmailMessageItem*
    │   └── AttachmentStrip
    ├── EmailComposer
    └── ThreadEmptyState

EmailSettingsPage
├── MailboxStatusCard
├── ConnectGmailCard
├── ReconnectWarningCard
└── SyncHealthCard
```

### 7. Data Flow

#### 7.1 Connect Gmail

1. Admin opens `/settings/email`.
2. Frontend requests `GET /api/settings/email`.
3. Clicking `Connect Gmail` calls `POST /api/settings/email/google/start`.
4. Backend returns `auth_url`; frontend performs `window.location.assign(auth_url)`.
5. Google redirects to `/api/email/oauth/google/callback`.
6. Backend validates signed `state`, exchanges the code, persists encrypted tokens in `email_mailboxes`, creates/updates `email_sync_state`, and redirects back to `/settings/email`.
7. Backend triggers initial backfill asynchronously.

#### 7.2 Initial backfill + incremental sync

1. `emailSyncService.startScheduler()` runs on server boot.
2. Scheduler queries `email_mailboxes` for connected mailboxes due for sync.
3. If no `last_history_id` exists, service performs bounded backfill (`EMAIL_SYNC_LOOKBACK_DAYS`, default 90).
4. After backfill, service stores `last_history_id` and marks `initial_backfill_completed_at`.
5. Subsequent runs use Gmail History API for incremental updates.
6. Each synced thread/message/attachment is upserted idempotently through `emailQueries`.
7. Failures update mailbox status to `sync_error` or `reconnect_required` without deleting existing local email data.

#### 7.3 Read/search/list

1. `/email` loads mailbox status via `GET /api/email/mailbox` and current thread list query in parallel.
2. Thread list comes from local Postgres tables, not live Gmail queries.
3. Search is performed server-side over local thread/message/attachment metadata within the current company only.
4. Opening a thread loads detail on demand and calls `POST /read` if `unread_count > 0`.
5. Thread pane renders message bodies and attachment metadata; attachment content is fetched only when requested.

#### 7.4 Compose / reply

1. Frontend submits `multipart/form-data`.
2. `emailService` validates mailbox state and recipients, builds a raw MIME message, and sends via Gmail API.
3. After send, backend fetches the sent Gmail message/thread to hydrate canonical provider ids and attachment metadata.
4. Backend upserts local thread/message records and returns the updated thread snapshot.
5. Frontend invalidates thread list + thread detail queries and keeps the user in the same workspace.

### 8. Integration Points

#### 8.1 Gmail / Google Workspace

Required Gmail capabilities:
- OAuth 2.0 authorization code flow
- `users.messages.send`
- `users.threads.get` / `users.threads.list`
- `users.history.list`
- `users.messages.attachments.get`

V1 assumptions:
- one shared mailbox per company
- no delegated mailboxes
- no aliases/routing rules product surface

#### 8.2 Existing Blanc auth/settings patterns

- Settings routes follow the same company-scoped pattern as `action-required-settings.js`
- UI routes use existing `ProtectedRoute`
- `company_id` always comes from `req.companyFilter?.company_id`

#### 8.3 Contacts / Leads / Jobs / Pulse deep-links

- Email data model must not depend on existing CRM linkage to function.
- When a contact/lead/job match is available later, `/email` may show deep-links to existing entities or to `/pulse/timeline/:id`.
- No direct mutation of `Pulse` timeline tables is part of this architecture slice.

#### 8.4 Realtime

- No required changes to `frontend/src/hooks/useRealtimeEvents.ts` or SSE taxonomy in v1.
- If later needed, the safest extension point is new `email.thread_updated` / `email.mailbox_state_changed` events via `realtimeService`.

### 9. Dependencies and Environment

#### Backend dependencies (root `package.json`)

- Add `googleapis` for OAuth + Gmail API access
- No new frontend UI dependency required for v1

#### New environment variables

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth client id |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | Backend callback URL for Gmail connect |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | 32-byte secret for encrypting Gmail tokens at rest |
| `EMAIL_SYNC_INTERVAL_MS` | Scheduler interval (default 120000) |
| `EMAIL_SYNC_LOOKBACK_DAYS` | Initial backfill window (default 90) |

### 10. Extend vs. Do Not Duplicate

#### Extend (modify in place)

| File | Why |
|------|-----|
| `src/server.js` | Canonical route mount point and scheduler startup location |
| `frontend/src/App.tsx` | Canonical route registration |
| `frontend/src/components/layout/appLayoutNavigation.tsx` | Canonical Settings menu |

#### Reuse

| Existing module | Reuse strategy |
|----------------|----------------|
| `frontend/src/services/apiClient.ts` | Auth-aware transport for new email API wrapper |
| `frontend/src/components/shared/FullscreenImageViewer.tsx` | Optional image attachment preview in thread pane |
| `backend/src/services/realtimeService.js` | Future extension point only; no mandatory v1 change |
| `backend/src/services/storageService.js` | Not required for v1 attachment persistence; keep as future option only if Gmail proxying proves insufficient |

#### Do NOT duplicate

| Existing module | Why not reuse directly |
|----------------|------------------------|
| `backend/src/routes/messaging.js` + `conversationsService.js` | Twilio Conversations SMS domain; wrong provider, wrong schema, wrong threading model |
| `frontend/src/pages/MessagesPage.tsx` | Two-pane SMS UI; not suitable for Front-like shared email workspace |
| `backend/src/routes/pulse.js` / `frontend/src/pages/PulsePage.tsx` | `Pulse` remains call/SMS timeline-first; email is a separate workspace in v1 |

---

## F014 — Ads Analytics Microservice

### 1. Goals

Provide a read-only, token-authenticated HTTP surface that returns Blanc funnel data (calls → leads → jobs → revenue) for a requested period. First consumer is the ABC Homes Google Ads weekly report script. No new auth mechanism, no new tables, no mutations — the feature is a thin SQL aggregation layer over existing data.

### 2. Route Registration (`src/server.js`)

`src/server.js` is the canonical mount point for integration routes. One `require`, one `app.use(...)` on the existing `/api/v1/integrations` base path, plus a one-line log update. Middleware chain inside the router mirrors `integrations-leads` (`rejectLegacyAuth → validateHeaders → authenticateIntegration → rateLimiter`).

### 3. Service Layer (`backend/src/services/analyticsService.js`)

Single service module, four public functions:

| Function | Endpoint | Purpose |
|----------|----------|---------|
| `getSummary` | `GET /summary` | Aggregated funnel metrics |
| `listCalls` | `GET /calls` | Paged inbound calls to tracking DID |
| `listLeads` | `GET /leads` | Paged leads in period with `tracking_call_sid` attribution |
| `listJobs` | `GET /jobs` | Paged jobs whose lead was created in the period |

All four share one canonical CTE trio:

```
tracked_calls      — inbound calls to tracking DID, TZ-adjusted period
period_leads       — leads with created_at in the period
attributed_leads   — leads joined to tracked_calls by last-10-digit phone match within 24h
```

This guarantees a single source of truth — numbers in `/summary` cannot diverge from the rows returned by `/calls|/leads|/jobs`.

### 4. Auth & Scopes (`backend/src/middleware/integrationsAuth.js`)

Reused unchanged. Scopes remain a JSONB array in `api_integrations.scopes`. Migration 080 is a **no-op DDL** whose only purpose is to add a `COMMENT ON COLUMN` that documents the known scopes (`leads:create`, `analytics:read`). Onboarding tooling can scan the migrations directory for the canonical scope list.

### 5. Key Issuance (`backend/scripts/issue-analytics-key.js`)

One-off CLI: generates a random key_id + 32-byte URL-safe secret, hashes secret with the server pepper using SHA-256, inserts into `api_integrations` with `scopes=['analytics:read']`, prints the secret **once**. Matches the existing peppered-hash pattern in `integrationsAuth.js`.

### 6. Error Model

Same envelope as `integrations-leads`: `{ success, code, message, request_id }`.

| HTTP | `code` | Trigger |
|------|--------|---------|
| 400 | `PERIOD_REQUIRED` | `from` / `to` missing or malformed |
| 400 | `PERIOD_TOO_LARGE` | `to - from > 92 days` |
| 401 | `AUTH_*` | from `integrationsAuth` |
| 403 | `SCOPE_INSUFFICIENT` | `analytics:read` missing from scopes |
| 429 | `RATE_LIMITED` | from `rateLimiter` |
| 500 | `INTERNAL_ERROR` | uncaught service/DB failure |

### 7. Timezone & Period Semantics

- All date math is pinned to `America/New_York` (ABC Homes operating TZ).
- `from` and `to` are inclusive calendar days; converted to a half-open UTC range in SQL via `($to::date + interval '1 day') AT TIME ZONE 'America/New_York'`.
- JS-side validation caps the range at 92 days and rejects reversed ranges with `PERIOD_REQUIRED` / `PERIOD_TOO_LARGE`.

### 8. Extend vs. Do Not Duplicate

#### Extend (modify in place)

| File | Why |
|------|-----|
| `src/server.js` | Canonical integration route mount point. |

#### Reuse

| Existing module | Reuse strategy |
|----------------|----------------|
| `backend/src/middleware/integrationsAuth.js` | Auth chain identical to `integrations-leads` — no fork. |
| `backend/src/middleware/rateLimiter.js` | Same per-key/IP budget. |
| `backend/src/db/connection.js` | Pool singleton used by every service. |

#### Do NOT duplicate

| Existing module | Why not reuse directly |
|----------------|------------------------|
| `backend/src/routes/calls.js` / `backend/src/services/callsService.js` | Internal Pulse routes with Keycloak auth; wrong auth context. |
| `backend/src/routes/leads.js` | Internal leads CRUD with Keycloak auth and write ops; wrong surface for external reporting. |
| `backend/src/routes/integrations-leads.js` | Lead-creation semantics, not read aggregation. Mirror the chain but keep router separate. |

### 9. Risks & Watch-outs (post-deploy)

- **Attribution gap** — leads where the join window misses the call (> 24h, wrong DID, contact-based lead without a tracking call). If `tracking_call_sid IS NULL` ratio > 20 %, revisit the join rule.
- **Invoice format** — `jobs.invoice_total` is TEXT (`"$1,234.00"`); current regex strips non-`[0-9.]`, which breaks on locales using `,` as decimal separator. Single-tenant US-only today, but flag if multi-locale comes in.
- **TZ drift** — hardcoded `America/New_York`. If a second tenant joins with a different TZ, move to `companies.timezone`.
- **Rate limit** — default 60 req/min per key is fine for a weekly cron; widen via `RATE_LIMIT_MAX_PER_KEY` when dashboards start polling.

---

## TWC-001 — Twilio API Client Singleton

### 1. Goal
Eliminate per-function instantiation of the Twilio Node SDK. A single REST client per process owns the only `https.Agent` keep-alive pool toward `api.twilio.com`. This collapses the ~199 idle ESTABLISHED outbound sockets observed in production to a small bounded set, and removes a class of CLOSE_WAIT leaks where short-lived clients abandoned their sockets.

### 2. Module map (after change)

```
                   ┌────────────────────────────────────────────┐
                   │ backend/src/services/twilioClient.js  (NEW)│
                   │   getTwilioClient() — lazy, memoised       │
                   │   Single twilio(sid, token) per process    │
                   └────────────────────────────────────────────┘
                              │ used by
   ┌──────────────────────────┼──────────────────────────────┐
   │                          │                              │
reconcileStale.js     callAvailability.js        inboxWorker.js
phoneSettings.js      conversationsService.js    twilioSync.js
                                                  reconcileService.js
```

### 3. Components

| Component | Status | Responsibility |
|---|---|---|
| `backend/src/services/twilioClient.js` | NEW | Sole owner of `twilio(sid, token)`. Exports `getTwilioClient()` that lazily constructs and memoises the client. Throws `Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required')` on first access if env is missing. Internal `let _client = null`; idempotent. |
| `backend/src/services/reconcileStale.js` | CHANGED | `fetchAndUpdateFromTwilio` no longer constructs a fresh client; calls `getTwilioClient()` instead. |
| `backend/src/services/callAvailability.js` | CHANGED | Per-call `twilio()` removed; uses `getTwilioClient()`. |
| `backend/src/services/inboxWorker.js` | CHANGED | Per-event `twilio()` removed; uses `getTwilioClient()`. |
| `backend/src/routes/phoneSettings.js` | CHANGED | Per-request `twilio()` removed; uses `getTwilioClient()`. |
| `backend/src/services/conversationsService.js` | CHANGED | Existing module-level `client` switched to `getTwilioClient()` (preserves API). |
| `backend/src/services/twilioSync.js` | CHANGED | Same. |
| `backend/src/services/reconcileService.js` | CHANGED | Same. |
| `backend/src/webhooks/twilioWebhooks.js` | UNTOUCHED | Uses `twilio.validateRequest()` static helper, no REST client. |
| `backend/src/webhooks/conversationsWebhooks.js` | UNTOUCHED | Same. |
| `src/routes/webhooks.js` | UNTOUCHED | Same. |
| `backend/src/services/voiceService.js` | UNTOUCHED | Uses `twilio.jwt.AccessToken` factory, no REST client. |

### 4. API contract

`getTwilioClient()` returns the Twilio REST client whose surface (`client.calls`, `client.lookups`, `client.conversations`, `client.messages`, `client.api`) is identical to what `twilio(sid, token)` returns today. No call-site changes beyond import + assignment.

### 5. Failure mode

| Scenario | Behavior |
|---|---|
| Missing `TWILIO_ACCOUNT_SID` or `TWILIO_AUTH_TOKEN` on first call | `Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required')` thrown synchronously by `getTwilioClient()`. |
| Subsequent calls when env present | Return the memoised instance (object identity stable). |
| Tests / CLI without env | Module-load does not throw; only call-sites that actually use Twilio fail at call time, which preserves existing behavior of the migrated modules. |

### 6. Acceptance check (operational)

Steady-state on prod:
```
ssh deploy@108.61.87.117 "cd /opt/albusto && docker compose exec -T app grep ' 01 ' /proc/net/tcp" | awk '$3 ~ /:01BB$/' | wc -l
```
should report ≤ ~20 (was ≥ 199). CLOSE_WAIT count should be 0–2 (was 28).

### 7. Out of scope

- Per-tenant Twilio credentials (analogue of `getClientForCompany` in `zenbookerClient.js`) — left as future work; current Blanc deployment uses a single Twilio account.
- Custom `https.Agent` tuning (maxSockets, freeSocketTimeout) — Twilio SDK defaults are sufficient once a single agent is shared.
- Untangling Twilio webhook signature validation — orthogonal.


---

## F015: Document Templates Customization

**Related requirements:** `docs/requirements.md#F015`
**Related spec:** `docs/specs/F015-document-templates.md`

### 1. Goals
1. Replace hardcoded constants in `backend/src/services/estimatePdfService.js` and `frontend/src/components/estimates/EstimatePreviewDialog.tsx` with a versioned, per-company **template descriptor** stored in PostgreSQL.
2. Single source of truth shared between PDF renderer and HTML preview.
3. Designed so adding `invoice` and `work_order` document types is data + small adapter, not a refactor.

### 2. New components

```
[frontend]
  pages/DocumentTemplatesPage.tsx       (list)
  pages/DocumentTemplateEditorPage.tsx  (editor + live preview)
  services/documentTemplatesApi.ts
  components/documents/TemplateEditor/  (form-based editor blocks)
[backend]
  routes/document-templates.js
  services/documentTemplatesService.js  (resolve, validate, CRUD orchestration)
  services/documentTemplates/
    factory.js                          (factory descriptors per type)
    schema/v1.json                      (Ajv schema for descriptor v1)
    rendererRegistry.js                 (document_type -> renderer adapter)
    estimateAdapter.js                  (descriptor + estimate -> PDF buffer)
  db/documentTemplatesQueries.js
[shared]
  backend/db/migrations/084_create_document_templates.sql
```

### 3. Data model

```sql
CREATE TABLE document_templates (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    document_type   TEXT NOT NULL CHECK (document_type IN ('estimate')),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    is_default      BOOLEAN NOT NULL DEFAULT false,
    schema_version  INTEGER NOT NULL DEFAULT 1,
    content         JSONB NOT NULL,
    archived_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, document_type, slug)
);

CREATE UNIQUE INDEX idx_doc_templates_one_default
    ON document_templates(company_id, document_type)
    WHERE is_default = true AND archived_at IS NULL;

CREATE INDEX idx_doc_templates_lookup
    ON document_templates(company_id, document_type, archived_at);
```

Seed step inside the same migration: `INSERT INTO document_templates (company_id, document_type, name, slug, is_default, schema_version, content) SELECT c.id, 'estimate', 'Default', 'default', true, 1, '<factory_descriptor_json>'::jsonb FROM companies c WHERE NOT EXISTS (SELECT 1 FROM document_templates dt WHERE dt.company_id = c.id AND dt.document_type='estimate');`

### 4. Descriptor schema (v1)

JSON Schema lives at `backend/src/services/documentTemplates/schema/v1.json`. Top-level keys: `schema_version` (const 1), `brand`, `theme`, `sections[]`, `footer`. Validated server-side with Ajv on every write; the same schema is consumed by the frontend (imported as JSON, used for typed form state via `json-schema-to-ts` or hand-mirrored TypeScript type).

### 5. Renderer integration

**Before (current):**
```
routes/estimates.js  -> estimatesService.generatePdf -> renderEstimatePdf(estimate)
                                                       └ uses module constants
```

**After:**
```
routes/estimates.js -> estimatesService.generatePdf
  -> documentTemplatesService.resolveTemplate(company_id, 'estimate')
  -> rendererRegistry.get('estimate').render(estimate, descriptor)
     └ same PdfCanvas internals, but reads brand/theme/sections from descriptor
     └ falls back to `factory.estimate()` if descriptor missing
```

`estimatePdfService.js` is refactored so all references to `COMPANY_PROFILE`, `DEFAULT_TERMS_AND_WARRANTY`, `COLORS` are replaced with reads from a `descriptor` parameter. The legacy module exports remain (re-exporting `factory.estimate().brand` / `factory.estimate().sections.find('terms').body_md`) so any external consumers keep working until they migrate.

### 6. Backend module layout (mirrors marketplace pattern)

| File | Purpose |
|---|---|
| `backend/src/db/documentTemplatesQueries.js` | Parameterized SQL: `listByType`, `getByIdScoped`, `update`, `resetToFactory`, `getDefaultByType`. All filter by `company_id`. |
| `backend/src/services/documentTemplatesService.js` | Orchestration, validation (Ajv), error class `DocumentTemplateServiceError`. Public `resolveTemplate(companyId, type)` used by renderer. |
| `backend/src/services/documentTemplates/factory.js` | Pure: returns frozen factory descriptor for a given `document_type`. |
| `backend/src/services/documentTemplates/rendererRegistry.js` | `register(type, adapter)` / `get(type)`. Adapter contract: `(estimate, descriptor) => Buffer`. |
| `backend/src/services/documentTemplates/estimateAdapter.js` | Wraps `estimatePdfService.renderEstimatePdf` so the registry call is uniform. |
| `backend/src/routes/document-templates.js` | Express router; `authenticate, requireCompanyAccess, requirePermission('tenant.documents.manage')` applied at mount. |

Mount in `src/server.js` next to marketplace:
```js
app.use('/api/document-templates',
    authenticate,
    requirePermission('tenant.documents.manage'),
    requireCompanyAccess,
    documentTemplatesRouter);
```

### 7. Frontend

- `frontend/src/services/documentTemplatesApi.ts` — typed wrapper over the new endpoints (uses `authedFetch`).
- `frontend/src/pages/DocumentTemplatesPage.tsx` — list grouped by `document_type`. Reuses table primitives from `IntegrationsPage`.
- `frontend/src/pages/DocumentTemplateEditorPage.tsx` — form editor with sections (Brand / Theme / Sections / Terms / Footer); right pane is a live preview component that takes the in-memory descriptor and renders an HTML approximation (same component used by `EstimatePreviewDialog` post-refactor).
- `EstimatePreviewDialog.tsx` is refactored: `DEFAULT_TERMS_AND_WARRANTY` removed; the dialog fetches the resolved descriptor via the same render endpoint or accepts it as a prop from the parent.

### 8. Permission

A new permission key `tenant.documents.manage` is added. P0 maps it to the same role as `tenant.integrations.manage` (admin). Add it to the role bootstrap migration; the route enforces it directly.

### 9. Backwards compatibility & rollback

- Migration is idempotent (`IF NOT EXISTS`, `WHERE NOT EXISTS` for seed).
- If the descriptor row is missing or fails Ajv validation, renderer falls back to `factory.estimate()` — never throws.
- Reverting the migration drops the table; renderer continues to work because it always falls back to factory.

### 10. Out of scope
- Multiple templates per type (P1): UI/route already takes `id`, but P0 always resolves the `is_default = true` row.
- Asset upload (logo): P0 stores `logo_url` string only.
- Template versioning UI (history): table has `archived_at`; P0 only uses it for soft-delete future.

### 11. Touched/protected files
**Modified:** `backend/src/services/estimatePdfService.js`, `backend/src/services/estimatesService.js` (only the `generatePdf` path), `frontend/src/components/estimates/EstimatePreviewDialog.tsx`, `src/server.js` (mount only).
**Protected (must not change):** `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, existing migration files 001-083.

## F016: VAPI AI — Marketplace + Call Flow Gating

### Новые файлы

| Файл | Назначение |
|------|-----------|
| `backend/db/migrations/088_seed_vapi_ai_marketplace_app.sql` | Регистрирует VAPI AI в marketplace_apps (provisioning_mode: none, category: telephony) |
| `frontend/src/services/vapiApi.ts` | Типизированный API клиент: getConnections, createConnection, createResource |
| `frontend/src/pages/VapiSettingsPage.tsx` | Полноценная страница настройки VAPI по адресу `/settings/integrations/vapi-ai` |

### Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `backend/src/db/marketplaceQueries.js` | Добавить `readMigration('088_seed_vapi_ai_marketplace_app.sql')` в ensureMarketplaceSchema |
| `frontend/src/pages/IntegrationsPage.tsx` | На плитке VAPI (app_key === 'vapi-ai') кнопка "Configure"/"Manage" → navigate('/settings/integrations/vapi-ai') вместо generic dialog |
| `frontend/src/App.tsx` | Добавить роут `/settings/integrations/vapi-ai` → `<VapiSettingsPage />` |
| `frontend/src/pages/telephony/CallFlowBuilderPage.tsx` | useEffect: GET /api/vapi/connections; если нет active — исключить vapi_agent из insert picker |

### Страница VapiSettingsPage

Секции:
1. **API Connection** — API Key (masked если уже сохранён), Display Name, Environment (prod/dev), кнопка "Verify & Connect" → POST /api/vapi/connections
2. **SIP Resource** (появляется после успешного connection) — SIP URI, Server URL, кнопка "Save" → POST /api/vapi/resources
3. **Finish Setup** — кнопка "Finish" → POST /api/marketplace/apps/vapi-ai/install → redirect обратно на /settings/integrations

Если VAPI уже подключён (active installation + active connection): страница в режиме просмотра с кнопкой "Disconnect".

### Поток подключения (frontend → backend)

```
navigate(/settings/integrations/vapi-ai)
  ↓
1. POST /api/vapi/connections   { api_key, display_name, environment }
   → provider_connections record (status: active) + validate key vs Vapi API
2. POST /api/vapi/resources     { provider_connection_id, sip_uri, server_url }
   → vapi_tenant_resources record
3. POST /api/marketplace/apps/vapi-ai/install  {}
   → marketplace_installations record (status: connected, provisioning_mode: none)
   → navigate(/settings/integrations)
```

### Поведение плитки VAPI в маркетплейсе

| Статус installation | Кнопка | Действие |
|---------------------|--------|---------|
| нет / Available | "Configure" | navigate('/settings/integrations/vapi-ai') |
| connected | "Manage" | navigate('/settings/integrations/vapi-ai') |
| provisioning_failed | "Manage" | navigate('/settings/integrations/vapi-ai') |

Generic `MarketplaceConnectDialog` и `MarketplaceDisconnectDialog` НЕ используются для VAPI.

### Гейтинг ноды в Call Flow Builder

```
GET /api/vapi/connections
  → [] или только non-active записи → vapi_agent скрыт из INSERT picker
  → хотя бы одна status='active'   → vapi_agent доступен
```

### Middleware (унаследованы от существующих роутов)
- `/api/vapi/*` — `authenticate + requireCompanyAccess`
- `/api/marketplace/*` — `authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess`

## F017: Согласованность Softphone и User Groups

**Спецификация:** `docs/specs/F017-telephony-groups-softphone-consolidation.md`

### Ключевая архитектурная проблема: два источника правды о номерах

| Таблица | Назначение сейчас | Решение F017 |
|---|---|---|
| `phone_number_settings` (phone_number UNIQUE, routing_mode, client_identity) | Используется webhook'ом для inbound-маршрутизации | **Авторитетная** таблица маршрутизации. Добавляется `group_id`. `routing_mode` становится производным от наличия `group_id` |
| `user_group_numbers` (group_id, phone_number) | Привязка номеров к группе из формы UserGroups | Поверхность редактирования; запись сквозная в `phone_number_settings.group_id`. Остаётся как удобный per-group список, синхронизируется |

**Решение:** единый источник привязки номер→группа — `phone_number_settings.group_id`. Форма группы и страница Phone Numbers пишут в него. `user_group_numbers` синхронизируется триггером/сервисом или становится представлением (decision на этапе Spec).

### Изменения схемы БД (через явные миграции)

```
Migration NNN_f017_telephony_routing.sql:
  ALTER TABLE phone_number_settings
    ADD COLUMN group_id TEXT REFERENCES user_groups(id) ON DELETE SET NULL;
  CREATE INDEX idx_pns_group ON phone_number_settings(group_id);

  -- F-FLOW-10: единственная стратегия
  ALTER TABLE user_groups ALTER COLUMN strategy SET DEFAULT 'Simultaneous';
  UPDATE user_groups SET strategy = 'Simultaneous';

  -- F-ROU-05: одна актуальная версия flow (status больше не управляет исполнением)
  -- колонку status оставляем (обратная совместимость), но рантайм её игнорирует

  -- F-INC-05: состояние исполнения flow
  CREATE TABLE call_flow_executions (
    id              TEXT PRIMARY KEY,
    company_id      TEXT NOT NULL,
    call_sid        TEXT NOT NULL,
    group_id        TEXT REFERENCES user_groups(id) ON DELETE SET NULL,
    flow_id         TEXT,
    current_node_id TEXT,
    context_json    TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'active',  -- active | completed | voicemail | failed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_cfe_call_sid ON call_flow_executions(call_sid);
  CREATE INDEX idx_cfe_company ON call_flow_executions(company_id);
```

### Новые компоненты

**Backend:**
- `backend/src/services/callFlowRuntime.js` — исполнение SCXML-flow при звонке. Функции: `startExecution(callSid, groupId)`, `advance(callSid, event)`, `nodeToTwiml(node, context)`. Парсит `graph_json`, ведёт состояние в `call_flow_executions`, генерирует TwiML по типу ноды (greeting/queue/voicemail/transfer/branch/hangup/vapi_agent).
- `backend/src/services/groupRouting.js` — резолв номер→группа→flow→доступные агенты. `resolveGroupForNumber(toNumber)`, `availableAgentsForGroup(groupId)` (фильтр по SSE-статусу available).
- `backend/src/services/agentPresence.js` — реестр статусов агентов (available/on_call/offline) в памяти + SSE-broadcast. Источник: события Twilio Device + активные звонки.

**Backend routes (расширение существующих):**
- `GET /api/user-groups/my` (новый в `userGroups.js`) — группы текущего пользователя по `req.companyFilter.company_id` + членство.
- `GET /api/voice/blanc-numbers` (изменение в `voice.js`) — фильтр по группам пользователя, добавить `group_name`.
- `PUT /api/phone-numbers/:id/group` (новый в `phoneNumbers.js`) — привязка/отвязка, 409 при занятом номере.

**Backend webhook (переписывание ядра):**
- `handleVoiceInbound` в `twilioWebhooks.js` — вместо рассылки всем `phone_calls_allowed`: (1) `resolveGroupForNumber(To)`, (2) `startExecution`, (3) первый узел → TwiML. `handleDialAction` → `callFlowRuntime.advance` для resume.

**Frontend (расширение):**
- `useSoftPhoneWidget.ts` — Caller ID из `/api/voice/blanc-numbers` (уже фильтруется бекендом), группа рядом с номером.
- `SoftPhoneHeaderButton.tsx` + точка инициализации Twilio Device — гейтинг по `/api/user-groups/my` (не в группах → не рендерить, не инициализировать Device).
- `UserGroupDetailPage.tsx` — убрать `userGroupsMock.ts`, перейти на `GET /api/user-groups/:id`.
- `UserGroupsPage.tsx` — `RING_STRATEGIES` → только Simultaneous (или убрать выбор стратегии целиком).
- `PhoneNumbersPage.tsx` — колонка группы + привязка/отвязка.
- SSE-подписка на `agent.status.changed` для real-time статусов в списке групп.

### Middleware и изоляция (обязательно)

- Все новые routes: `app.use(..., authenticate, requireCompanyAccess, router)` в `src/server.js` (mount-only).
- `company_id` только через `req.companyFilter?.company_id`.
- Все SQL по группам/номерам/flow фильтруют `company_id`. Доступ к чужой группе/номеру → 404.
- Webhook'и (`/webhooks/twilio/*`) остаются unauthenticated с валидацией подписи Twilio; company_id резолвится по номеру (`phone_number_settings`).

### SSE-события (новые)

- `agent.status.changed` — `{ userId, groupIds[], status }`
- `group.call.queued` / `group.call.accepted` / `group.call.ended` — синхронизация очереди группы между диспетчерами.

### Что НЕ дублируется (расширяем существующее)

- `ensureFlowForGroup` (в `userGroups.js`) — переиспользуется как есть; skeleton по умолчанию.
- `buildVapiSipTwiml` / `flowResumeRouter` (voice-agent) — переиспользуются для ноды vapi_agent.
- `realtimeService` — переиспользуется для новых SSE-событий, не создаётся параллельный.
- Twilio Device hook (`useTwilioDevice`) — оборачивается гейтингом, не переписывается.

---

## Sales CRM MCP Architecture

**Status:** Implemented and audited through Sales workflow selections.

```
/api/crm REST
      │
      ▼
CRM service layer ──► CRM query layer ──► crm_* tables / tasks / contacts / audit_log
      ▲
      │
MCP executor ◄── MCP registry/schema validator
      ▲
      │
Authenticated backend MCP / public HTTP / legacy SSE / stdio
```

**Core rules:**
- `/api/crm` is the source service surface for accounts, contacts, deals, pipeline, activities, tasks, notes, metadata, and predefined lists.
- MCP tools call the CRM service layer directly in-process, preserving tenant scope, write allowlists, before/after responses, audit, and sanitized error mapping.
- Read tools require tenant context only. Write tools require `sales.crm.write` and explicit confirmation.
- Write MCP tools use field-specific schemas for the allowed update surface: `deal.next_step`, `deal.stage`, `deal.forecast_category`, `deal.close_date`, `deal.amount`, `deal.risk_summary`, `deal.competitor`, and `task.status`. They still dispatch through CRM services so company scope, allowlists, before/after values, generated-or-propagated request id, and audit remain centralized.
- The compatibility `crm.update_deal_field` tool validates its free-form `value` against the selected allowlisted field before service dispatch.
- Public and stdio transports build env-bound tenant/user context and fail closed when required config is missing.
- Pipeline analytics compute current state from `crm_deals`, changes/slippage from `crm_deal_history`, and optional baseline deltas from `crm_pipeline_weekly_snapshots`.
- Sales workflow selections are centralized in `crmListsService`: `crm.list_sales_workflows` exposes discovery metadata, `crm.get_sales_list` supports stable workflow keys, and explicit alias tools route to the same list service where defaults are needed.
- Workflow calendar windows use company timezone from MCP context. `my_open_deals` requires the current actor and rejects cross-owner scoping to avoid returning all open deals by accident.
- Rollout mounts `/api/crm` and `/api/crm/mcp` through `authenticate, requireCompanyAccess`; `/mcp/crm` is mounted separately and guarded by public MCP token/env context.
- Bulk/delete MCP tools are not registered. Public/stdio write calls remain disabled unless explicitly enabled by environment flags.

---

## ALB-100: Albusto Commercial Platform Program

**Date:** 2026-06-12 · **Requirements:** `docs/requirements.md` §ALB-100 · **Spec:** `docs/specs/ALB-100-platform-program.md`

### Identity & registration plane

```
Browser (custom pages, Albusto brand)
  /signup /signin /verify-phone /onboarding   ← frontend/src/pages/auth/*
        │ JSON
        ▼
backend/src/routes/publicAuth.js  (NO authenticate; strict rate limits)
  POST /api/public/signup            → keycloakService.createUser + email verify
  POST /api/public/otp/send|verify   → otpService (Twilio SMS, hashed codes)
  POST /api/public/onboarding        → platformCompanyService.bootstrapCompany
  GET  /api/public/places/suggest    → googlePlacesService (server-side key)
  GET  /api/public/places/resolve    → place → {city,state,zip,lat,lng,timezone}
        │
        ▼
Keycloak (crm-prod realm): users, passwords, Google IdP, email verification.
Frontend obtains tokens via standard Keycloak OIDC (unchanged authedFetch).
```

- **2FA enforcement point:** `keycloakAuth.authenticate()` — after token
  verification, when the request carries no valid trusted-device proof for the
  crm_user, API responds `401 PHONE_VERIFICATION_REQUIRED`; frontend
  AuthProvider intercepts → OTP screen → `POST /api/auth/trust-device` issues
  `albusto_td` httpOnly cookie (random id, 30d) + row in `trusted_devices`.
  SSE/static paths exempt. Dev mode exempt.
- **otpService:** codes 6 digits, sha256(pepper+code), tables `phone_otp`
  (id, phone, purpose signup|login|change, code_hash, attempts, expires_at,
  consumed_at) and `trusted_devices` (id, user_id, device_id_hash, label,
  last_used_at, expires_at, revoked_at). Migration **097**.
- **platformCompanyService.bootstrapCompany:** transaction — companies row
  (city/state/zip/lat/lng/timezone from Places) + membership(tenant_admin) +
  seed company_role_configs/permissions (copy of canonical defaults) +
  company_user_profiles + audit `company.created`. Idempotent by
  (created_by_user_id, name) for retry safety.

### Platform admin plane (ALB-102)

- `backend/src/routes/platformCompanies.js` mounted at `/api/platform/companies`
  with `authenticate + requirePlatformRole('super_admin')`.
- SuperAdminPage: new Companies tab → `frontend/src/components/admin/CompaniesTab.tsx`.
- Suspend/restore = `companies.status` + `status_reason` (+ audit). Tenant deny
  already enforced by PF007 (`COMPANY_SUSPENDED`).

### HARDENING-002 (ALB-103)

Same pattern as HARDENING-001: per-route `requirePermission`, queries scoped by
`req.companyFilter`, provider scope via `getProviderScope(req)` + jobs mirror
(calls/conversations join contacts → jobs). Files: routes/calls.js,
routes/messaging.js, routes/conversations.js, routes/leads (src/routes/leads.js
legacy + backend routes), routes/email.js + their query modules.

### Provider bridge UI (ALB-104)

CompanyUsersPage user drawer → new `FieldTechSection` component; roster via
existing `GET /api/zenbooker/team-members` (admin has tenant.company.manage);
save via existing `PATCH /api/users/:id`.

### CI sanitizer (ALB-105)

`tests/tenantSafetyLint.test.js` — static scan, allowlist inline.

### super_admin completion + rebrand (ALB-106)

- `/api/admin/*` → `requirePlatformRole('super_admin')`; drop ProtectedRoute
  legacy fallback; platform account seeded via script
  `backend/scripts/create-platform-admin.js` (Keycloak user + platform_role).
- Rebrand: visible strings only (header, titles, manifest, auth pages, emails).

### New env

`GOOGLE_PLACES_KEY` (server; falls back to GOOGLE_GEOCODING_KEY),
`OTP_PEPPER` (falls back to BLANC_SERVER_PEPPER), `TRUSTED_DEVICE_TTL_DAYS=30`,
`FEATURE_SELF_SIGNUP` (kill-switch), `FEATURE_SMS_2FA` (kill-switch, default off
until rollout), `SIGNUP_SMS_FROM` (defaults to SOFTPHONE_CALLER_ID).

---

## AUTO-001: Automation/Rules Engine E2E (ADR-001 §2.2-2.3)

**Backend (new/extend):**
- `backend/src/services/agentWorker.js` — NEW. Polls tasks(kind=agent,
  agent_status=queued), claims via `UPDATE…SET agent_status='running'…RETURNING`
  (FOR UPDATE SKIP LOCKED semantics через atomic UPDATE), dispatches by
  agent_type to handlers (`agentHandlers.js`), writes output/status, emits
  `agent_task.succeeded|failed` to eventBus. Started in src/server.js boot.
- `backend/src/services/agentHandlers.js` — NEW. Registry of agent_type →
  handler. Built-in: `summarize_thread`, `mcp_tool` (calls crmMcpToolExecutor
  with a synthetic tenant context), `noop`. Adding a handler = one registry entry.
- `backend/src/routes/automationRules.js` — EXTEND: add GET catalog endpoint
  (event types + action types + agent types) for the editor; GET /agent-tasks
  list.
- `backend/src/services/rulesSeed.js` — NEW. Seed/templates for AR-equivalent
  rules (inbound_sms, missed_call); applied per-company on demand or by flag.
- Migration 102: index for agent worker claim already from 100
  (idx_tasks_agent_queue); add `automation_rules.is_system` marker + seed flag
  on company; nothing destructive.

**Frontend (new):**
- `frontend/src/pages/AutomationPage.tsx` — NEW. Rules list + create/edit drawer.
- `frontend/src/components/automation/RuleEditor.tsx` — NEW. Trigger picker
  (event/timer), ConditionBuilder, ActionList with template preview.
- `frontend/src/components/automation/RuleRunsPanel.tsx` — NEW. Run history.
- `frontend/src/services/automationApi.ts` — NEW. authedFetch wrappers.
- Route `/settings/automation` (permission `tenant.company.manage`), nav entry.

**Event catalog** (stable, exported from a shared module
`backend/src/services/eventCatalog.js`): job.status_changed, job.created,
lead.created, lead.status_changed, call.completed, call.missed, sms.inbound,
sms.outbound, provider.assigned, payment.succeeded, invoice.payment_failed,
subscription.past_due, agent_task.succeeded, agent_task.failed.

**Protected:** src/server.js (only boot-block addition for worker, like existing
workers), eventBus/rulesEngine/ruleActions (extend via registry, not rewrite).

---

## BILLING-UI (ADR-001 §2.4 completion)
**Backend:**
- `routes/billing.js` EXTEND: GET / уже отдаёт subscription+usage+plans; добавить
  invoices в ответ; GET /invoices (отдельный, пагинация); POST /checkout есть.
- `routes/billingWebhook.js` NEW: POST /api/billing/webhook — express.raw body,
  no auth, Stripe signature → billingService.handleProviderWebhook. Mounted in
  src/server.js BEFORE express.json (needs raw body).
- `platformCompanyService.bootstrapCompany` EXTEND: вызвать billingService.startTrial
  после создания компании (идемпотентно, non-blocking).
- `billingService` уже имеет getSubscription/getUsage/createCheckout/
  handleProviderWebhook; добавить getInvoices(companyId).
- Plan limits для usage-полосок: billing_plans.metered + included семантика;
  усиление: добавить included_units в plan (sms/calls/agent) — migration 103.

**Frontend (UX-first):**
- `pages/BillingPage.tsx` NEW — статус-карта, usage-полоски, планы, инвойсы.
- `services/billingApi.ts` NEW — authedFetch wrappers.
- Route `/settings/billing` (tenant.company.manage), nav entry.

**Plan limits source:** migration 103 adds `billing_plans.included_units` jsonb
{sms, call_minutes, agent_runs} so usage bars show real caps (trial: generous).

**Protected:** src/server.js (webhook mount needs raw-body — careful ordering,
additive); existing billing schema (extend via migration only).
