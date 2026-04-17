# Blanc Contact Center — Tasks

> FSM-001: FSM/SCXML Workflow Editor — Task Breakdown

**Feature:** Database-driven FSM replacing hardcoded status constants
**Migration range:** 072–074
**Total tasks:** 30
**Phases:** 5

---

## Phase 1: Database & Parser Foundation

---

### TASK-001: Migration — fsm_machines, fsm_versions, fsm_audit_log tables
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/db/migrations/072_create_fsm_tables.sql` — CREATE TABLE fsm_machines, fsm_versions, fsm_audit_log with indexes, FK constraint from fsm_machines.active_version_id to fsm_versions.id
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/db/migrations/README.md` — do not rename existing migrations
**Acceptance criteria:**
- [ ] `fsm_machines` table created with columns: id, machine_key, company_id (FK to companies), title, description, active_version_id, created_at, updated_at
- [ ] UNIQUE constraint on (company_id, machine_key)
- [ ] `fsm_versions` table created with columns: id, machine_id (FK to fsm_machines ON DELETE CASCADE), company_id (FK to companies), version_number, status (CHECK 'draft'/'published'/'archived'), scxml_source, change_note, created_by, created_at, published_by, published_at
- [ ] `fsm_audit_log` table created with columns: id, company_id, machine_key, version_id, actor_id, actor_email, action, payload_json (JSONB), created_at
- [ ] All indexes from architecture spec created (idx_fsm_machines_company, idx_fsm_versions_machine, idx_fsm_versions_company, idx_fsm_versions_status, idx_fsm_audit_company, idx_fsm_audit_machine, idx_fsm_audit_created)
- [ ] Migration runs without errors on a fresh DB with existing `companies` table
**Related test cases:** TC-FSM-008 (data isolation depends on schema)

---

### TASK-002: Migration — FSM permission roles
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/db/migrations/074_add_fsm_permissions.sql` — INSERT fsm.viewer, fsm.editor, fsm.publisher, fsm.override into role_permissions
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/middleware/authorization.js` — existing requirePermission middleware already supports arbitrary permission keys
**Acceptance criteria:**
- [ ] `admin` role receives all four permissions: fsm.viewer, fsm.editor, fsm.publisher, fsm.override
- [ ] `manager` role receives only fsm.viewer
- [ ] ON CONFLICT DO NOTHING ensures idempotent reruns
- [ ] Migration runs without errors
**Related test cases:** TC-FSM-007

---

### TASK-003: Install backend dependency (fast-xml-parser)
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/package.json` — add `fast-xml-parser` dependency
**Files NOT to modify:**
- `frontend/package.json`
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `fast-xml-parser` added to `dependencies` (not devDependencies)
- [ ] `npm install` in backend directory succeeds
- [ ] Package version is latest stable (^5.x)
**Related test cases:** TC-FSM-001 (parser depends on this)

---

### TASK-004: SCXML parser service — parseSCXML, validateSCXML
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-003
**Files to modify:**
- `backend/src/services/fsmService.js` — NEW FILE: implement `parseSCXML(xml)` and `validateSCXML(xml)` functions using fast-xml-parser
**Files NOT to modify:**
- `backend/src/services/jobsService.js` — do not modify yet
- `backend/src/services/leadsService.js` — do not modify yet
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `parseSCXML(xmlString)` returns a ParsedGraph object with: `states` (Map of state id -> { id, label, statusName, transitions, isFinal }), `initialState` (string), `finalStates` (array), `metadata` ({ machine, title })
- [ ] Transitions parsed with all `blanc:*` namespace attributes: action (bool), label, confirm (bool), confirmText, roles (array), order (number), icon
- [ ] State `blanc:label` and `blanc:statusName` attributes extracted correctly
- [ ] `<final>` elements parsed with `isFinal: true`
- [ ] `validateSCXML(xmlString)` returns `{ valid: boolean, errors: [{line, col, message, severity}], warnings: [{...}] }`
- [ ] Forbidden elements rejected: `<script>`, `<invoke>`, `<send>`, `<onentry>`, `<onexit>`, `<parallel>`, `<history>`, `<datamodel>`
- [ ] Missing `initial` attribute on `<scxml>` root produces error
- [ ] Transition target referencing non-existent state produces error
- [ ] Unreachable states (no incoming transitions, not initial) produce warning
- [ ] Duplicate events in same state produce warning
- [ ] Malformed XML returns parse error
- [ ] Module exports: `parseSCXML`, `validateSCXML`
**Related test cases:** TC-FSM-001, TC-FSM-002, TC-FSM-003, TC-FSM-004, TC-FSM-020, TC-FSM-021, TC-FSM-030

---

### TASK-005: Seed SCXML files for reference
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `fsm/job.scxml` — NEW FILE: Job workflow SCXML matching ALLOWED_TRANSITIONS in jobsService.js exactly (7 states: Submitted, Waiting_for_parts, Follow_Up_with_Client, Visit_completed, Job_is_Done, Rescheduled, Canceled)
- `fsm/lead.scxml` — NEW FILE: Lead workflow SCXML (8 states: Submitted, New, Contacted, Qualified, Proposal_Sent, Negotiation, Lost, Converted)
**Files NOT to modify:**
- `backend/src/services/jobsService.js` — reference only, do not modify
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `fsm/job.scxml` is valid SCXML with `xmlns:blanc="https://blanc.app/fsm"`, `initial="Submitted"`, `blanc:machine="job"`, `blanc:title="Job Workflow"`
- [ ] All 7 job states present with correct transitions matching architecture spec
- [ ] All `blanc:confirm` and `blanc:confirmText` attributes present on Cancel transitions
- [ ] `fsm/lead.scxml` is valid SCXML with 8 lead states and correct transitions
- [ ] `<final>` used for terminal states (Canceled for jobs; Lost, Converted for leads)
- [ ] Both files pass `validateSCXML()` with zero errors
**Related test cases:** TC-FSM-001, TC-FSM-005

---

### TASK-006: Migration — seed initial published FSM versions for existing companies
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-001
**Files to modify:**
- `backend/db/migrations/073_seed_fsm_machines.sql` — DO $$ block that iterates over all companies, inserts fsm_machines rows for 'job' and 'lead', inserts fsm_versions with status='published' and version_number=1, updates active_version_id
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/db/migrations/072_create_fsm_tables.sql` — already created in TASK-001
**Acceptance criteria:**
- [ ] For every existing company: 2 fsm_machines rows (job, lead) created with ON CONFLICT DO NOTHING
- [ ] For each machine: 1 fsm_versions row with status='published', version_number=1, scxml_source matching seed SCXML from architecture spec
- [ ] `fsm_machines.active_version_id` updated to point to the published version
- [ ] created_by and published_by set to 'system'
- [ ] Migration is idempotent (ON CONFLICT DO NOTHING)
- [ ] SCXML content in SQL exactly matches the seed SCXML from Docs/architecture.md
**Related test cases:** TC-FSM-005, TC-FSM-008

---

## Phase 2: Backend API

---

### TASK-007: FSM service — machine CRUD and version reads
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-001, TASK-004, TASK-006
**Files to modify:**
- `backend/src/services/fsmService.js` — add functions: `listMachines(companyId)`, `getActiveVersion(companyId, machineKey)`, `getDraft(companyId, machineKey)`, `listVersions(companyId, machineKey)`
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/services/jobsService.js`
**Acceptance criteria:**
- [ ] `listMachines(companyId)` queries fsm_machines WHERE company_id=$1, joins fsm_versions for active_version info and has_draft boolean
- [ ] `getActiveVersion(companyId, machineKey)` returns published version with scxml_source, version_number, published_at, published_by
- [ ] `getDraft(companyId, machineKey)` returns draft version or null if none exists
- [ ] `listVersions(companyId, machineKey)` returns all versions sorted by version_number DESC
- [ ] All queries filter by company_id — data isolated between tenants
- [ ] Returns null/empty for non-existent machines (not error)
**Related test cases:** TC-FSM-008, TC-FSM-009, TC-FSM-012

---

### TASK-008: FSM service — draft management (saveDraft, publishDraft, restoreVersion)
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-007
**Files to modify:**
- `backend/src/services/fsmService.js` — add functions: `saveDraft(companyId, machineKey, scxml, userId, email)`, `publishDraft(companyId, machineKey, changeNote, userId, email)`, `restoreVersion(companyId, machineKey, versionId, userId, email)`, `logAudit(companyId, machineKey, versionId, actorId, actorEmail, action, payload)`, `invalidateCache(companyId, machineKey)`
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/services/jobsService.js`
**Acceptance criteria:**
- [ ] `saveDraft` validates SCXML first (returns 400 equivalent on errors), then upserts draft version; logs `save_draft` to fsm_audit_log
- [ ] `saveDraft` supports optimistic concurrency: if version_id provided and differs from current draft, throws conflict error
- [ ] `publishDraft` in a DB transaction: re-validates, archives current published, promotes draft to published with incremented version_number, updates fsm_machines.active_version_id, invalidates cache, logs `publish`
- [ ] `publishDraft` rejects if draft has validation errors (returns errors array)
- [ ] `restoreVersion` copies scxml_source from specified version into a new/updated draft; logs `restore`
- [ ] `logAudit` inserts into fsm_audit_log with payload_json
- [ ] `invalidateCache` clears in-memory parsed graph for (companyId, machineKey)
- [ ] In-memory graph cache: Map keyed by `${companyId}:${machineKey}`, stores ParsedGraph, invalidated on publish
**Related test cases:** TC-FSM-009, TC-FSM-010, TC-FSM-011, TC-FSM-024, TC-FSM-027

---

### TASK-009: FSM routes — read endpoints
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-007, TASK-002
**Files to modify:**
- `backend/src/routes/fsm.js` — NEW FILE: Express router with GET /machines, GET /:machineKey/active, GET /:machineKey/draft, GET /:machineKey/versions, GET /:machineKey/actions
**Files NOT to modify:**
- `src/server.js` (protected — mounting happens in TASK-012)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] `GET /machines` requires `fsm.viewer` permission via `requirePermission('fsm.viewer')`
- [ ] `GET /:machineKey/active` requires `fsm.viewer`
- [ ] `GET /:machineKey/draft` requires `fsm.editor`
- [ ] `GET /:machineKey/versions` requires `fsm.viewer`
- [ ] `GET /:machineKey/actions` requires any authenticated user (no additional permission)
- [ ] company_id obtained via `req.companyFilter?.company_id` (NOT req.companyId)
- [ ] All responses follow `{ ok: true, data: ... }` pattern
- [ ] Actions endpoint accepts `?state=X&roles=a,b` query params
- [ ] 404 returned for non-existent machines, not 500
**Related test cases:** TC-FSM-007, TC-FSM-008, TC-FSM-012, TC-FSM-022, TC-FSM-023, TC-FSM-031, TC-FSM-032

---

### TASK-010: FSM routes — write endpoints
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-008, TASK-009
**Files to modify:**
- `backend/src/routes/fsm.js` — add PUT /:machineKey/draft, POST /:machineKey/validate, POST /:machineKey/publish, POST /:machineKey/versions/:versionId/restore
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] `PUT /:machineKey/draft` requires `fsm.editor`, accepts `{ scxml_source }`, validates, upserts draft
- [ ] `POST /:machineKey/validate` requires `fsm.editor`, accepts `{ scxml_source }`, returns `{ valid, errors, warnings }`
- [ ] `POST /:machineKey/publish` requires `fsm.publisher`, accepts `{ change_note }`, promotes draft
- [ ] `POST /:machineKey/versions/:versionId/restore` requires `fsm.editor`, copies version as new draft
- [ ] 400 returned with error details when SCXML validation fails
- [ ] 409 returned on draft version conflict
- [ ] 404 returned when no draft exists for publish, or version not found for restore
- [ ] company_id from `req.companyFilter?.company_id`
- [ ] Empty change_note on publish returns 400
**Related test cases:** TC-FSM-009, TC-FSM-010, TC-FSM-011, TC-FSM-024, TC-FSM-027

---

### TASK-011: FSM runtime — resolveTransition, getAvailableActions, apply, override
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-008
**Files to modify:**
- `backend/src/services/fsmService.js` — add functions: `resolveTransition(companyId, machineKey, currentState, event)`, `getAvailableActions(companyId, machineKey, currentState, userRoles)`
- `backend/src/routes/fsm.js` — add POST /:machineKey/apply, POST /:machineKey/override
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/services/jobsService.js` — do not modify yet (Phase 4)
- `backend/src/services/leadsService.js` — do not modify yet (Phase 4)
**Acceptance criteria:**
- [ ] `resolveTransition` loads published graph from cache or DB, finds matching transition from currentState with given event, returns `{ valid: true, targetState }` using blanc:statusName or state id
- [ ] `resolveTransition` returns `{ valid: false }` for invalid event from current state
- [ ] `resolveTransition` falls back to hardcoded ALLOWED_TRANSITIONS when no published FSM exists
- [ ] `getAvailableActions` filters by blanc:action="true", filters by user roles (intersection with blanc:roles or no roles = visible to all), sorts by blanc:order
- [ ] `getAvailableActions` falls back to hardcoded constants when no published FSM
- [ ] `POST /:machineKey/apply` loads entity via jobsService/leadsService, validates transition, updates status, logs audit
- [ ] `POST /:machineKey/override` requires `fsm.override`, validates target state exists in SCXML, requires non-empty reason, updates status, logs audit
- [ ] Override rejects if target state equals current state (400)
- [ ] Override rejects if target state does not exist in published SCXML (400)
- [ ] Entity not found returns 404 (not 403 — data isolation)
**Related test cases:** TC-FSM-005, TC-FSM-006, TC-FSM-013, TC-FSM-014, TC-FSM-015, TC-FSM-016, TC-FSM-017, TC-FSM-018, TC-FSM-019, TC-FSM-022, TC-FSM-025, TC-FSM-026

---

### TASK-012: Mount FSM route in server.js + audit logging
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-009, TASK-010, TASK-011
**Files to modify:**
- `src/server.js` — add import for fsmRouter and mount line: `app.use('/api/fsm', authenticate, requireCompanyAccess, fsmRouter)` in the "Auth + tenant-scoped CRM API routes" section
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `frontend/src/hooks/useRealtimeEvents.ts` (protected)
**Acceptance criteria:**
- [ ] Only ONE new require/import line and ONE app.use() line added to server.js
- [ ] Route mounted in correct section (alongside other authenticated routes)
- [ ] No other changes to server.js
- [ ] `GET /api/fsm/machines` accessible with valid auth token
- [ ] `GET /api/fsm/machines` returns 401 without token
**Related test cases:** TC-FSM-007

---

## Phase 3: Frontend Editor

---

### TASK-013: Install frontend dependencies
**Phase:** 3
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `frontend/package.json` — add `@monaco-editor/react` and `state-machine-cat` as dependencies
**Files NOT to modify:**
- `backend/package.json`
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `@monaco-editor/react` added to dependencies
- [ ] `state-machine-cat` added to dependencies
- [ ] `npm install` in frontend directory succeeds
- [ ] Both packages importable in a .tsx file without type errors
**Related test cases:** TC-FSM-028, TC-FSM-029

---

### TASK-014: FSM API client hooks — useFsmEditor.ts, useFsmActions.ts
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-012
**Files to modify:**
- `frontend/src/hooks/useFsmEditor.ts` — NEW FILE: React Query hooks for editor operations (load draft, load active, save draft, validate, publish, list versions, restore)
- `frontend/src/hooks/useFsmActions.ts` — NEW FILE: React Query hooks for runtime (fetch available actions, apply transition, override)
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected — use it, don't modify)
- `frontend/src/hooks/useRealtimeEvents.ts` (protected)
**Acceptance criteria:**
- [ ] `useFsmEditor(machineKey)` provides: draft query, active query, saveDraft mutation, validate mutation, publish mutation, versions query, restore mutation
- [ ] All API calls use `authedFetch` with correct paths (`/api/fsm/...`)
- [ ] `useFsmActions(machineKey, currentState, roles)` provides: actions query, applyTransition mutation
- [ ] Override mutation in separate hook or export
- [ ] Proper React Query cache invalidation on save/publish/restore/apply
- [ ] Loading, error, and success states handled
- [ ] Types defined for API responses
**Related test cases:** TC-FSM-009, TC-FSM-013

---

### TASK-015: LeadFormSettingsPage — add Shadcn Tabs wrapper
**Phase:** 3
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `frontend/src/pages/LeadFormSettingsPage.tsx` — wrap existing content in Shadcn Tabs component, add "Workflows" tab trigger (gated by fsm_editor_enabled feature flag)
**Files NOT to modify:**
- `frontend/src/pages/LeadFormSettingsPage.css` — no CSS changes needed (Tabs component uses its own styles)
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Existing page content wrapped in `<Tabs defaultValue="settings">`
- [ ] `<TabsTrigger value="settings">Settings</TabsTrigger>` renders for all users
- [ ] `<TabsTrigger value="workflows">Workflows</TabsTrigger>` renders only when `fsm_editor_enabled` feature flag is true
- [ ] `<TabsContent value="settings">` contains all existing page content unchanged — no functional changes
- [ ] `<TabsContent value="workflows">` renders `<MachineList />` placeholder (or empty div until TASK-016)
- [ ] All existing functionality (Job Types, Metadata Fields, Job Tags, DnD) works exactly as before
**Related test cases:** SC-01 (spec scenario)

---

### TASK-016: MachineList component
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-014
**Files to modify:**
- `frontend/src/components/workflows/MachineList.tsx` — NEW FILE: list of FSM machines with active version badge and draft indicator; "Open Editor" action per machine
**Files NOT to modify:**
- `frontend/src/pages/LeadFormSettingsPage.tsx` — already has Workflows tab from TASK-015
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Fetches machines via `useFsmEditor` or direct `authedFetch` to `GET /api/fsm/machines`
- [ ] Renders each machine: title, description, active version number, published_at date, has_draft indicator
- [ ] "Open Editor" button/link per machine row
- [ ] Loading state while fetching
- [ ] Error state with retry button on fetch failure
- [ ] Empty state if no machines (unlikely but handled)
- [ ] Styling follows Blanc design system: `--blanc-line` borders, `rounded-xl`, no decorative elements
**Related test cases:** SC-01

---

### TASK-017: WorkflowEditor — Monaco editor pane
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-013, TASK-014
**Files to modify:**
- `frontend/src/components/workflows/WorkflowEditor.tsx` — NEW FILE: split-view layout with Monaco editor (left pane), manages SCXML draft state, toolbar with validate/save/publish/export/history buttons
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Split-view layout: Monaco editor (left), diagram preview placeholder (right)
- [ ] Monaco configured with XML language, line numbers, minimap enabled
- [ ] Loads draft SCXML first; falls back to active version if no draft; falls back to minimal template if neither
- [ ] 300ms debounce on content changes for preview updates
- [ ] Toolbar buttons: Validate, Save Draft, Publish, Export, Version History
- [ ] Dirty state tracked (comparing editor content to last saved)
- [ ] Status pill: "Valid" (green), "Draft has changes" (yellow), "Has errors" (red)
- [ ] Save Draft button disabled while save request in flight
- [ ] Publish button hidden for users without fsm.publisher role
**Related test cases:** SC-01, SC-02, SC-03

---

### TASK-018: DiagramPreview component — SCXML to SVG rendering
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-013
**Files to modify:**
- `frontend/src/components/workflows/DiagramPreview.tsx` — NEW FILE: renders SVG from SCXML via state-machine-cat, pan/zoom support, error overlay
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Converts SCXML to smcat format, then renders SVG via state-machine-cat
- [ ] SVG rendering triggered by parent passing SCXML string (debounced by parent)
- [ ] Pan and zoom support on the SVG container
- [ ] Error overlay when SCXML is malformed: "Can't render diagram" + error message
- [ ] Loading spinner during render
- [ ] Warning for large diagrams (>1 second render time)
- [ ] SVG contains visual state nodes and transition arrows
**Related test cases:** TC-FSM-028, TC-FSM-029, SC-01

---

### TASK-019: ProblemsPanel + toolbar integration
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-017
**Files to modify:**
- `frontend/src/components/workflows/ProblemsPanel.tsx` — NEW FILE: collapsible panel displaying validation errors (red) and warnings (yellow) with line:column references; click navigates Monaco to error line
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Panel below editor, collapsible
- [ ] Errors shown with red severity icon, warnings with yellow
- [ ] Each entry: severity, message, line:column reference
- [ ] Clicking an entry scrolls Monaco to that line and highlights it (via ref callback from WorkflowEditor)
- [ ] Panel opens automatically when validation returns errors
- [ ] "N errors, M warnings" summary in panel header
**Related test cases:** SC-02 (validate and save flow)

---

### TASK-020: VersionHistory modal + PublishDialog modal
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-014
**Files to modify:**
- `frontend/src/components/workflows/VersionHistory.tsx` — NEW FILE: modal listing versions with restore action
- `frontend/src/components/workflows/PublishDialog.tsx` — NEW FILE: confirmation modal with change note textarea
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] VersionHistory modal lists versions: version_number, status badge, author, date, change_note (truncated with expand)
- [ ] Versions sorted by version_number DESC
- [ ] "Restore as draft" button per archived/published version
- [ ] Restore confirmation if unsaved changes exist in editor
- [ ] PublishDialog: textarea for change_note (required), "Confirm Publish" button disabled when empty
- [ ] Both modals follow Blanc design: no `<hr>`, section separation by spacing, `--blanc-line` borders
**Related test cases:** SC-03, SC-06, TC-FSM-024

---

## Phase 4: Runtime Integration

---

### TASK-021: ActionsBlock component
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-014
**Files to modify:**
- `frontend/src/components/workflows/ActionsBlock.tsx` — NEW FILE: renders hot action buttons from published SCXML transitions; handles confirmation dialogs; override dropdown for fsm.override role
**Files NOT to modify:**
- `frontend/src/components/jobs/JobStatusTags.tsx` — not yet (TASK-022)
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Props: machineKey, entityId, currentState
- [ ] Fetches available actions via `useFsmActions` hook
- [ ] Renders button per action, label from `blanc:label`, sorted by `blanc:order`
- [ ] Handles `confirm: true` actions: shows confirmation dialog with `confirmText` (or default text)
- [ ] Clicking action calls `POST /api/fsm/:machineKey/apply`
- [ ] "Change status..." link visible only for users with fsm.override role
- [ ] Override dropdown lists all states from published SCXML (excluding current)
- [ ] Override requires reason textarea, calls `POST /api/fsm/:machineKey/override`
- [ ] Empty actions = no buttons rendered, no "Actions" header
- [ ] React Query cache invalidation on successful transition
**Related test cases:** TC-FSM-022, TC-FSM-023, SC-04, SC-05, SC-08

---

### TASK-022: Replace hardcoded buttons in JobStatusTags.tsx with ActionsBlock
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-021
**Files to modify:**
- `frontend/src/components/jobs/JobStatusTags.tsx` — replace hardcoded status-change dropdown/buttons with `<ActionsBlock machineKey="job" entityId={job.id} currentState={job.blanc_status} />`
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] Hardcoded status dropdown removed
- [ ] `<ActionsBlock>` component renders in its place
- [ ] All other card content, layout, and styling preserved
- [ ] Existing status badge display unchanged
- [ ] Works with both FSM-driven and fallback (hardcoded) actions
**Related test cases:** SC-04

---

### TASK-023: Manual override UI in ActionsBlock
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-021
**Files to modify:**
- `frontend/src/components/workflows/ActionsBlock.tsx` — ensure override UI is complete: dropdown of all states, reason textarea, confirmation dialog
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] "Change status..." link only visible if user has `fsm.override` role (checked via Keycloak token claims)
- [ ] Dropdown lists all valid states from published SCXML excluding current state
- [ ] Confirmation dialog: "This is an override. It bypasses allowed transitions." + reason textarea (mandatory)
- [ ] On confirm, calls `POST /api/fsm/:machineKey/override` with entityId, targetState, reason
- [ ] Toast on success: "Status changed to X (override)"
- [ ] Toast on error with server message
- [ ] Falls back to BLANC_STATUSES list when no published FSM
**Related test cases:** TC-FSM-015, TC-FSM-016, TC-FSM-017, TC-FSM-025, TC-FSM-026, SC-05

---

### TASK-024: Modify jobsService.js — delegate to FSM runtime with fallback
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-011
**Files to modify:**
- `backend/src/services/jobsService.js` — modify `updateBlancStatus()` to try fsmService.resolveTransition first, fall back to ALLOWED_TRANSITIONS; add `getJobTransitions(companyId, currentState, userRoles)` export
**Files NOT to modify:**
- `src/server.js` (protected)
- OUTBOUND_MAP, computeBlancStatusFromZb, syncFromZenbooker, cancelJob, markEnroute, markInProgress, markComplete, zbJobToColumns — preserve all Zenbooker logic
**Acceptance criteria:**
- [ ] `updateBlancStatus()` calls `fsmService.resolveTransition(companyId, 'job', currentState, newStatus)` first
- [ ] If no published FSM exists (fsmService returns fallback), uses existing ALLOWED_TRANSITIONS check
- [ ] BLANC_STATUSES and ALLOWED_TRANSITIONS constants kept intact as fallback
- [ ] `getJobTransitions(companyId, currentState, userRoles)` delegates to fsmService.getAvailableActions or falls back to ALLOWED_TRANSITIONS
- [ ] OUTBOUND_MAP and Zenbooker sync logic completely unchanged
- [ ] All existing Zenbooker pass-through actions (cancelJob, markEnroute, markInProgress, markComplete) unchanged
**Related test cases:** TC-FSM-005, TC-FSM-014, TC-FSM-018

---

### TASK-025: Modify leadsService.js — delegate to FSM runtime with fallback
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-011
**Files to modify:**
- `backend/src/services/leadsService.js` — modify `updateLead()` to validate Status changes via fsmService.resolveTransition when published FSM exists; add `getLeadTransitions(companyId, currentStatus, userRoles)` export
**Files NOT to modify:**
- `src/server.js` (protected)
- All existing CRUD, convertLead, markLost, activateLead, phone normalization, metadata extraction — preserve
**Acceptance criteria:**
- [ ] When `Status` field changes in `updateLead()`, validates via `fsmService.resolveTransition(companyId, 'lead', currentStatus, newStatus)` if published FSM exists
- [ ] If no published FSM, allows current implicit behavior (no validation)
- [ ] `getLeadTransitions(companyId, currentStatus, userRoles)` delegates to fsmService.getAvailableActions or returns empty array as fallback
- [ ] All existing CRUD, convertLead, markLost, activateLead functions unchanged
**Related test cases:** TC-FSM-018

---

### TASK-026: Feature flag gating
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-015, TASK-021
**Files to modify:**
- `frontend/src/pages/LeadFormSettingsPage.tsx` — ensure Workflows tab visibility gated by `fsm_editor_enabled` flag
- `backend/src/routes/fsm.js` — check `fsm_publishing_enabled` flag on publish endpoint; check `fsm_editor_enabled` on editor endpoints
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] Workflows tab hidden when `fsm_editor_enabled` is false
- [ ] Publish endpoint returns 403 when `fsm_publishing_enabled` is false
- [ ] Editor read/write endpoints return 403 when `fsm_editor_enabled` is false
- [ ] Runtime endpoints (actions, apply, override) always available regardless of feature flags
- [ ] Feature flags read from company settings or environment config
**Related test cases:** SC-01 (feature flag precondition)

---

## Phase 5: Tests

---

### TASK-027: Unit tests — SCXML parser
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-004, TASK-005
**Files to modify:**
- `tests/services/fsmService.test.js` — NEW FILE: unit tests for parseSCXML and validateSCXML
**Files NOT to modify:**
- `backend/src/services/fsmService.js` — test only, do not modify
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] TC-FSM-001: valid SCXML produces correct graph (7 job states, all transitions, initialState, finalStates, metadata)
- [ ] TC-FSM-002: forbidden elements (`<script>`, `<invoke>`, `<send>`, `<onentry>`, `<onexit>`, `<parallel>`, `<history>`, `<datamodel>`) rejected
- [ ] TC-FSM-003: missing initial state produces error
- [ ] TC-FSM-004: blanc namespace attributes extracted correctly (label, statusName, action, confirm, confirmText, roles, order, icon)
- [ ] TC-FSM-020: unreachable states detected as warning
- [ ] TC-FSM-021: duplicate events in same state detected as warning
- [ ] TC-FSM-030: malformed XML returns parse error
- [ ] All tests pass with `npm test`
**Related test cases:** TC-FSM-001, TC-FSM-002, TC-FSM-003, TC-FSM-004, TC-FSM-020, TC-FSM-021, TC-FSM-030

---

### TASK-028: Integration tests — FSM API endpoints
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-012
**Files to modify:**
- `tests/routes/fsm.test.js` — NEW FILE: integration tests for all FSM API endpoints
**Files NOT to modify:**
- `backend/src/routes/fsm.js` — test only
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] TC-FSM-007: 401 without token, 403 without permission for each endpoint
- [ ] TC-FSM-008: company A cannot access company B's FSM data (machines, active, history, apply, override)
- [ ] TC-FSM-009: save draft, load draft, load active — draft does not affect active
- [ ] TC-FSM-010: publish draft — version incremented, active updated, old version archived
- [ ] TC-FSM-011: publish blocked when validation errors exist
- [ ] TC-FSM-012: version history returns in order
- [ ] TC-FSM-019: entity not found returns 404
- [ ] TC-FSM-027: version conflict returns 409
- [ ] TC-FSM-032: missing state query parameter returns 400
- [ ] All tests use proper test DB setup/teardown with company isolation
**Related test cases:** TC-FSM-007 through TC-FSM-019, TC-FSM-027, TC-FSM-032

---

### TASK-029: Unit tests — FSM runtime (transitions, fallback)
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-011
**Files to modify:**
- `tests/services/fsmService.test.js` — add test suites for resolveTransition and getAvailableActions (append to file from TASK-027)
**Files NOT to modify:**
- `backend/src/services/fsmService.js` — test only
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] TC-FSM-005: valid transition applied correctly (Submitted + TO_FOLLOW_UP -> Follow Up with Client)
- [ ] TC-FSM-006: invalid transition rejected (Canceled + TO_FOLLOW_UP -> invalid)
- [ ] TC-FSM-018: fallback to hardcoded constants when no published FSM exists
- [ ] TC-FSM-022: actions filtered by role (admin-only transition hidden from agent)
- [ ] TC-FSM-023: confirm dialog metadata returned in actions
- [ ] TC-FSM-031: fallback actions from hardcoded constants
- [ ] All tests pass with `npm test`
**Related test cases:** TC-FSM-005, TC-FSM-006, TC-FSM-018, TC-FSM-022, TC-FSM-023, TC-FSM-031

---

### TASK-030: Integration tests — ActionsBlock, WorkflowEditor
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-021, TASK-017
**Files to modify:**
- `tests/components/ActionsBlock.test.tsx` — NEW FILE: component tests for ActionsBlock
- `tests/components/WorkflowEditor.test.tsx` — NEW FILE: component tests for WorkflowEditor
**Files NOT to modify:**
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] ActionsBlock renders correct buttons for a given state and actions response
- [ ] ActionsBlock shows confirmation dialog for confirm transitions
- [ ] ActionsBlock hides override link when user lacks fsm.override role
- [ ] ActionsBlock renders empty when no actions available
- [ ] WorkflowEditor loads draft/active SCXML correctly
- [ ] WorkflowEditor toolbar buttons trigger correct API calls
- [ ] TC-FSM-013: apply endpoint integration — entity status updated
- [ ] TC-FSM-014: Zenbooker outbound sync fires on mapped statuses
- [ ] TC-FSM-015: override requires fsm.override role
- [ ] TC-FSM-016: successful override with audit log
- [ ] TC-FSM-017: missing reason rejected
- [ ] TC-FSM-025: target state not in SCXML rejected
- [ ] TC-FSM-026: override to current state rejected
**Related test cases:** TC-FSM-013 through TC-FSM-017, TC-FSM-025, TC-FSM-026

---

## Dependency Graph

```
TASK-001 (migration: tables) ─────────────────────┐
TASK-002 (migration: permissions)                  │
TASK-003 (install fast-xml-parser) ───► TASK-004   │
TASK-005 (seed SCXML files)                        │
TASK-006 (migration: seed data) ◄─── TASK-001     │
                                                   │
TASK-004 + TASK-006 ──► TASK-007 (service: reads)  │
TASK-007 ──► TASK-008 (service: writes)            │
TASK-007 + TASK-002 ──► TASK-009 (routes: read)    │
TASK-008 + TASK-009 ──► TASK-010 (routes: write)   │
TASK-008 ──► TASK-011 (runtime)                    │
TASK-009 + TASK-010 + TASK-011 ──► TASK-012 (mount)│
                                                   │
TASK-013 (install frontend deps)                   │
TASK-012 ──► TASK-014 (hooks)                      │
TASK-015 (tabs wrapper)                            │
TASK-014 ──► TASK-016 (MachineList)                │
TASK-013 + TASK-014 ──► TASK-017 (WorkflowEditor)  │
TASK-013 ──► TASK-018 (DiagramPreview)             │
TASK-017 ──► TASK-019 (ProblemsPanel)              │
TASK-014 ──► TASK-020 (VersionHistory + Publish)   │
                                                   │
TASK-014 ──► TASK-021 (ActionsBlock)               │
TASK-021 ──► TASK-022 (replace JobStatusTags)      │
TASK-021 ──► TASK-023 (override UI)                │
TASK-011 ──► TASK-024 (jobsService integration)    │
TASK-011 ──► TASK-025 (leadsService integration)   │
TASK-015 + TASK-021 ──► TASK-026 (feature flags)   │
                                                   │
TASK-004 + TASK-005 ──► TASK-027 (parser tests)    │
TASK-012 ──► TASK-028 (API tests)                  │
TASK-011 ──► TASK-029 (runtime tests)              │
TASK-021 + TASK-017 ──► TASK-030 (component tests) │
```

## Execution Order (recommended)

**Wave 1 (parallel):** TASK-001, TASK-002, TASK-003, TASK-005, TASK-013
**Wave 2:** TASK-004, TASK-006
**Wave 3:** TASK-007
**Wave 4:** TASK-008
**Wave 5 (parallel):** TASK-009, TASK-011, TASK-015
**Wave 6:** TASK-010
**Wave 7:** TASK-012, TASK-014
**Wave 8 (parallel):** TASK-016, TASK-017, TASK-018, TASK-020, TASK-021, TASK-027
**Wave 9 (parallel):** TASK-019, TASK-022, TASK-023, TASK-024, TASK-025, TASK-028, TASK-029
**Wave 10:** TASK-026, TASK-030

---
---

# IMG-001: Fullscreen Image Viewer — Task Breakdown

**Feature:** Shared fullscreen lightbox for image attachments
**Total tasks:** 2
**Phases:** 1

---

## Phase 1: Extract & Implement

---

### TASK-IMG-001: Extract FullscreenImageViewer + RotatableImage to shared component

**Phase:** 1
**Status:** done
**Dependencies:** none
**Files to modify:**
- `frontend/src/components/shared/FullscreenImageViewer.tsx` — **NEW**: Create shared component with `FullscreenImageViewer` and `RotatableImage` exports
- `frontend/src/components/payments/PaymentDetailPanel.tsx` — Remove inline `FullscreenViewer` and `RotatableImage`, import from shared

**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)

**Acceptance criteria:**
- [ ] `FullscreenImageViewer` exported from shared with generic `{url, filename}[]` interface
- [ ] `RotatableImage` exported from shared (used by both inline preview and fullscreen)
- [ ] `PaymentDetailPanel` imports from shared, no inline FullscreenViewer/RotatableImage
- [ ] Fullscreen opens on image click, closes on Escape/backdrop/X
- [ ] Arrow key navigation works, rotation resets on navigate
- [ ] Thumbnail strip at bottom, body scroll locked
- [ ] TypeScript compiles without errors

---

### TASK-IMG-002: Write tests for FullscreenImageViewer

**Phase:** 1
**Status:** skipped (no frontend test infrastructure — Jest not configured for TSX/JSdom)
**Dependencies:** TASK-IMG-001
**Files to modify:**
- `frontend/src/components/shared/__tests__/FullscreenImageViewer.test.tsx` — **NEW**: Jest + RTL tests

**Files NOT to modify:**
- All production code (only tests)

**Acceptance criteria:**
- [ ] Tests cover: open/close, keyboard navigation, rotation reset, body scroll lock, non-image skip
- [ ] All tests pass with `npm test`
- [ ] Test-cases from `Docs/test-cases/IMG-001-fullscreen-image-viewer.md` covered

---

## Execution Order

**Wave 1:** TASK-IMG-001
**Wave 2:** TASK-IMG-002

---

# SCHED-LIST-001: Schedule List View — Tasks

**Feature:** New "List" view mode for Schedule page
**Total tasks:** 4
**Phases:** 2

---

## Phase 1: Plumbing (ViewMode + wiring)

### TASK-LIST-001: Add 'list' to ViewMode and useScheduleData
**Phase:** 1
**Status:** done
**Dependencies:** none
**Files to modify:**
- `frontend/src/hooks/useScheduleData.ts` — Add `'list'` to ViewMode union, dateRange switch (week range), navigateDate (week-like)
**Acceptance criteria:**
- [ ] `ViewMode` type includes `'list'`
- [ ] `dateRange` returns week range for `'list'`
- [ ] `navigateDate` uses week navigation for `'list'`

---

### TASK-LIST-002: Add 'List' to CalendarControls VIEW_OPTIONS
**Phase:** 1
**Status:** done
**Dependencies:** none
**Files to modify:**
- `frontend/src/components/schedule/CalendarControls.tsx` — Add `{ value: 'list', label: 'List' }` to VIEW_OPTIONS, add 'list' to getDateLabel
**Acceptance criteria:**
- [ ] VIEW_OPTIONS includes `{ value: 'list', label: 'List' }`
- [ ] Date label shows week range for 'list' mode

---

## Phase 2: ListView component + wiring

### TASK-LIST-003: Create ListView component
**Phase:** 2
**Status:** done
**Dependencies:** TASK-LIST-001
**Files to modify:**
- `frontend/src/components/schedule/ListView.tsx` — NEW: Provider columns, day grouping with DateSeparator, ScheduleItemCard rendering, DnD support
**Acceptance criteria:**
- [ ] Provider columns rendered (sorted alphabetically, Unassigned last)
- [ ] Items grouped by day with DateSeparator-style headings
- [ ] Empty days not rendered
- [ ] Items sorted by start_at within each day
- [ ] ScheduleItemCard used with compact={false} (time slot visible)
- [ ] Click triggers onSelectItem
- [ ] DnD reassign between columns works
- [ ] Horizontal scroll when columns overflow

---

### TASK-LIST-004: Wire ListView into SchedulePage
**Phase:** 2
**Status:** done
**Dependencies:** TASK-LIST-003
**Files to modify:**
- `frontend/src/pages/SchedulePage.tsx` — Import ListView, add case 'list' to renderCalendarView switch
**Acceptance criteria:**
- [ ] SchedulePage renders ListView when viewMode === 'list'
- [ ] All props passed correctly (currentDate, items, settings, providers, onSelectItem, onReassign, onCreateFromSlot)

---

## Execution Order

**Wave 1:** TASK-LIST-001, TASK-LIST-002 (parallel)
**Wave 2:** TASK-LIST-003
**Wave 3:** TASK-LIST-004

---

# EMAIL-001: Gmail Shared Mailbox + Email Workspace — Task Breakdown

**Feature:** One shared Gmail mailbox per company + separate `/email` operator workspace
**Migration range:** 079
**Total tasks:** 12
**Phases:** 5

---

## Phase 1: Persistence + OAuth Foundation

### TASK-EMAIL-001: Migration — email mailbox, thread, message, attachment, and sync tables
**Phase:** 1
**Status:** done
**Dependencies:** none
**Files to modify:**
- `backend/db/migrations/079_create_email_tables.sql` — **NEW**: create `email_mailboxes`, `email_threads`, `email_messages`, `email_attachments`, `email_sync_state` with indexes and constraints from architecture spec
**Files NOT to modify:**
- `src/server.js` (protected)
- existing migrations `072`–`078`
**Acceptance criteria:**
- [ ] `email_mailboxes` created with UNIQUE (`company_id`, `provider`) and encrypted token columns
- [ ] `email_threads` created with UNIQUE (`company_id`, `provider_thread_id`)
- [ ] `email_messages` created with UNIQUE (`company_id`, `provider_message_id`)
- [ ] `email_attachments` linked to `email_messages` with cascading delete
- [ ] `email_sync_state` created with one row per mailbox
- [ ] All new tables include `company_id` for tenant isolation
- [ ] Required indexes for thread list sort/filter and provider id lookups created
- [ ] Migration runs on a fresh DB without breaking existing tables
**Related test cases:** TC-EMAIL-001, TC-EMAIL-004, TC-EMAIL-005, TC-EMAIL-010, TC-EMAIL-014

---

### TASK-EMAIL-002: Query layer + mailbox credential storage
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-EMAIL-001
**Files to modify:**
- `backend/src/db/emailQueries.js` — **NEW**: mailbox CRUD, thread list/detail queries, idempotent upserts, sync-state helpers
- `backend/src/services/emailMailboxService.js` — **NEW**: token encryption/decryption, mailbox status updates, OAuth state signing/validation helpers
- `package.json` — add `googleapis`
**Files NOT to modify:**
- `backend/src/db/queries.js` — keep existing cross-domain facade intact unless a thin export is strictly necessary
- `frontend/package.json`
**Acceptance criteria:**
- [ ] `emailQueries` exposes canonical methods for mailbox lookup, thread list/detail, mark read, upsert thread/message/attachment, sync state, and due-mailbox selection
- [ ] Gmail tokens are encrypted at rest via `EMAIL_TOKEN_ENCRYPTION_KEY`
- [ ] Mailbox service never returns raw access/refresh tokens to route handlers or frontend payloads
- [ ] Package install succeeds with new Gmail dependency
**Related test cases:** TC-EMAIL-001, TC-EMAIL-003, TC-EMAIL-005, TC-EMAIL-012

---

### TASK-EMAIL-003: Settings routes + OAuth callback
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-EMAIL-002
**Files to modify:**
- `backend/src/routes/email-settings.js` — **NEW**: `GET /`, `POST /google/start`, `POST /disconnect`, `POST /sync`
- `backend/src/routes/email-oauth.js` — **NEW**: `GET /google/callback`
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `frontend/src/auth/ProtectedRoute.tsx`
**Acceptance criteria:**
- [ ] Settings routes require `tenant.integrations.manage`
- [ ] Callback route validates signed OAuth state and redirects back to `/settings/email`
- [ ] Disconnect marks mailbox `disconnected` without deleting synced local history
- [ ] Manual sync endpoint returns current sync status and does not leak credential data
**Related test cases:** TC-EMAIL-001, TC-EMAIL-002, TC-EMAIL-003, TC-EMAIL-013

---

## Phase 2: Gmail Sync + Message Domain

### TASK-EMAIL-004: Email sync service — bounded backfill and incremental history sync
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-EMAIL-002
**Files to modify:**
- `backend/src/services/emailSyncService.js` — **NEW**: `syncMailbox`, `runInitialBackfill`, `syncIncrementalHistory`, `startScheduler`
**Files NOT to modify:**
- `backend/src/services/inboxWorker.js` — keep Twilio worker isolated
- `backend/src/services/conversationsService.js` — keep SMS provider logic isolated
**Acceptance criteria:**
- [ ] Initial sync imports a bounded recent window (`EMAIL_SYNC_LOOKBACK_DAYS`)
- [ ] Incremental sync uses stored Gmail history checkpoint
- [ ] Duplicate provider payloads are handled idempotently
- [ ] Invalid/missing Gmail history checkpoint falls back to bounded backfill path
- [ ] Mailbox sync status/timestamps updated on success and failure
**Related test cases:** TC-EMAIL-004, TC-EMAIL-005, TC-EMAIL-013, TC-EMAIL-014

---

### TASK-EMAIL-005: Email service — send, reply, hydrate sent message, attachment proxy
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-EMAIL-002
**Files to modify:**
- `backend/src/services/emailService.js` — **NEW**: Gmail client factory, raw MIME send/reply, sent-message hydration, attachment streaming/download
**Files NOT to modify:**
- `backend/src/services/storageService.js` — do not introduce S3 persistence unless Gmail proxying proves insufficient
- `backend/src/services/textPolishService.js`
**Acceptance criteria:**
- [ ] New email send supports To, CC, subject, body, and attachments
- [ ] Reply uses existing Gmail thread context instead of creating a new thread
- [ ] Backend fetches the canonical sent Gmail message after send and upserts local records
- [ ] Attachment download streams through backend and enforces tenant scope
- [ ] Compose/reply reject when mailbox is `reconnect_required` or `disconnected`
**Related test cases:** TC-EMAIL-008, TC-EMAIL-009, TC-EMAIL-010, TC-EMAIL-011

---

## Phase 3: Backend API + App Wiring

### TASK-EMAIL-006: Email workspace routes
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-EMAIL-004, TASK-EMAIL-005
**Files to modify:**
- `backend/src/routes/email.js` — **NEW**: `GET /mailbox`, `GET /threads`, `GET /threads/:id`, `POST /threads/:id/read`, `POST /threads/compose`, `POST /threads/:id/reply`, `GET /attachments/:attachmentId/download`
**Files NOT to modify:**
- `backend/src/routes/messaging.js` — keep SMS routes unchanged
- `backend/src/routes/pulse.js` — keep Pulse timeline contract unchanged
**Acceptance criteria:**
- [ ] Read routes require `messages.view_internal`
- [ ] `GET /api/email/mailbox` returns non-secret mailbox state for `/email`
- [ ] Compose/reply routes require `messages.send`
- [ ] Thread list supports server-driven `view`, `q`, `cursor`, `limit`
- [ ] Thread detail returns messages + attachments in chronological order
- [ ] Mark-read endpoint is idempotent and tenant-safe
**Related test cases:** TC-EMAIL-006, TC-EMAIL-007, TC-EMAIL-008, TC-EMAIL-009, TC-EMAIL-010, TC-EMAIL-012, TC-EMAIL-028

---

### TASK-EMAIL-007: Mount routes and start sync scheduler
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-EMAIL-003, TASK-EMAIL-004, TASK-EMAIL-006
**Files to modify:**
- `src/server.js` — mount `/api/settings/email`, `/api/email`, `/api/email/oauth`; start email sync scheduler
**Files NOT to modify:**
- existing route protection order for unrelated modules
- `frontend/src/hooks/useRealtimeEvents.ts` (protected)
**Acceptance criteria:**
- [ ] Public OAuth callback route is mounted before SPA/static fallbacks
- [ ] Tenant-scoped email/settings routes are mounted with existing auth middleware
- [ ] Scheduler starts once per backend process and does not block server boot
- [ ] Existing `/api/messaging` and `/api/pulse` behavior is preserved
**Related test cases:** TC-EMAIL-002, TC-EMAIL-013, TC-EMAIL-015

---

## Phase 4: Frontend Settings + Email Workspace

### TASK-EMAIL-008: Email settings page + typed API wrapper
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-EMAIL-003, TASK-EMAIL-007
**Files to modify:**
- `frontend/src/services/emailApi.ts` — **NEW**: typed settings/workspace calls
- `frontend/src/pages/EmailSettingsPage.tsx` — **NEW**: mailbox status, connect/reconnect/disconnect, manual sync
- `frontend/src/App.tsx` — add `/settings/email`
- `frontend/src/components/layout/appLayoutNavigation.tsx` — add Settings menu entry
**Files NOT to modify:**
- top navigation tabs in `AppNavTabs`
- `frontend/src/services/messagingApi.ts`
**Acceptance criteria:**
- [ ] `/settings/email` is protected by `tenant.integrations.manage`
- [ ] Settings dropdown contains `Email`
- [ ] Top navigation tabs remain unchanged
- [ ] Connect action redirects browser to backend-provided Google auth URL
- [ ] Reconnect/disconnect/sync states are visible and user-readable
**Related test cases:** TC-EMAIL-016, TC-EMAIL-024, TC-EMAIL-025, TC-EMAIL-026

---

### TASK-EMAIL-009: Email workspace shell + thread list
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-EMAIL-006, TASK-EMAIL-008
**Files to modify:**
- `frontend/src/pages/EmailPage.tsx` — **NEW**
- `frontend/src/components/email/MailboxRail.tsx` — **NEW**
- `frontend/src/components/email/EmailThreadList.tsx` — **NEW**
- `frontend/src/components/email/EmailThreadRow.tsx` — **NEW**
- `frontend/src/App.tsx` — add `/email`
**Files NOT to modify:**
- `frontend/src/pages/MessagesPage.tsx`
- `frontend/src/pages/PulsePage.tsx`
**Acceptance criteria:**
- [ ] `/email` is protected by `messages.view_internal`
- [ ] `/email` loads mailbox state from a reader-safe workspace endpoint, not the admin settings endpoint
- [ ] No-mailbox state renders CTA to `/settings/email`
- [ ] Left rail supports system views (`Inbox`, `All`, `Sent`, `Unread`, `With attachments`)
- [ ] Thread list uses server-driven search/filter queries
- [ ] Thread row shows sender, subject, preview, time, unread, attachment state
**Related test cases:** TC-EMAIL-017, TC-EMAIL-018, TC-EMAIL-019, TC-EMAIL-023, TC-EMAIL-026, TC-EMAIL-028

---

### TASK-EMAIL-010: Thread pane + compose/reply + attachment UI
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-EMAIL-005, TASK-EMAIL-009
**Files to modify:**
- `frontend/src/components/email/EmailThreadPane.tsx` — **NEW**
- `frontend/src/components/email/EmailMessageItem.tsx` — **NEW**
- `frontend/src/components/email/EmailComposer.tsx` — **NEW**
**Files NOT to modify:**
- `frontend/src/components/pulse/SmsForm.tsx`
- `frontend/src/components/messaging/MessageThread.tsx`
**Acceptance criteria:**
- [ ] Selecting a thread loads detail on demand
- [ ] Opening unread thread triggers mark-read mutation
- [ ] Composer supports new email + reply modes
- [ ] Validation requires To + Subject + (body or attachment) for compose
- [ ] Reply stays in current thread after success
- [ ] Previewable image attachments can reuse existing fullscreen image viewer
**Related test cases:** TC-EMAIL-020, TC-EMAIL-021, TC-EMAIL-022, TC-EMAIL-024, TC-EMAIL-027

---

## Phase 5: Verification

### TASK-EMAIL-011: Backend automated tests
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-EMAIL-004, TASK-EMAIL-005, TASK-EMAIL-006, TASK-EMAIL-007
**Files to modify:**
- `tests/routes/email.test.js` — **NEW**
- `tests/services/emailMailboxService.test.js` — **NEW**
- `tests/services/emailSyncService.test.js` — **NEW**
**Files NOT to modify:**
- unrelated Twilio tests
**Acceptance criteria:**
- [ ] Route tests cover auth/permission guards, tenant isolation, list/detail/read, compose/reply, attachment download
- [ ] Service tests cover token encryption, OAuth callback persistence, initial backfill, incremental sync idempotency, history-gap fallback
- [ ] Jest suite passes with new email tests included
**Related test cases:** TC-EMAIL-001 through TC-EMAIL-015

---

### TASK-EMAIL-012: Frontend verification and regression checklist
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-EMAIL-008, TASK-EMAIL-009, TASK-EMAIL-010
**Files to modify:**
- `docs/test-cases/EMAIL-001-gmail-shared-mailbox-workspace.md` — keep manual/visual verification aligned with implemented UI
**Files NOT to modify:**
- unrelated page specs
**Acceptance criteria:**
- [ ] QA pass covers route protection, no-mailbox state, thread selection, mark-read, compose, reply, search, attachment open/download, reconnect-required state
- [ ] Regression pass confirms top nav unchanged and existing `MessagesPage`/`PulsePage` flows still work
- [ ] Any missing frontend automation gaps are explicitly documented
**Related test cases:** TC-EMAIL-016 through TC-EMAIL-027

---

## Execution Order

**Wave 1:** TASK-EMAIL-001
**Wave 2:** TASK-EMAIL-002, TASK-EMAIL-003 (serial preferred if OAuth state helpers live in mailbox service)
**Wave 3:** TASK-EMAIL-004, TASK-EMAIL-005 (parallel)
**Wave 4:** TASK-EMAIL-006
**Wave 5:** TASK-EMAIL-007
**Wave 6:** TASK-EMAIL-008, TASK-EMAIL-009 (parallel once routes exist)
**Wave 7:** TASK-EMAIL-010
**Wave 8:** TASK-EMAIL-011, TASK-EMAIL-012

---

# PF007-HARDENING-001: Provider Scope, Tenant Isolation & RBAC Hardening — Task Breakdown

**Feature:** Enforce provider-assigned-only visibility, close tenant isolation gaps, and make backend/frontend RBAC deny-by-default
**Migration range:** 080
**Total tasks:** 17
**Phases:** 5

---

## Phase 1: Ownership Foundation

### TASK-RBAC-001: Migration — provider bridge and internal assignee mirrors
**Phase:** 1
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/db/migrations/080_pf007_provider_scope_hardening.sql` — **NEW**: add provider bridge field on `company_user_profiles`, add internal assignee mirror on `jobs`, create indexes/backfill
**Files NOT to modify:**
- `src/server.js` (protected)
- existing migrations `001`–`079`
**Acceptance criteria:**
- [ ] `company_user_profiles` has nullable `zenbooker_team_member_id` used only as an integration bridge
- [ ] `jobs` has `assigned_provider_user_ids JSONB NOT NULL DEFAULT '[]'`
- [ ] Required indexes exist for company-scoped provider visibility queries
- [ ] Migration is idempotent and runs on a fresh DB without breaking existing PF007 tables
- [ ] Internal ownership remains authoritative via `crm_users.id`; external provider ids do not become an auth source

---

### TASK-RBAC-002: Team Management API — expose provider bridge in user profile
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-RBAC-001
**Files to modify:**
- `backend/src/routes/users.js` — expose provider bridge field in user read/update flows
- `backend/src/services/userService.js` — persist and validate `profile.zenbooker_team_member_id`
- `backend/src/db/membershipQueries.js` — load/store profile mapping tenant-safely
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/CompanyUsersPage.tsx` — frontend wiring comes later
**Acceptance criteria:**
- [ ] `GET /api/users/:id` returns membership profile including `zenbooker_team_member_id`
- [ ] `PATCH /api/users/:id` accepts and persists `profile.zenbooker_team_member_id`
- [ ] Updates stay tenant-scoped and cross-company user ids return `404`
- [ ] Audit payload records mapping changes

---

### TASK-RBAC-003: Job sync — map external provider assignments to internal CRM users
**Phase:** 1
**Status:** pending
**Dependencies:** TASK-RBAC-001, TASK-RBAC-002
**Files to modify:**
- `backend/src/services/jobsService.js` — populate `assigned_provider_user_ids` during upsert/sync
- `backend/src/services/jobSyncService.js` — keep internal assignee mirror updated on assignment events
- `backend/src/db/membershipQueries.js` — resolve company-scoped provider bridge lookups
**Files NOT to modify:**
- `backend/src/routes/jobs.js` — visibility enforcement comes later
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] Job sync resolves external provider ids to internal `crm_users.id` within the same company
- [ ] `jobs.assigned_provider_user_ids` is updated whenever Zenbooker assignment changes
- [ ] Unmapped external provider ids do not grant visibility to any CRM user
- [ ] Re-syncs remain idempotent and company-scoped

---

## Phase 2: Provider Scope and Tenant Isolation

### TASK-RBAC-004: Jobs API — enforce `assigned_only` provider visibility
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-RBAC-003
**Files to modify:**
- `backend/src/routes/jobs.js` — enforce visibility checks on list/detail/history/notes surfaces
- `backend/src/services/jobsService.js` — apply `req.authz.scopes.job_visibility` and current `crm_users.id`
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/JobsPage.tsx` — frontend gating comes later
**Acceptance criteria:**
- [ ] When `job_visibility = assigned_only`, list queries return only jobs whose `assigned_provider_user_ids` include the current `crm_users.id`
- [ ] `GET /api/jobs/:id`, `/history`, and `/notes` apply the same visibility rule
- [ ] Non-visible jobs return `404`, not `403`
- [ ] All jobs queries continue filtering by `company_id`
- [ ] Roles with `job_visibility = all` keep current tenant-wide behavior

---

### TASK-RBAC-005: Schedule read model — provider sees only own work
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-RBAC-003
**Files to modify:**
- `backend/src/db/scheduleQueries.js` — filter `job` and `task` rows by current assignee for provider scope
- `backend/src/services/scheduleService.js` — apply authz-aware filters for list/detail/mutations
- `backend/src/routes/schedule.js` — enforce read vs dispatch capability boundaries
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/SchedulePage.tsx` — frontend gating comes later
**Acceptance criteria:**
- [ ] Providers with `assigned_only` receive only their own `job` items and their own assigned `task` items
- [ ] Provider schedule responses do not include `lead` items
- [ ] Schedule item detail enforces the same scope and returns `404` for non-visible entities
- [ ] Dispatch mutations and settings remain unavailable without dispatch-capable permissions
- [ ] Tenant context is taken only from `req.companyFilter?.company_id`

---

### TASK-RBAC-006: Contacts API — tenant-safe queries and provider client scope
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-RBAC-004
**Files to modify:**
- `backend/src/routes/contacts.js` — require tenant-safe list/detail/update flows
- `backend/src/services/contactsService.js` — add company-scoped and provider-scoped contact queries
- `backend/src/db/contactsQueries.js` — remove cross-tenant phone lookups
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/ContactsPage.tsx` — frontend changes come later
**Acceptance criteria:**
- [ ] `GET /api/contacts` filters by `company_id`
- [ ] Provider contact list/detail includes only contacts linked to currently visible assigned jobs
- [ ] Phone lookup helpers no longer search globally across tenants
- [ ] `GET/PATCH /api/contacts/:id` return `404` for foreign-company or non-visible contacts
- [ ] Related lead queries remain company-scoped

---

### TASK-RBAC-007: Pulse timeline access — own clients only
**Phase:** 2
**Status:** pending
**Dependencies:** TASK-RBAC-004, TASK-RBAC-006
**Files to modify:**
- `backend/src/routes/pulse.js` — enforce tenant-safe timeline/contact lookup and provider client scope
- `backend/src/db/queries.js` — add tenant-safe timeline/contact helpers as needed
- `backend/src/db/conversationsQueries.js` — ensure conversation/message lookups respect tenant context
**Files NOT to modify:**
- `src/server.js` (protected)
- `frontend/src/pages/PulsePage.tsx` — frontend gating comes later
**Acceptance criteria:**
- [ ] `/api/pulse/timeline/:contactId` and `/timeline-by-id/:timelineId` only resolve entities inside the current tenant
- [ ] Providers can open Pulse only for contacts reachable from their visible assigned jobs
- [ ] SMS conversation lookup cannot pull another tenant's data by phone match
- [ ] Financial events are omitted unless the user has `financial_data.view`
- [ ] Foreign-company or non-visible contact/timeline ids return `404`

---

## Phase 3: Backend RBAC Hardening

### TASK-RBAC-008: Route permissions — Jobs and Schedule
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-RBAC-004, TASK-RBAC-005
**Files to modify:**
- `backend/src/routes/jobs.js` — add granular permission guards per read/write action
- `backend/src/routes/schedule.js` — separate `schedule.view` from `schedule.dispatch`
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/middleware/authorization.js` — reuse existing middleware, do not redesign it here
**Acceptance criteria:**
- [ ] Jobs read routes require `jobs.view`
- [ ] Jobs mutations require the matching permissions (`jobs.edit`, `jobs.assign`, `jobs.close`, `jobs.done_pending_approval`) by action
- [ ] Schedule read routes require `schedule.view`
- [ ] Schedule dispatch/settings/mutation routes require `schedule.dispatch`
- [ ] Hidden UI is no longer a security boundary for jobs/schedule APIs

---

### TASK-RBAC-009: Route permissions — Contacts and Pulse
**Phase:** 3
**Status:** pending
**Dependencies:** TASK-RBAC-006, TASK-RBAC-007
**Files to modify:**
- `backend/src/routes/contacts.js` — require `contacts.view` / `contacts.edit`
- `backend/src/routes/pulse.js` — require `pulse.view`
**Files NOT to modify:**
- `src/server.js` (protected)
- `backend/src/middleware/keycloakAuth.js` — no auth-model redesign in this task
**Acceptance criteria:**
- [ ] Contact read routes require `contacts.view`
- [ ] Contact update routes require `contacts.edit`
- [ ] Pulse timeline routes require `pulse.view`
- [ ] Permission denial returns `403` before data access; entity non-visibility still returns `404`

---

### TASK-RBAC-010: Finance routes — tenant context fix and granular permission checks
**Phase:** 3
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/src/routes/estimates.js` — replace `req.companyId` and add per-action permission guards
- `backend/src/routes/invoices.js` — replace `req.companyId` and add per-action permission guards
- `backend/src/routes/payments.js` — replace `req.companyId` and add per-action permission guards
**Files NOT to modify:**
- `src/server.js` (protected)
- DB query files for finance modules — keep this task focused on route/context hardening
**Acceptance criteria:**
- [ ] All finance routes use `req.companyFilter?.company_id` and never read `req.companyId`
- [ ] Read/create/send/collect/refund routes require the matching permission keys
- [ ] Users without finance permissions cannot read totals or invoke payment collection endpoints
- [ ] Entity-by-id routes stay tenant-scoped and return `404` for foreign ids
- [ ] No route falls back to global or undefined company context

---

### TASK-RBAC-011: FSM backend — server-side action filtering and apply authorization
**Phase:** 3
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/src/routes/fsm.js` — stop trusting client-supplied `roles`, enforce server authz on `/actions` and `/apply`
**Files NOT to modify:**
- `backend/src/services/fsmService.js` — reuse existing graph helpers and contracts
- `src/server.js` (protected)
**Acceptance criteria:**
- [ ] `/api/fsm/:machineKey/actions` filters actions using `req.authz`, not query-string role hints
- [ ] `/api/fsm/:machineKey/apply` enforces permission checks before mutating entity state
- [ ] Platform-only `super_admin` cannot access tenant FSM routes
- [ ] Fallback behavior when no published graph exists does not widen permissions

---

### TASK-RBAC-012: Tenant access middleware cleanup — remove remaining platform bypass assumptions
**Phase:** 3
**Status:** pending
**Dependencies:** none
**Files to modify:**
- `backend/src/middleware/keycloakAuth.js` — stop leaking legacy `is_super_admin` assumptions into tenant access
- `backend/src/middleware/authorization.js` — keep tenant/platform denial behavior consistent
- `backend/src/services/authorizationService.js` — keep compatibility mapping without bypassing tenant RBAC
**Files NOT to modify:**
- `src/server.js` (protected)
- frontend auth files — frontend alignment comes later
**Acceptance criteria:**
- [ ] Tenant access is derived from `req.authz`, not from ad-hoc `req.user.is_super_admin` checks
- [ ] Platform-only users consistently receive tenant denial on tenant routes
- [ ] Legacy `company_admin/company_member` mapping remains compatibility-only and does not create new bypass paths
- [ ] Access-denied audit context includes platform role and target route for tenant denials

---

## Phase 4: Frontend Capability Gating

### TASK-RBAC-013: Navigation and route alignment by permissions
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-RBAC-008, TASK-RBAC-009, TASK-RBAC-012
**Files to modify:**
- `frontend/src/components/layout/appLayoutNavigation.tsx` — build top nav and settings menu from effective permissions
- `frontend/src/App.tsx` — align route guards with canonical permission keys
- `frontend/src/auth/ProtectedRoute.tsx` — remove blanket tenant bypass for legacy `super_admin`
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `frontend/src/auth/AuthProvider.tsx` — no auth-context contract change in this task
**Acceptance criteria:**
- [ ] Navigation only shows workspaces and settings backed by current permissions
- [ ] `/schedule` is guarded by `schedule.view`, not `jobs.view`
- [ ] ProtectedRoute does not grant tenant access only because the token contains legacy `super_admin`
- [ ] Platform-only routes remain available only to platform super admin
- [ ] Direct navigation to hidden pages is blocked by route guards

---

### TASK-RBAC-014: Jobs UI — stop loading forbidden finance and admin data
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-RBAC-008, TASK-RBAC-010, TASK-RBAC-013
**Files to modify:**
- `frontend/src/hooks/useJobsData.ts` — gate tag/settings preloads by permission
- `frontend/src/components/jobs/JobDetailPanel.tsx` — hide finance surface when not allowed
- `frontend/src/hooks/useJobFinancials.ts` — skip finance fetches without finance visibility
**Files NOT to modify:**
- `frontend/src/lib/authedFetch.ts` (protected)
- `frontend/src/pages/JobsPage.tsx` — keep page composition stable in this task
**Acceptance criteria:**
- [ ] Job tags and list-field settings are not fetched for users lacking the required management permissions
- [ ] Finance tab/section renders only when the user has finance visibility
- [ ] Financial hooks do not call estimates/invoices endpoints for unauthorized users
- [ ] Provider job detail shows only actions allowed by effective permissions

---

### TASK-RBAC-015: Schedule UI — provider-safe loading and controls
**Phase:** 4
**Status:** pending
**Dependencies:** TASK-RBAC-005, TASK-RBAC-013
**Files to modify:**
- `frontend/src/hooks/useScheduleData.ts` — gate provider roster and dispatch settings fetches by permission
- `frontend/src/pages/SchedulePage.tsx` — hide dispatch-only actions for provider users
- `frontend/src/components/schedule/CalendarControls.tsx` — hide or disable dispatch-only controls
**Files NOT to modify:**
- `frontend/src/hooks/useRealtimeEvents.ts` (protected)
- `frontend/src/lib/authedFetch.ts` (protected)
**Acceptance criteria:**
- [ ] Provider users load only the schedule data returned by the scoped backend API
- [ ] Dispatch settings and full provider roster are not fetched without `schedule.dispatch`
- [ ] Reassign, create-from-slot, and other dispatch-only controls are hidden or disabled for provider users
- [ ] Dispatcher and tenant-admin workflows keep current functionality

---

## Phase 5: Verification

### TASK-RBAC-016: Backend automated tests — provider scope and tenant isolation
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-RBAC-004, TASK-RBAC-005, TASK-RBAC-006, TASK-RBAC-007, TASK-RBAC-008, TASK-RBAC-009
**Files to modify:**
- `tests/jobsProviderScope.test.js` — **NEW**
- `tests/scheduleProviderScope.test.js` — **NEW**
- `tests/contactsPulseTenantIsolation.test.js` — **NEW**
**Files NOT to modify:**
- unrelated Twilio and email tests
**Acceptance criteria:**
- [ ] Tests cover provider assigned-only jobs list/detail/history behavior
- [ ] Tests cover provider schedule visibility, no-leads behavior, and forbidden dispatch mutations
- [ ] Tests cover contacts/pulse own-client-only visibility and `404` for foreign or non-visible ids
- [ ] Tests explicitly verify `company_id` tenant isolation across companies
- [ ] Jest suite passes with the new RBAC hardening tests included

---

### TASK-RBAC-017: Regression verification — finance, FSM, and frontend gating
**Phase:** 5
**Status:** pending
**Dependencies:** TASK-RBAC-010, TASK-RBAC-011, TASK-RBAC-013, TASK-RBAC-014, TASK-RBAC-015
**Files to modify:**
- `tests/paymentsRoute.test.js` — extend for tenant context and finance permission denials
- `tests/routes/fsm.test.js` — extend for server-side action filtering and unauthorized apply
- `docs/test-cases/PF007-rbac-hardening.md` — **NEW**: manual verification checklist for nav hiding and forbidden preloads
**Files NOT to modify:**
- unrelated schedule layout and telephony tests
**Acceptance criteria:**
- [ ] Finance route tests cover `req.companyFilter?.company_id` usage and permission denials
- [ ] FSM tests cover server-side action filtering and unauthorized transition rejection
- [ ] Manual checklist covers nav hiding, forbidden prefetch prevention, and provider access only to own client timelines
- [ ] Remaining rollout risks and any uncovered automation gaps are explicitly documented

---

## Execution Order

**Wave 1:** TASK-RBAC-001
**Wave 2:** TASK-RBAC-002, TASK-RBAC-003 (serial preferred because sync depends on the new profile mapping)
**Wave 3:** TASK-RBAC-004, TASK-RBAC-005 (parallel once internal assignee mirror exists)
**Wave 4:** TASK-RBAC-006, TASK-RBAC-007
**Wave 5:** TASK-RBAC-008, TASK-RBAC-009, TASK-RBAC-010, TASK-RBAC-011, TASK-RBAC-012
**Wave 6:** TASK-RBAC-013
**Wave 7:** TASK-RBAC-014, TASK-RBAC-015 (parallel once route guards are stable)
**Wave 8:** TASK-RBAC-016, TASK-RBAC-017
