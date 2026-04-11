# Blanc Contact Center — Architecture

> Architectural decisions and module structure for the project.

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
