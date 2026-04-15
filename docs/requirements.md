# Blanc Contact Center — Requirements

> Formalized feature requirements for the system.

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
