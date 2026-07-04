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
fly ssh console -a abc-metrics -C "grep ' 01 ' /proc/net/tcp" | awk '$3 ~ /:01BB$/' | wc -l
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

---

## F018: Stripe Payments Marketplace — Tenant Customer Payments (Phases 1–2)

**Источник требований:** requirements.md F018; spec STRIPE-PAY-001 (Phases 1–2).
**Принцип:** расширяем существующий ledger/marketplace/invoice слой, НЕ создаём второй
payment-center и НЕ трогаем платформенный billing (ADR-001).

### Существующий функционал (расширяем, не дублируем)
- `marketplaceQueries.ensureMarketplaceSchema()` (`backend/src/db/marketplaceQueries.js:12`)
  — применяет seed-миграции маркетплейса; **добавить сюда новую seed-миграцию stripe**.
- `marketplaceService` install/disconnect + `/api/marketplace/*` — переиспользуем для
  install/disconnect плитки (provisioning_mode='none', как VAPI).
- `paymentsService.createTransaction(companyId, userId, data)`
  (`backend/src/services/paymentsService.js:64`) — уже пишет в `payment_transactions`
  и обновляет invoice через `invoicesQueries.recordPayment`. Webhook ledger-sync ДОЛЖЕН
  идти через него (`external_source='stripe'`, `external_id=<stripe id>`), а не плодить
  свой INSERT. ⚠️ требуется идемпотентность — см. ниже.
- `invoicesService.recordPayment` / `invoicesQueries.recordPayment` + `createEvent`
  — invoice balance/status + timeline. Нельзя дублировать пересчёт.
- `invoicesService.ensurePublicLink` + `public-invoices.js` (`/api/public/invoices/:token/pdf`,
  short `/i/:token`) — основа public `Pay now`. ⚠️ сейчас public-слой ТОЛЬКО PDF, JSON-
  эндпоинтов нет — добавляем новые public-token эндпоинты.
- `stripeProvider.parseWebhook` (`backend/src/services/billing/stripeProvider.js`) —
  HMAC-SHA256 v1 паттерн как **референс**; для Connect делаем ОТДЕЛЬНЫЙ provider
  (другой webhook secret, Stripe-Account scoping). Платформенный provider не трогаем.
- `billingWebhook` mount в `src/server.js` (express.raw до express.json) — паттерн
  монтирования для нового tenant-payments webhook.

### Нельзя дублировать
- Второй INSERT в `payment_transactions` в обход `paymentsService`.
- Свой пересчёт invoice paid/balance (только через `invoicesQueries.recordPayment`).
- Свой marketplace install-flow (используем `/api/marketplace/*`).
- Платформенный `stripeProvider`/`billingService`/`/api/billing/webhook`.

### Новые компоненты

**Database (миграции 107–110, idempotent, добавить в ensureMarketplaceSchema где нужно):**
- `107_create_stripe_connected_accounts.sql` — per-company connected account
  (`company_id` UNIQUE, `marketplace_installation_id`, `stripe_account_id`, `livemode`,
  `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements_currently_due`
  jsonb, `requirements_past_due` jsonb, `capabilities` jsonb, `status`, timestamps).
- `108_create_stripe_payment_sessions.sql` — (`company_id`, `invoice_id`, `job_id`,
  `contact_id`, `created_by`, `surface` ['checkout_link'|'manual_card'|'tap_to_pay'],
  `amount`, `currency`, `status`, `stripe_checkout_session_id`, `stripe_payment_intent_id`,
  `stripe_charge_id`, `stripe_account_id`, `url`, `expires_at`, `metadata`, timestamps).
- `109_create_stripe_webhook_events.sql` — (`stripe_event_id` UNIQUE, `livemode`,
  `event_type`, `stripe_account_id`, `company_id`, `processing_status`, `payload` jsonb,
  `error`, `processed_at`, `created_at`) — идемпотентность + аудит.
- `110_seed_stripe_payments_marketplace_app.sql` — `marketplace_apps` row
  `app_key='stripe-payments'`, category 'payments', provisioning_mode='none',
  status='published', metadata.setup_path='/settings/integrations/stripe-payments'.
- Ledger идемпотентность: partial UNIQUE index `(company_id, external_id) WHERE
  external_source='stripe'` (по образцу 104) — добавить в 107 или отдельной строкой.

Backend:
- `backend/src/services/stripeConnectProvider.js` — zero-SDK REST к Stripe (fetch +
  `Stripe-Account` header для connected-account ops + HMAC verify Connect webhook).
  Методы: createAccount(v2, direct charges), createAccountLink(onboarding), getAccount,
  createCheckoutSession, retrieveCheckoutSession, parseConnectWebhook.
- `backend/src/services/stripePaymentsService.js` — доменная логика: connect/onboarding-
  link/refresh-status/disconnect; readiness state machine; ensure/reuse checkout session
  по invoice; webhook dispatch → ledger через `paymentsService.createTransaction`
  (идемпотентно); audit events. Хранит connected-account + sessions через новые queries.
- `backend/src/db/stripePaymentsQueries.js` — CRUD по 3 новым таблицам (все запросы
  фильтруют по `company_id`; webhook lookup по stripe ids → затем company-scope verify).
- `backend/src/routes/stripePayments.js` — settings/onboarding API.
- `backend/src/routes/stripePaymentsWebhook.js` — tenant-payments webhook (raw body).
- Расширения: `backend/src/routes/invoices.js` (+payment-link эндпоинты),
  `backend/src/routes/public-invoices.js` (+public summary/pay эндпоинты).

Frontend:
- `frontend/src/pages/StripePaymentsSettingsPage.tsx` — по образцу `VapiSettingsPage`.
- `frontend/src/services/stripePaymentsApi.ts` — authedFetch wrappers.
- Правки: `IntegrationsPage.tsx` (плитка stripe-payments → navigate на setup, статус-
  бейджи), `App.tsx` (route, guard `tenant.integrations.manage`),
  `components/invoices/InvoiceDetailPanel.tsx` (Collect payment vs Record offline,
  readiness banner, link/attempt блоки), invoice send dialog (Include payment link).
- Public `Pay now`: минимальная public pay-страница или редирект-флоу через токен.

### API endpoints (middleware: authenticate, requireCompanyAccess; company_id ←
`req.companyFilter?.company_id`; все SQL по company_id)
- `GET  /api/stripe-payments/status` — readiness + checklist (perm tenant.integrations.manage)
- `POST /api/stripe-payments/connect` — создать/найти connected account
- `POST /api/stripe-payments/onboarding-link` — account link (resume onboarding)
- `POST /api/stripe-payments/refresh-status` — pull из Stripe, обновить локально
- `POST /api/stripe-payments/disconnect` — выключить новые платежи (история остаётся)
- `POST /api/invoices/:id/stripe-payment-link` — create/reuse checkout session
  (perm payments.collect_online; чужой invoice → 404)
- `GET  /api/invoices/:id/stripe-payment-link` — активная сессия/история (perm payments.view)
- `POST /api/invoices/:id/send-payment-link` — email/SMS + invoice_event (perm payments.collect_online)
- `POST /api/stripe-payments/webhook` — **NO auth**, express.raw, signature verify
  (`STRIPE_CONNECT_WEBHOOK_SECRET`), идемпотентно по stripe_event_id; mount в server.js
  ДО express.json и ОТДЕЛЬНО от `/api/billing/webhook`.
- Public (no auth, token=credential): `GET /api/public/invoices/:token/pay-info`
  (summary+balance), `POST /api/public/invoices/:token/pay` (create/reuse session → url).

### Readiness state machine (gating, FR-003)
`not_connected → onboarding_incomplete → action_required(requirements due) →
payments_disabled → connected_ready` (+ `payouts_disabled`, `disconnected`).
Online collection разрешён только при `charges_enabled && card capability active`.
Marketplace плитка маппит state → бейдж (Available/Setup incomplete/Connected/Action
required/Payouts disabled/Disconnected).

### Файлы для изменений (точные пути)
- NEW backend: migrations 107–110; services/stripeConnectProvider.js,
  stripePaymentsService.js; db/stripePaymentsQueries.js; routes/stripePayments.js,
  routes/stripePaymentsWebhook.js.
- EDIT backend: db/marketplaceQueries.js (ensureMarketplaceSchema += 110 seed),
  routes/invoices.js (+3 эндпоинта), routes/public-invoices.js (+2 public эндпоинта),
  src/server.js (mount-only: webhook raw до json + 2 router'а).
- NEW frontend: pages/StripePaymentsSettingsPage.tsx, services/stripePaymentsApi.ts.
- EDIT frontend: pages/IntegrationsPage.tsx, App.tsx,
  components/invoices/InvoiceDetailPanel.tsx (+ invoice send dialog, public invoice).

**Защищённые:** src/server.js (mount-only), authedFetch.ts, useRealtimeEvents.ts,
backend/db schema (только новые миграции), платформенный billing — не трогать.

## NOTES-001 — Unified notes lifecycle (2026-06-25)

Notes remain JSONB arrays on `jobs.notes` / `leads.structured_notes` / `contacts.structured_notes` (chosen over a normalized table to stay backwards-compatible with existing data + Zenbooker sync). Each note now carries a stable `id`, `created_by` (Keycloak sub), and a `deleted_at` tombstone. A shared `notesMutationService` (adapter-per-entity: `{entityType, attachmentEntityId, loadNotes, saveNotes}`) holds the permission gate (`canMutateNote`: admin→any, owner→own, legacy/no-author/Zenbooker→admin-only), edit (text + attachment add/remove) and soft-delete. Attachments link by `note_attachments.note_id` (was positional `note_index`). Edit/delete emit `note_edited`/`note_deleted` `domain_events` surfaced in the History tab; soft-deleted notes are filtered from all read paths. Frontend `NotesSection` is the single component (kebab ⋮ + edit/delete); `StructuredNotesSection` and `JobNotesSection` were removed.

## SLOT-ENGINE-001 UX polish — design notes (2026-06-25)

UX/copy polish over the merged SLOT-ENGINE-001. **No new architecture**: zero new files, components, deps, routes, API/DB/contract changes, token renames, or protected-file edits. Touches exactly three files: `slot-engine/src/engine.js` (`explain()` only), `frontend/src/components/conversations/CustomTimeModal.tsx`, and `.../CustomTimeModal.css`. The engine I/O contract is unchanged — `explanation` stays a `string` field on each recommendation; only its content changes (and `score`/`confidence` are read, not modified).

**`explain()` — content-only rewrite + signature simplification.** Currently `explain(win, date, tech, m)` returns Russian text with a redundant `${date}, ${win.start}-${win.end}, ${tech.name}` prefix (the card already renders date/time/tech). It has exactly **one** call site (engine.js inside `recommendSlots`). Decision: **simplify the signature to `explain(m)`** — drop the now-unused `win`/`date`/`tech` params cleanly rather than leave dead args; update that one call site. New body composes a terse English reason from the same `metrics` (e.g. `"Tech already working nearby · low added travel · comfortable schedule buffer"`), never empty (a non-empty terse fallback covers metric-poor candidates). No scoring/ranking/`reasonCodes`/`metrics` logic changes. Engine tests assert on type/shape (`typeof explanation === 'string'`, non-empty), **not** literal copy, so wording can evolve.

**Temperature mini-bar — inline, not a shared component.** The single visual quality signal (replacing the raw `score` number + raw `confidence` chip) is a thin vertical fill rendered as **inline JSX + CSS classes local to the rec card** (`.ctm-rec-card__temp` / `__temp-fill`), NOT a new shared component — it has exactly one consumer (the rec card) and extracting it would over-abstract a polish pack. The raw numeric score moves off the card face into the card's `title`/`aria-label` only.

**Mapping helper — a tiny pure function in CustomTimeModal.tsx.** A local pure helper (e.g. `tempFromRec({score, confidence})` → `{ fillPct, colorVar, label }`) maps engine `confidence` (`'high'|'medium'|'low'`) + `score` to the bar's fill height, an Albusto color token (high→green, medium→blue, low→amber/muted), and an a11y label. Lives **beside the other module-local helpers** in CustomTimeModal.tsx (next to `recToSlotDates`/`parseHHMM`); no engine change — engine already returns `confidence`+`score`.

**Humanized fallback string — a module-level constant.** When `explanation` is ever missing, the visible sub-text uses a constant human English string (e.g. `REC_FALLBACK_REASON = 'Good fit for this route'`) declared at module top in CustomTimeModal.tsx — the `reason_codes?.[0]` snake_case fallback is removed so no machine token can leak to the UI.

**Other in-place edits (no architecture impact).** Vocabulary copy ("Recommended times" / "Recommended" / "Preselected"); zero-recs empty state gated on engine-enabled-and-reachable (preserves existing graceful absence when disabled/unreachable — `showRecPanel` logic extended, not replaced); technician pagination arrows switched to the already-imported shared `Button` (`variant="ghost" size="icon"`); overlay bands made keyboard-accessible (role/tabIndex/Enter-Space) reusing existing `onApplyRec`; map info-window emoji removed. CSS: cold tokens → warm Albusto (`--muted-foreground`→`--blanc-ink-3`, `--border`→`--blanc-line`), dead dark fallbacks (`#27303f`/`#0f172a`/`#1e293b`/`#334155`/`#64748b`/`#94a3b8`) removed in touched rules, and dead `.ctm-timelines__dots/__footer/__legend*` rules deleted. `--blanc-*` token names and `Blanc*` identifiers are NOT renamed (internal-only).

## ONWAY-001 — design (2026-06-26)

From a Job card in a pre-visit status a technician taps a primary **"On the way"** CTA → a modal does one `navigator.geolocation.getCurrentPosition`, optionally computes a Google travel-time ETA (device coords → job address), offers preset tiles + custom minutes → **"Notify client"** sends an outbound SMS (tech + ETA) into the customer conversation and flips the job to a new **On the way** status. Hard rule of ordering: **SMS first (primary success), status second (best-effort)**.

### Adding the "On the way" job status (riskiest part — concrete plan)

The Job FSM is **dual-sourced**: a hardcoded fallback in `jobsService.js` (`BLANC_STATUSES` line 25, `ALLOWED_TRANSITIONS` line 36) **and** a per-company published SCXML row in the DB (`fsm_machines`/`fsm_versions`, seeded by migration `073_seed_fsm_machines.sql`). At runtime `updateBlancStatus` (jobsService.js:831) calls `fsmService.resolveTransition(companyId,'job',from,to)` **first**; only when it returns `{fallback:true}` (no published version) does the hardcoded map apply. For every already-seeded company the DB graph is authoritative — so editing only `fsm/job.scxml` or the `073` seed body would **NOT** reach existing tenants. **A new migration is required**, modeled exactly on the existing precedent `095_add_review_lead_status.sql` (which added a lead state to already-published machines). The change is therefore **three coordinated edits + one migration**, all kept consistent:

1. **`backend/db/migrations/127_job_fsm_on_the_way.sql` (NEW)** — loop every company's active published `job` version, idempotency-guarded `WHERE v.scxml_source NOT LIKE '%id="On_the_way"%'`; `replace()` to (a) add a `<state id="On_the_way" blanc:label="On the way" blanc:statusName="On the way">` with onward action transitions `TO_VISIT_COMPLETED → Visit_completed` and `TO_CANCELED → Canceled`, and (b) inject an inbound `<transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label="On the way" .../>` into the `Submitted` **and** `Rescheduled` states. Archive the old published row, insert `version_number+1` as `published`, repoint `fsm_machines.active_version_id` — same shape as migration 095. (`Visit_completed` already exists as a state with onward `→ Job is Done / Canceled`, so "On the way → Visit completed" lands the job on the normal completion path.)
2. **`fsm/job.scxml` (EDIT)** — add the same `On_the_way` state + the two inbound transitions, so the canonical file matches the DB and new fresh `073` seeds stay correct.
3. **`backend/db/migrations/073_seed_fsm_machines.sql` (EDIT, optional-but-consistent)** — add the same state/transitions to the embedded `$scxml_job$` heredoc so a brand-new DB seeded from scratch already includes On-the-way (keeps 073 and 127 convergent; running both is safe because 127's `NOT LIKE` guard no-ops when the state is already present).
4. **`backend/src/services/jobsService.js` (EDIT)** — append `'On the way'` to `BLANC_STATUSES` and add `'On the way': ['Visit completed','Canceled']` plus `'On the way'` into the `Submitted` and `Rescheduled` arrays in `ALLOWED_TRANSITIONS`, so the fallback map mirrors the SCXML for unseeded companies and the `fallback` safety net. **`OUTBOUND_MAP`/the Zenbooker block is left untouched** — On the way has no ZB mapping, so the existing `if (newStatus === 'Job is Done'…)` / `Canceled` guards simply skip it (no outbound ZB call). **No existing status/transition is removed or altered** (protects FSM-001 §8 completeness).

**Status color (frontend):** add `'On the way': '#0EA5E9'` (sky/cyan — distinct from Submitted `#3B82F6` and the amber ZB `en-route`) to `BLANC_STATUS_COLORS` in **`frontend/src/components/jobs/jobHelpers.tsx`** (lines 16-22), and add `'On the way'` to the `BLANC_STATUSES` array there (lines 6-12) so filters/badges render it. `BlancBadge` (same file) then colors it automatically. **Caveat:** the new Blanc status **On the way** is orthogonal to the existing Zenbooker `zb_status: 'en-route'` substatus (and the `/enroute` route / `markEnroute`) — they must not be conflated; On the way is a `blanc_status`, en-route is a ZB substatus.

### API surface

**Two endpoints under the existing jobs router** (`backend/src/routes/jobs.js`, mounted in `src/server.js` behind `authenticate`+`requireCompanyAccess`; `company_id` from `req.companyFilter?.company_id` only):

- **`POST /api/jobs/:id/eta/estimate`** `{ origin:{lat,lng} }` → `{ eta_minutes|null, status }`. `requirePermission('messages.send')`. Loads the job (company-scoped → 404 cross-tenant); if the job has usable `lat/lng` (or a geocodable `address`) it calls `routeDistanceService.computePair(origin, {lat,lng}, 'driving')` and returns `durationMinutes`; otherwise/`NO_KEY`/`failed` → `{ eta_minutes:null }` (UI shows tiles only). Pure read — no SMS, no status change. Driving, no traffic; key already in env (`GOOGLE_GEOCODING_KEY || GOOGLE_PLACES_KEY`, server-side only).
- **`POST /api/jobs/:id/eta/notify`** `{ eta_minutes }` → notify = SMS then status. `requirePermission('messages.send')`. Steps: (1) load job company-scoped; (2) resolve `customerE164` from `job.customer_phone` (denormalized column) — **absent → 422 `No phone number on file`, no side effects** (SC-03); (3) resolve `{tech}` = `job.assigned_techs?.[0]?.name` (omit phrase gracefully if none) and `{company}` = company name; (4) resolve the proxy DID server-side (see below); (5) `conversationsService.getOrCreateConversation(customerE164, proxyE164, companyId)` + `sendMessage(conv.id, { body, author:'agent' })` — the wallet gate inside `sendMessage` (`walletService.assertServiceActive`) stays the single cost enforcement point; wallet/Twilio failure → propagate error, **status NOT changed** (SC-05/06); (6) on SMS success, `jobsService.updateBlancStatus(id,'On the way',companyId)` — if **this** throws, return `{ ok:true, warning:'status_not_advanced' }` (no SMS rollback, AC-7). Idempotent on the success path (a job already in On the way → `resolveTransition` treats same-state as `__NOOP__`, so a double-tap won't double-send if guarded client-side + is harmless server-side). SMS body is the exact OW-R5 template. This reuses the same `updateBlancStatus` path as `PATCH /:id/status` (which already emits `eventService.logEvent('status_changed')` + `eventBus 'job.status_changed'`), so audit/history/automation fire for free.

Rationale for a dedicated `/eta/notify` rather than reusing `PATCH /:id/status`: the notify action is **SMS-primary with status as a best-effort side effect** and needs the proxy/tech/template orchestration — folding that into the generic status route would overload it and break its "status is the operation" contract.

### Twilio proxy DID resolution (server-side)

There is **no clean per-company "primary sending number" helper** today, and the canonical `phone_number_settings` table has **no `is_default` column**. Existing send paths resolve the proxy three different ways: `routes/messaging.js POST /start` takes `proxyE164` **from the client body** (not acceptable here — must be server-derived per AC-12); `services/ruleActions.send_sms` falls back to **`process.env.SOFTPHONE_CALLER_ID`**; `routes/pulse.js GET /default-proxy` uses an **MRU query** `SELECT proxy_e164 FROM sms_conversations WHERE proxy_e164 IS NOT NULL AND company_id=$1 ORDER BY last_message_at DESC LIMIT 1`. **Decision for ONWAY-001:** add a small server-side resolver `resolveCompanyProxyE164(companyId)` (place beside the send orchestration, e.g. a helper in the route or a `conversationsService` export) that tries, in order: (1) the MRU `sms_conversations.proxy_e164` for the company (reuses pulse's proven logic, keeps the same outbound identity the customer already sees); (2) fallback `process.env.SOFTPHONE_CALLER_ID`. If both are null → 422 (`No sending number configured`), status unchanged. This avoids a live Twilio `incomingPhoneNumbers.list` round-trip on the hot path. **This is the one boundary the customer must confirm** (below).

### routeDistanceService

Reuse **`routeDistanceService.computePair(origin, dest, travelMode='driving')`** (`backend/src/services/routeDistanceService.js:46`) → returns `{ status:'success', durationMinutes, fromCache }` or `{ status:'failed', errorCode }`. It is global-cache-first, fires Google Distance Matrix only on cache-miss, sends **no `departure_time`** (no traffic — consistent with SCHED-ROUTE-001), and reads the key from env only (`GOOGLE_GEOCODING_KEY || GOOGLE_PLACES_KEY`); a missing key returns `{status:'failed',errorCode:'NO_KEY'}` which the estimate endpoint maps to `eta_minutes:null` (SC-02 behavior). Round minutes are already integers.

### Frontend

- **Primary CTA** lives in **`frontend/src/components/jobs/JobStatusTags.tsx`** → the live `JobOpsSection` (note: `JobActionBar.tsx` is a dead `export {}` stub — do not use). Add an "On the way" primary button in the existing primary-CTA region (the same full-width orange-gradient slot as "Start Job", ~lines 113-139), rendered **only when** `job.blanc_status ∈ {Submitted, Rescheduled}` (the FSM-defined pre-visit set with a transition into On the way) — the FSM-driven `ActionsBlock` (already imported) will also list it as a transition button, but the styled primary CTA + modal is the intended entry point. Gate on the `messages.send` permission client-side (hide if absent).
- **New modal** `frontend/src/components/jobs/OnTheWayModal.tsx` (mirror the Shadcn-`Dialog` pattern of `components/transactions/RecordPaymentDialog.tsx`): on open call `navigator.geolocation.getCurrentPosition` once; on a fix **and** when the job has an address/coords → `jobsApi.estimateEta(id,{origin})` and pre-select the returned minutes; on denied/unavailable/no-address/`null` → show "ETA unavailable — location is off" and tiles only. Tiles **10/15/20/30/45/60** + "Set custom time" (positive integer). "Notify client" → `jobsApi.notifyOnTheWay(id,{eta_minutes})`; on success close + `afterMutation(id)` (refreshes the job, via the existing `useJobDetail` flow); surface the non-blocking `warning:'status_not_advanced'` if present.
- **`frontend/src/services/jobsApi.ts`** — add two methods using the existing `jobsRequest<T>()` helper + `authedFetch`: `estimateEta(id, { origin })` → `POST ${JOBS_BASE}/${id}/eta/estimate`, and `notifyOnTheWay(id, { eta_minutes })` → `POST ${JOBS_BASE}/${id}/eta/notify`. `LocalJob` already carries `customer_phone`, `address`, `lat`, `lng`, `assigned_techs[]`, `blanc_status` — no type changes needed beyond the new method signatures.

### File-touch summary

- **NEW:** `backend/db/migrations/127_job_fsm_on_the_way.sql`; `frontend/src/components/jobs/OnTheWayModal.tsx`. (Optionally `backend/db/migrations/rollback_127_*.sql`.)
- **EDIT backend:** `services/jobsService.js` (BLANC_STATUSES + ALLOWED_TRANSITIONS); `routes/jobs.js` (+2 routes + `resolveCompanyProxyE164` helper); `fsm/job.scxml`; `db/migrations/073_seed_fsm_machines.sql` (keep seed convergent). `services/conversationsService.js` and `services/routeDistanceService.js` are **reused unchanged**.
- **EDIT frontend:** `components/jobs/JobStatusTags.tsx` (primary CTA + modal mount); `components/jobs/jobHelpers.tsx` (status color + list); `services/jobsApi.ts` (2 methods).
- **Protected / untouched:** `walletService` gate, `OUTBOUND_MAP`/ZB sync, existing FSM states/transitions, `authedFetch.ts`, `useRealtimeEvents.ts`, `src/server.js` (jobs router already mounted — no new mount needed).

### Open boundary question (customer)

**Which Twilio number should the "on the way" SMS be sent FROM for a company that owns several SMS-capable DIDs?** There is no configured "default sending number" in the schema. The plan uses MRU-of-recent-conversations → `SOFTPHONE_CALLER_ID` fallback, which is correct for the current single-prod-number setup but is ambiguous for a multi-number tenant. Confirm: (a) MRU-then-env fallback is acceptable for v1, or (b) a specific company setting / first-SMS-capable-number rule is required.

---

## REC-SETTINGS-001 — design (2026-06-26)

Per-company configuration that replaces the **hardcoded** `config_override` in `backend/src/services/slotEngineService.js` with values a dispatcher edits in Settings → Technicians. **No engine change / no redeploy** — the engine already deep-merges any `config_override` over `slot-engine/src/config.js DEFAULT_CONFIG` (`mergeConfig`). The only change is *where the override comes from*. Sibling of SLOT-ENGINE-001's `technician_base_locations`; mirrors that feature's route/service/queries/API-client patterns exactly.

### Storage + migration

- **NEW** `backend/db/migrations/128_create_slot_engine_settings.sql` (highest existing = 127 / ONWAY). One row per company; the 5 editable params stored as **discrete jsonb keys** (NOT a full engine-config blob — keeps UI/validation trivial; the service maps them to engine keys):

```sql
CREATE TABLE IF NOT EXISTS slot_engine_settings (
    company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    config      JSONB NOT NULL,   -- { max_distance_miles, overlap_minutes, min_buffer_minutes, horizon_days, recommendations_shown }
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- update_updated_at_column() is the shared trigger fn (used by 010/125/etc.)
CREATE TRIGGER trg_slot_engine_settings_updated_at
    BEFORE UPDATE ON slot_engine_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

The two **fixed** values (`geography.allow_empty_day_candidates=true`, `workload.max_day_utilization=0.95`) are **NOT stored** — they're injected at build time, so they're always present regardless of row contents.

### Queries + service + resolver (single source of truth)

- **NEW** `backend/src/db/slotEngineSettingsQueries.js` — `getByCompany(companyId)` (SELECT, WHERE company_id) + `upsert(companyId, config)` (INSERT … ON CONFLICT (company_id) DO UPDATE SET config=EXCLUDED.config, updated_at=NOW()). `ensureSchema()` reads `128_*.sql` (mirrors `technicianBaseLocationQueries.js`). Every query filters by `company_id`.
- **NEW** `backend/src/services/slotEngineSettingsService.js` — owns the **`DEFAULTS` constant** (the single source of truth) and the **`buildConfigOverride(settings)`** function (single place the engine-key mapping lives):
  - `DEFAULTS = { max_distance_miles: 10, overlap_minutes: 0, min_buffer_minutes: 15, horizon_days: 3, recommendations_shown: 3 }`
  - `VALIDATION` = integer ranges: distance 1–100, overlap 0–240, buffer 0–240, horizon 1–14, shown 1–10.
  - `get(companyId)` → row.config OR `DEFAULTS` (never partial; missing keys filled from `DEFAULTS`).
  - `resolve(companyId)` → same as `get` but degrades to `DEFAULTS` on any DB error (safe-failure parity).
  - `validate(payload)` → returns the 5 coerced integers or throws `{ httpStatus: 422, code: 'INVALID_SETTINGS' }`; all-or-nothing (no partial save).
  - `save(companyId, payload)` → `validate` then `queries.upsert`.
  - `buildConfigOverride(s)` maps the 5 values → engine keys, **plus the two fixed values, always**:
    ```js
    {
      geography: {
        max_distance_from_existing_job_miles: s.max_distance_miles,
        max_distance_from_base_if_empty_day_miles: s.max_distance_miles, // ONE radius → BOTH keys
        allow_empty_day_candidates: true,                                // fixed
      },
      overlap:     { max_timeframe_overlap_minutes: s.overlap_minutes },
      feasibility: { min_required_slack_minutes: s.min_buffer_minutes },
      planning:    { horizon_days: s.horizon_days },
      ranking:     { top_n: s.recommendations_shown },
      workload:    { max_day_utilization: 0.95 },                        // fixed
    }
    ```

### slotEngineService edits (the only consumer change)

- Add `const settingsService = require('./slotEngineSettingsService');` near the top of `getRecommendations` resolve the row once: `const settings = await settingsService.resolve(companyId);`.
- **Drop** the local module constant `HORIZON_DAYS = 2` (line ~20). The date window now uses the resolved value: `const latest = newJob.latest_allowed_date || addDaysLocal(today, settings.horizon_days);` (line ~162) — so the snapshot window (`buildScheduledJobs` range) and `planning.horizon_days` agree (AC-5).
- **Replace** the hardcoded literal at line ~199 — `config_override: { geography: { allow_empty_day_candidates: true, max_distance_from_base_if_empty_day_miles: 40 } }` — with `config_override: settingsService.buildConfigOverride(settings)`.
- Safe-failure preserved: `resolve` never throws (DB error → `DEFAULTS`); the existing empty/flagged-result paths on engine fault / missing `SLOT_ENGINE_URL` are untouched.

### Routes (GET + PUT)

- **NEW** `backend/src/routes/slotEngineSettings.js` — `companyId(req)=req.companyFilter?.company_id`:
  - `GET /` → `requirePermission('tenant.company.manage')` → `{ ok:true, data: await svc.get(companyId(req)) }` (defaults when no row).
  - `PUT /` → `requirePermission('tenant.company.manage')` → `svc.save(companyId(req), req.body)` → `{ ok:true, data }`; on `err.httpStatus` (422 INVALID_SETTINGS) return that status; else 500. **PUT body carries only the 5 params — company_id is never read from the payload.**
- **Mount** in `src/server.js` next to the base-locations line (~246), same chain (permission enforced per-route, like its sibling):
  `app.use('/api/settings/slot-engine-settings', authenticate, requireCompanyAccess, require('../backend/src/routes/slotEngineSettings'));`

### Frontend

- **NEW** `frontend/src/services/slotEngineSettingsApi.ts` — `authedFetch` from `./apiClient`, unwraps `json.data`, mirrors `technicianBaseLocationsApi.ts`. `interface SlotEngineSettings { max_distance_miles; overlap_minutes; min_buffer_minutes; horizon_days; recommendations_shown }`; methods `get(): Promise<SlotEngineSettings>` (GET) and `save(body): Promise<SlotEngineSettings>` (PUT). Export a `DEFAULTS` mirror + the validation ranges for client-side echo.
- **NEW** `frontend/src/components/settings/RecommendationSettings.tsx` — the "Recommendation settings" block. Loads on mount (`get`, falling back to defaults), holds the 5 fields in local state, **saves on an explicit Save button** (the page is not a live-blur form). 3 number inputs (Max distance, Planning horizon, Recommendations shown) + 2 minute-pickers (Allow overlap, Min buffer) with presets {0, 30, 60, custom} → custom resolves to an integer that still satisfies 0–240. Albusto tokens (`--blanc-*`), section header `.blanc-eyebrow`, no `<hr>`/separators; English copy. Client validation mirrors server ranges; on 422 surface the field error via `toast`.
- **EDIT** `frontend/src/pages/TechnicianPhotosPage.tsx` — mount `<RecommendationSettings />` directly under the existing `<CompanyBaseAddress …>` block (~line 145), inside its own `mb-6` wrapper. No other page logic changes.

### Backwards-compat / protected

- Companies with **no row → `DEFAULTS`** everywhere (GET, `resolve`, `buildConfigOverride`); behavior is well-defined before anyone saves. The previous hardcoded empty-day radius (40 mi) is intentionally superseded by the configurable `max_distance_miles` (default 10).
- **Untouched:** `slot-engine/` (`DEFAULT_CONFIG` + `mergeConfig` contract), the `technician_base_locations` table/routes/screen, `authedFetch.ts`/`apiClient.ts`, `src/server.js` core (only one new mount line). Multi-tenant isolation via `req.companyFilter` + `tenant.company.manage`.

### File-touch summary

- **NEW backend:** `db/migrations/128_create_slot_engine_settings.sql`; `db/slotEngineSettingsQueries.js`; `services/slotEngineSettingsService.js` (DEFAULTS + buildConfigOverride live here); `routes/slotEngineSettings.js`. (Optional `db/migrations/rollback_128_*.sql`.)
- **EDIT backend:** `services/slotEngineService.js` (drop `HORIZON_DAYS`; resolve settings; horizon from `settings.horizon_days`; `config_override = buildConfigOverride`); `src/server.js` (+1 mount line).
- **NEW frontend:** `services/slotEngineSettingsApi.ts`; `components/settings/RecommendationSettings.tsx`.
- **EDIT frontend:** `pages/TechnicianPhotosPage.tsx` (mount the block under `CompanyBaseAddress`).

### Open boundary question (customer)

The hardcoded empty-day base radius was **40 mi**; the new configurable **Max distance** maps to *both* `max_distance_from_existing_job_miles` and `max_distance_from_base_if_empty_day_miles` with a **default of 10 mi**. So on first run (no row) the effective empty-day radius **drops 40 → 10**, which can shrink first-run recommendations versus today. Confirm: (a) one shared 10-mi default for both radii is intended, or (b) the empty-day radius should default wider (e.g. keep 40, or a separate 6th param) to preserve current first-run breadth.

---

## REC-SETTINGS-002 — design (2026-06-26)

Follow-up to REC-SETTINGS-001. The Max-distance setting currently maps to the engine's GEO pre-filter only; empty-day candidates that pass the geo gate are then independently rejected by the engine's **TRAVEL-FEASIBILITY** gates (left at their `DEFAULT_CONFIG` values), so effective empty-day coverage is ~5 mi regardless of the setting. Fix: also derive the travel caps from `max_distance_miles` so the geo radius binds. **The only code that changes is `buildConfigOverride` (+ its unit tests).** No engine change, no UI change, no DB/migration change.

### Why travel binds today (engine trace — `slot-engine/src/engine.js`)

For an **empty day** the new job is spliced into an empty route at `idx = 0`, so `prev === base` and `next === base` (engine.js ~L125–126). The relevant gates (~L132–147), all using `driveMinutes` (raw drive, **no** geo-uncertainty margin):
- per-edge: `ePrevNew.driveMinutes` and `eNewNext.driveMinutes` vs `travel.max_edge_travel_minutes` (default **45**);
- detour: `extraTravel = ePrevNew.driveMinutes + eNewNext.driveMinutes − ePrevNext.driveMinutes` vs `travel.max_extra_travel_minutes` (default **35**), where `ePrevNext = T(base, base)` (distance 0).

The GEO empty-day gate (~L107) compares the **haversine miles** `dBase` to `max_distance_from_base_if_empty_day_miles` with **no** speed/multiplier/buffer applied — so once we lift the travel caps above what a job at the radius needs, the geo gate is the binding constraint.

### Derived travel-time model (constants cited)

`adjustedTravelMinutes` (`slot-engine/src/geo.js` L25–43):
```
driveMinutes(D) = (D / average_city_speed_mph) * 60 * travel_time_multiplier + operational_buffer_minutes
```
Constants from `slot-engine/src/config.js` `DEFAULT_CONFIG.travel`:
`average_city_speed_mph = 25`, `travel_time_multiplier = 1.10`, `operational_buffer_minutes = 10`.

Let `K = (60 / 25) * 1.10 = 2.64` min/mi and `BUF = 10` min. Then:
- **edge** (base→job): `edgeDriveMinutes(D) = K·D + BUF = 2.64·D + 10`
- **extra** (empty day, base→job→base): `ePrevNext = T(base,base)` has distance 0 ⇒ `driveMinutes = BUF`. So
  `extraTravelMinutes(D) = 2·edgeDriveMinutes(D) − BUF = 2·K·D + BUF = 5.28·D + 10`.

Sanity vs prod: `extraTravelMinutes(5) = 5.28·5 + 10 = 36.4` min ≈ the default cap **35**, and solving `5.28·D + 10 = 35` gives **D ≈ 4.74 mi** — matching the observed ~4.5–5 mi cutoff (job at base → recs; 5.4 mi → 0 feasible).

### What changes in `buildConfigOverride` (single function, `slotEngineSettingsService.js`)

Add module constants mirroring the engine (documented literals — backend does **not** import `slot-engine/`):
```
ENGINE_SPEED_MPH = 25; ENGINE_TRAVEL_MULT = 1.10; ENGINE_OP_BUFFER_MIN = 10;
ENGINE_EDGE_DEFAULT = 45; ENGINE_EXTRA_DEFAULT = 35; TRAVEL_HEADROOM = 1.10;
K = (60 / ENGINE_SPEED_MPH) * ENGINE_TRAVEL_MULT;   // 2.64 min/mi
```
Emit one **new** `travel` block keyed off `D = settings.max_distance_miles`:
```
edge  = K * D + ENGINE_OP_BUFFER_MIN;          // edgeDriveMinutes(D)
extra = 2 * K * D + ENGINE_OP_BUFFER_MIN;      // extraTravelMinutes(D)
travel: {
  max_edge_travel_minutes:  Math.max(ENGINE_EDGE_DEFAULT,  Math.ceil(edge  * TRAVEL_HEADROOM)),
  max_extra_travel_minutes: Math.max(ENGINE_EXTRA_DEFAULT, Math.ceil(extra * TRAVEL_HEADROOM)),
}
```
The `geography` / `overlap` / `feasibility` / `planning` / `ranking` / `workload` blocks are **unchanged** from REC-SETTINGS-001. Output now has **7** top-level keys (adds `travel`).

**Headroom = ×1.10 (then `Math.ceil`), with each cap floored at the engine default (edge ≥ 45, extra ≥ 35).** Rationale:
- A *multiplicative* margin scales with the cap (a flat +N would be negligible at radius 100 and oversized at radius 1). 10% comfortably absorbs the difference between the closed-form straight-line distance and the engine's actual per-pair haversine recomputation, guaranteeing a job at exactly the radius passes both travel gates so the **geo gate binds** (AC-2).
- Flooring at the engine defaults guarantees the override is **never more restrictive than today** (AC-3): at small radii where the formula would yield <45/<35, we keep 45/35.
- Because `geography.max_distance_from_base_if_empty_day_miles = D` uses raw haversine (no multiplier/buffer) and the travel caps now exceed `extraTravelMinutes(D)` and `edgeDriveMinutes(D)`, the GEO gate trips first → coverage is bounded by the radius, with the engine's existing **workday / route-fit** checks (`checkFeasibility`, `workday.shift_*`, `max_day_utilization`) as the natural upper bound (binding decision #1).

### Resulting caps (representative radii)

| `max_distance_miles` | edge(D) | extra(D) | `max_edge_travel_minutes` | `max_extra_travel_minutes` |
|---|---|---|---|---|
| 1   | 12.64 | 15.28 | **45** (floored) | **35** (floored) |
| 10  | 36.40 | 62.80 | **45** (floored) | **70** |
| 25  | 76.00 | 142.00 | **84** | **157** |
| 100 | 274.00 | 538.00 | **302** | **592** |

(`extra` caps are strictly increasing in D: 35 < 70 < 157 < 592; edge caps non-decreasing: 45 = 45 < 84 < 302.)

### Backwards-compat / protected

- Saved `slot_engine_settings` rows are unaffected (no schema/migration change). No-row companies still resolve to DEFAULTS (10 mi) and now reach ~10 mi empty-day coverage instead of ~5.
- **Untouched:** `slot-engine/` (`DEFAULT_CONFIG`, `mergeConfig`, `geo.js`, `engine.js`), all routes, `slotEngineService` consumption path (it still calls `buildConfigOverride` and forwards the result verbatim), and the entire frontend.

### File-touch summary

- **EDIT backend:** `backend/src/services/slotEngineSettingsService.js` — extend `buildConfigOverride` with the derived `travel` block + the mirrored engine constants.
- **EDIT tests:** `tests/slotEngineSettings.test.js` — new `buildConfigOverride` travel-block assertions; supersede the two REC-SETTINGS-001 assertions that hard-coded "6 top-level keys / `o.travel` undefined".
- **No** new files; **no** engine/route/frontend/migration changes.

---

## EMAIL-TIMELINE-001 — design (2026-06-26)

Wire email send/receive into the Pulse contact timeline by **reusing EMAIL-001** and inserting a **mail-provider abstraction** between the timeline/exchange logic and Gmail. Requirements: `docs/requirements.md › EMAIL-TIMELINE-001`. Backend entry is repo-root **`src/server.js`**, which mounts routers/services from `../backend/src/...`; migrations live in **`backend/db/migrations/`** (next number = **129**).

### Layering (the seam)

```
                Pulse timeline / composer (FE)
                              │
        ┌─────────────────────┴───────────────────────┐
        │  emailTimelineService  (NEW, provider-agnostic) │
        │   - inbound: filter→match contact→link→unread   │
        │   - outbound: route reply vs initiate           │
        │   - projection: quote-strip → timeline rows     │
        └─────────────────────┬───────────────────────┘
                              │ depends only on ↓ interface
                    ┌─────────┴──────────┐
                    │   MailProvider     │   (NEW interface)
                    └─────────┬──────────┘
                              │ implemented by
                    ┌─────────┴──────────┐
                    │   GmailProvider    │   (NEW thin adapter)
                    └─────────┬──────────┘
                              │ delegates to EXISTING EMAIL-001
        emailMailboxService · emailSyncService · emailService · emailQueries
```

**Rule:** `emailTimelineService` and `buildTimeline` import **only** `MailProvider`/the provider registry and `emailQueries` — never `googleapis` or `email{Mailbox,Sync,}Service` directly. All Gmail specifics (history list, watch, MIME, label inspection) stay in `GmailProvider` + EMAIL-001. This is the single seam REC for future IMAP.

### The `MailProvider` interface (`backend/src/services/mail/MailProvider.js`)

A documented base/contract (CommonJS "interface" = a class with throwing stubs + a JSDoc contract; `GmailProvider extends` it). Methods + responsibilities:

| Method | Responsibility |
|---|---|
| `getConnectionStatus(companyId)` | `{ connected: boolean, status, email_address|null }` — for the composer CTA + send guards. Gmail: `emailMailboxService.getMailboxStatus`. |
| `startWatch(companyId)` | Register provider push for INBOX; persist provider cursor + watch expiry. Gmail: `users.watch({ topicName, labelIds:['INBOX'] })` → store `history_id` + `watch_expiration`. |
| `renewWatch(companyId)` / `stopWatch(companyId)` | Re-arm before expiry / tear down on disconnect. Gmail: `users.watch` again / `users.stop`. |
| `handlePushNotification(payload)` | Verify + decode a provider push into `{ companyId, cursor }`; the service then calls `pullChanges`. Gmail: base64-decode the Pub/Sub `message.data` → `{ emailAddress, historyId }`, resolve mailbox by address. **Verification (token/OIDC) happens in the route**, payload shape here. |
| `pullChanges(companyId, sinceCursor)` | Return **normalized inbound messages** since cursor + new cursor. Gmail: `syncIncrementalHistory` semantics, but yields a normalized `NormalizedInboundMessage[]` (see below) with `labelIds` + `isInbound` included. |
| `sendMessage(companyId, { to, subject, body, inReplyTo, references, providerThreadId })` | Send; reply when `providerThreadId` present, else new thread. Returns `{ provider_message_id, provider_thread_id }`. Gmail: delegates to `emailService.replyToThread` (thread present) or `emailService.sendEmail` (new). |

**`NormalizedInboundMessage`** (provider-neutral): `{ provider_message_id, provider_thread_id, message_id_header, in_reply_to_header, references_header, from_email, from_name, to:[], subject, body_text, snippet, internal_at, labelIds:[], is_outbound:boolean }`. This is the only shape `emailTimelineService` consumes — no Gmail types leak up.

**`GmailProvider`** (`backend/src/services/mail/GmailProvider.js`) is a thin adapter; it does **not** duplicate token/refresh/MIME/history logic — it calls EMAIL-001. A `providerRegistry.get(companyId)` returns the provider for the company's mailbox (`provider` column is already `'gmail'`-checked in `079`); v1 always returns `GmailProvider`.

### Inbound real-time flow

Pub/Sub topic + push subscription point at a new endpoint. Five steps:

1. **Watch.** On mailbox connect (and on a renewal tick), `GmailProvider.startWatch` calls `gmail.users.watch({ userId:'me', requestBody:{ topicName: GMAIL_PUBSUB_TOPIC, labelIds:['INBOX'], labelFilterAction:'include' } })` and persists the returned `historyId` + `expiration` to new `email_mailboxes` columns `watch_history_id` + `watch_expires_at`.
2. **Push received + verified.** Google Pub/Sub POSTs the notification to **`POST /api/email/push/google`**, mounted in `src/server.js` **before `express.json`** with `express.raw({ type:'*/*' })` — exactly like `stripePaymentsWebhook` at `src/server.js:75`. The route **verifies** the push: either the Pub/Sub **OIDC bearer JWT** (verify signature + `aud` = our endpoint / `email` claim against `GMAIL_PUBSUB_SA_EMAIL`) or, simpler, a pre-shared **`?token=GMAIL_PUSH_VERIFICATION_TOKEN`** configured on the subscription. Invalid/missing → `401/403`, no work. Valid → **ack 200 immediately**, then process async (`setImmediate`/detached) so Pub/Sub never retries on our latency.
3. **Pull + filter.** `handlePushNotification` decodes `{ emailAddress, historyId }`, resolves the company/mailbox by `emailAddress` (tenant context derives from the **payload**, not a session). `emailTimelineService.ingestForCompany(companyId)` calls `provider.pullChanges` (which runs the existing history walk and `importGmailThread` so the **inbox stays populated**), then for each `NormalizedInboundMessage` **drops** any with `is_outbound` true or `labelIds ∩ {SENT, DRAFT}` ≠ ∅ — only genuine **INBOX external inbound** proceeds. *(Draft-edit storms die here: draft saves/edits carry `DRAFT` and are filtered → no timeline activity, satisfying AC-2.)*
4. **Contact match → link.** For each surviving message, `findEmailContact(from_email, companyId)` queries `contacts.email` (normalized) **and** `contact_emails.email_normalized` (company-scoped, `idx_contact_emails_normalized` already exists). **No match → skip** (stays inbox-only, AC-3/FR-IN-6). On match, link the `email_messages` row to the contact (data model below) and resolve/create the contact's `timelines` row (`findOrCreateTimeline` is phone-keyed; we add `findOrCreateTimelineByContact(contactId, companyId)` to `timelinesQueries`, reusing the orphan-adopt logic already in `pulse.js POST /ensure-timeline`).
5. **Unread + live.** Mirror SMS inbound exactly: `markContactUnread(contactId, internal_at)` + `markTimelineUnread(timelineId)`; run the same per-company Action-Required trigger (`arConfigHelper.getTriggerConfig(companyId, 'inbound_email')`); broadcast via `realtimeService` (a `messageAdded`-equivalent including `timelineId`) so an open `usePulsePage` `refetchTimeline()`s. **Idempotency:** linkage keys on the existing unique `(company_id, provider_message_id)`; re-link is a no-op update, so the overlapping **5-minute poll reconciliation** (kept) never double-posts (AC-1/AC-11).

**Watch-renewal scheduler.** A new interval in `emailSyncService` (or a sibling `emailWatchScheduler`) started next to the existing one at `src/server.js:413`: every `GMAIL_WATCH_RENEW_INTERVAL_MS` (default 12h) it renews any mailbox whose `watch_expires_at` is within 48h. The **existing 5-min poll scheduler is unchanged** and serves as the reconciliation fallback.

**Poll path reuse.** The existing `syncIncrementalHistory` is refactored minimally so its per-message handling also calls `emailTimelineService.linkInboundMessage(normalized, companyId)` (the same filter+match+link+unread used by push). One code path, two triggers (push + poll).

### Data model — DECISION

**Chosen: extend `email_messages` with a contact link + a thin read-time projection into `buildTimeline`. Reject a unified `messages` table.**

- **Why not a unified `messages` table:** SMS lives in `sms_messages` (+`sms_conversations`, phone-keyed) with Twilio delivery semantics; email lives in `email_messages` (+`email_threads`, Gmail-keyed) with MIME/threading semantics. Merging them means a risky backfill migration of a live SMS table, a lossy lowest-common-denominator schema, and rewriting the SMS read/write + unread paths — all explicitly out of scope and high-blast-radius. The timeline already **merges heterogeneous sources at read time** (`calls`, `sms`, `financial_events` are different tables fused in `buildTimeline` and sorted on the client in `PulseTimeline.tsx`). Email is one more source.
- **Chosen approach:** add nullable `contact_id` (+ a derived flag) to `email_messages`; `buildTimeline` runs an additional query for inbound/outbound email rows linked to the contact and emits a normalized `email_messages[]` array (and/or folds them into the existing `messages` array with a `channel:'email'` discriminator). Minimal new surface; **inbox queries are unaffected** because the new column is nullable and never filtered by the inbox.

**Migration `129_email_timeline_link.sql`:**

```sql
-- email_messages: link a message to the contact whose timeline it belongs to
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS contact_id  BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS timeline_id BIGINT REFERENCES timelines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS on_timeline BOOLEAN NOT NULL DEFAULT false;  -- true once projected (inbound matched OR outbound-from-timeline)

-- read path: "give me this contact's timeline email, newest-aware, tenant-scoped"
CREATE INDEX IF NOT EXISTS idx_email_messages_contact_timeline
  ON email_messages (company_id, contact_id, gmail_internal_at)
  WHERE contact_id IS NOT NULL;

-- mailbox: Gmail watch lifecycle for real-time push
ALTER TABLE email_mailboxes
  ADD COLUMN IF NOT EXISTS watch_history_id  TEXT,
  ADD COLUMN IF NOT EXISTS watch_expires_at  TIMESTAMPTZ;
```

Notes: `contacts.id` and `timelines.id` are **BIGINT** (BIGSERIAL); `email_messages.company_id` stays **UUID** (matches `079`). `on_timeline` lets `buildTimeline`/inbox cheaply distinguish "this email is a timeline item" without re-running the match. No change to the `079` tables' existing columns, constraints, or the inbox's `getThreads`/`getMessagesByThread` queries.

**`buildTimeline` extension** (`backend/src/routes/pulse.js`, inside the shared builder after the SMS block, gated on `contact?.id`):

```sql
SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
       to_recipients_json, subject, body_text, snippet, gmail_internal_at,
       sent_by_user_email
FROM email_messages
WHERE company_id = $1 AND contact_id = $2 AND on_timeline = true
ORDER BY gmail_internal_at ASC;
```

Each row is mapped to a timeline email item (quote-stripped `body_text` → display body) and returned in a new `email_messages` array on the JSON (alongside `calls`/`messages`/`conversations`/`financial_events`), keeping the SMS payload untouched. Permission/visibility unchanged (`pulse.view`, provider `assigned_only`). The unread-count endpoint (`GET /api/pulse/unread-count`) continues to read `contacts.has_unread`, which inbound email already sets — so email-unread surfaces in the existing badge with no change there.

### Outbound — routing + reuse

- **Composer signal.** `SmsForm.onSend` is extended from `(message, files, selectedPhone)` to also carry the chosen **channel + target**: `onSend(message, files, { channel:'sms'|'email', value })`. `usePulsePage.handleSendMessage` branches on `channel`.
- **SMS branch:** unchanged — existing `messagingApi.sendMessage` / `startConversation`.
- **Email branch:** new `emailApi.sendTimelineEmail(contactId, { body })`. Backend **route** `POST /api/email/timeline/contacts/:contactId/send` (mounted under the existing authed `/api/email`, `requirePermission('messages.send')`, `requireCompanyAccess`) → `emailTimelineService.sendForContact(companyId, contactId, body, user)`:
  - **Reply vs initiate:** look up the contact's **most recent email thread** (`email_messages.contact_id = $contactId` → newest `thread_id`). Found → `provider.sendMessage({ ..., providerThreadId })` which routes to `emailService.replyToThread` (subject `Re:` + `In-Reply-To`/`References` from the thread's last message — existing behavior). None → `provider.sendMessage` with no thread → `emailService.sendEmail` (new thread) with **auto subject** `Message from <company.name>` (FR-OUT-2).
  - **To:** the selected contact email (validated against `contacts.email`/`contact_emails` for that contact + company).
  - **Hydrate + link:** `emailService.{reply,send}` already re-imports the thread via `importGmailThread`; the service then stamps `contact_id`/`timeline_id`/`on_timeline=true` on the just-sent `email_messages` row (matched by returned `provider_message_id`) and broadcasts so the timeline shows the outbound bubble immediately (FR-OUT-4).
- **Reused as-is:** `emailService.sendEmail`, `emailService.replyToThread`, `buildMimeMessage`, `getValidAccessToken`, `importGmailThread`. **Not duplicated.** v1 sends **no `files`** on the email branch (text only).

### Composer + timeline UI

- **`SmsForm.tsx` "To" selector** (today shows up to 2 phones, lines ~57–67): generalize the dropdown to a **target list** = `[{kind:'sms', value:phone, label}…, {kind:'email', value:email, label}…]`. Email entries come from `contact.email` + `contact_emails`. When `mailbox.status !== 'connected'`, render a **non-selectable CTA row** ("Google email not connected — connect to message clients by email") that `navigate`s to the email settings/connect page (FR-UI-3; pattern mirrors the existing "+ Add New" row that navigates to `/settings/quick-messages`). The selected target drives an `email` vs `sms` send and toggles minor copy (placeholder, char-counter hidden for email). No subject field is ever shown.
- **`usePulsePage.ts`:** add `mailboxStatus` (from `emailApi.getWorkspaceMailbox`, React-Query-cached), build the email target list from `contact`/`contactDetail`, and compute **default channel = last inbound channel**: extend the existing `lastUsedPhone` logic to also consider the newest inbound `email_messages` timestamp; if email is newest, default the selector to that email; else keep the SMS default. `handleSendMessage` gains the `{channel}` branch.
- **`messagingApi.ts` / `emailApi.ts`:** add `emailApi.sendTimelineEmail`. (Keep email calls in `emailApi`; SMS in `messagingApi` — no cross-import.)
- **Timeline render:** add an `email` item type alongside `sms` in `PulseTimeline.tsx`'s `useMemo` fusion (timestamp = `gmail_internal_at`), rendering an **`EmailListItem`** bubble (new, sibling to `SmsListItem.tsx`) — inbound left / outbound right, plain text (quote-stripped body), timestamp, a small mail glyph / "Email" eyebrow to distinguish channel. No HTML, no attachment chips (v1). `types/pulse.ts` gets an `EmailTimelineItem` type; the timeline fetch hook maps the new `email_messages` array.

### Config / env (`.env.example` additions)

```
# EMAIL-TIMELINE-001 — Gmail real-time push (Google Cloud Pub/Sub)
GMAIL_PUBSUB_TOPIC=projects/<gcp-project>/topics/gmail-inbound   # topic passed to users.watch
GMAIL_PUSH_VERIFICATION_TOKEN=                                   # shared secret on the push subscription (?token=)
GMAIL_PUBSUB_SA_EMAIL=                                           # (if OIDC) service account in the push JWT 'email' claim
GMAIL_PUSH_ENDPOINT_PATH=/api/email/push/google                 # informational; subscription push URL
GMAIL_WATCH_RENEW_INTERVAL_MS=43200000                          # 12h watch-renewal tick (watch expires ≤7d)
# Reused from EMAIL-001 (already present): GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI, EMAIL_TOKEN_ENCRYPTION_KEY,
# EMAIL_OAUTH_STATE_SECRET, EMAIL_SYNC_INTERVAL_MS (5-min poll kept as reconciliation).
```

Gmail watch additionally requires the Gmail API service account `gmail-api-push@system.gserviceaccount.com` to have **Pub/Sub Publisher** on the topic (GCP setup, documented in deploy notes — not code).

### Files to change / add

**Backend (add)**
- `backend/src/services/mail/MailProvider.js` — interface/contract + `NormalizedInboundMessage` JSDoc.
- `backend/src/services/mail/GmailProvider.js` — adapter delegating to EMAIL-001 services (watch/renew/stop, pullChanges→normalize, sendMessage→send/reply, getConnectionStatus).
- `backend/src/services/mail/providerRegistry.js` — `get(companyId)` → provider (v1: Gmail).
- `backend/src/services/emailTimelineService.js` — provider-agnostic: `linkInboundMessage`, `ingestForCompany`, `findEmailContact`, `sendForContact`, quote-stripper `toTimelineBody`.
- `backend/src/routes/email-push.js` — `POST /api/email/push/google` (raw body, token/OIDC verify, fast-ack, async ingest).

**Backend (edit)**
- `src/server.js` — mount `email-push` **before `express.json`** (next to `:70–76`); start the **watch-renewal scheduler** next to `:411–413`.
- `backend/src/routes/pulse.js` — `buildTimeline`: add the contact-linked email query + `email_messages` array in the response.
- `backend/src/routes/email.js` — add `POST /timeline/contacts/:contactId/send` (`messages.send`).
- `backend/src/services/emailSyncService.js` — call `emailTimelineService.linkInboundMessage` from the history path (push + poll share it); export a `pullChangesNormalized` helper for the provider.
- `backend/src/services/emailMailboxService.js` — persist/clear `watch_history_id`/`watch_expires_at` on connect/disconnect; `disconnectMailbox` → `provider.stopWatch`.
- `backend/src/db/emailQueries.js` — `linkMessageToContact`, `getTimelineEmailByContact`, watch-column updates, `listMailboxesForWatchRenewal`.
- `backend/src/db/timelinesQueries.js` — `findOrCreateTimelineByContact(contactId, companyId)`.
- `backend/src/services/arConfigHelper` usage — support an `inbound_email` trigger key (config-only).

**DB (add)**
- `backend/db/migrations/129_email_timeline_link.sql` (above) + `backend/db/migrations/rollback_129_email_timeline_link.sql`.

**Frontend (edit)**
- `frontend/src/components/pulse/SmsForm.tsx` — generalized "To" target selector (phones + emails + connect-CTA), channel-aware `onSend`.
- `frontend/src/hooks/usePulsePage.ts` — mailbox status, email targets, default-channel = last inbound channel, `handleSendMessage` email branch.
- `frontend/src/services/emailApi.ts` — `sendTimelineEmail`.
- `frontend/src/components/pulse/PulseTimeline.tsx` — fuse `email` items; `frontend/src/components/pulse/EmailListItem.tsx` (**add**) — email bubble.
- `frontend/src/types/pulse.ts` / `frontend/src/types/contact.ts` — `EmailTimelineItem`; ensure `contact_emails` surfaced to the composer.
- `frontend/src/hooks/usePulseTimeline.ts` (or equivalent) — map the new `email_messages` array.

### Protected / forbidden (must not break)

- **EMAIL-001 inbox**: `backend/src/routes/email.js` existing endpoints, `email-oauth.js`, `email-settings.js`, `components/email/*`, `EmailPage`/`EmailSettingsPage`, `getThreads`/`getMessagesByThread`, attachment download, OAuth. The new email-timeline column is **nullable** and never filtered by inbox queries.
- **EMAIL-001 services**: do not change `getValidAccessToken`/refresh, `importGmailThread` thread-upsert, or `email_sync_state` checkpointing semantics; only **add hooks**/new exports. Keep the 5-minute scheduler (now also reconciliation).
- **SMS/calls/financial timeline**: `buildTimeline`'s existing arrays + the SMS send path (`conversationsService`, `messagingApi`) stay intact — email is additive (new array + new composer branch).
- **slot-engine**, `src/server.js` boot order/core, `authedFetch.ts`, `useRealtimeEvents.ts`, the `079` migration, and all prior migrations — unchanged.
- **Tenancy**: no email query may omit `company_id`; the push route derives tenant from the verified notification payload, never trusts a caller-supplied id.

### Risks / edge cases

- **No contact match** → inbox-only, no timeline/unread/contact (AC-3). Expected, not an error.
- **Multiple contacts share one email** (`from_email` matches >1 contact in the company) → v1 links to the **most-recently-active** match (deterministic tiebreak: highest `contacts.updated_at`, then lowest id) and logs a warning; never fans out to several timelines. (Documented limitation; contact-merge is out of scope.)
- **Contact has email but mailbox disconnected** → composer email entries show the **connect CTA**, not a send target (FR-UI-3); inbound simply isn't arriving (no watch). Outbound route returns `409` (mirrors `emailService`'s `reconnect_required`).
- **Gmail watch expiry (≤7d)** → renewal scheduler re-arms within 48h of expiry; if a watch lapses, the 5-min poll still ingests inbound into the timeline (degraded latency, not loss) (AC-11).
- **Pub/Sub at-least-once / retries / duplicates / reorders** → idempotent on `(company_id, provider_message_id)`; re-link is a no-op; fast-ack prevents retry storms; poll overlap is safe.
- **Threading when initiating** → no `providerThreadId` ⇒ `sendEmail` (new thread); a reply path is taken **only** when a prior email thread for the contact exists, preventing accidental cross-thread merges.
- **Draft-edit push storm** → every draft save/edit emits `labelsAdded`/`messagesAdded` history carrying the `DRAFT` label; the INBOX-external filter in step 3 drops all of them ⇒ zero timeline activity (AC-2). Outbound (`SENT`/own-from) is filtered the same way; the agent's own sent timeline emails are projected by the **send path** (stamping `on_timeline`), not by inbound ingest, so there's no double-count.
- **History-gap fallback** (`syncIncrementalHistory` 404 → backfill) is preserved; backfilled threads run the same `linkInboundMessage`, so a gap self-heals onto the timeline.
- **Push endpoint spoofing** → unverified token/OIDC ⇒ rejected before any DB work (AC-10).

---

# SEND-DOC-001 — Architecture (Architect 02)

> Wires the existing-but-unconnected delivery infra (`emailService.sendEmail`, `conversationsService` SMS, `generatePdf`, `ensurePublicLink`) into the two "send" stubs, gives **estimates** the tokenized public page invoices already have, and relocates Gmail connect into a **marketplace app**, retiring `/settings/email`. **Reuse over rebuild** throughout. Migration number: **131** (next free; latest on disk is 130).

## A. Estimate public link + page (mirror the invoice machinery)

### A.1 Migration `131_estimates_public_token.sql` (+ `rollback_131_*.sql`)
Mirror migration 087 exactly, on `estimates`:
```sql
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS public_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_public_token
  ON estimates (public_token) WHERE public_token IS NOT NULL;
```
Rollback drops the index then the column. Additive, idempotent (re-runnable by `apply_migrations.js`).

### A.2 Queries — `backend/src/db/estimatesQueries.js` (mirror invoicesQueries 563-599)
- `getEstimateByPublicToken(publicToken)` — `SELECT … FROM estimates e … WHERE e.public_token = $1` (no company scope; token is auth). Join the same contact fields the list query exposes (`contact_name/contact_email/contact_phone`) + company name for the page header.
- `setPublicToken(estimateId, companyId, token)` — `UPDATE estimates SET public_token = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2`.

### A.3 Service — `backend/src/services/estimatesService.js`
- `ensurePublicLink(companyId, id)` — copy of the invoice impl: load estimate (404 if missing), reuse `public_token` or mint `crypto.randomBytes(8).toString('base64url')` via `setPublicToken`, return `{ token, url }` where `url = (PUBLIC_APP_URL||APP_URL).replace(/\/+$/,'') + '/e/' + token`. Idempotent.
- `getPublicEstimate(token)` — `getEstimateByPublicToken` + `getEstimateItems`, shaped for the page (number, status, items, totals, company_name, contact display name). 404 if not found.
- `generatePdfByPublicToken(token)` — mirror invoice: resolve by token, load items, `documentTemplatesService.resolveTemplate(company_id,'estimate')` + `rendererRegistry.get('estimate')`, return `{ estimate, buffer }`. (Note the doc-link in the **email** points to `/e/<token>` page, but the **PDF route** is `/api/public/estimates/:token/pdf`; the page's "Download PDF" hits that.)
- Export all three.

### A.4 Public routes — new `backend/src/routes/public-estimates.js` (mirror public-invoices.js)
- `GET /estimates/:token` → `estimatesService.getPublicEstimate(token)` → `{ ok:true, data }` (view JSON for the React page). Validate token with the same `TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/` → 404 on mismatch.
- `GET /estimates/:token/pdf` → `generatePdfByPublicToken` → stream `application/pdf` inline (copy headers/Cache-Control from public-invoices).
- `shortRouter.get('/e/:token')` → in dev/SSR-less Vite this must reach the **React page**, not the PDF. Two valid options (pick one, document): (a) serve the SPA `index.html` for `/e/:token` (client routes via React Router to `PublicEstimateViewPage`), like `/pay/:token` is an App.tsx route reached by the SPA; **or** (b) 302 to `/api/public/estimates/:token` JSON. **Chosen: (a)** — `/e/:token` is a **client route** (App.tsx), NOT a server redirect; the server short-router is only needed if a hard GET must resolve, in which case 302 → the SPA path. Keep it parallel to how `/pay/:token` already works as a pure App.tsx route (no server short-link for the *page*; `/i/:token` short-link is only for the **PDF**). So: add a **PDF** short-link `GET /ep/:token → 302 /api/public/estimates/:token/pdf` for SMS-friendly PDF if needed, but the customer link in messages is the **page** `/e/<token>` (served by the SPA).
- Mount in `src/server.js` next to public-invoices (auth-skipping), e.g.:
  ```js
  const publicEstimatesRouter = require('../backend/src/routes/public-estimates');
  app.use('/api/public', publicEstimatesRouter);
  app.use('/', publicEstimatesRouter.shortRouter); // optional PDF short-link
  ```
  `/e/:token` itself is handled by the SPA catch-all (same as `/pay/:token`).

### A.5 Page — `frontend/src/pages/PublicEstimateViewPage.tsx` + route App.tsx
- New default-export component mirroring `PublicInvoicePayPage` structure (token from `useParams`, fetch `GET /api/public/estimates/:token`, loading/error states), **view-only**: company header, estimate number, line-items table, totals, status badge, "Download PDF" → `/api/public/estimates/:token/pdf`. No tip/Stripe/Accept. Albusto tokens (`--blanc-*`), product name "Albusto".
- `App.tsx`: add `<Route path="/e/:token" element={<PublicEstimateViewPage />} />` adjacent to the `/pay/:token` route (both outside the authed shell).

### A.6 Token security
- 64-bit opaque token = the only credential; unscoped lookup resolves exactly one row (unique index). `TOKEN_RE` rejects malformed input before any DB hit. PDF route sets `Cache-Control: private, must-revalidate`. No enumeration (random, not sequential). Same posture as invoices (AC-16/17).

## B. Dispatch wiring (the core of PART A)

### B.1 `estimatesService.sendEstimate(companyId, userId, id, { channel, recipient, message })`
Replace the stub body. Steps:
1. Load estimate (404), `assertNotArchived`, `assertHasItems`. Normalize channel (`text`→`sms`); must be `email|sms`.
2. **Validate recipient** present (else `EstimatesServiceError('VALIDATION', …, 400)`).
3. `link = (await ensurePublicLink(companyId, id)).url` (the `/e/<token>` page).
4. **Email branch**:
   - `{ buffer } = await generatePdf(companyId, id)`.
   - Build `subject` + `body` (HTML) from templates (B.3); body includes the `link`.
   - `result = await emailService.sendEmail(companyId, { to: recipient, subject, body, files: [{ originalname: \`\${estimate_number||'estimate'}.pdf\`, mimetype: 'application/pdf', buffer }], userId, userEmail })`.
   - **Timeline stamp**: if the estimate has a `contact_id`, resolve its `timeline_id` and call `emailQueries.linkMessageToContact(result.provider_message_id, companyId, { contact_id, timeline_id, on_timeline:true })` so the sent email projects onto the contact timeline (the EMAIL-TIMELINE-001 outbound mechanism). Best-effort (wrap in try/catch; a stamp failure must not undo a real send).
5. **SMS branch**:
   - `customerE164 = toE164(recipient)` → `422 NO_PHONE` if falsy.
   - `proxyE164 = await resolveCompanyProxyE164(companyId)` (extract the helper from `routes/jobs.js` into a shared module — see B.5) → `422 NO_PROXY` if null.
   - `conv = await conversationsService.getOrCreateConversation(customerE164, proxyE164, companyId)`; `await conversationsService.sendMessage(conv.id, { body: smsBody(message, link), author:'agent' })`. Wallet gate is **inside** `sendMessage` → maps to `402`. `conversationsService` already records the message + projects SMS to the timeline (no extra stamp needed).
6. **On success only**: `updateEstimate(id, companyId, { status:'sent', sent_at: now })` (add `sent_at` handling; estimates currently lack a sent flip) and `createEvent(id, 'sent', 'user', userId, { channel, recipient })`. **On any dispatch throw → do NOT change status** (let the error propagate; route maps to the right HTTP code).

### B.2 `invoicesService.sendInvoice(companyId, userId, id, { channel, recipient, message, includePaymentLink })`
Same shape, but:
- `link = (await ensurePublicLink(companyId, id)).url` is the **`/i/<token>` short PDF link today**; the **customer page** is `/pay/<token>`. For consistency the message link should be the **pay page** `/pay/<token>` (what `InvoiceSendDialog` already mints via `ensureInvoicePublicLink`). Keep `ensureInvoicePublicLink` returning the page URL the dialog expects; pass the same URL into the body. Honor `includePaymentLink` (omit link when false).
- Email branch attaches the invoice PDF (`generatePdf`) + body link; SMS branch identical to B.1.5. Timeline stamp identical (invoice carries `contact_id`).
- **Move the status flip to after a successful dispatch** (today it flips first, then "records"): keep `updateInvoiceStatus(id, companyId, 'sent', 'sent_at')` + the `sent` event, but only once dispatch succeeds.

### B.3 Templates (default subject/body per doc × channel)
Add a small `documentSendTemplates` helper (or inline). Mirrors the friendly tone already in `InvoiceSendDialog.buildDefaultMessage` (the **dialog** prefills the editable message; the **service** uses `message` as the body and only synthesizes the **subject** + wraps SMS/email link). 
- **Email subject**: estimate → `Estimate {number} from {company}`; invoice → `Invoice {number} from {company}`.
- **Email body**: HTML wrap of the operator-edited `message` (newlines→`<br>`), with the `link` rendered as an anchor ("View your estimate/invoice online"). PDF is the attachment.
- **SMS body**: the operator-edited `message`; if it does not already contain the link, append ` {link}`. (The dialog's default already embeds the link, so usually a no-op.)

### B.4 Routes — pass the new body through
- `routes/estimates.js` `POST /:id/send` (perm `estimates.send`): read `{ channel, recipient, message }` from `req.body`, pass to `sendEstimate`. Map service errors: `VALIDATION`→400, `MAILBOX_NOT_CONNECTED`/409 (from `emailService`) → 409, `WALLET_BLOCKED`→402, `NO_PROXY`/`NO_PHONE`→422.
- `routes/invoices.js` `POST /:id/send` (perm `invoices.send`): same body incl. `includePaymentLink`; same error mapping. (Both routes already exist; only the handler payload + error translation expand.)

### B.5 `proxyE164` resolution (shared)
`resolveCompanyProxyE164(companyId)` lives in `routes/jobs.js:716` (most-recent `sms_conversations.proxy_e164`, else `SOFTPHONE_CALLER_ID`). **Extract to `backend/src/services/messagingHelper.js`** (or reuse if a phone-helper module exists per RF007) and import in both `jobs.js` and the send services — no logic change. Returns null when no number ⇒ `422 NO_PROXY`.

## C. Send dialog (frontend)

### C.1 `EstimateSendDialog` upgrade (to invoice parity)
Rewrite `frontend/src/components/estimates/EstimateSendDialog.tsx` to mirror `InvoiceSendDialog`: 
- Props gain `contactPhone`, `estimateNumber`, `contactName`. State: `channel: 'email'|'sms'`, `emailRecipient`/`phoneRecipient` (prefilled), `message`, `publicUrl`.
- On open, `ensureEstimatePublicLink(estimateId)` (new `estimatesApi` fn calling `POST /api/estimates/:id/public-link` OR a thin `GET` — add a tiny authed route `POST /api/estimates/:id/public-link → ensurePublicLink`, mirroring the invoice one) to mint/fetch the `/e/<token>` URL for the default message.
- Default message via a `buildDefaultMessage(channel, {...})` (estimate-flavored copy: "Here's your estimate {n}. View it online: {url}"). Channel toggle email|SMS, editable recipient, required message. `onSend({ channel, recipient, message })`.
- `EstimateSendData` (estimatesApi.ts:140) → `{ channel:'email'|'sms'; recipient:string; message:string }`; `sendEstimate(id, data)` posts the full body.

### C.2 `InvoiceSendDialog` — reused as-is
Already complete (channel, recipient, message, include-payment-link, mints `ensureInvoicePublicLink`). No change beyond passing `includePaymentLink`/`message`/`recipient` straight to the now-real `sendInvoice` (it already does).

### C.3 Connection-status check + connect CTA
- Before/within the email branch the dialog (or the panel) checks `emailApi.getTimelineMailboxStatus()` → `{ connected, email_address }`. If not connected and channel=email, show an inline notice + a **"Connect Google Email"** link to the new marketplace app setup path (FR-A6/B1), and disable email Send. Also handle a `409 MAILBOX_NOT_CONNECTED` from the API defensively (same CTA toast).
- This reuses the **existing** pattern in `IntegrationsPage.tsx` (`requiresGmail`, `dependency_cta.path`, `gmailConnected = mailbox.provider==='gmail' && status==='connected'`).

### C.4 Financials-tab fix (FR-A7)
In `JobFinancialsTab.tsx` (:337-346) and `LeadFinancialsTab.tsx` (:271-280), stop calling `sendInvoice(id, { channel:'email', recipient:'' })` from `InvoiceDetailPanel.onSend`. Instead let `InvoiceDetailPanel` own the `InvoiceSendDialog` (it already does in its own panel usage) and pass `contactEmail`/`contactPhone`/`invoiceNumber`/`contactName`/`balanceDue`/`total`/`dueDate` so the dialog prefills; the tab's `onSend` becomes the real `sendInvoice(id, data)` with the dialog's `{channel,recipient,message}`. Same for estimates via `EstimateSendDialog`. (Verify whether `InvoiceDetailPanel` already renders the dialog internally; if so, the tabs just stop the bypassing direct call and forward `data`.)

## D. Marketplace app for Google Email (PART B)

### D.1 Seed `131`/`132_seed_google_email_marketplace_app.sql`
> Use the **next** migration number after the token migration (token = 131, seed = 132) so both land in one feature. Mirror the Stripe seed (116):
```sql
INSERT INTO marketplace_apps (app_key, name, provider_name, category, app_type,
  short_description, long_description, requested_scopes, provisioning_mode, status,
  support_email, privacy_url, docs_url, metadata)
VALUES ('google-email', 'Google Email', 'Albusto', 'communication', 'internal',
  'Send estimates & invoices and sync mail from your Gmail.',
  'Connects a company Gmail mailbox via Google OAuth. Albusto uses it to email documents to customers and to project email onto the contact timeline.',
  '["email:send","email:read"]'::jsonb, 'none', 'published',
  'support@albusto.local', 'https://albusto.local/privacy', '/settings/api-docs',
  '{"setup_path":"/settings/integrations/google-email","manages_gmail_connection":true}'::jsonb)
ON CONFLICT (app_key) DO UPDATE SET … updated_at = NOW();
```
Also in the same seed: **`UPDATE marketplace_apps SET metadata = jsonb_set(metadata,'{dependency_cta,path}','"/settings/integrations/google-email"') WHERE app_key='mail-secretary';`** (FR-B6).

### D.2 Connect → existing OAuth
The app's setup surface (new `GoogleEmailSettingsPage` routed at `/settings/integrations/google-email`, mirroring `StripePaymentsSettingsPage`/`VapiSettingsPage`, OR the `IntegrationsPage` "Connect Gmail" inline action) calls the **unchanged** `POST /api/settings/email/google/start` (perm `tenant.integrations.manage`) → returns the Google consent URL → browser navigates → Google → `GET /api/email/oauth/google/callback`. No OAuth rewrite.

### D.3 Connected-state derived from the real mailbox (key design point)
The "Google Email" app must show **Connected + address** from the **actual mailbox**, not a fabricated install row:
- **Frontend**: the app's card/detail reads `getMailboxSettings()`/`getTimelineMailboxStatus()` and treats `provider==='gmail' && status==='connected'` as connected (exactly like `IntegrationsPage.gmailConnected`). For the `google-email` app specifically, **override** the generic `installation?.status==='connected'` check with this mailbox-derived boolean and display `email_address`.
- **Backend (optional, cleaner)**: in `marketplaceService.listApps`/`isAppConnected`, special-case `app_key==='google-email'` to derive `connected` from `emailMailboxService` mailbox status (overlay a synthetic `installation: { status: mailbox.connected ? 'connected':'disconnected', external_installation_id: mailbox.email_address }`) so the marketplace truthfully reflects Gmail without requiring a real `marketplace_installations` insert. Document that `google-email` does **not** go through `installApp` provisioning (provisioning_mode `none`); its lifecycle is the OAuth connect/disconnect.

### D.4 Disconnect
The app's Disconnect calls the existing `POST /api/settings/email/disconnect` (perm `tenant.integrations.manage`) — tears down the Gmail watch, nulls tokens, preserves history. After it returns, the mailbox-derived state flips to Not connected (D.3), so the app reflects it without a separate install-row mutation.

### D.5 Callback redirect change (FR-B6)
`routes/email-oauth.js`: replace `const SETTINGS_URL = '/settings/email';` with `'/settings/integrations/google-email'` (success → `?connected=1`, error → `?error=…`, `?email_error=already_connected|connect_failed`). The new setup page reads these flags (toast). The OAuth logic is otherwise untouched.

### D.6 Remove `/settings/email` route + nav (FR-B5)
- `App.tsx:142`: **delete** the `/settings/email` route; add a **redirect** `<Route path="/settings/email" element={<Navigate to="/settings/integrations/google-email" replace />} />` so old bookmarks/the callback (until cache clears) don't 404.
- `appLayoutNavigation.tsx:96`: **remove** the `{ label:'Email', path:'/settings/email' }` nav item.
- Either delete `EmailSettingsPage.tsx` or repurpose its connect/disconnect/status UI into `GoogleEmailSettingsPage` (preferred: reuse its JSX). 
- Update the other `/settings/email` string references (`SmsForm`, `EmailThreadPane`, `EmailPage`, `IntegrationsPage`, `emailApi`) to the new path.

## E. Files — change / add / protected

**DB (add)**
- `backend/db/migrations/131_estimates_public_token.sql` + `rollback_131_estimates_public_token.sql`
- `backend/db/migrations/132_seed_google_email_marketplace_app.sql` (incl. mail-secretary dependency_cta update)

**Backend (change)**
- `services/estimatesService.js` — `ensurePublicLink`, `getPublicEstimate`, `generatePdfByPublicToken`, rewrite `sendEstimate` (real dispatch + status flip + timeline stamp); add `sent_at` handling.
- `services/invoicesService.js` — make `sendInvoice` actually dispatch (email/SMS) + move status flip after success; honor `includePaymentLink`.
- `db/estimatesQueries.js` — `getEstimateByPublicToken`, `setPublicToken`.
- `routes/estimates.js` — `/:id/send` body + error mapping; add `POST /:id/public-link`.
- `routes/invoices.js` — `/:id/send` body (`includePaymentLink`) + error mapping.
- `routes/email-oauth.js` — `SETTINGS_URL` → marketplace path.
- `src/server.js` — mount `public-estimates` router (+ optional short-link).
- (extract) `services/messagingHelper.js` — shared `resolveCompanyProxyE164`; update `routes/jobs.js` import.

**Backend (add)**
- `routes/public-estimates.js`.

**Frontend (change)**
- `components/estimates/EstimateSendDialog.tsx` — full upgrade to invoice parity.
- `services/estimatesApi.ts` — `EstimateSendData` shape, `ensureEstimatePublicLink`, `sendEstimate` body.
- `components/jobs/JobFinancialsTab.tsx`, `components/leads/LeadFinancialsTab.tsx` — route send through the dialog (FR-A7).
- `App.tsx` — add `/e/:token` route; replace `/settings/email` route with a redirect; (add `/settings/integrations/google-email`).
- `components/layout/appLayoutNavigation.tsx` — remove Email nav item.
- `pages/IntegrationsPage.tsx` — Google Email app: mailbox-derived connected-state + CTA path; update `dependency_cta` default fallback.
- `SmsForm.tsx`, `EmailThreadPane.tsx`, `EmailPage.tsx`, `emailApi.ts` — repoint `/settings/email` strings.

**Frontend (add)**
- `pages/PublicEstimateViewPage.tsx`.
- `pages/GoogleEmailSettingsPage.tsx` (or repurpose `EmailSettingsPage.tsx`).

**Protected (do not break)**
- EMAIL-TIMELINE-001 send/receive + `emailQueries.linkMessageToContact` semantics; EMAIL-001 inbox.
- Google OAuth backend (`email-settings.js`, `email-oauth.js` except the redirect string, `emailMailboxService` incl. token refresh + watch).
- Invoice pay page `/pay/:token`, `ensureInvoicePublicLink`, `/i/:token`, Stripe public-pay routes.
- `src/server.js` public-mount ordering (auth-skipping `/api/public/*`).

## F. Risks / edge cases
- **Estimate/invoice with no contact email/phone** → recipient empty: dialog disables Send; backend 400. If `contact_id` exists but no email, operator can still type one (dialog recipient is editable); timeline stamp only runs when `contact_id` is present.
- **SMS with no company Twilio number** → `resolveCompanyProxyE164` null → `422 NO_PROXY`, no side effects, no false Sent (mirror ETA-notify).
- **Wallet blocked** → `assertServiceActive` throws inside `sendMessage` → `402`; status untouched.
- **Email not connected mid-send** → `emailService.sendEmail` throws (`Mailbox is not connected` / `409 reconnect_required`); service surfaces `409 MAILBOX_NOT_CONNECTED`; status untouched; UI shows the connect CTA → Google Email app.
- **Partial success** (email sent but timeline stamp fails) → send is authoritative; stamp is best-effort/try-catch so a stamp error never rolls back a real send or blocks the status flip; a missed stamp self-heals if the inbound/sync path later links the SENT message (EMAIL-TIMELINE-001 already projects own-from sent mail via the send path).
- **Public token leakage** → opaque 64-bit token, unique index, `TOKEN_RE` guard, `private` cache; view-only page exposes no payment action; same posture as invoices.
- **Removing `/settings/email`** → keep a `Navigate` redirect for old bookmarks and the in-flight OAuth callback; update the callback `SETTINGS_URL` so new flows never hit the old path.
- **Marketplace "connected" vs install-row mismatch** → `google-email` connected-state is **derived from the real mailbox** (D.3), not a `marketplace_installations` row; disconnecting the mailbox flips the app to Not connected even with a stale install row; `isAppConnected('google-email')` (if used by gates like mail-secretary) must consult the mailbox, not just an install row.
- **Idempotent resend** → `ensurePublicLink` reuses the token; re-sending re-flips `sent`/`sent_at` and adds another `sent` event (acceptable: an audit trail of each send).

---

## GOOGLE-SSO-FIX-001 — Google login architecture

**Identity plane (unchanged, relied upon).** Keycloak stays the sole identity plane.
Any authenticated request → `middleware/keycloakAuth.authenticate` verifies the RS256
token then calls `userService.findOrCreateUser({ sub, email, name, preferred_username })`,
which **JIT-upserts `crm_users` by `keycloak_sub`** and pulls `full_name`+`email` from the
token. This is IdP-agnostic — a Google-brokered token provisions a `crm_users` row exactly
like a password token. No backend change was needed for "pull name/email from Google".

**Frontend init seam (the fix).** `getKeycloak()` returns a singleton that is only
`init()`-ed by `AuthProvider`'s main effect — which the `publicPage` guard skips on
`/signup`. New exports in `AuthProvider.tsx`:
- `ensureKeycloakInitialized()` — lazy, once-only `kc.init({ pkceMethod:'S256', checkLoginIframe:false })`
  (no `onLoad` → wires adapter + PKCE without redirecting). Guarded by a module `kcInitPromise`
  and the existing `kcInitialized` flag, so app pages still init exactly once.
- `loginWithIdp(idpHint, redirectUri)` — awaits the init, then `kc.login(...)`.
`SignupPage.googleSignup` calls `loginWithIdp('google', origin + '/onboarding')`. The PKCE
verifier lives in keycloak-js callback storage across the full-page redirect; `/onboarding`
(a protected page, so `AuthProvider` inits with `onLoad:'login-required'`, same `pkceMethod`)
completes the code→token exchange.

**Keycloak config as source-of-truth.** `keycloak/realm-export.json` now carries the
`google` IdP (`${GOOGLE_IDP_CLIENT_ID/SECRET}`, `trustEmail:true`, `syncMode:IMPORT`),
`identityProviderMappers` (given→firstName, family→lastName, email), and the custom
first-broker-login flow **"first broker login auto link"** (`idp-review-profile` DISABLED,
`idp-create-user-if-unique` ∥ `idp-auto-link` ALTERNATIVE) for verified-email auto-linking.
Because `--import-realm` only configures a realm on first import, `scripts/setup-google-idp.sh`
(idempotent Admin REST create-or-update) is the apply-path for the already-imported prod realm.

**Sign-in surface.** `login.ftl` renders `social.providers` as a styled Google button; the
React `/signup` keeps its own button (now wired via `loginWithIdp`).

**Edge cases.**
- **login() before init** → previously `TypeError (adapter undefined)`; now `ensureKeycloakInitialized` guarantees the adapter + PKCE first.
- **PKCE-required client** → `pkceMethod:'S256'` is set on init so `code_challenge` is always present (crm-web rejects otherwise).
- **Google email already registered (password)** → `trustEmail` + `idp-auto-link` link silently; no duplicate user (`duplicateEmailsAllowed:false` upheld).
- **Missing broker redirect URI in Google Console** → Google returns `redirect_uri_mismatch`; required URI is `<KC>/realms/crm-prod/broker/google/endpoint` (documented in the script + `.env.example`).
- **Dev import without `GOOGLE_IDP_*`** → `${…:}` empty-string defaults keep the realm import valid.

---

## ONBOARD-FIX-001 — tenant-isolation model + onboarding authz refresh

**Tenant scope = membership only.** `requireCompanyAccess` now sets `req.companyFilter`
solely from `req.authz.company.id`, which `authorizationService.resolveAuthzContext` derives
**only** from an active `company_memberships` row (or null). The removed fallback to
`req.user.company_id` (the `crm_users.company_id` "shadow", backfilled to the seed company by
migration 012) was the leak: a membership-less user resolved to Boston Masters. `crm_users.company_id`
is now audit-context only (the three `sessions.js` refs are marked `tenant-safety-allow`); it is
never consulted for data scoping. All 53 tenant routes read `req.companyFilter` — so a
membership-less request gets `403 TENANT_CONTEXT_REQUIRED` and no data.

**Fail-closed dev bypass.** `authenticate`'s `!FEATURE_AUTH` branch hands out the seed company
as `company_admin` — fine for local dev, catastrophic in prod. It now returns
`500 AUTH_MISCONFIGURED` when `NODE_ENV==='production'`, so a missing `FEATURE_AUTH_ENABLED`
can never silently expose Boston Masters.

**Shadow hygiene (migration 140).** Idempotently NULLs `crm_users.company_id` wherever it is
not backed by an active membership in that company, so no other code path can resurrect the
leak. Preserves the shadow where it correctly mirrors a membership.

**Frontend authz refresh seam.** `AuthProvider` gains `refreshAuthz()` (re-`GET /api/auth/me`
with the current token — backend resolves from `company_memberships`, so the token needn't
change). `OnboardingPage.createCompany` awaits it before navigating (success + `ALREADY_ONBOARDED`).
Because `useAuthz` reads from `useAuth`, `ProtectedRoute` and `OnboardingGate` both see the fresh
`company`/`permissions` immediately — no redirect loop, no false 403, no full-page reload (which
would risk the 401→2FA loop the onboarding flow deliberately avoids).

**Phone normalization.** Onboarding masks via the shared `formatUSPhone` and posts `toE164(phone)`
to `/api/public/otp/{send,verify}` — one canonical phone util across New Lead + onboarding.

**Theme completeness.** The albusto theme (own CSS only, no base styles) now overrides the 6
reachable pages that previously rendered unstyled: `login-otp`, `select-authenticator`,
`login-reset-password`, `login-update-password`, `error`, `idp-review-user-profile`.

**Edge cases.**
- Membership-less user on any tenant route → 403 (was: seed-company data). Regression-tested.
- Reporter's case (`office@bostonmasters.com`) → most likely a pre-existing Boston Masters member (Google account-link) → `409 ALREADY_ONBOARDED` → their own company's Pulse; not a leak, but the fix closes the structural hole.
- Prod `FEATURE_AUTH_ENABLED` unset → 500 (fail closed) instead of universal Boston Masters admin.

---

## LEADS-NEW-BADGE-001 — nav count badge (mirrors the Pulse pattern)

**Count source.** `leadsService.countNewLeads(companyId)` → `COUNT(*) WHERE company_id=$1 AND
lead_lost=false AND status = ANY(NEW_LEAD_STATUSES)`, `NEW_LEAD_STATUSES=['Submitted','New','Review']`
(exported single source of truth). Exposed at `GET /api/leads/new-count` (`leads.view`,
`req.companyFilter.company_id`) — registered **before** `/:uuid` (Express route-ordering trap).
Uses the existing `idx_leads_status`; no migration.

**Live refresh (hybrid).** `AppLayout` mirrors the Pulse-badge pattern: `leadsNewCount` state,
`fetchLeadsNewCount()` (guarded on `company`), refetch on mount + `location.pathname`, a **60s
poll**, and SSE. Emits: `leadsService.emitLeadChange()` → `realtimeService.broadcast('lead.created'|'lead.updated', {company_id,status,lead_id})`
from `createLead` (creation chokepoint — manual/VAPI/integration) and the four status mutators
(`updateLead` on status change, `markLost`, `activateLead`, `convertLead`). Best-effort (never
breaks the write); the 60s poll self-heals any missed emit.

**Tenant safety.** `realtimeService.broadcast` fans out to ALL clients (no per-company channel),
so: the payload is minimal & PII-free; the client refetches its own company-scoped count **only**
when `event.company_id === company.id`. No cross-tenant data crosses the wire (the count endpoint is
company-scoped regardless). The global-broadcast SSE design is a pre-existing property, noted for a
possible future per-company-channel refactor (out of scope here).

**Protected-hook touch.** `useRealtimeEvents` gains `lead.created`/`lead.updated` in its
`genericEventTypes` array only — routed to consumers via the existing `onGenericEvent(type, data)`
callback (no new callback plumbing). Minimal additive change.

**Semantics.** Purely status-derived — no read/unread. The badge does not clear on viewing the page;
it reflects the live count of leads still in the new set. Persistent triage indicator.

---

## PRICEBOOK-001 — Price Book architecture

**Data.** `estimate_item_presets` IS the Items table (extended with `category_id`/`code`/`unit`).
`price_book_categories` (grouping only) + `price_book_groups` + M2M `price_book_group_items`
(`quantity`+`sort_order` on the link, unique `(group_id,item_id)`). Category FK `ON DELETE SET NULL`.
Migration 141; all company-scoped, soft-delete, unique active name per company.

**Layering.** `priceBookQueries` (SQL, transactional `setGroupItems` via `db.getClient()`) →
`priceBookService` (validation, membership replace, `getGroupExpansion`) → `routes/price-book.js`
(`price_book.view` reads / `price_book.manage` writes). Items CRUD delegates to the extended
`estimateItemPresetsService`. The inline picker keeps its own `/api/estimate-item-presets` route.

**Group → document.** A group is never stored on an estimate/invoice. Adding it = fetch
`GET /groups/:id/expand` (active items only, snapshot price/qty, ordered) → `POST .../items/bulk`
(one status-reset + ONE recalc + ONE `items_added` event). Group `total` is a read-time
Σ(price×qty) over active items.

**RBAC.** `price_book.view`/`.manage` in `permissionCatalog.js` (Roles editor) + `050` (new companies)
+ 141 backfill (existing). view→all doc-editing roles; manage→admin+manager.

**Frontend.** `PriceBookPage` (Settings → Price Book, tabs Items/Groups/Categories, dialog editors) +
`priceBookApi`. `ItemPresetSearchCombobox` gains an optional Groups section (`onPickGroup`) — the
Estimate/Invoice panels' `pickGroup` expands via the bulk endpoint. `DEV_PERMISSIONS` include the new
keys so the page shows in local dev.

**Edge cases.** Archived category/group/item → hidden from pickers (SET NULL / soft-delete); group
expansion skips archived items; `normalizeItems` filters non-numeric item_ids (jest-caught).

## PRICEBOOK-002 — Inline-editable Items grid

**Goal.** Replace the Items tab's row-list + slide-over editor with a spreadsheet-style
grid where all 7 item fields are edited in place and saved as one atomic batch.

### Backend
- New endpoint `PUT /api/price-book/items/bulk` — company-scoped, gated `price_book.manage`
  (mounted under the existing `authenticate, requireCompanyAccess` router; no server.js change).
- Payload: `{ creates:[{clientKey?,name,description,code,unit,default_unit_price,default_taxable,category_id}],
  updates:[{id,...same}], deletes:[id] }`.
- Response: `{ items:[<full listForManage snapshot>], summary:{created,updated,deleted},
  createdMap:[{clientKey,id}] }`.
- Logic lives in `estimateItemPresetsService.bulkSaveItems(companyId, payload, {actorId})`,
  which validates the whole batch first (name required per non-deleted row; price finite ≥0;
  category_id must belong to the company or be null; fully-empty new rows are discarded), then
  calls `estimateItemPresetsQueries.bulkSaveItems`, a single `db.getClient()` BEGIN/COMMIT/ROLLBACK
  transaction modeled on `priceBookQueries.setGroupItems`. It reuses `insertPreset` /
  `updatePresetScoped` / `archivePresetScoped` with the shared `client`.
- **All-or-nothing:** any invalid row, foreign item id, or foreign category id rejects the whole
  request (422/404 with structured `details`) before COMMIT — nothing is written. Already-archived
  deletes are idempotent no-ops.
- `listForManage` internal limit cap raised 200→1000 so the grid can load the full catalog.
  Per-row `POST/PATCH/DELETE /items/:id` are retained for back-compat (CSV import, external callers).

### Frontend
- `ItemsTab` (in `PriceBookPage.tsx`) becomes a draft grid holding `RowDraft[]` with a
  per-row status (`pristine|new|edited|deleted`) + stable local key. Loads all items once
  (`?limit=500`) and filters client-side so unsaved edits survive search.
- Per-row trash marks a server row `deleted` (undoable client-side until Save); actual soft-delete
  (`archived_at`) happens inside the bulk transaction on Save. New rows are removed locally.
- Pinned "+ add empty row"; single **Save changes** (enabled only when dirty) + **Discard**.
  Unsaved-changes guard on tab switch and page unload.
- `ItemPanel` (per-item slide-over) is **removed from the Items flow** — documented exception to
  the right-side "layer" canon: inline table edit, Blanc tokens, IBM Plex/Manrope, no decorative
  `<hr>`/separators, horizontal scroll on narrow screens. Groups/Categories keep the layer pattern.
- API client gains `bulkSaveItems` + bulk types in `priceBookApi.ts`.

### Decisions (boundary questions resolved)
- Duplicate item names allowed (spreadsheet semantics; no unique-name constraint on presets).
- Inline category creation out of scope (Categories tab owns that). `default_quantity` preserved, not
  surfaced. Last-write-wins on concurrent edits (no version column). Save errors highlight offending
  cells + toast.

### Compatibility
- `estimate_item_presets` is shared with the inline estimate/invoice picker (`searchForCompany`,
  `getGroupExpansion`), both of which filter `archived_at IS NULL`; soft-deleting here removes items
  from those paths as intended without breaking group memberships (soft-delete, not hard-delete).
- Bulk updates carry only the 7 grid fields, so `default_quantity/usage_count/last_used_at/created_by`
  are never clobbered. No schema migration required (columns exist since migration 141).

---

## ONBTEL-001: Онбординг новой компании → Marketplace «Telephony — Twilio» → фиксы изоляции Twilio

**Статус:** Architecture · **Дата:** 2026-07-02 · **Автор:** Agent 02 (Architect)
**Требования:** `Docs/requirements.md` §«Фича ONBTEL-001» (решения владельца — обязательны)
**Принцип:** три части (A/B/C) расширяют существующие подсистемы: онбординг-чеклист поверх ALB-101, marketplace-приложение по канону F016/F018/SEND-DOC-001-D, тариф поверх биллинг-модели mig 101/103/107/108/109, фиксы изоляции внутри ALB-107. `src/server.js` **не меняется вообще** (ни одного нового mount).

### 0. Результаты разведки кода (коррекции к входному аудиту)

| Утверждение аудита | Факт в коде | Следствие |
|---|---|---|
| «нет UNIQUE на `phone_number_settings.phone_number`» | UNIQUE **есть**: prod-фикстура `schema_pre_096.sql:7296` (`phone_number_settings_phone_number_key`), ensure-DDL в `phoneSettings.js:19` (`TEXT NOT NULL UNIQUE`), и `buyNumber` использует `ON CONFLICT (phone_number)` (упал бы без него) | C3 = **защитная формализация**: guarded DO-блок «если unique-индекса по колонке нет → dedup → создать»; на prod — no-op |
| «`twilio_subaccount_sid` — только non-unique index» | mig 098 создаёт колонку `TEXT UNIQUE` inline (таблица не существовала до 098 — CREATE TABLE выполнился везде); отдельный partial-index — избыточный дубль | То же: guarded-добавление, на prod — no-op |
| — | `company_telephony` строки существуют и **с `twilio_subaccount_sid = NULL`** (upsert autonomous-mode, mig 142) | derived-connected обязан проверять `sid IS NOT NULL` (уже так в `getTelephonyState`); UNIQUE должен допускать множественные NULL (Postgres-default — ок) |
| — | `phoneSettings.js` GET-sync (`:86-108`) листит **master**-аккаунт (`getTwilioClient()`) для ЛЮБОЙ компании и upsert'ит номера с `company_id` = компании запросившего | Смежный claim-лик master-номеров чужим tenant'ом; без его закрытия инвариант C2 не держится → включён как **C2b** (1 строка) |

### 1. Существующий функционал

**Расширяем (точки интеграции):**
- `backend/src/routes/onboarding.js` — mounted `app.use('/api/onboarding', authenticate, onboardingRouter)` (`src/server.js:314`); добавляем route-level-защищённый `GET /checklist` (прецедент route-level middleware — `phoneSettings.js:79`).
- `backend/src/services/billingService.js:140 subscribe(companyId, planId)` — уже: карта на файле → off-session charge + активация; нет карты → hosted checkout c `metadata.plan_id` → активация вебхуком. Расширяем веткой «цена ≤ 0» для PAYG. Вызывается из существующего `POST /api/billing/checkout` (`routes/billing.js:40`).
- Биллинг-конвейер PAYG **уже существует целиком**: usage пишется (`EVENT_TO_METRIC` sms/call_minutes → `billing_usage_records`), `computeOverage` (`included_units` 0 → всё usage платно по `metered`), `billOverage` дебетует кошелёк, `overageScheduler` (6h) прогоняет `status IN ('active','past_due')`. Ноль новых механизмов — только seed-строка плана.
- Лимит номеров **уже enforce'ится**: `telephonyTenantService.buyNumber:234-247` → `getPlanForCompany().max_phone_numbers` → 422 `NUMBER_LIMIT`.
- `backend/src/services/marketplaceService.js` — overlay-паттерн `buildGoogleEmailInstallationOverlay` (`:43`) + special-case в `listApps` (`:208`) и `isAppConnected` (`:62`) — точный прецедент для derived-state телефонии.
- `backend/src/db/marketplaceQueries.js:12 ensureMarketplaceSchema` — += новый seed 145.
- `backend/src/services/telephonyTenantService.js` — `getTelephonyState` (source of truth для connected), `connectTelephony` (идемпотентен), `searchNumbers`/`buyNumber`, `ensureSoftphoneSetup`, `getSoftphoneCreds`, `resolveCompanyByAccountSid`, `DEFAULT_COMPANY_ID` — всё reuse as-is.
- `backend/src/webhooks/twilioWebhooks.js` — `handleVoiceInbound:256-369` (C1/C4), `companyIdForNumber:9-16`.
- `backend/src/services/voiceService.js:61-77 generateTokenForCompany` (C5; единственный вызов — `routes/voice.js:129`).
- Frontend: `useAuthz().isTenantAdmin()` (`hooks/useAuthz.ts:21`), `PulsePage.tsx` (структура `.blanc-page-wrapper` → `.blanc-unified-header` + `.pulse-layout`), `IntegrationsPage.tsx` (per-app ветки кнопок `:257-299`), `TelephonyLayout.tsx` (обёртка всех `/settings/telephony/*`), канон страниц `VapiSettingsPage/StripePaymentsSettingsPage`.

**Нельзя дублировать:**
- Второй connect-флоу субаккаунта (только `POST /api/telephony/numbers/connect`).
- Второй механизм тарификации/списаний (только `billing_plans` + `computeOverage`/`billOverage`/wallet; никаких «своих» счётчиков минут).
- Второй install-lifecycle (только `/api/marketplace/*`; для telephony-twilio — вообще без install-строки, см. §3.3).
- `walletService.assertServiceActive` / `isServiceBlocked` — единственный сервис-гейт.
- Повторная реализация плитки/бейджей маркетплейса, `MarketplaceConnectDialog` (protected).

### 2. Часть A — онбординг-чеклист на `/pulse`

#### 2.1 Хранилище: `companies.settings` JSONB (mig 010) + каталог пунктов в коде — БЕЗ новой таблицы и БЕЗ новой миграции

Решение и обоснование:
- **Статус выполнения пунктов — derived, его не хранят.** Пункт телефонии = `EXISTS(SELECT 1 FROM phone_number_settings WHERE company_id = $1)` (released-номера удаляются из таблицы `releaseNumber`'ом, поэтому «≥1 активный номер» ≡ «есть строка»; у Boston Masters строки есть — сценарий A5 выполняется автоматически).
- **Единственное персистентное поле** — `companies.settings.onboarding_checklist.completed_at` (write-once): когда все пункты derived-выполнены, сервис фиксирует момент. Нужен, чтобы **добавление новых пунктов в будущем не воскресило карточку** у давно завершивших компаний и чтобы release последнего номера не вернул чеклист («после выполнения всех пунктов не показывается никогда»). Для одного timestamp'а новая таблица — оверкилл; JSONB-колонка существует с mig 010.
- **Каталог пунктов** — data-driven registry в новом `backend/src/services/onboardingChecklistService.js` (прецедент — `permissionCatalog.js`): массив `{ key, title, description, cta: {label, path}, isComplete(companyId) }`. Расширение = одна запись. «Данные, не хардкод» выполняется на границе API: фронт рендерит `items[]` из ответа, ничего не зная о составе.
- Запись `completed_at` — идемпотентный `UPDATE companies SET settings = jsonb_set(...)` с guard'ом `WHERE settings#>>'{onboarding_checklist,completed_at}' IS NULL`, компания только из `req.companyFilter.company_id`.

#### 2.2 Endpoint

`GET /api/onboarding/checklist` — **расширение существующего** `routes/onboarding.js` (mount `/api/onboarding` уже есть → `src/server.js` не трогаем). Роутер mounted `authenticate`-only (так задумано для онбординга), поэтому защита — route-level:
- `router.get('/checklist', requireCompanyAccess, <inline tenant_admin gate>, handler)`, `requireCompanyAccess` — из `backend/src/middleware/keycloakAuth.js`.
- **Gate tenant_admin — inline**: `req.authz?.membership?.role_key === 'tenant_admin'` (dev-mode `req.user._devMode` — пропуск, как всюду). ВАЖНО: `requireRole('company_admin')` НЕ годится — его legacy-mapping (`keycloakAuth.js:157`) пропускает и `manager`.
- Ответ (см. таблицу контрактов §7): `visible:false` при `completed_at` установленном ИЛИ когда все пункты выполнены (в этом же запросе `completed_at` фиксируется). Boston Masters при первом GET получает `completed_at` и навсегда `visible:false` — никакого бэкфилла не нужно.

#### 2.3 Collapse-состояние: localStorage (клиент), сервер не пишем

Ключ `albusto.onb-checklist.collapsed:<companyId>`. Обоснование: это UI-предпочтение одного устройства, не бизнес-данные; выполнение/скрытие — derived на сервере (источник правды не размывается); API остаётся GET-only (нет мутаций → нет 403/isolation-поверхности). Требование «между визитами/сессиями» localStorage покрывает. Полного dismiss нет by construction — endpoint'а нет.

#### 2.4 Frontend-размещение

- `frontend/src/components/onboarding/OnboardingChecklistCard.tsx` — карточка: заголовок + прогресс (`N of M done`) + список пунктов (иконка-статус, текст, CTA-кнопка → `navigate(item.cta.path)`), collapse в компактную строку. Дизайн: Blanc-токены, `.blanc-eyebrow`, без `<hr>`, продукт в текстах — Albusto.
- `frontend/src/hooks/useOnboardingChecklist.ts` — React Query (`enabled: authenticated && !!company && isTenantAdmin()`), `refetchOnWindowFocus` (default) закрывает возврат из визарда.
- **Вставка в `PulsePage.tsx`**: между `.blanc-unified-header` и `.pulse-layout` (строки ~210-213). Layout-совместимость проверена: `.blanc-page-wrapper:has(.pulse-layout)` — фикс-высотный flex-контейнер, `.pulse-layout` имеет `flex:1; min-height:0` → карточка с `flex-shrink:0` встаёт в поток, сдвигает layout вниз, независимый скролл колонок сохраняется (desktop и mobile). `usePulsePage.ts` **не трогаем** — чеклист живёт своим hook'ом.
- Рендер-гейт на фронте: `isTenantAdmin() && checklist?.visible` (плюс серверный 403 для не-админов).

### 3. Часть B — Marketplace-приложение «Telephony — Twilio»

#### 3.1 Seed (mig 145) — `provisioning_mode='none'`

По шаблону seed 116. Значения строки `marketplace_apps`:

| Поле | Значение | Комментарий |
|---|---|---|
| `app_key` | `telephony-twilio` | |
| `name` | `Telephony — Twilio` | |
| `provider_name` | `Albusto` | внутренняя интеграция (как google-email) |
| `category` | `telephony` | как vapi-ai |
| `app_type` | `internal` | |
| `requested_scopes` | `[]` | ключей к CRM-API не выдаём |
| `provisioning_mode` | **`none`** | connect — внутренний субаккаунт-флоу `telephonyTenantService`; `push_credentials` существует для выдачи/пуша credentials приложения через `integrationsService` — телефонии не нужен ни один `api_integrations`-ключ. Ровно паттерн vapi/stripe-payments/google-email |
| `status` | `published` | |
| `metadata` | `{"setup_path":"/settings/integrations/telephony-twilio", "derived_connection":true, "access_summary":["Buy and manage phone numbers","Route inbound calls and SMS"]}` | `derived_connection` — новый data-driven флаг, см. 3.3 |

Плюс `readMigration('145_…')` в `ensureMarketplaceSchema` (`marketplaceQueries.js`, после 132).

#### 3.2 Страница-визард

`frontend/src/pages/TelephonyTwilioSettingsPage.tsx`, роут `/settings/integrations/telephony-twilio` в `App.tsx` с `ProtectedRoute permissions={['tenant.integrations.manage']}` (канон соседних страниц, `App.tsx:129-131`). Три шага; **активный шаг derived из серверного состояния** (устойчиво к перезаходу/refresh, идемпотентно):

| Шаг | Состояние «выполнен» | Данные | Действия (все — reuse) |
|---|---|---|---|
| 1. Connect | `GET /api/telephony/numbers/status → state.connected` | — | `POST /api/telephony/numbers/connect`, затем best-effort `POST /api/telephony/numbers/softphone/setup` (ровно как `PhoneNumbersPage.connectTelephony:103-117`) |
| 2. Тариф | `GET /api/billing → subscription.plan_id !== 'trial'` | `plans[]` из того же `GET /api/billing` (payg попадёт автоматически после seed 146) | PAYG: `POST /api/billing/checkout {plan_id:'payg'}` → `{activated:true}`; Пакет: `POST /api/billing/checkout {plan_id:'starter'|'pro'|'huge', return_path:'/settings/integrations/telephony-twilio?step=3&billing=success'}` → `{url}` → redirect → возврат в визард → refetch |
| 3. Номер | у компании ≥1 номер (`GET /api/telephony/numbers`) | — | `GET /api/telephony/numbers/search?…` + `POST /api/telephony/numbers/buy` (422 `NUMBER_LIMIT` показывается как upsell-подсказка «нужно больше номеров — выберите пакетный план») |

Завершение (все 3 выполнены) → финальный экран с ссылками «Manage telephony» (`/settings/telephony`) и «Back to Integrations». Пункт чеклиста Части A выполнится сам (derived).

#### 3.3 Тарифный контракт PAYG (решения владельца — обязательные значения)

**Seed mig 146** — строка `billing_plans`:

| Поле | Значение |
|---|---|
| `id` | `payg` |
| `name` | `Pay as you go` |
| `monthly_base_usd` | `0` |
| `included_seats` / `per_seat_usd` | `3` / `0` (зеркало trial; seats кошельковым `billPlanFee` не тарифицируются — поле декоративное, не блокер) |
| `metered` | `{"sms":0.03,"call_minutes":0.04,"agent_runs":0}` |
| `included_units` | `{"sms":0,"call_minutes":0,"agent_runs":0}` |
| `max_phone_numbers` | `1` |
| `provider_price_id` | `NULL` (Stripe-checkout для payg не используется) |
| `is_active` | `true` |

`ON CONFLICT (id) DO UPDATE` (идемпотентно, как 107).

**Применение без Stripe** — расширение `billingService.subscribe(companyId, planId, { successUrl, cancelUrl }?)`:
1. Загрузить план (как сейчас). Если `Number(plan.monthly_base_usd) <= 0` → **ветка ДО `providerConfigured()`-проверки**: `UPDATE billing_subscriptions SET plan_id=$2, status='active', updated_at=now() WHERE company_id=$1`; если строки подписки нет (теоретически) — `INSERT … ON CONFLICT (company_id) DO UPDATE` тем же значением; Stripe/customer/карта НЕ требуются; ответ `{activated:true}`. `billPlanFee` вызывать не нужно (fee 0 → no-op), кошелёк не трогается (требование: активация PAYG не требует пополнения).
2. **Идемпотентность:** повторный `subscribe('payg')` — тот же UPDATE тех же значений, снова `{activated:true}`; повторный проход визарда планов не плодит (PK `company_id`).
3. Платные планы — существующая логика untouched, плюс опциональные `successUrl/cancelUrl`, приходящие из route.

**`routes/billing.js POST /checkout`** — body расширяется опциональным `return_path`; валидация: строка, начинается с `/`, не содержит `//` и `:` (path-only, анти-open-redirect); успех/отмена = `https://app.albusto.com${return_path}` (дефолты — текущие захардкоженные URL). Списания по ставкам: ничего не пишем — существующие `recordUsage` → `computeOverage` (included=0) → `billOverage` → wallet-дебет по `overageScheduler` (payg-подписка в `status='active'` → уже в выборке).

#### 3.4 Installation-state: **derived, install-строка НЕ создаётся никогда**

По прецеденту SEND-DOC-001 D.3 (google-email):
- `marketplaceService.listApps` — overlay для `app_key==='telephony-twilio'`: synthetic `installation = { id:null, status: state.connected ? 'connected' : null, installed_at: state.connected_at||null, …, external_installation_id: null }`, где `state = telephonyTenantService.getTelephonyState(companyId)` (subaccount-SID наружу не отдаём). Default-компания → `connected:true, mode:'master'` → плитка Boston Masters сразу Connected — «нулевые изменения поведения» выполняются. Компания с `company_telephony`-строкой без SID (autonomous-mode upsert) → `connected:false` (уже так в `getTelephonyState:59`).
- `isAppConnected('telephony-twilio')` — тот же special-case (симметрия с google-email; гейтов на телефонию сейчас нет, но контракт честный).
- **Ответ на «что и когда создаётся»: ничего и никогда.** Единый источник правды — `company_telephony`; и новые (через визард), и legacy-компании отображаются одинаково без ретроактивных install-строк и без двойного источника правды.
- **Fail-safe:** `installApp` в начале (рядом с `validateInstallPrerequisites`) отклоняет приложения с `metadata.derived_connection === true` → `MarketplaceServiceError('This app is configured from its setup page.', 'DERIVED_CONNECTION_APP', 409)`. Data-driven (без hardcode app_key), заодно формализует то, что для google-email было только конвенцией фронта.
- `IntegrationsPage.tsx` — ветка `app.app_key === 'telephony-twilio'` (рядом с существующими `:257-299`): `installation?.status === 'connected'` → кнопка **Manage** → `navigate('/settings/telephony')` (требование B.5); иначе **Configure** → `navigate(metadata.setup_path)`.

#### 3.5 Redirect неподключённой компании из Settings → Telephony

В `frontend/src/components/telephony/TelephonyLayout.tsx` (единая обёртка всех `/settings/telephony/*` роутов): на mount — `GET /api/telephony/numbers/status`; пока грузится — ничего не рендерить (без flash);
- `state.connected === false` и `hasPermission('tenant.integrations.manage')` → `<Navigate to="/settings/integrations/telephony-twilio" replace />`;
- `connected === false` без права integrations → компактный empty-state «Telephony is not connected yet — ask your administrator» (без мёртвого redirect-цикла в 403);
- `connected === true` (включая default-компанию — у неё state всегда connected) → рендер как сейчас, byte-identical.
Дополнительно `pages/telephony/PhoneNumbersPage.tsx`: локальная кнопка `connectTelephony` (`:288`) и сам локальный connect-обработчик заменяются на переход в визард (connect-флоу существует ровно в одном месте). Search/buy-функции страницы остаются для подключённых компаний.

### 4. Часть C — фиксы изоляции (файлы + контракты, без кода)

#### C1 — Reject неизвестного номера (`backend/src/webhooks/twilioWebhooks.js`, `handleVoiceInbound`)

- Только в inbound-ветке (`else`, после `isOutbound` — SIP-outbound не трогаем): резолв компании **один раз**: `companyId = await telephonyTenantService.resolveCompanyByAccountSid(req.body.AccountSid)` → fallback `companyIdForNumber(To)` (канон ALB-107 «AccountSid → To» сохранён; master-AccountSid всегда даёт DEFAULT → все сценарии Boston Masters byte-identical, включая номера без строки в `phone_number_settings` — как сегодня, generic voicemail).
- `companyId === null` (не master, не connected-субаккаунт, номер никому не принадлежит) → структурный лог + `200 text/xml` `<Response><Reject/></Response>` (default reason `rejected` — отличим от wallet-гейта `reason="busy"`). Generic voicemail для company-less звонка более не достижим.
- **Форма лога** (одна строка, JSON-поля): `console.warn('[<traceId>] inbound_call.rejected', { event:'inbound_call.rejected', reason:'unknown_number', call_sid, account_sid, to, from })`.
- `ingestToInbox` остаётся ДО резолва (как сейчас) — аудит-след в `webhook_inbox` сохраняем; `recordMissedInbound` для unknown НЕ вызывается (нет компании — не создаём orphan-timeline; это же причина, почему created-by-status-callback residue остаётся pre-existing поведением, не расширяем скоуп).
- Ошибка DB при резолве → `null` → Reject (fail-closed).

#### C4 — wallet-гейт до роутинга без null-обхода (тот же файл/функция)

Гейт уже стоит ДО `resolveGroupForNumber`/`callFlowRuntime`; фикс = **использовать `companyId`, резолвнутый в C1** (второй lookup `companyIdForNumber(To).catch(()=>null)` в `:336` удаляется). После C1 `companyId` в этой точке гарантированно non-null → условие `blockedCompanyId && …` больше не может «проскочить» из-за null. Поведение при блокировке — без изменений (`Reject reason="busy"` + `recordMissedInbound`). Обработка ошибок `isServiceBlocked` (`.catch(()=>false)`) сохраняется — транзиентная ошибка кошелька не должна валить легитимную маршрутизацию (требование «не изменить маршрутизацию легитимных звонков»; сам резолв компании — fail-closed через C1).

#### C2 — `phone_number_settings.company_id` NOT NULL + backfill (mig 147)

Порядок внутри миграции (идемпотентно, паттерн mig 140 с `RAISE NOTICE` числа затронутых строк на каждом шаге):
1. Посчитать и залогировать количество `company_id IS NULL`.
2. Повторить правило mig 091: backfill из `user_group_numbers → user_groups.company_id` (страховка для дрейфнувших сред).
3. **Остальные NULL → DEFAULT seed-компания `00000000-0000-0000-0000-000000000001`.** Обоснование выбора «в default», а не DELETE/park: (а) NULL-строки исторически порождались только master-account-путями — pre-091 legacy и master-sync `phoneSettings.js`; субаккаунтный `buyNumber` (098, позже 091) всегда пишет `company_id`, значит субаккаунтный номер физически не может быть NULL-orphan'ом → присвоение default'у не может отдать чужой номер Boston Masters; (б) DELETE опасен: master-номер жив на Twilio → следующий `GET /api/phone-settings` любого tenant'а re-sync'нул бы его строку уже с **чужим** `company_id` (cross-tenant claim + маршрутизация звонков чужому tenant'у); (в) поведение inbound для этих номеров не меняется (master AccountSid и так резолвится в DEFAULT после C1; wallet DEFAULT-компании не blocked: баланс 0 > floor −5).
4. `ALTER TABLE … ALTER COLUMN company_id SET NOT NULL` (guarded от повторного применения).
Rollback (`rollback_147`): `DROP NOT NULL`; данные backfill'а не откатываются (задокументировать в заголовке — data-миграция односторонняя).

#### C2b — закрыть источник новых «бесхозных»/mis-claimed строк (`backend/src/routes/phoneSettings.js`)

GET-sync (`:100-108`) всегда листит **master**-аккаунт (`getTwilioClient()`), но upsert'ит с `company_id` компании-запросчика. Контракт после фикса: sync-upsert биндит `company_id = telephonyTenantService.DEFAULT_COMPANY_ID` (номера master-аккаунта принадлежат default-компании — фактическому владельцу аккаунта). Для Boston Masters — byte-identical (их `$1` и был default); для прочих tenant'ов закрывается и лик листинга master-номеров в их настройки, и claim через `COALESCE`-ветку. Выборка `WHERE company_id=$1` и `PUT /:id … AND company_id=$4` не меняются. Без этой строки NOT NULL из C2 механически выполняется, но инвариант «номер принадлежит компании, чей (суб)аккаунт им владеет» — нет; включено в скоуп C2 осознанно (1 строка + тест).

#### C3 — UNIQUE ×2 (mig 148, защитная формализация)

- `phone_number_settings.phone_number`: DO-блок — если в `pg_constraint`/`pg_indexes` НЕТ unique по колонке → pre-dedup (оставить строку с `twilio_number_sid IS NOT NULL`, при равенстве — новейшую по `updated_at`; удалённые — `RAISE NOTICE` с количеством) → создать `uq_phone_number_settings_phone_number`. На prod (constraint `phone_number_settings_phone_number_key` существует) — no-op; смысл — выровнять дрейфнувшие среды и зафиксировать инвариант декларативно.
- `company_telephony.twilio_subaccount_sid`: аналогичный DO-блок (UNIQUE, NULL-ы допускаются — Postgres-семантика, строки autonomous-mode с NULL-SID легальны). Pre-dedup: дубль SID = кросс-tenant шаринг субаккаунта → оставить строку с ранним `connected_at`, у поздней — `twilio_subaccount_sid = NULL` + `RAISE WARNING` с обоими `company_id` (fail-closed: «осиротевшая» компания увидит `TELEPHONY_NOT_CONNECTED` до ручного разбора, а не чужие номера).
- Rollback (`rollback_148`): DROP только объектов с нашими именами `uq_…` (существующие исторические констрейнты не трогает).

#### C5 — fail-closed softphone-токен

- `backend/src/services/voiceService.js` `generateTokenForCompany`: **точное условие** — `companyId === telephonyTenantService.DEFAULT_COMPANY_ID` → env-fallback `generateToken(identity)` (как сейчас, Boston Masters untouched); иначе (включая falsy companyId) `getSoftphoneCreds(companyId)`; `null` → **throw `{ httpStatus: 409, code: 'SOFTPHONE_NOT_PROVISIONED', message: 'SoftPhone is not provisioned for this company — connect telephony and run softphone setup.' }`** (409 согласован с `TELEPHONY_NOT_CONNECTED`-конвенцией сервиса). Тихий фолбэк на master env creds для не-default компаний исчезает.
- `backend/src/routes/voice.js` `GET /token`: catch дополняется веткой `err.httpStatus` → `res.status(err.httpStatus).json({ error: err.message, code: err.code })` (сейчас всё → 500). Auto-provision в токен-роуте НЕ делаем (провижининг — явное действие connect-флоу/визарда; токен-роут дергается часто и не должен ходить в Twilio). Implementer: проверить, что frontend softphone на не-200 деградирует в «недоступен» (default-компания и корректно настроенные tenant'ы не затронуты).

### 5. План миграций (145…148; перепроверить фактический max непосредственно перед созданием — параллельные ветки)

| # | Файл | Одна забота | Rollback |
|---|---|---|---|
| 145 | `145_seed_telephony_twilio_marketplace_app.sql` | seed `marketplace_apps` (ON CONFLICT DO UPDATE) + регистрация в `ensureMarketplaceSchema` | `rollback_145…`: DELETE строки app (install-строк у приложения не бывает — FK-безопасно) |
| 146 | `146_seed_payg_billing_plan.sql` | seed `billing_plans` id='payg' | `rollback_146…`: `UPDATE … SET is_active=false` (НЕ DELETE — возможен FK из `billing_subscriptions`) |
| 147 | `147_phone_number_settings_company_not_null.sql` | backfill (091-правило → default) + NOT NULL, счётчики RAISE NOTICE | `rollback_147…`: DROP NOT NULL (backfill не откатывается — задокументировано) |
| 148 | `148_telephony_unique_guards.sql` | guarded dedup + UNIQUE ×2 | `rollback_148…`: DROP только своих `uq_…` |

Все — идемпотентные, CommonJS-бэкенд не затрагивают. Перед деплоем — прогон **реальных** запросов миграций/чеклиста в one-off контейнере против копии prod DB (урок LIST-PAGINATION-001).

### 6. Файлы

**Backend — новые:**
- `backend/src/services/onboardingChecklistService.js` — каталог пунктов + `getChecklist(companyId)` + write-once `completed_at`
- `backend/db/migrations/145…148*.sql` + 4 rollback-файла (см. §5)

**Backend — изменяемые:**
- `backend/src/routes/onboarding.js` — + `GET /checklist` (route-level `requireCompanyAccess` + inline tenant_admin)
- `backend/src/services/billingService.js` — `subscribe()`: ветка цены ≤0 (до `providerConfigured`), опциональные success/cancel URL
- `backend/src/routes/billing.js` — `POST /checkout`: опциональный `return_path` (path-only валидация)
- `backend/src/services/marketplaceService.js` — overlay `telephony-twilio` в `listApps` + special-case `isAppConnected` + reject install для `metadata.derived_connection`
- `backend/src/db/marketplaceQueries.js` — `ensureMarketplaceSchema` += 145
- `backend/src/webhooks/twilioWebhooks.js` — `handleVoiceInbound`: C1 (резолв AccountSid→To, Reject+лог) + C4 (гейт на резолвнутом companyId)
- `backend/src/services/voiceService.js` — C5 fail-closed
- `backend/src/routes/voice.js` — `/token`: маппинг `err.httpStatus` (409)
- `backend/src/routes/phoneSettings.js` — C2b: sync-upsert биндит DEFAULT_COMPANY_ID

**Frontend — новые:**
- `frontend/src/pages/TelephonyTwilioSettingsPage.tsx` — визард (канон VapiSettingsPage)
- `frontend/src/components/onboarding/OnboardingChecklistCard.tsx`
- `frontend/src/hooks/useOnboardingChecklist.ts`
- `frontend/src/services/onboardingApi.ts` — authedFetch-обёртка `GET /api/onboarding/checklist` (канон `*Api.ts`)

**Frontend — изменяемые:**
- `frontend/src/App.tsx` — роут `/settings/integrations/telephony-twilio` (`tenant.integrations.manage`)
- `frontend/src/pages/PulsePage.tsx` — вставка карточки между header и `.pulse-layout`
- `frontend/src/pages/IntegrationsPage.tsx` — ветка плитки `telephony-twilio` (Manage → `/settings/telephony`; Configure → setup_path)
- `frontend/src/components/telephony/TelephonyLayout.tsx` — redirect/empty-state для `connected:false`
- `frontend/src/pages/telephony/PhoneNumbersPage.tsx` — локальный connect → переход в визард

**НЕ трогать (защищённые):** `src/server.js` (изменений НЕТ — все mounts существуют), `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, существующие миграции ≤144, `routes/billingWebhook.js` + raw-body mount, `platformCompanyService.bootstrapCompany` (транзакция/идемпотентность), `callFlowRuntime`/`groupRouting`/autonomous-mode (fail-open чтение), `walletService.assertServiceActive` (контракт), `telephonyTenantService.connectTelephony/buyNumber/searchNumbers` (reuse без правок), `MarketplaceConnectDialog`, существующие 5 приложений и их страницы, `usePulsePage.ts`, поведение Boston Masters byte-в-byte (master AccountSid → DEFAULT в C1; env-creds в C5; C2b для default — идентичные значения).

### 7. Контракты API (новые/изменённые)

| Method/Path | Middleware (mount + route) | Request | Response 200/201 | Ошибки |
|---|---|---|---|---|
| `GET /api/onboarding/checklist` **NEW** | mount: `authenticate`; route: `requireCompanyAccess` + inline `role_key==='tenant_admin'`; company из `req.companyFilter.company_id` | — | `{ ok:true, checklist:{ visible:boolean, completed_at:string\|null, items:[{ key:'connect_telephony', title:string, description:string, done:boolean, cta:{label:string, path:'/settings/integrations/telephony-twilio'} }] } }` | 401 без токена; 403 `TENANT_CONTEXT_REQUIRED`/`PLATFORM_SCOPE_ONLY` (requireCompanyAccess) и 403 `TENANT_ADMIN_ONLY` (не-админ); 500 `INTERNAL_ERROR` |
| `POST /api/billing/checkout` **CHANGED** | существующий mount: `authenticate + requirePermission('tenant.company.manage') + requireCompanyAccess` | `{ plan_id:'payg'\|'starter'\|'pro'\|'huge', return_path?: string /^\/…/ }` | payg (или любой план ≤$0): `{ ok:true, activated:true }`; платный c картой: `{ ok:true, activated:true }`; платный без карты: `{ ok:true, url:string }` | 401/403 (mount); 404 план не найден/не активен; 422 `plan_id required`; 422 `PROVIDER_NOT_CONFIGURED` (только платные); 422 невалидный `return_path` |
| `GET /api/marketplace/apps` **CHANGED (payload)** | без изменений | — | для `telephony-twilio` поле `installation` — synthetic overlay из `company_telephony` (default-компания → connected); форма объекта прежняя | как сейчас |
| `POST /api/marketplace/apps/telephony-twilio/install` **CHANGED (поведение)** | без изменений | — | — (не используется) | **409 `DERIVED_CONNECTION_APP`** для приложений с `metadata.derived_connection` |
| `GET /api/voice/token` **CHANGED (ошибки)** | без изменений (`authenticate + requireCompanyAccess`) | — | как сейчас `{ token, identity, expiresAt, allowed:true }` | + **409 `SOFTPHONE_NOT_PROVISIONED`** (не-default компания без softphone-кредов); 401; 500 |
| `POST /webhooks/twilio/voice-inbound` **CHANGED (TwiML)** | подпись per-subaccount (без изменений) | Twilio form | unknown number/account → `200 text/xml <Response><Reject/></Response>` + структурный warn-лог `{event:'inbound_call.rejected', reason:'unknown_number', call_sid, account_sid, to, from}`; wallet-blocked → `<Reject reason="busy"/>` (как сейчас) | 403 invalid signature (как сейчас) |
| Reuse без изменений | — | `GET/POST /api/telephony/numbers/status·connect·search·buy·softphone/setup`, `GET /api/billing`, `GET /api/telephony/numbers` | | |

### 8. Безопасность (правила проекта)

- `company_id` во всех новых/изменённых обработчиках — ТОЛЬКО `req.companyFilter?.company_id` (никогда из payload); чеклист и `subscribe` не принимают company от клиента вовсе.
- Каждый SQL фильтрует по `company_id`: чеклист (`EXISTS … WHERE company_id=$1`, `UPDATE companies WHERE id=$1`), subscribe (`WHERE company_id=$1`), overlay (`getTelephonyState(companyId)`); webhook-путь — company по `AccountSid`→`To` (модель ALB-107, подпись — токеном субаккаунта, без изменений).
- Кросс-tenant: чужие сущности недостижимы by construction (нет id-параметров в новых endpoint'ах); `return_path` — path-only (анти-open-redirect); subaccount SID наружу в marketplace-overlay не отдаётся.
- Fail-closed: C1 reject при нерезолвнутой компании (включая DB-ошибку резолва), C5 — 409 вместо master-creds; fail-open сохранён только там, где защищает легитимную маршрутизацию (ошибка `isServiceBlocked`) и в autonomous-mode (protected).
- Обязательные тесты 401/403 + изоляция: `tests/onboardingChecklist.test.js` (401; 403 для manager/dispatcher/provider и platform-only; company-scope), `tests/billingPaygSubscribe.test.js` (payg без Stripe, идемпотентность, платный путь не сломан, reject абсолютных `return_path`), `tests/twilioInboundIsolation.test.js` (C1: master AccountSid НЕ reject'ится; unknown → Reject+лог; C4: гейт на резолвнутой компании), `tests/voiceTokenFailClosed.test.js` (default → env; не-default без кредов → 409; с кредами → токен), `tests/marketplaceTelephonyOverlay.test.js` (derived connected: default/subaccount/не подключена; install → 409). Jest в worktree — с `--testPathIgnorePatterns "/node_modules/"`; фронт верифицировать `npm run build` (tsc -b).

### 9. Риски / решённые вопросы (блокирующих вопросов нет)

1. **C3 фактически уже выполнен на prod** (разведка §0) — миграция 148 остаётся по требованиям как guarded-формализация; Planner не должен писать безусловный `ADD CONSTRAINT` (упадёт duplicate).
2. Решено и обосновано (переигрывается без слома архитектуры, если владелец захочет): PAYG `included_seats=3/per_seat 0` (зеркало trial; на списания не влияет); C2-orphans → DEFAULT-компания (не DELETE — анти-лик, см. C2); C2b (1 строка в `phoneSettings.js`) включён в скоуп как условие инварианта C2; collapse — localStorage.
3. PAYG-списания — **в arrears раз в период** через существующий `overageScheduler` (как у всех планов), realtime-дебета за звонок нет; защита от ухода в минус — существующий wallet-гейт (floor −$5) на inbound (C4) и исходящих. Соответствует требованию «действует существующий wallet-гейт».
4. Плитка telephony-twilio показывает Connected сразу после шага 1 (субаккаунт есть), даже без номера — это прямое следствие требования B.5 «состояние выводится из фактического подключения (`company_telephony`)»; полнота онбординга отслеживается чеклистом Части A (номер), не плиткой.
5. Residue-события status-callback'ов отклонённых unknown-звонков продолжают попадать в `webhook_inbox` (pre-existing конвейер) — осознанно вне скоупа; сам звонок отклоняется до какого-либо voicemail/routing.

---

## EMAIL-OUTBOUND-001 — outbound leg in the unified-list email CTE (architecture)

**Decision: two-leg `UNION ALL` inside `email_by_contact`, one `DISTINCT ON` on top.** The inbound
leg keeps its predicates **byte-identical** (text-match `contact_emails.email_normalized =
lower(trim(em.from_email))`, `em.direction = 'inbound'`, `em.from_email IS NOT NULL` — the mig 143
functional index and the d56db8f search fix depend on exactly this text). The new outbound leg reads
ONLY the persisted mig-129 link — `em.direction = 'outbound' AND em.contact_id IS NOT NULL AND
em.on_timeline = true` — never `to_recipients_json` (per-row JSONB expansion in the hot query is
banned). Alternatives rejected: a single persisted-link source for BOTH directions silently changes
inbound coverage (history was never back-linked; binding constraint says inbound stays as-is); an
OR-extended single leg (`text-match OR contact_id`) denies the planner both index paths. `UNION ALL`
gives each leg its own exact index. Everything OUTSIDE the CTE is untouched: join
(`eml.contact_id = tl.contact_id`), surfacing predicate (`eml.email_thread_id IS NOT NULL`), search
alias (`eml.email_subject`), `GREATEST` ordering, AR/unread tiers, orphan-shadow dedup, `total_count`.

**CTE shape (both legs `company_id = $1` on `em` AND `et` — AC-5):**
```sql
email_by_contact AS (
    SELECT DISTINCT ON (contact_id)
           contact_id, email_thread_id, email_subject,
           last_message_at, last_message_direction, unread_count
    FROM (
        SELECT ce.contact_id, et.id AS email_thread_id, et.subject AS email_subject,
               et.last_message_at, et.last_message_direction, et.unread_count
        FROM email_messages em
        JOIN contact_emails ce ON ce.email_normalized = lower(trim(em.from_email))
        JOIN email_threads et ON et.id = em.thread_id
        WHERE em.company_id = $1 AND et.company_id = $1
          AND em.direction = 'inbound' AND em.from_email IS NOT NULL
        UNION ALL
        SELECT em.contact_id, et.id, et.subject,
               et.last_message_at, et.last_message_direction, et.unread_count
        FROM email_messages em
        JOIN email_threads et ON et.id = em.thread_id
        WHERE em.company_id = $1 AND et.company_id = $1
          AND em.direction = 'outbound' AND em.contact_id IS NOT NULL
          AND em.on_timeline = true
    ) legs
    ORDER BY contact_id, last_message_at DESC NULLS LAST, email_thread_id DESC
)
```
Newest thread across both directions wins (a mixed thread emits identical tuples from both legs —
`DISTINCT ON` dedup is harmless; thread-level `last_message_at`/`last_message_direction`/`unread_count`
come from `email_threads` either way). `email_thread_id DESC` is a NEW deterministic tie-break — it
only fixes previously plan-dependent ordering of equal-timestamp threads (reviewer note, not a
semantic change). Frozen output shape: same six columns/aliases out of the CTE.

**Unread invariant (FR-3/D2) — verified, not assumed.** `email_threads.unread_count` is written only
by `upsertThread` (`backend/src/db/emailQueries.js:250`, `unread_count = EXCLUDED.unread_count`) with
a value counted from Gmail `UNREAD` labels in `backend/src/services/emailSyncService.js:131-132` —
own sent mail never carries `UNREAD`, so it grows only from inbound; outbound linking actively CLEARS
it (`backend/src/services/email/emailTimelineService.js:348-354` → `markThreadRead`,
`emailQueries.js:262-271`); Pulse mark-read clears it (`backend/src/routes/calls.js:317-321`). This
change only READS `et.unread_count` → outbound-first rows surface with `any_unread = false` by
construction; jest asserts it.

**Migration 155 — `155_backfill_outbound_email_links.sql` (FR-5 historical parity; mig 144/154
pattern: one idempotent `DO $$` block, `RAISE NOTICE` row-counts per step, rollback file).** Live
linking exists (send path + Gmail push). **[CORRECTED 2026-07-04: the poll reconciler IS scheduled —
`src/server.js` runtime shell (`runTimelineLinkPoll`, EMAIL-TIMELINE-001 TASK-ET-4, 5-min tick, ungated)
drains unlinked inbound AND outbound; the original 'never scheduled' claim was a grep-scope artifact
(backend/src only). Verified in prod logs. The backfill below remains necessary for the historical tail
the LIMIT-bounded drain never reached.]** Pre-backfill history sat unlinked (`contact_id IS NULL`).
Steps, mirroring `linkOutboundMessage` semantics exactly:
1. **Match set:** unlinked genuinely-sent outbound rows (`direction='outbound' AND contact_id IS NULL
   AND on_timeline = false AND message_id_header IS NOT NULL AND message_id_header <> ''` — the
   draft-safe discriminator canonized in `listUnlinkedOutboundForTimeline`, `emailQueries.js:525-530`);
   recipients via `jsonb_array_elements(em.to_recipients_json) WITH ORDINALITY` (one-time expansion is
   fine in a migration); contact match mirrors `findEmailContact` (`emailQueries.js:424-438`):
   company-scoped `c.company_id = em.company_id`, `lower(c.email) = addr OR ce.email_normalized = addr`,
   tie-break `c.updated_at DESC NULLS LAST, c.id ASC`; first matching recipient wins
   (`DISTINCT ON (em.id) ORDER BY em.id, ord, …`).
2. **Timeline find-or-create — full SQL mirror of `findOrCreateTimelineByContact`
   (`timelinesQueries.js:246-311`), NOT a bare INSERT:** (a) reuse the existing contact-linked
   timeline; (b) else ADOPT the newest phone-digit-matching orphan (`UPDATE timelines SET contact_id,
   phone_e164 = NULL` + re-point `calls.contact_id`) — a bare INSERT would fork the person across two
   timelines and the orphan-shadow dedup would then hide their call history (the exact
   ORPHAN-TASK-REHOME-001 bug class); (c) else `INSERT (contact_id, company_id) … ON CONFLICT
   (contact_id) WHERE contact_id IS NOT NULL DO NOTHING` (arbiter = mig 029 partial unique).
   *Why create timelines at all (vs "lazy"):* there is no lazy creation on any read path — the list
   roots on `timelines`, so link-without-timeline fails FR-5 for precisely the target case
   (Gmail-direct send to an email-only lead); only a FUTURE send would heal it.
3. **Stamp links** (`contact_id`, `timeline_id`, `on_timeline = true`) — mirror of
   `linkMessageToContact`.
4. **Re-run the mig-144 open-task re-home sweep verbatim** — step 2 can newly shadow orphans; the
   project invariant since ORPHAN-TASK-REHOME-001 is that every canonical-timeline-creating path
   sweeps (the JS helper does at `timelinesQueries.js:306-309`). Idempotent by construction.
`rollback_155…`: documented one-way (backfilled links are indistinguishable from runtime links; undo
= PITR — same posture as `rollback_144`). Re-run safety: step 1 selects `contact_id IS NULL`, so a
second apply matches nothing.

**Index decision: NO new index by default (PULSE-PERF-001: no speculative indexes).** Leg 1 keeps mig
143 (`(company_id, lower(trim(from_email)))`). Leg 2 is served by the mig 129 partial index
(`(company_id, contact_id, gmail_internal_at) WHERE contact_id IS NOT NULL`) — its partial condition
plus `company_id` prefix contain the leg's driving predicate; `direction`/`on_timeline` are residual
filters over the (small) linked set. Escape hatch ONLY if the EXPLAIN gate fails: mig 156 partial
index `ON email_messages (company_id, contact_id, thread_id) WHERE direction = 'outbound' AND
contact_id IS NOT NULL AND on_timeline = true` — predicate copied verbatim from the leg.

**EXPLAIN verification plan (AC-6 gate, blocking).** The local dev DB is NOT prod-like for email
(5 `email_messages` rows — measured); run against a fresh prod `pg_dump` restore or read-only on prod
from the app container (PULSE-PERF-001 methodology). Procedure: `EXPLAIN (ANALYZE, BUFFERS)` of the
EXACT `getUnifiedTimelinePage` SQL (real params: Boston Masters company UUID, limit 50/offset 0; once
plain, once with a search term), before AND after; acceptance = `email_by_contact` evaluated ONCE (no
per-timeline re-scan), no per-row Seq Scan over `email_messages`, latency ≈ the 0.3s baseline; plus
timing the real function via a node one-liner in the app container. Mig 155 itself is EXPLAIN-exempt
(one-time), but its per-step counts must be recorded from the prod-copy dry run.

**Files.** `backend/src/db/timelinesQueries.js` — the CTE + the function-header "Scope A/INBOUND"
comment (lines ~321-324, 349-353) now describing both legs (ONLY behavioral change point);
`backend/db/migrations/155_backfill_outbound_email_links.sql` + `rollback_155_…`;
`tests/listPaginationByContact.test.js` — extended, every existing assertion untouched (they pin the
inbound leg + aliases), new assertions for `UNION ALL`, the three outbound predicates, both legs'
`$1` scoping, and `any_unread = false` on outbound-first; real-DB scenario run vs prod copy
(outbound-only / inbound+outbound mix / two-threads-newest-wins / no-match / draft / cross-tenant)
documented in the PR — mocked jest validates SQL text only (LIST-PAGINATION-001 lesson). Optional
gated: `156_*` index. **No route/frontend changes** (`GET /api/calls/by-contact` mount + middleware
as-is; icons shipped in d455c52).

**Protected (untouched):** `emailTimelineService` (senders/linkers/DRAFT guard/`markThreadRead`),
`emailQueries`, `buildTimeline` + timeline-detail projection, `/email` workspace + push pipeline,
migrations ≤ 154, `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`, unread model.

**Risks / flags.** (1) `ingestPolledForCompany` stays unwired — after mig 155 a Gmail-push outage
would again accumulate unlinked outbound rows with nothing draining them; wiring the poller is a
small separate owner decision, out of scope here. (2) The `DISTINCT ON` tie-break addition — safe,
called out for review. (3) Backfill corner: two matched contacts sharing one orphan timeline →
deterministic one-orphan-one-contact assignment via double `DISTINCT ON` (JS resolves the same case
by iteration order today). (4) Deploy only with explicit owner consent (standing rule); re-verify
max migration number immediately before creating 155 (parallel branches).

---

## TASKS-COUNT-BADGE-001: "open tasks" counter badge in navigation

**Status:** Architecture · **Type:** feature (backend read route + frontend nav badge) · **Migrations:** none · **Realtime:** additive PII-free `task.changed` event (chosen — see below). Direct clone of LEADS-NEW-BADGE-001, applied to Tasks, but the count is **RBAC-scoped per user** (managers → all company open tasks; everyone else → own), so it needs its own count route reusing the *Tasks* visibility model, not the leads one.

**Load-bearing invariant (AC-1..AC-3):** the badge value MUST equal, for the same session, the row count of `GET /api/tasks?status=open`. This is guaranteed structurally by making the count a `COUNT(*)` over the **exact same WHERE the list builds** — never a hand-rewritten predicate. To make drift impossible we refactor the shared predicate out of `listTasks` into one builder both call.

### Shared-predicate refactor (anti-drift — the crux)

`backend/src/db/tasksQueries.js` today inlines the filter/param assembly inside `listTasks` (lines ~118-145: `conditions = ['t.company_id = $1', HAS_ENTITY_PARENT]` then pushes `scopeOwnerId`/`status`/`assignee_id`/`parent_type`/`overdue`/`due_from`/`due_to`). Extract that assembly into a private helper:

```
// builds the WHERE conditions[] + params[] shared by listTasks and
// countTasks so the two can never diverge (TASKS-COUNT-BADGE-001 invariant).
function buildTaskListFilters(companyId, filters = {}) {
    const params = [companyId];
    const conditions = ['t.company_id = $1', HAS_ENTITY_PARENT];
    // ...identical scopeOwnerId/status/assignee_id/parent_type/overdue/due_from/due_to pushes...
    return { conditions, params };
}
```

`listTasks` becomes: call `buildTaskListFilters`, then append `limit/offset` to `params`, run `SELECT_TASK … WHERE conditions.join(' AND ') … ORDER BY … LIMIT/OFFSET`. Behavior byte-identical (same conditions, same order of pushes → same `$n` numbering). New sibling:

```
async function countTasks(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const { conditions, params } = buildTaskListFilters(companyId, filters);
    const { rows } = await queryFor(client, db)(
        `SELECT COUNT(*)::int AS count FROM tasks t WHERE ${conditions.join(' AND ')}`,
        params
    );
    return rows[0]?.count || 0;
}
```

`countTasks` needs **no** `SELECT_TASK` join block — `HAS_ENTITY_PARENT` and every filter reference only `t.*` columns, so the count runs against the bare `tasks t` (all the LEFT JOINs in `SELECT_TASK` are label-hydration only and irrelevant to a `COUNT(*)`). This keeps it cheap. Export `countTasks` alongside `listTasks`. The badge calls it with `{ status: 'open', scopeOwnerId }` — the same `filters` the route already computes for the list.

### Route: `GET /api/tasks/count`

New route in `backend/src/routes/tasks.js`, gated `requirePermission('tasks.view')` (same gate as `GET /`). It mirrors the list handler's visibility branch verbatim so the two resolve identity/scoping identically:

```
// ── GET /count — open-task badge count (role-scoped, mirrors GET /) ──────────
// Mounted ABOVE PATCH/DELETE '/:id' or Express matches "count" as :id.
router.get('/count', requirePermission('tasks.view'), async (req, res) => {
    try {
        const filters = { status: 'open' };
        if (canManage(req)) {
            if (req.query.assignee_id) filters.assignee_id = req.query.assignee_id;
        } else {
            filters.scopeOwnerId = actorId(req);
        }
        const count = await tasksQueries.countTasks(companyId(req), filters);
        res.json({ ok: true, data: { count } });
    } catch (err) {
        console.error('[Tasks] GET /count failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to count tasks' } });
    }
});
```

`companyId(req)` = `req.companyFilter?.company_id`; `actorId(req)` = `req.user?.crmUser?.id` (created_by-FK-crm-user-id rule — no `sub` fallback); `canManage(req)` = `_devMode || permissions.includes('tasks.manage')`. Response envelope `{ ok, data: { count } }` matches the Tasks routes and the leads badge contract.

**Mount position — critical.** `routes/tasks.js` has NO `GET /:id`, but it DOES have `PATCH /:id` and `DELETE /:id` (lines 139, 174). A literal `GET /count` can't collide with those verbs, but to follow the `/new-count`-before-`/:uuid` discipline (leads.js:160) and stay safe against a future `GET /:id`, place `/count` in the **static-segment cluster near the top** — immediately after `GET /` and alongside `GET /assignees` / `GET /entity/...` (all before the `/:id` param routes). No `src/server.js` change: the router is already mounted `app.use('/api/tasks', authenticate, requireCompanyAccess, tasksRouter)`.

### Realtime decision — CHOSEN: (a) one additive PII-free `task.changed` event

**Recommendation: option (a), a single coarse `task.changed` event carrying only `{ company_id }`, emitted at the mutation points that change an open-visible count.** Reasoning: the badge is a live-freshness affordance; the 60s poll already satisfies the AC-4 "within 60s" floor, but option (a) buys instant update at genuinely low surface-area because the leads precedent (`emitLeadChange`) is a drop-in template and a *single* event name touches exactly two frontend lists. We deliberately mirror leads' "server scopes, client only filters by `company_id`" contract: the client receives `task.changed` and simply refetches its own properly-scoped `/api/tasks/count` (which re-applies manager-vs-owner), so the event needs **no** `owner_user_id` — a coarse company-level ping is sufficient and strictly PII-free (one UUID). Payload richer than `{ company_id }` (e.g. `owner_user_id`, `id`, `status`) would tempt client-side count math that could drift from the server predicate — the very failure mode AC-3 forbids — so we keep it coarse on purpose. Snooze/due-date-only edits do NOT emit (they don't flip `status`).

**Single helper** in `backend/src/services/tasksService.js` (create the file if absent — it does not exist today; a 15-line module), matching `emitLeadChange` shape:

```
function emitTaskChange(companyId) {
    if (!companyId) return;
    try { require('./realtimeService').broadcast('task.changed', { company_id: companyId }); }
    catch (err) { console.warn('[tasksService] task event broadcast failed:', err.message); }
}
```

Best-effort — a broadcast failure never breaks the task write (leads discipline). Add `{ key: 'task.changed', label: 'Open-task count changed', sample_fields: ['company_id'] }` to `backend/src/services/eventCatalog.js` (currently only `agent_task.succeeded/failed`).

**EXACT emission sites (only where an open-visible count can change):**

| Site | File / handler | Emit? | Why |
|---|---|---|---|
| User create | `routes/tasks.js` `POST /` (after `createTask` succeeds, before `res`) | **yes** | new open task |
| Complete / reopen | `routes/tasks.js` `PATCH /:id` | **yes, but only when `patch.status !== undefined`** | status flip changes open-count; a description/owner/due-only PATCH does not (owner reassign handled next row) |
| Owner reassign | `routes/tasks.js` `PATCH /:id` | **yes, when `owner_user_id` changed** | moves the task between owners' scoped counts (manager count unaffected, but the client refetch is cheap and correct) |
| Snooze / due-date only | `routes/tasks.js` `PATCH /:id` | **no** | does not flip status → open-count unchanged (requirement excludes it) |
| Delete | `routes/tasks.js` `DELETE /:id` | **yes** | removes an open task |
| Agent/inbound/rules timeline task | `db/timelinesQueries.js` `createTask` | **yes — ONLY when it INSERTs a NEW row with `created_by IN ('user','agent')`** | this path both INSERTs and UPSERT-updates; only a fresh insert of a *listed* provenance changes the count. `system`/`automation` provenance and the UPSERT-update branch (lines ~709-732) do NOT emit — those tasks are `HAS_ENTITY_PARENT`-excluded (Pulse-only) and updating an existing open task doesn't change the count |

Practical simplification for the PATCH row: since `emitTaskChange` is coarse and idempotent from the client's side (it just triggers a refetch), the pragmatic implementation emits once per PATCH **whenever `status` OR `owner_user_id` was in the patch** (skip pure description/due edits) — one guard, no double-emit. For `timelinesQueries.createTask`, emit only inside the final INSERT branch when `provenance IN ('user','agent')`; because that module is DB-layer, `require('../services/tasksService').emitTaskChange(companyId)` best-effort (or inline `realtimeService.broadcast`), consistent with how `emitLeadChange` lives in the service layer and is called from write paths.

**Frontend wiring for the event (additive, both lists — a name in only one is silently dead):**
- `frontend/src/hooks/useRealtimeEvents.ts` `genericEventTypes` (~line 76) — append `'task.changed'`.
- `frontend/src/hooks/sseManager.ts` `namedEvents` (~line 106) — append `'task.changed'`.
- `AppLayout.tsx` `useRealtimeEvents.onGenericEvent` (~line 131) — extend the guard: `if (type === 'task.changed' && d?.company_id === company?.id) fetchOpenTasksCount();`.

### Frontend threading (`openTasksCount`, parallel to `leadsNewCount`)

- **`frontend/src/components/layout/AppLayout.tsx`:** add `const [openTasksCount, setOpenTasksCount] = useState(0)` + `fetchOpenTasksCount` (calls `authedFetch('/api/tasks/count')`, reads `json?.data?.count ?? 0`, gated on `company`) — a verbatim clone of `fetchLeadsNewCount` (lines 109-123): fetch on mount + on `location.pathname` change (`useEffect([fetchOpenTasksCount, location.pathname])`) + 60s `setInterval` poll. Pass `openTasksCount` into both `<AppNavTabs …>` (line 156) and `<BottomNavBar …>` (line 163). Extend the existing `onGenericEvent` (do NOT add a second `useRealtimeEvents` call).
- **`frontend/src/components/layout/appLayoutNavigation.tsx`:**
  - Add `openTasksCount: number` to `AppNavProps` (line 8) and to the `BottomNavBar` prop type (line 54); thread through both destructures.
  - `AppNavTabs` (line 39-42): add `t.key === 'tasks'` to the `position: relative` set (the `style` ternary on line 39), and render, next to the existing pulse/leads badges: `{t.key === 'tasks' && openTasksCount > 0 && <span className="pulse-unread-badge" title={\`${openTasksCount} open tasks\`}>{openTasksCount > 9 ? '9+' : openTasksCount}</span>}`.
  - `BottomNavBar` (lines 69-84): add the matching `t.key === 'tasks'` branch using the same absolute-position `pulse-unread-badge` span the pulse/leads mobile badges use.
- **No CSS change** — reuses the existing `pulse-unread-badge` class (AppLayout.css); the `9+` cap and zero-hides-badge rules come free from the render guard, matching Pulse/Leads exactly.

### Files to change

| File | Change |
|---|---|
| `backend/src/db/tasksQueries.js` | Extract `buildTaskListFilters` from `listTasks`; add `countTasks`; export it. `listTasks` behavior unchanged. |
| `backend/src/routes/tasks.js` | Add `GET /count` (gated `tasks.view`) in the static-segment cluster, above `/:id` param routes; mirror the `GET /` manager-vs-owner branch. Add `emitTaskChange` calls in `POST /`, `PATCH /:id` (status-or-owner guard), `DELETE /:id`. |
| `backend/src/services/tasksService.js` | **New** (~15 lines): `emitTaskChange(companyId)` → PII-free `task.changed` broadcast, best-effort. |
| `backend/src/db/timelinesQueries.js` | In `createTask`, emit `task.changed` only on the NEW-INSERT branch when `provenance IN ('user','agent')` (not the UPSERT-update branch, not `system`/`automation`). |
| `backend/src/services/eventCatalog.js` | Add `task.changed` catalog entry. |
| `frontend/src/components/layout/AppLayout.tsx` | `openTasksCount` state + `fetchOpenTasksCount` + mount/route/60s poll; pass to `AppNavTabs` + `BottomNavBar`; extend `onGenericEvent` for `task.changed`. |
| `frontend/src/components/layout/appLayoutNavigation.tsx` | `openTasksCount` prop on `AppNavProps` + `BottomNavBar`; render the `tasks` badge (desktop + mobile) with the `pulse-unread-badge` span. |
| `frontend/src/hooks/useRealtimeEvents.ts` | Append `'task.changed'` to `genericEventTypes` (additive only). |
| `frontend/src/hooks/sseManager.ts` | Append `'task.changed'` to `namedEvents`. |

### Middleware / scoping / protected

- **Middleware chain:** unchanged — `GET /api/tasks/count` inherits `app.use('/api/tasks', authenticate, requireCompanyAccess, tasksRouter)` + its own `requirePermission('tasks.view')`. No `server.js` edit.
- **`company_id` source:** `req.companyFilter?.company_id` everywhere; `countTasks`'s SQL is `WHERE t.company_id = $1 AND …` (tenancy AC-6 — same guarantee the list enforces).
- **Cheapness:** `COUNT(*) FROM tasks t WHERE company_id, HAS_ENTITY_PARENT, status='open' [, owner_user_id]` is served by the existing `company_id`/`status`/`owner_user_id` access on `tasks`; no per-row scan, no new index, no migration.
- **Protected (untouched):** `GET /api/tasks` list behavior + visibility model (the count *reuses* the extracted builder, doesn't alter list output), `HAS_ENTITY_PARENT` definition, AR-TASK-UNIFY-001 timeline coupling, `tasks.view`/`tasks.manage` gates, LEADS-NEW-BADGE-001 wiring (`leadsNewCount`/`/new-count`/its SSE types) added *alongside*, `useRealtimeEvents.ts`/`sseManager.ts` touched additively only, `pulse-unread-badge` markup shared not modified. Deploy to prod only with explicit owner consent (standing rule).

## CONTACT-EMAIL-MERGE-001: adding an email to a contact merges that address's correspondence (email analogue of the phone-merge)

**Status:** Architecture · **Date:** 2026-07-04 · **Owner:** Contacts / Pulse / Email
The email counterpart of the shipped phone-merge (`timelineMergeService.mergeOrphanTimelines`, fired async from `PATCH /api/contacts/:id`). Adds a multi-email list to the contact editor, persists it to `contact_emails` (closing a real gap — `PATCH` today writes only the `contacts.email` scalar and never `contact_emails`), and — for each newly-added address — merges that address's existing correspondence onto the contact's timeline. Requirements D1–D3 binding.

### Duplication check (result)
Not a duplicate. Reuses every existing primitive; adds one new merge service (the email analogue of `timelineMergeService`) and extends the `PATCH` route + editor. **No general contact-merge service exists** (owner's prior dedup was ad-hoc SQL) — this codifies the recipe. `email_by_contact` CTE, `getUnifiedTimelinePage`, `findEmailContact`, `linkMessageToContact`, `findOrCreateTimelineByContact` are reused unchanged.

### Decision A — Sync (in-request), NOT async
The phone-merge is fire-and-forget async because it only *re-points* (no deletes). The email full-merge **DELETES a contact**, so it needs stronger consistency and a predictable post-save state (the editor reloads and must show the merged result — AC-1/AC-2). **Chosen: run the merge synchronously inside the `PATCH` handler, before the `res.json(...)`, wrapped in a single DB transaction together with the `contact_emails` writes** (contact update + emails upsert + per-address resolution atomic). Rationale: (1) the merge set is tiny (the addresses just typed, not a history scan), so Save latency stays low; (2) a reload immediately reflects link/merge (no "just-added email whose merge hasn't run" window); (3) atomicity guarantees a failure never leaves `contact_emails` written but the merge half-done, or a contact deleted with children orphaned. The existing async legs (leads cascade, Zenbooker push) stay async and outside the tx (unchanged). This diverges from the phone-merge deliberately and is documented as such; the phone path is untouched.

### Decision B — Reusable contact-merge service: `backend/src/services/contactEmailMergeService.js` (NEW)
Email analogue of `timelineMergeService.js`. All functions accept an optional `client` (the PATCH tx) and fall back to the pool, and are strictly `company_id`-scoped and idempotent.

- **`resolveAddedEmail(targetContactId, emailNormalized, companyId, client)`** — the per-address entry point the route calls for each newly-added address. Resolves who currently owns `emailNormalized` within `companyId` via a `findEmailContact`-style lookup (`contacts.email OR contact_emails.email_normalized`), then dispatches:
  - **Inbox-only (no owning contact):** `linkInboxMessages(...)` — resolve the target's timeline via `timelinesQueries.findOrCreateTimelineByContact(target, companyId, client)` (which already adopts orphans + re-homes shadow-orphan open tasks), then for every `email_messages` row whose `lower(trim(from_email)) = emailNormalized AND company_id = $` (mig-143 functional index serves this — no new index) call `emailQueries.linkMessageToContact(providerMessageId, companyId, { contact_id: target, timeline_id, on_timeline: true })`. Idempotent re-link. [D3]
  - **Owner is a SEPARATE contact + passes the emptiness test (D2a):** `mergeContacts(survivorId=target, dupId=owner, companyId, client)` — FULL MERGE + delete (see Decision B2).
  - **Owner is a SEPARATE contact + FAILS the emptiness test (D2b):** re-point ONLY that address's `email_messages` (+ their thread linkage via `linkMessageToContact`) onto the target's timeline; the other contact and all its non-email data stay intact (no delete). Same message loop as inbox-only, but sourced from the owner's messages for that address.
  - **Owner IS the target (address already on this contact):** no-op (idempotent re-save).
- **`mergeContacts(survivorId, dupId, companyId, client)`** — reusable full-merge, the codified dedup recipe. Re-points every `contact_id` child from `dupId`→`survivorId`, adopts/merges the timeline, then deletes `dupId`. **FK order is load-bearing** (Decision B3). Built generic (not email-specific) so a future manual-merge action can reuse it, but for v1 it is only reachable through `resolveAddedEmail`'s D2a branch.

### Decision B2 — Emptiness test (the D2a↔D2b gate): `isContactEmailOnly(contactId, companyId, client)`
A contact is deletable only if it is **nothing but email**. The predicate enumerates **every** table with a `contact_id` FK to `contacts(id)` (audited from migrations) so "identity/data" is never under-counted and a real contact is never destroyed. Returns `true` only when the contact has **no** `phone_e164` AND **no** `secondary_phone` AND **zero** referencing rows in ALL of:

| Table (FK on-delete) | mig | Counts as identity because |
|---|---|---|
| `jobs` (SET NULL) | 031 | a booked job |
| `leads` (SET NULL) | 023 | a lead |
| `estimates` (SET NULL) | 053 | a quote |
| `invoices` (SET NULL) | 057 | a bill |
| `payment_transactions` (SET NULL) | 064 | money |
| `stripe_payment_sessions` (SET NULL) | 114 | a payment session |
| `portal_access_tokens` (CASCADE) | 066 | customer-portal identity |
| `portal_sessions` (CASCADE) | 067 | portal identity |
| `portal_events` (SET NULL) | 068 | portal activity |
| `crm_account_contacts` (CASCADE) | 088 | linked to a CRM account |
| `crm_deal_contacts` (CASCADE) | 088 | on a CRM deal |
| `crm_activities` (SET NULL) | 088 | logged CRM activity |
| `tasks` (contact_id SET NULL; thread_id CASCADE) | 038/089 | an independent task NOT co-located on the email timeline being merged |
| `contact_addresses` (CASCADE) | 026 | a saved address = real identity |

Excluded from the test (they ARE the email footprint being moved, so their presence must NOT block deletion): the dup's own `contact_emails` rows and its `email_messages` / its email timeline. `timelines` (SET NULL, mig 028) is likewise not a blocker — it is adopted/merged, not counted. The test is a single `SELECT EXISTS(...) OR EXISTS(...) …` over the above (each company-scoped where the table carries `company_id`), evaluated inside the tx. Erring toward "not empty" is safe: it degrades D2a→D2b (re-point only, keep the contact) — never a wrong delete.

### Decision B3 — FK-order merge recipe (in `mergeContacts`, inside the tx)
CASCADE traps mirror ORPHAN-TASK-REHOME-001. Order:
1. **Adopt/merge the timeline FIRST** (resolve `survivorTl = findOrCreateTimelineByContact(survivor)`; find the dup's timeline `dupTl`).
2. **Re-point OPEN tasks off `dupTl` BEFORE any timeline delete** — `UPDATE tasks SET thread_id = survivorTl WHERE thread_id = dupTl AND status='open'` (tasks.thread_id is `ON DELETE CASCADE`; skipping this silently destroys an open Action-Required task). Also `UPDATE tasks SET contact_id = survivor WHERE contact_id = dup` (contact_id is SET NULL — re-point so history follows).
3. **Re-point `email_messages`** — `UPDATE email_messages SET contact_id=survivor, timeline_id=survivorTl, on_timeline=true WHERE contact_id=dup AND company_id=$` (email_threads has NO contact_id — threads need no re-point; linkage lives on messages).
4. **Re-point the remaining SET-NULL children** that constitute movable history — `jobs`, `leads`, `estimates`, `invoices`, `payment_transactions`, `stripe_payment_sessions`, `portal_events`, `crm_activities` → set `contact_id=survivor` (company-scoped). (In the D2a path these are all empty by the emptiness test, so these updates move 0 rows — but `mergeContacts` is generic and does them unconditionally for reuse-safety.)
5. **Move M2M / CASCADE children with NOT-EXISTS guards** to dodge unique collisions: `contact_emails` (`UNIQUE(contact_id, email_normalized)`), `contact_addresses`, `crm_account_contacts` (`UNIQUE(company_id, account_id, contact_id)`), `crm_deal_contacts`, `portal_access_tokens`, `portal_sessions` — `UPDATE … SET contact_id=survivor WHERE contact_id=dup AND NOT EXISTS (SELECT 1 … WHERE contact_id=survivor AND <unique-cols match>)`; rows that would collide are left on the dup and die with the CASCADE delete (they are dup-of-survivor by definition).
6. **Delete the now-emptied dup timeline(s)**, then **DELETE the dup contact LAST** (after all children re-pointed) — its residual CASCADE children (already-moved-or-duplicate) drop cleanly. `findEmailContact(address)` afterwards returns the survivor (AC-2).

### Decision C — `contact_emails` write path & PATCH email-array contract
**Chosen shape: an `emails[]` array on the existing `PATCH /api/contacts/:id` body** (not a separate `/:id/emails` sub-resource) — one atomic Save, one tx, mirrors how `secondary_phone` rides the same PATCH.
- Request: `emails?: Array<{ email: string; is_primary?: boolean }>` (optional; when omitted, behavior is unchanged — backward compatible). Exactly one `is_primary:true` is enforced server-side (first primary wins; if none flagged, the first entry is primary).
- Add `'emails'` handling to `PATCH` **outside** the scalar `allowedFields` loop (it is an array, not a column). After the `contacts` row UPDATE, inside the same tx:
  1. Normalize each: `email_normalized = lower(trim(email))`; drop blanks/invalid.
  2. **Upsert** each via `contactDedupeService.enrichEmail`-semantics (`INSERT … ON CONFLICT (contact_id, email_normalized) DO NOTHING`); keep the scalar `contacts.email` in sync with the primary (existing consumers read it).
  3. **FR-8 non-destructive removal (default):** rows dropped from the list have their `contact_emails` row deleted, but already-linked `email_messages` history stays on the timeline (no reverse-merge). This is the safe default; a destructive un-merge is out of scope.
  4. For each address that is **newly added** in this PATCH (not previously in `contact_emails`), call `contactEmailMergeService.resolveAddedEmail(id, emailNormalized, companyId, client)`.
- **Reuse, don't hand-roll:** `enrichEmail` and `getAdditionalEmails` in `contactDedupeService.js` are **defined but NOT currently exported** (module.exports lists only `resolveContact`/`searchCandidates`/normalizers/`createNewContactPublic`) — add both to the exports so the route/merge service can call them. `enrichEmail` already handles the "no primary → set primary + insert" vs "additional" split and `ON CONFLICT DO NOTHING`.
- **GET surfaces the list:** `contactsService.getById` returns `c.*` only (scalar email). Extend the contact detail response with an `emails` array (reuse `getContactEmails(contactId, primaryEmail)` at contactsService.js:195, already returns primary-first de-duped `string[]`, or a richer `{email,is_primary}[]`) so the editor can render/populate the multi-email list. `getUnifiedTimelinePage`'s `email_by_contact` CTE already resolves via `contact_emails.email_normalized` → **no list-query change** (FR-7).

### Decision D — Migration: NONE required
mig 025 (`contact_emails` + its `UNIQUE(contact_id, email_normalized)`, `ON DELETE CASCADE`, `idx_contact_emails_normalized`), mig 079/129 (`email_messages.contact_id/timeline_id/on_timeline`), and **mig 143** (`idx_email_messages_from_normalized ON email_messages(company_id, (lower(trim(from_email))))`) already cover every lookup — including the inbox-only re-point's "messages by normalized `from_email` within a company", which mig 143 serves exactly. No new index (PULSE-PERF-001: no speculative indexes). No historical backfill needed (mig 154 already backfilled `contact_emails` from `contacts.email`; this feature merges on the add action going forward). **Next free migration number is 156** if one ever becomes necessary (re-verify max immediately before creating — parallel branches).

### Idempotency, company scoping, verification
- **Idempotent** end-to-end: `linkMessageToContact` is a no-op re-link; `enrichEmail`/`contact_emails` upsert `ON CONFLICT DO NOTHING`; a full-merge whose dup is already gone resolves to the survivor and no-ops; re-saving the same email set moves nothing.
- **Company-scoped on every leg** — resolution, message re-point, thread linkage, contact delete all filtered by the editing contact's `company_id` (`req.companyFilter?.company_id`). No cross-tenant read/move/delete (LIST-PAGINATION-001 SMS-leak / ZB-ISO-001 precedents).
- **Verify (LIST-PAGINATION-001 lesson):** jest mocks are insufficient — run the REAL merge against a **prod-sized DB copy** for all branches (inbox-only link, empty-auto-contact full merge + delete, has-identity re-point, no-correspondence record, multi-email, cross-tenant isolation) and `EXPLAIN` the inbox-only `from_email` lookup to confirm the mig-143 index is used. Document in the PR.

### Middleware / scoping / protected
- **Middleware chain unchanged:** `PATCH /api/contacts/:id` keeps `requirePermission('contacts.edit')` under `app.use('/api/contacts', authenticate, requireCompanyAccess, contactsRouter)`. No new route, no `server.js` edit.
- **`company_id` source:** `req.companyFilter?.company_id`, threaded into every merge-service call and SQL leg.
- **Protected (untouched):** the phone-merge (`mergeOrphanTimelines` + its async trigger + ORPHAN-TASK-REHOME-001 task re-home) — the email path is added ALONGSIDE, phone path byte-for-byte intact; `email_by_contact` CTE / `getUnifiedTimelinePage` (EMAIL-OUTBOUND-001, LIST-PAGINATION-001) shape/semantics; `linkMessageToContact` idempotent-relink + EMAIL-UNREAD-001 unread semantics; `findEmailContact` resolution; `contact_emails` invariants (mig 025); the leads-cascade + async ZB contact sync in `PATCH` (stay firing, outside the tx). Deploy to prod only with explicit owner consent (standing rule).

### Files to change
| File | Change |
|---|---|
| `backend/src/services/contactEmailMergeService.js` | **NEW.** `resolveAddedEmail`, `mergeContacts`, `isContactEmailOnly`, `linkInboxMessages` — email analogue of `timelineMergeService.js`. Sync, tx-aware (`client` param), company-scoped, idempotent. |
| `backend/src/routes/contacts.js` | `PATCH /:id`: accept `emails[]` (outside the scalar loop); wrap contact-update + emails-upsert + per-address `resolveAddedEmail` in ONE tx BEFORE `res.json`; keep scalar `contacts.email` synced to primary; FR-8 non-destructive removal. Leads-cascade + ZB push stay async/unchanged. |
| `backend/src/services/contactDedupeService.js` | Add `enrichEmail` and `getAdditionalEmails` to `module.exports` (currently defined-but-unexported) so route/merge reuse them. Logic unchanged. |
| `backend/src/services/contactsService.js` | Extend contact detail (`getContactById`/`getById` consumer) to return an `emails` array (reuse `getContactEmails`) so the editor can load the list. |
| `backend/src/db/emailQueries.js` | Add a company-scoped helper `listMessageIdsForAddress(emailNormalized, companyId, client)` (messages by `lower(trim(from_email))`, served by mig-143 index) used by the inbox-only / D2b re-point loops. `findEmailContact` / `linkMessageToContact` reused unchanged. |
| `backend/src/db/timelinesQueries.js` | Reused: `findOrCreateTimelineByContact` (accepts the tx `client`) + `reassignShadowOrphanOpenTasks`. No shape change. |
| `frontend/src/components/contacts/EditContactDialog.tsx` | Replace the single email `FloatingField` with a multi-email list (primary + add/remove additional, one primary, basic email validation) mirroring the secondary-phone control; submit `emails[]` in the PATCH payload. |
| `frontend/src/services/contactsApi.ts` | Extend `updateContact` fields type with `emails?: { email: string; is_primary?: boolean }[]`; surface `emails` on the contact detail type for load. |
| `backend/tests/` (jest) | New tests for `contactEmailMergeService` (all D1–D3 branches, idempotency, tenancy, FK/task-safety) + PATCH email-array persistence; plus documented real-DB-copy verification. |

## EMAIL-LEAD-ORIGIN-001: email-only Pulse timelines are first-class — show the contact card and let a lead be born from an email (phone optional)

**Status:** Architecture · **Date:** 2026-07-04 · **Owner:** Pulse / Leads / Contacts / Email
Makes an existing-but-invisible state usable. The Pulse detail card is phone-gated (`PulsePage.tsx:361` requires `p.phone`, which is `''` for an email-only timeline), leads are phone-born (the wizard hard-requires `phone`; `POST /api/leads` requires `Phone ≥ 5` chars), and there is no lead-by-`contact_id` lookup — so an email-only contact shows no card, can't birth a lead, and can't tell whether a lead already exists. Two parts: **PART A** ungates the card + hardens the phoneless panel; **PART B** lets a lead be created from an email with phone OPTIONAL, gated by a new by-`contact_id` lookup that prevents duplicates. **Purely additive: every phone path stays byte-for-byte.**

### Duplication check (result)
Not a duplicate — reuses every existing primitive; adds one lookup (route+service+hook), relaxes one validation rule, and makes the wizard phone-optional. **`contactDedupeService.resolveContact` already resolves phoneless input** (Step 3 email-match, Step 4 name-only→ambiguous, and `createNewContact` already writes `phone_e164` NULL via `toE164(null)===null`) — so **no new resolve branch and no parallel dedup path**. `leadsService.createLead` already guards `if (columns.phone)` before normalizing, so a phoneless insert omits the column (NULL). `FIELD_MAP` already maps `contact_id`. `LeadDetailPanel` / `LeadInfoSections` are already phoneless-safe (`{phone && …}` at `LeadInfoSections.tsx:85` gates the whole `tel:`/ClickToCall/OpenTimeline row). Schema is ready: `leads.phone` NULLABLE (mig 004), `leads.email` VARCHAR(200), `leads.contact_id` + `idx_leads_contact_id` (mig 023).

### Decision A — FR-B4 (sidebar lead-signal by contact_id): DEFER for v1 (do NOT touch `getUnifiedTimelinePage`)
**Chosen: do not add a contact_id-based lead signal to the hot list query.** Rationale: (1) `getUnifiedTimelinePage` (`timelinesQueries.js:381`) has **no unconditional "has_open_lead" sidebar signal** — the only `leads` references (lines 397/400) live inside the **search-filter** branch and match `regexp_replace(l.phone,…)` digits against `co.phone_e164`/`tl.phone_e164` digits; an email-origin lead (phone NULL) can't match that join and doesn't need to. (2) The conversation **already surfaces** as an email thread via the `email_by_contact` CTE (lines 419/538, resolves by `contact_emails.email_normalized`) — the same seam EMAIL-TIMELINE-001 / LIST-PAGINATION-001 ship. (3) The email-origin lead also lists on the **Leads page** (phone-independent) and on the **contact** (via `leads.contact_id`), and the card itself resolves it via the new by-contact lookup (Decision B). So there is no concrete gap. Touching this query would incur PULSE-PERF-001 risk (index-expression = exact-predicate discipline) for zero user-visible benefit. **What the user does/doesn't see with the defer:** the email-only conversation still appears in the Pulse sidebar (as its email thread) and, when opened, shows LeadDetailPanel once a lead exists; it does **not** gain a separate lead-styled sidebar accent/badge keyed off the lead (phone-origin leads get that only through the phone-digit search-match path today, which is unchanged). This is acceptable and consistent with the requirement's own FR-B4 guidance. If ever pursued later, it is index-only per PULSE-PERF-001.

### Decision B — Lead-by-contact_id lookup (route + service + hook), mirroring `getLeadByPhone`'s open-lead semantics
The card must know whether a phoneless contact already has an open lead → duplicate-prevention. Add a lookup that answers the **same "is there an OPEN actionable lead?"** question the phone lookups answer, keyed on `contact_id`.
- **`leadsService.getLeadByContact(contactId, companyId)`** (NEW) — byte-for-byte the shape of `getLeadByPhone` (`leadsService.js:1104`) with the join replaced: `WHERE l.contact_id = $1 AND l.status NOT IN ('Lost','Converted') [AND l.company_id = $2]`, same `lead_team_assignments` `team` aggregation, `ORDER BY l.id DESC LIMIT 1`, same **"contact already has a job → return null"** post-filter (`SELECT 1 FROM jobs WHERE contact_id=$1 LIMIT 1`), returns `rowToLead(row)` or `null`. Company-scoped (predicate on the already-scoped lead row; the job-check inherits scoping from that row, exactly as `getLeadByPhone` does today). Reuses `idx_leads_contact_id` (mig 023) — **no seq-scan, no new index**. Add to `module.exports`.
- **`GET /api/leads/by-contact/:contactId`** (NEW, in `leads.js`, placed with the other static-segment `by-*` routes **above** `/:uuid`) — `requirePermission('leads.view','pulse.view')` (identical gate to `by-phone`); validate `contactId` is a positive int (else 400 `INVALID_ID`); `const lead = await leadsService.getLeadByContact(Number(contactId), req.companyFilter?.company_id); res.json(successResponse({ lead }, reqId))`. Inherits `authenticate` + `requireCompanyAccess` from the `server.js:160` mount — **no `server.js` edit**.
- **`leadsApi.getLeadByContact(contactId)`** (NEW, `leadsApi.ts`) → `GET /by-contact/:id`, returns `LeadDetailResponse` (same envelope as `getLeadByPhone`).
- **`useLeadByContact(contactId)`** (NEW hook, alongside `useLeadByPhone.ts`) — verbatim shape of `useLeadByPhone`: `queryKey: ['lead-by-contact', contactId]`, `enabled: !!contactId`, `staleTime: 60_000`, `retry: false`, returns `{ lead, isLoading }`.
- **`usePulsePage` wiring:** call `useLeadByContact(contact?.id)` **alongside** `useLeadByPhone(phone || undefined)`. The card's lead is `leadOverride || fetchedLeadByPhone || fetchedLeadByContact`; `leadLoading` becomes `phoneLoading || contactLoading` **only when a phone-less lookup is actually in flight** (`enabled` gates each — a phone timeline never fires the contact query and vice-versa is fine since both are cheap and idempotent). The existing `contactDetail` effect and `setLeadOverride(null)` reset key off `phone` today; extend the reset key to also react to `contact?.id` so switching timelines clears the override. **Phone path unchanged** — when `phone` is present, `useLeadByPhone` still drives (its result wins if both resolve, which for a normal phone contact is the same lead).

### Decision C — `POST /api/leads`: relax phone-mandatory to phone-OR-email-OR-contact_id; resolve reuses `resolveContact` unchanged
- **Validation (`leads.js:202`):** replace `if (!body.Phone || body.Phone.length < 5) errors.push('Phone is required (min 5 chars)')` with:
  `const hasPhone = body.Phone && String(body.Phone).length >= 5; const hasEmail = !!(body.Email && String(body.Email).trim()); const hasContact = !!body.selected_contact_id; if (!hasPhone && !hasEmail && !hasContact) errors.push('Phone, Email, or a selected contact is required');` — `FirstName`/`LastName` rules unchanged. (AC-3: email+name+`selected_contact_id`, no phone → success; none of the three → still 400.)
- **Resolve branch — NO new path.** The four existing branches already cover phoneless:
  - **`selected_contact_id` + `attach` (or default)** — `body.contact_id = selectedContactId` directly; no `resolveContact` call, no phone touched. Works phoneless as-is.
  - **`selected_contact_id` + `update_contact`** — the `phone_e164 = toE164(body.Phone) || body.Phone` write must **skip when phone is absent** (don't null-out an existing phone): guard that one `updates.push` with `if (body.Phone) { … }` (the email/company/secondary writes already guard on `!== undefined`). Additive, phone-origin unchanged.
  - **default / `only_lead`** — call `resolveContact({ first_name, last_name, phone: body.Phone, email: body.Email }, companyId)` **as today**; with `phone` absent it flows to Step 3 (email match/create) or Step 4 (name-only→ambiguous→409, correct behavior). `createNewContact` writes `phone_e164` NULL for a blank phone (already true). **No signature change to `resolveContact`.**
- The stored lead: `createLead` sees no `Phone` → `columns.phone` unset → NULL; `Email`→`email`, `contact_id`→`contact_id`. **The async contact→lead cascade, ZB sync, push, address sync, and `contact_resolution` echo all keep firing unchanged.**

### Decision D — `CreateLeadJobWizard` phone-optional + email/contactId origin; the with-JOB leg stays phone-required (ZB constraint)
- **Props:** `phone?: string` (optional); add `contactId?: number`, `email?: string` (origin prefill). Existing phone invocation (`PulsePage.tsx:395` passes `phone={p.phone}`) keeps working.
- **Phone field:** stays a normal editable field, initialized `formatUSPhone(phone || '')` (blank when email-origin) — the dispatcher **may** type one but isn't required to. Prefill `email` from the `email` prop.
- **Lead payload (`handleCreate`):** send `Phone` **only when non-blank** (`...(toE164(phoneNumber) ? { Phone: toE164(phoneNumber) } : {})`); always send `Email` when present; pass `selected_contact_id: contactId` + `contact_update_mode: 'attach'` when `contactId` is provided so the lead links to the timeline's contact (no dedup, no fabricated phone). `invalidateQueries` also for `['lead-by-contact', contactId]`.
- **The wizard header phone-row (`tel:`/`ClickToCallButton`/`OpenTimelineButton` at lines 220-225):** render **only when `phone`** is present (the buttons already self-hide via `if(!phone) return null`, but the `<span>{formatPhone(phone)}</span>` + `<Phone>` icon must be gated so the row isn't an empty stub). Email-origin → no phone row.
- **ZB / with-JOB constraint (stated explicitly):** ZB job creation **requires a phone** (customer payload) — so an **email-origin lead is LEAD-ONLY, not job-creating**. The `zbJobPayload.customer` already conditionally spreads phone (`...(phoneNumber && { phone: toE164(phoneNumber) })`), but the **`convertLead` customer** at line 170 hardcodes `phone: toE164(phoneNumber)` (→ `null` when blank) — make it conditional too (`...(phoneNumber && { phone: toE164(phoneNumber) })`). When phone is blank the wizard should **offer only "Create Lead" (no "Create Lead & Job")** — the with-job button/leg is hidden/disabled until a phone is entered. Existing phone-carrying ZB creates unchanged.

### Decision E — PART A: the ungate condition + `PulseContactPanel` null-guards
- **Gate (`PulsePage.tsx:361`)** — replace `!isAnonTimeline && (p.contactId || p.timelineId) && p.phone` with **identity-based**:
  `!isAnonTimeline && (p.contactId || p.timelineId) && (p.phone || p.contact?.id)`
  For an email-only timeline `p.contact?.id` is populated (pulse.js:71-77 loads the company-scoped contact whenever `timeline.contact_id` is set), so the same tri-state resolves: LeadDetailPanel (lead via by-phone **or** by-contact) → PulseContactPanel (contact, no lead) → CreateLeadJobWizard (no contact-lead). **Anon stays excluded** (`!isAnonTimeline` untouched). The wizard branch passes `contactId={p.contact?.id}` + `email` for the email-origin mode.
- **`PulseContactPanel` primary-phone row (lines 117-122)** — wrap in `{contact.phone_e164 && ( … )}` exactly as the secondary-phone row (line 123) is already guarded, so `tel:${contact.phone_e164}` (→ `tel:null`) / `ClickToCallButton` / `OpenTimelineButton` never render with an empty phone. Email row + `mailto:` + inline add-email stay. (`LeadDetailPanel`/`LeadInfoSections` need **no change** — already `{phone && …}`-guarded.)
- **SMS composer (`PulsePage.tsx:415`)** — the `{p.phone && !isAnonTimeline && (<SmsForm … />)}` guard **already** hides the composer when there's no phone; keep as-is (email sending stays available through the composer's email target when a phone exists; a phoneless contact simply has no SMS leg — email is reachable via the panel's `mailto:` and, when the timeline has an email thread, the composer appears only if a phone target exists — acceptable for v1 per Out-of-scope). No new SMS code.

### Decision F — Migration: NONE
`leads.phone` NULLABLE (mig 004), `leads.email` (mig 004), `leads.contact_id` + `idx_leads_contact_id` (mig 023) already cover storage **and** the by-contact lookup's index. `getLeadByContact` filters on the indexed `contact_id` — no seq-scan (re-verify with `EXPLAIN` on the prod copy per verify plan). **Max migration = 155; no new file.** (`idx_leads_phone` — mig 004 — and the phone paths are untouched.)

### Company scoping & protected
- **Every new leg company-scoped** via `req.companyFilter?.company_id`: `getLeadByContact`'s lead predicate; the relaxed POST resolve (companyId already threaded to `resolveContact`/`createLead`). No cross-tenant read/attach/create (ONBOARD-FIX-001 / ZB-ISO-001).
- **Protected (untouched):** `getUnifiedTimelinePage` / `email_by_contact` CTE (Decision A defers FR-B4); the phone lead path (`useLeadByPhone`/`useLeadsByPhones`, `getLeadByPhone`/`getLeadsByPhones`, `GET /by-phone`+`POST /by-phones`, the wizard's phone invocation) added-alongside; `resolveContact` signature (reused, not changed); `leads.phone` nullable + mig 004/023 (no destructive change); the POST phone-origin contract (name rules, `selected_contact_id`/`contact_update_mode`, async cascade + ZB sync — only the phone-mandatory rule relaxes); anon-timeline handling (gate keys on identity, not on removing the anon guard); LEADS-NEW-BADGE-001 (status/`lead_lost`-based, phone-independent — an email-origin "new" lead counts the same, no badge/SSE change).

### Verify plan (real DB, not just mocked jest)
Jest mocks the DB (LIST-PAGINATION-001 / created_by-FK lessons hide phoneless-insert & by-contact bugs), so against a **prod-DB copy**: (1) `EXPLAIN` `getLeadByContact` → confirm `idx_leads_contact_id` used; (2) run the **real** phoneless create (`POST /api/leads` with email+name+`selected_contact_id`, no phone) → assert row has `phone` NULL, `email` set, `contact_id` set; (3) by-contact returns the open lead / null-when-job-exists / null-when-Lost-Converted; (4) tenancy: a foreign-company `contactId` returns null; (5) regression: a phone create + `by-phone` are byte-identical. Jest still covers the validation branches (phone-only / email-only / contact-only / none), company scoping, and no-duplicate.

### Files to change
| File | Change |
|---|---|
| `backend/src/routes/leads.js` | Relax POST validation (line 202) to phone-OR-email-OR-`selected_contact_id`; guard the `update_contact` `phone_e164` write with `if (body.Phone)`; add `GET /by-contact/:contactId` (`requirePermission('leads.view','pulse.view')`, int-validate, company-scoped) with the other `by-*` static routes above `/:uuid`. Resolve branches otherwise unchanged. |
| `backend/src/services/leadsService.js` | Add `getLeadByContact(contactId, companyId)` (clone of `getLeadByPhone`: `contact_id` predicate, `status NOT IN ('Lost','Converted')`, company scope, job-exists→null, `team` agg, `rowToLead`); export it. |
| `frontend/src/services/leadsApi.ts` | Add `getLeadByContact(contactId)` → `GET /by-contact/:id` (returns `LeadDetailResponse`). |
| `frontend/src/hooks/useLeadByContact.ts` | **NEW.** Clone of `useLeadByPhone` keyed on `contactId` (`['lead-by-contact', contactId]`, `enabled: !!contactId`). |
| `frontend/src/hooks/usePulsePage.ts` | Call `useLeadByContact(contact?.id)` alongside `useLeadByPhone`; `lead = override || byPhone || byContact`; `leadLoading` reflects both `enabled` queries; extend the override/target reset to react to `contact?.id`; return the contact-lead source. |
| `frontend/src/pages/PulsePage.tsx` | Ungate the tri-state (line 361) to `!isAnonTimeline && (p.contactId || p.timelineId) && (p.phone || p.contact?.id)`; pass `contactId={p.contact?.id}` + `email` to `CreateLeadJobWizard`. SMS `{p.phone && …}` guard unchanged. |
| `frontend/src/components/contacts/PulseContactPanel.tsx` | Wrap the primary-phone row (lines 117-122) in `{contact.phone_e164 && ( … )}` (mirror the secondary-phone guard) so `tel:`/ClickToCall/OpenTimeline never emit with an empty phone. Email row unchanged. |
| `frontend/src/components/conversations/CreateLeadJobWizard.tsx` | `phone` optional + `contactId?`/`email?` props; init phone from `phone||''`, prefill email; send `Phone` only when non-blank, `Email` always when present, `selected_contact_id`+`contact_update_mode:'attach'` when `contactId` set; gate the header phone-row on `phone`; make `convertLead` customer phone conditional (line 170); hide/disable the with-JOB leg when phone is blank (ZB needs a phone → email-origin lead is lead-only). |
| `frontend/src/components/conversations/WizardStep1.tsx` | (If email-origin prefill is surfaced here) the phone `PhoneInput` stays but is non-required; no label "*". No structural change. |
| `backend/tests/` (jest) | `getLeadByContact` (open/none/job-exists/Lost-Converted/tenancy) + phoneless email-origin `POST /api/leads` (validation branches, company scope, no-duplicate) + documented real-DB-copy verification. |
| **Migration** | **NONE** (mig 004 nullable phone + email; mig 023 `contact_id`+`idx_leads_contact_id`). Max = 155. |

### Middleware / scoping / protected
- **Middleware chain:** `GET /api/leads/by-contact/:contactId` inherits `app.use('/api/leads', authenticate, requireCompanyAccess, leadsRouter)` (`src/server.js:160`) + its own `requirePermission('leads.view','pulse.view')`. **No `server.js` edit.**
- **`company_id` source:** `req.companyFilter?.company_id` on the lookup and the create (already threaded). All new SQL filters by it (tenancy AC-7).
- Deploy to prod only with explicit owner consent (standing rule).

## VAPI-SLOT-ENGINE-001: Sara offers engine-ranked windows on the call; the caller's pick becomes a schedule-blocking hold on the lead

**Status:** Architecture · **Date:** 2026-07-04 · **Owner:** Voice / Schedule / Leads
Upgrades one step of the shipped LQV2 call flow + closes one discard. Today the voice agent (Sara / Lead-Qualifier-v2) answers scheduling with the **generic** `checkAvailability` (`scheduleService.getAvailableSlots`, `vapi-tools.js:126`) and then **throws away** the caller's pick — `preferredSlot` is only rendered into a Comments line (`buildCallSummary`, `vapi-tools.js:139/170`); `lead_date_time`/`lead_end_date_time` are never set, so the pick never becomes a hold. This feature (1) adds a **new VAPI tool** that calls the **location-aware SLOT-ENGINE-001** ranker directly, (2) makes `createLead` **persist** the chosen structured slot to `lead_date_time`/`lead_end_date_time` (the hold), and (3) adds **open held leads to the engine's occupancy** so the same window isn't re-offered. **Backend + repo-config only. No frontend change, no migration, no new hold entity, no schedule-render change.**

### Duplication check (result)
Not a duplicate — reuses every primitive; adds one tool handler, one occupancy sub-query, one `createLead` write, and one repo-JSON edit. **`slotEngineService.getRecommendations`** (`slotEngineService.js:152`) already builds the snapshot + ranks + safe-fails — reused as-is (single call change: `buildScheduledJobs` gains held leads). **`marketplaceService.isAppConnected(…, SMART_SLOT_ENGINE_APP_KEY)`** (`marketplaceService.js:93/697`, key `'smart-slot-engine'`, seed mig 126) — the exact gate the dispatcher proxy applies at `schedule.js:203`, re-implemented in the tool (the proxy itself can't be reused — it needs `authenticate`+`schedule.dispatch`; VAPI is server-to-server). **`leadsService.createLead` `FIELD_MAP`** already maps `LeadDateTime→lead_date_time`, `LeadEndDateTime→lead_end_date_time`, `Latitude→latitude`, `Longitude→longitude` (`leadsService.js:132-150`) and the columns already exist (mig 004) — so the hold persists with **no service change and no migration**. **Leads already render on the Schedule** via the UNION (`scheduleQueries.js:158-183`, `l.lead_date_time`/`l.latitude`) filtered by `l.status NOT IN ('converted','lost','spam')` — setting the two columns is the whole hold. **`convertLead`** already carries `zb_job_payload.timeslot.start/end` → job `start_date`/`end_date` (`leadsService.js:757/631`) and `markLost` sets `status='Lost'` — so confirm/cancel free the slot with **no teardown**.

### Decision A — Held-lead occupancy coords: NO migration; reuse `leads.latitude`/`leads.longitude`; extend `buildScheduledJobs` with a company-scoped held-lead sub-read (the load-bearing decision)
**Chosen: (a) leads already store coordinates — no new columns, no geocode-on-hold.** `leads.latitude`/`leads.longitude` (`NUMERIC(10,7)`, mig 004) already exist and `FIELD_MAP` already maps `Latitude`/`Longitude`; the VAPI agent already has the validated address's lat/lng (from `validateAddress`, `vapi-tools.js:113`), so `createLead` writes those coordinates onto the lead alongside the slot (Decision D). This makes the hold **geo-aware for free** — rejecting option (b) geocode-at-occupancy-build (an extra Google call **per engine request** — too expensive on the hot path) and option (c) time-only block (the engine is fundamentally geo-routed — `buildScheduledJobs` **skips any row without finite lat/lng** at `slotEngineService.js:121`, and the engine snaps occupancy into `schedule[techId][date]` by coordinates; a coordinate-less "time block" would be silently dropped, not honored, so it cannot block routing). **Migration decision: NONE. Max migration on disk = 155 (confirmed: `155_backfill_outbound_email_links.sql`); no `156` is created.** No supporting index either — the held-lead read is date-windowed + company-scoped and small (`idx_leads_lead_date_time`, mig 004, already covers the ordering/range; re-verify with `EXPLAIN` on the prod copy per the verify plan).

**The occupancy extension (`slotEngineService.buildScheduledJobs`, the ONLY occupancy change):** after the jobs loop, append open held leads via a small dedicated query (no reusable lead-occupancy getter exists — a new one is required). Exactly which leads enter, and the filter (mirrored **verbatim** from the leads-in-Schedule UNION, `scheduleQueries.js:136` — lowercase, **not** the capitalized `('Lost','Converted')` set used by the lead-by-phone/contact lookups):
```sql
SELECT id, lead_date_time, lead_end_date_time, latitude, longitude, job_type
FROM leads
WHERE company_id = $1
  AND status NOT IN ('converted','lost','spam')   -- verbatim, lowercase (scheduleQueries.js:136)
  AND lead_date_time IS NOT NULL
  AND latitude IS NOT NULL AND longitude IS NOT NULL
  AND lead_date_time  >= ($2::date::timestamp AT TIME ZONE $4)   -- dayLower/dayUpper style (scheduleQueries.js:66)
  AND lead_date_time  <  (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE $4)
```
Each row maps to the **same** occupancy shape a job produces — `{ id: 'lead:'+id, date: localDate(lead_date_time, tz), status: 'scheduled', job_type: job_type||'unknown', window_start: localHHMM(lead_date_time, tz), window_end: localHHMM(lead_end_date_time||lead_date_time, tz), lat, lng, duration_minutes: minutesBetween(lead_date_time, lead_end_date_time)||DEFAULT_DURATION_MINUTES, assigned_technicians: [] }` (reusing the module's existing `localDate`/`localHHMM`/`minutesBetween`). `assigned_technicians: []` = an **unassigned** hold: the engine treats it as a route-blocking time+place occupancy for *any* tech in the area (it doesn't pin one tech's route), which is exactly the "don't re-offer this window near here" semantics we want (AC-5, scenario 7). Because `buildScheduledJobs` is shared by the VAPI path **and** the dispatcher proxy path (`schedule.js`), holds correctly block re-offering **everywhere** — a dispatcher won't re-offer a slot a caller just held either. Note a lead **without** coordinates (agent had zip only, engine used a centroid but the lead row got no lat/lng) can't enter the geo-occupancy — accepted for v1 (the requirement's own FR-5 note): it still renders on the Schedule as a hold, just doesn't block the engine. To minimize that gap, Decision D writes lat/lng whenever the agent has them.

### Decision B — Engine per-slot output → agent windows + hold ISO (shape + tz-combine, pinned)
**Pinned wrapper per-slot shape** (verified end-to-end, not assumed): the raw engine emits each recommendation at `slot-engine/src/engine.js:314` as `{ rank, date:'YYYY-MM-DD', time_frame:{start,end} (local 'HH:MM'), technicians:[{id,name}], score, confidence, feasible_arrival_interval:{start,end}, metrics, reason_codes, explanation, requires_dispatch_confirmation? }` (the `rankAndDiversify` step already reshapes the internal `techId`/`techName` into the `technicians:[{id,name}]` array). `getRecommendations` passes `json.recommendations` through **untouched** (`slotEngineService.js:226`), and the frontend `SlotRecommendation` interface (`slotRecommendationsApi.ts`) matches it exactly — so **the tool maps from that shape**. **Load-bearing fields for a hold: `date` + `time_frame.{start,end}`.**
- **(1) Spoken windows for the agent:** each offered slot → `{ date, start: time_frame.start, end: time_frame.end }` (+ a human label like `"Tue Jul 8, 10:00–13:00"`) so Sara reads back concrete windows, never "morning."
- **(2) Structured chosen slot back into `createLead`:** the agent echoes the picked slot's `{ date, start, end }`; `createLead` composes real timestamps. **tz-combine (pinned):** `date`('YYYY-MM-DD') + `HH:MM` + **company timezone** → ISO, using the **exact algorithm the frontend `dateInTZ` uses** (`companyTime.ts:17`) but re-implemented on the backend as a small local helper (there is **no** backend tz→ISO combine today; `slotEngineService`'s `localDate`/`localHHMM` are the inverse direction): build `Date.UTC(y, mo-1, d, hh, mm)`, read the tz's offset at that instant via `Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset'})` → parse `GMT±HH:MM`, subtract the offset. Company tz resolves the same way the engine does — `scheduleService.getDispatchSettings(companyId).timezone` → `'America/New_York'` fallback (`slotEngineService.resolveTimezone`). `lead_date_time = combine(date, start, tz)`, `lead_end_date_time = combine(date, end, tz)`.

### Decision C — New VAPI tool contract: `recommendSlots` (gated, safe-fail, deeper mode)
- **Name:** `recommendSlots`. **Handler** `handleRecommendSlots(args)` in `vapi-tools.js`, dispatched in the switch alongside the other four; company hardwired to `DEFAULT_COMPANY_ID` (`vapi-tools.js:25`), like every VAPI tool (AC-8). It calls **`slotEngineService.getRecommendations(DEFAULT_COMPANY_ID, { new_job:{…} })` directly** (NOT the auth'd proxy).
- **Arguments:** `{ zip?, lat?, lng?, address?, unitType?, durationMinutes?, excludeSlots?: string[], daysAhead?: number }`.
  - **Location (FR-2):** prefer `lat`/`lng` (validated address) → else `address` → else `zip` (passed as `address` so the engine geocodes to a centroid; engine forces low confidence for a centroid). Built into `new_job.{lat,lng,address}`.
  - `new_job.job_type` = `unitType ? unitType+' Repair' : 'Appliance Repair'` (mirrors `createLead`); `new_job.duration_minutes` = `durationMinutes || APPOINTMENT_DURATION_MIN` (120, the existing LQV2 constant). `exclude_job_id` N/A (prospective caller — no existing job).
  - **Deeper mechanism (FR-3, dual): `excludeSlots` + `daysAhead`.** `excludeSlots` = an array of **stable slot keys** the assistant echoes back from a previous offer (see result); the tool filters returned recommendations whose key ∈ `excludeSlots`. `daysAhead` extends the horizon: `new_job.latest_allowed_date = today + daysAhead` (company-local, via the engine's own `addDaysLocal`; default horizon = `settings.horizon_days`). Repeatable within the call — "none suit" → agent re-calls with the accumulated `excludeSlots` and/or a larger `daysAhead`.
- **Result shape:** `{ available: boolean, slots: [{ key, date, start, end, label, techName?, confidence }], fallback?: boolean }`, capped to **3** (`.slice(0,3)`). **Stable slot key** = `` `${date}|${time_frame.start}|${time_frame.end}` `` (deterministic, tech-agnostic — the same window from a different tech collapses to one offer, matching the engine's own per-window dedupe and making `excludeSlots` round-trip correctly). `available:true` only when `engine_status:'ok'` **and** ≥1 slot survives filtering.
- **Gating + safe-failure (FR-1, AC-4):** first `await marketplaceService.isAppConnected(DEFAULT_COMPANY_ID, marketplaceService.SMART_SLOT_ENGINE_APP_KEY)`; if not connected → return `{ available:false, slots:[], fallback:true }` **without** calling the engine. Otherwise call `getRecommendations`; if it returns `engine_status:'unavailable'` (its own safe-failure: engine down / non-2xx / timeout / no `SLOT_ENGINE_URL`) or `recommendations:[]` → `{ available:false, slots:[], fallback:true }`. Wrap the whole handler in try/catch → same fallback (a `NEW_JOB_LOCATION_REQUIRED` throw from a bad location also degrades to fallback, never a 500). **The call never breaks; lead creation is never blocked** (LQV2 rule). The engine's 4 s timeout keeps tool p95 < 2000 s target intact on the happy path; a slow engine falls back.

### Decision D — `createLead` persists the chosen structured slot as the hold (back-compat)
`handleCreateLead` gains an optional `chosenSlot` argument: `{ date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM' }` (the structured pick the agent passes back from `recommendSlots`). When present **and** valid: resolve company tz, compose `lead_date_time`/`lead_end_date_time` via the Decision-B tz-combine, and add to the `createLead` body `LeadDateTime`, `LeadEndDateTime`, and — when the agent also has coordinates (`lat`/`lng` args, from `validateAddress`) — `Latitude`/`Longitude` (so the hold enters the geo-occupancy per Decision A). `FIELD_MAP` maps all four to columns unchanged — **no `leadsService` change**. **Back-compat (AC-2/AC-4):** a `createLead` **without** `chosenSlot` (callback / fallback / caller didn't pick) behaves **exactly as today** — columns stay NULL, no hold. The `Comments` summary line (`buildCallSummary`, including its `Slot: …` label for human context) is **kept** — but it is no longer the source of the hold; the structured columns are. The existing phone-required guard, retry, JobSource, disqualified handling, and "never block the call" semantics are all preserved. (A slot without a phone still can't create a valid lead — the phone guard stays; but the agent collects phone before booking anyway, step 7.)

### Decision E — Repo assistant JSON (`lead-qualifier-v2.json` ONLY; live PATCH out of scope)
- **New tool-def** appended to `model.tools[]` in the **same shape** as the existing five: `{ type:'function', server:{ url:'https://api.albusto.com/api/vapi-tools', secret:'REPLACE_WITH_VAPI_TOOLS_SECRET' }, function:{ name:'recommendSlots', description, parameters:{ type:'object', properties:{ zip, lat, lng, address, unitType, durationMinutes, excludeSlots, daysAhead } } } }` (secret placeholder = the v2 repo convention; the real secret is injected at push time).
- **Scheduling-prompt rewrite** (system prompt, `model.messages[0].content`, step **6 "OFFER A CONCRETE WINDOW"** + step **9 "CREATE LEAD"**): step 6 → call **`recommendSlots`** (with the validated lat/lng or the zip), offer the **top 2–3** returned windows verbatim ("Tuesday between 10 and 1, or Wednesday 1 to 4 — which works?"); on **"none suit"** → re-call `recommendSlots` in **deeper** mode (echo the already-offered slot **keys** in `excludeSlots` and/or bump `daysAhead`) and offer a fresh 2–3; on **`available:false`/`fallback:true`** (engine down or app not connected) → **degrade to the existing `checkAvailability` path** (generic windows) or offer a callback — never crash, never invent a window. Step 9 → pass the **structured `chosenSlot`** (`{date,start,end}` of the accepted window) into `createLead` in addition to the existing fields (`preferredSlot` text may remain for the human summary). **This edits only the repo JSON.** The **live** assistant (`30e85a87`) is a **separate owner-consent-gated `PATCH api.vapi.ai` prod step** (get-first — it drifts; REST PATCH — the CLI `update` panics; re-inject `VAPI_TOOLS_SECRET` into every `model.tools[].server`; keep `answerOnBridge="true"`) — explicitly **not** in this pipeline (AC-7).

### Decision F — Confirm/cancel lifecycle: freed by EXISTING status filters, NO teardown
Verified against the code: a held lead leaves both the Schedule render **and** the new engine occupancy through the **same** `status NOT IN ('converted','lost','spam')` filter, with **no new teardown code** (AC-6). **Confirm →** `convertLead` (`leadsService.js:704`) sets `status='Converted'` and carries `zb_job_payload.timeslot.start/end` → the local job's `start_date`/`end_date` (`leadsService.js:757/631`); the now-`Converted` lead drops out of the occupancy sub-read (Decision A filter) and the UNION, while the **job** occupies the time via `buildScheduledJobs`' existing jobs loop — the hold is seamlessly replaced by the booking. **Cancel/lose →** `markLost` (`leadsService.js:451`) sets `status='Lost'`; the lead drops out of both by the same filter, freeing the slot. Neither path needs to know a "hold" existed — it was only ever a lead with `lead_date_time` set.

### Company scoping, gating, safe-failure (invariants)
- **Single-tenant, hardwired:** `recommendSlots` and the `createLead` slot-write use `DEFAULT_COMPANY_ID` (seed …0001), like the other four VAPI tools; the occupancy sub-read is `WHERE company_id = $1` bound to that constant (no cross-tenant read/write; no per-request company inference at the vapi-tools layer — tenant context is the assistant assignment). The endpoint stays behind `x-vapi-secret` vs `VAPI_TOOLS_SECRET` (**fail-closed**, `vapi-tools.js:32`) and is **not** exposed via the auth'd proxy (proxy auth unweakened).
- **Gate:** `isAppConnected(DEFAULT_COMPANY_ID, SMART_SLOT_ENGINE_APP_KEY)` — identical to `schedule.js:203`. **Safe-failure:** not-connected / `engine_status:'unavailable'` / empty / any throw → `{ available:false, slots:[], fallback:true }`; the agent degrades to `checkAvailability`/callback; the call and lead complete (slot columns NULL).

### Verify plan (real DB + real engine + engine-down; assistant JSON validated, not pushed)
Jest mocks the DB (LIST-PAGINATION-001 / created_by-FK lessons — a slot-persist or occupancy-read bug hides in a string-only mock), so against a **prod-DB copy** + the **real** slot engine: (1) **real `createLead` slot write** — call `handleCreateLead` with a `chosenSlot` + phone → assert the row has `lead_date_time`/`lead_end_date_time` set to the composed timestamps **and** `latitude`/`longitude` populated (verify the tz-combine against a known EDT/EST instant); a `createLead` **without** `chosenSlot` → columns NULL (back-compat). (2) **real occupancy-with-held-leads** — insert a non-terminal lead with `lead_date_time`+coords, run `getRecommendations` for an overlapping location → that window is **not** offered (AC-5, scenario 7); flip the lead to `Converted`/`Lost` → the window **is** offered again; `EXPLAIN` the held-lead sub-read → confirm it's date-windowed/small (no seq-scan regression). (3) **end-to-end tool** against the real engine — `recommendSlots` returns ≤3 keyed slots; a **deeper** call with `excludeSlots` returns a fresh set that excludes the prior keys (AC-3). (4) **engine-down fallback** — stop the engine (or unset `SLOT_ENGINE_URL`, or disconnect the marketplace app) → `recommendSlots` returns `{available:false, fallback:true}` (never throws), and a `createLead` still succeeds with NULL slot columns (AC-4). (5) **assistant JSON validated** — `JSON.parse` clean, `model.tools[]` has `recommendSlots` in the correct `function`/`server` shape, scheduling prompt updated — but **NOT** pushed to `30e85a87` (owner-gated). Jest still covers the gated/safe-fail/deeper branches, the slot-persist mapping, and company scope.

### Files to change
| File | Change |
|---|---|
| `backend/src/routes/vapi-tools.js` | Add `handleRecommendSlots(args)` (gated on `isAppConnected(DEFAULT_COMPANY_ID, SMART_SLOT_ENGINE_APP_KEY)`, calls `slotEngineService.getRecommendations` directly, maps wrapper recs → `{key,date,start,end,label,confidence}` capped to 3, `excludeSlots`+`daysAhead` deeper mode, safe-fail → `{available:false,slots:[],fallback:true}`) + dispatch `recommendSlots` in the switch. Extend `handleCreateLead` to accept `chosenSlot`+`lat`/`lng` and add `LeadDateTime`/`LeadEndDateTime`/`Latitude`/`Longitude` to the body when present (keep Comments summary; NULL when absent). Add a small backend tz-combine helper (mirror `dateInTZ`). Require `marketplaceService` + `slotEngineService`. |
| `backend/src/services/slotEngineService.js` | Extend `buildScheduledJobs` to append open non-terminal held leads (`status NOT IN ('converted','lost','spam')`, `lead_date_time NOT NULL`, coords NOT NULL, date-windowed, company-scoped) via a new small query, mapped to the existing occupancy shape (`localDate`/`localHHMM`/`minutesBetween`, `assigned_technicians:[]`). Only occupancy change; no scoring/contract change. |
| `voice-agent/assistants/lead-qualifier-v2.json` | Add the `recommendSlots` tool-def to `model.tools[]` (same `function`/`server` shape, `REPLACE_WITH_VAPI_TOOLS_SECRET`); rewrite scheduling prompt steps 6 + 9 (call `recommendSlots`, offer top 2–3, deeper on "none suit," fallback to `checkAvailability`/callback, pass structured `chosenSlot` into `createLead`). Repo JSON only — live PATCH is a separate owner-gated step. |

**No migration** (max on disk = 155; `lead_date_time`/`lead_end_date_time`/`latitude`/`longitude` exist, mig 004; `FIELD_MAP` maps all four). **No frontend change, no new hold entity, no schedule-render change.** `marketplaceService`, `leadsService` (`createLead`/`convertLead`/`markLost`), `scheduleService.getAvailableSlots` (stays the fallback), the slot engine, the proxy, and `CustomTimeModal` are **reused unchanged** (except the single `buildScheduledJobs` occupancy add).
