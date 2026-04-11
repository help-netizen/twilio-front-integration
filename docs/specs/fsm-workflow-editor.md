# Specification: FSM-001 -- FSM/SCXML Workflow Editor

**Status:** Spec
**Feature:** Database-driven FSM replacing hardcoded status constants
**Priority:** High
**Owner:** FSM/Platform
**Feature flags:** `fsm_editor_enabled`, `fsm_publishing_enabled`
**Architecture ref:** `Docs/architecture.md` section FSM-001
**Requirements ref:** `Docs/requirements.md` section FSM-001

---

## 1. Overview

Replace hardcoded status lists (`BLANC_STATUSES`, `ALLOWED_TRANSITIONS` in `jobsService.js`) and lead status constants with a database-driven FSM model defined in SCXML. Provide an admin UI (embedded in LeadFormSettingsPage as a tab) for editing, validating, versioning, and publishing workflow definitions. Entity cards derive their action buttons from the published SCXML transitions at runtime.

---

## 2. Detailed Behavior Scenarios

### 2.1 SC-01: View and Edit a Workflow Definition

**Actor:** Admin with `fsm.editor` role
**Precondition:** Feature flag `fsm_editor_enabled` is `true`. User navigates to `/settings/lead-form` and selects the "Workflows" tab.

**Happy Path:**
1. Frontend renders `LeadFormSettingsPage` with Shadcn `Tabs`. The "Workflows" tab is visible only when `fsm_editor_enabled` is `true`.
2. `<MachineList />` mounts inside the Workflows tab. It calls `GET /api/fsm/machines` via `authedFetch`.
3. Backend returns list of machines (Job, Lead) with `active_version` info and `has_draft` boolean.
4. User clicks "Open Editor" on the Job machine row.
5. `<WorkflowEditor machineKey="job" />` mounts with split-view layout.
6. The editor hook (`useFsmEditor`) calls `GET /api/fsm/job/draft` first. If a draft exists, Monaco loads the draft SCXML. If no draft (404/null), it falls back to `GET /api/fsm/job/active` and loads the published SCXML.
7. Monaco editor renders the SCXML with XML syntax highlighting, line numbers, minimap enabled.
8. `<DiagramPreview />` parses the SCXML client-side via `state-machine-cat` and renders an SVG.
9. User modifies SCXML (e.g., adds a new `<state>`, changes a `<transition target>`).
10. After 300ms debounce (no further keystrokes), `<DiagramPreview />` re-parses and re-renders the SVG.
11. If the SCXML is well-formed, the diagram updates smoothly and any previous error overlay is cleared.
12. Toolbar status pill updates to "Draft has changes" (comparing current editor content to last saved draft).

**Error Cases:**
- **Malformed XML during editing:** After debounce, `state-machine-cat` parse fails. `<DiagramPreview />` shows an error overlay ("Can't render diagram" + short error message + "See Problems" link). The `<ProblemsPanel />` populates with the parse error (line/column if available). The editor remains fully functional -- the user can continue typing.
- **Network error loading machine list:** `GET /api/fsm/machines` fails. Toast: "Failed to load workflows". The tab shows an empty state with a retry button.
- **Network error loading SCXML:** `GET /api/fsm/job/draft` or `/active` fails. Toast: "Failed to load workflow". Editor shows empty state with retry.
- **Permission denied:** User without `fsm.editor` role tries to access the Workflows tab. The tab is hidden by frontend (feature flag + role check). If the user somehow reaches the API, backend returns `403`.

**Edge Cases:**
- **Empty SCXML (new machine, no published version):** If both draft and active return null/404, the editor starts with a minimal SCXML template skeleton.
- **Very large graph (100+ states):** Diagram render may take up to 300ms. A loading spinner overlays the diagram pane during render. If render exceeds 1 second, a warning appears: "Large diagram -- rendering may be slow".
- **Concurrent edits (two admins editing same machine):** No real-time collaboration. Last save wins. When user saves a draft, if the draft `version_id` in DB differs from what the editor loaded (another admin saved in between), the backend returns `409 Conflict`. Frontend shows a dialog: "Draft was modified by another user. Reload to see their changes?" with "Reload" and "Overwrite" options.

---

### 2.2 SC-02: Validate and Save a Draft

**Actor:** Admin with `fsm.editor` role
**Precondition:** SCXML has been modified in the editor.

**Happy Path:**
1. User clicks "Validate" in the toolbar.
2. Frontend sends `POST /api/fsm/job/validate` with `{ scxml_source: "<current editor content>" }`.
3. Backend parses the SCXML via `fsmService.validateSCXML()`, returns `{ valid: true, errors: [], warnings: [] }` or `{ valid: false, errors: [...], warnings: [...] }`.
4. `<ProblemsPanel />` opens (if collapsed) and displays results. Errors shown with red icon, warnings with yellow icon. Each entry shows: severity, message, line:column reference.
5. If errors exist: status pill shows "Has errors" (red). User clicks an error entry in ProblemsPanel -- Monaco scrolls to the line and highlights it.
6. User fixes the error, re-validates. Result is clean (`valid: true`).
7. User clicks "Save Draft".
8. Frontend sends `PUT /api/fsm/job/draft` with `{ scxml_source: "<editor content>" }`.
9. Backend validates the SCXML (same rules as validate endpoint). If valid, upserts into `fsm_versions` with `status='draft'`. Logs to `fsm_audit_log` (`action='save_draft'`).
10. Frontend receives `{ ok: true, data: { version_id } }`. Toast: "Draft saved". Status pill updates to "Valid" (green). Dirty flag clears.

**Error Cases:**
- **Save with blocking errors:** Backend returns `400` with error list. Frontend shows ProblemsPanel with errors. Toast: "Cannot save -- SCXML has errors". Draft is NOT saved.
- **Network error on validate:** Toast: "Network error during validation". ProblemsPanel shows nothing new.
- **Network error on save:** Toast: "Failed to save draft". Dirty flag remains. User can retry.
- **Version conflict on save (409):** Another admin saved a draft in between. Dialog: "Draft was modified by another user. Reload or overwrite?"

**Edge Cases:**
- **Validate with warnings only:** `valid: true`, warnings displayed. Draft can be saved. Warnings do not block save or publish.
- **Save without prior validate:** Allowed. Backend runs validation during save. If errors, returns 400.
- **Rapid saves (debounce):** The "Save Draft" button is disabled while a save request is in flight. Prevents double-saves.

---

### 2.3 SC-03: Publish a Workflow Version

**Actor:** Admin with `fsm.publisher` role
**Precondition:** A valid draft exists with zero blocking errors.

**Happy Path:**
1. User clicks "Publish" in the toolbar.
2. `<PublishDialog />` modal opens. Contains a textarea for change note (required, minimum 1 character).
3. User enters a change note (e.g., "Added Rescheduled -> Follow Up transition") and clicks "Confirm Publish".
4. Frontend sends `POST /api/fsm/job/publish` with `{ change_note: "Added Rescheduled -> Follow Up transition" }`.
5. Backend (`fsmService.publishDraft()`):
   a. Loads the current draft for `(company_id, 'job')`.
   b. Re-validates the SCXML. If blocking errors exist, returns `400`.
   c. Begins DB transaction:
      - Archives current published version (`status` -> `'archived'`).
      - Promotes draft: `status` -> `'published'`, `version_number` = previous_max + 1, sets `published_by`, `published_at`.
      - Updates `fsm_machines.active_version_id` to the new version.
   d. Commits transaction.
   e. Invalidates in-memory graph cache for `(company_id, 'job')`.
   f. Logs to `fsm_audit_log` (`action='publish'`, payload includes `change_note`, `version_number`).
   g. Returns `{ ok: true, data: { version_id, version_number } }`.
6. Frontend receives success. Toast: "Version 13 published". Editor reloads with the newly published version. Draft indicator disappears. Version selector updates.
7. Runtime immediately uses the new published version for transition resolution (cache was invalidated).

**Error Cases:**
- **No draft exists:** Backend returns `404`. Toast: "No draft to publish".
- **Draft has blocking errors:** Backend returns `400` with error list. Toast: "Cannot publish -- draft has validation errors". ProblemsPanel shows errors.
- **User lacks `fsm.publisher` role:** Backend returns `403`. Button is hidden on frontend for non-publishers, but server enforces.
- **Empty change note:** Frontend prevents submission (button disabled). If bypassed, backend returns `400 { error: "change_note is required" }`.
- **Network error:** Toast: "Failed to publish". No state change.
- **DB transaction failure:** Backend rolls back. Returns `500`. Toast: "Server error during publish".

**Edge Cases:**
- **Publishing while another admin publishes simultaneously:** The transaction uses row-level locking on `fsm_machines`. The second publish will either see an updated `active_version_id` (and archive the first admin's version) or fail with a serialization error (retry needed).
- **Feature flag `fsm_publishing_enabled` is false:** Publish button is hidden. Backend returns `403` if called directly.

---

### 2.4 SC-04: Status Transition via Hot Action Button

**Actor:** Agent viewing a Job card
**Precondition:** Job is in state `Submitted`. Published SCXML defines transitions from `Submitted`.

**Happy Path:**
1. Job detail card mounts `<ActionsBlock machineKey="job" entityId={123} currentState="Submitted" />`.
2. `useFsmActions` hook calls `GET /api/fsm/job/actions?state=Submitted&roles=agent`.
3. Backend (`fsmService.getAvailableActions()`):
   a. Loads published SCXML from in-memory cache (or DB -> parse -> cache on miss).
   b. Finds `<state id="Submitted">` in parsed graph.
   c. Filters transitions where `blanc:action="true"` AND (no `blanc:roles` attribute OR user roles intersect with `blanc:roles` value).
   d. Returns action list sorted by `blanc:order`.
   e. **Fallback:** If no published FSM version exists, derives actions from hardcoded `ALLOWED_TRANSITIONS` map.
4. ActionsBlock renders buttons: "Follow up", "Waiting for parts", "Cancel".
5. User clicks "Follow up".
6. The transition does NOT have `blanc:confirm="true"`, so no confirmation dialog.
7. Frontend sends `POST /api/fsm/job/apply` with `{ entityId: 123, event: "TO_FOLLOW_UP" }`.
8. Backend route handler:
   a. Loads the job via `jobsService.getJobById(123, companyId)`. Verifies it belongs to the company.
   b. Calls `fsmService.resolveTransition(companyId, 'job', 'Submitted', 'TO_FOLLOW_UP')`.
   c. `resolveTransition` loads published graph, finds transition from `Submitted` with event `TO_FOLLOW_UP`, resolves target state name (uses `blanc:statusName` if present, else state `id`). Returns `{ targetState: 'Follow Up with Client', valid: true }`.
   d. Calls `jobsService.updateBlancStatus(123, 'Follow Up with Client')`.
   e. `updateBlancStatus` checks `OUTBOUND_MAP` -- `'Follow Up with Client'` is NOT in the map, so no Zenbooker sync fires.
   f. Logs to `fsm_audit_log` (`action='apply'`, payload: `{ from: 'Submitted', to: 'Follow Up with Client', event: 'TO_FOLLOW_UP', entityId: 123 }`).
   g. Returns `{ ok: true, data: { previousState: 'Submitted', newState: 'Follow Up with Client', entityId: 123 } }`.
9. Frontend receives success. React Query cache invalidates. Card re-renders with new state. ActionsBlock fetches new actions for `Follow Up with Client`.

**Error Cases:**
- **Invalid event for current state:** Backend returns `400 { error: "Transition TO_FOLLOW_UP is not valid from state 'Job is Done'" }`. Toast: "Transition not allowed".
- **Job not found / wrong company:** Backend returns `404`. Toast: "Job not found".
- **Stale state (another user transitioned the job):** Backend loads current state from DB. If current state differs from what frontend sent (frontend sends `currentState` but backend re-reads from DB), the transition may fail if the event is not valid from the actual current state. Returns `400` or `409`. Toast: "Job status has changed. Please refresh."
- **No published FSM + hardcoded fallback:** `fsmService.resolveTransition` finds no published version. Falls back to `ALLOWED_TRANSITIONS['Submitted']` which includes `'Follow Up with Client'`. Transition proceeds normally.
- **Zenbooker sync error (non-blocking):** If the new status triggers an outbound sync and it fails, the status change still succeeds locally. Error is logged server-side. No user-facing error.

**Edge Cases:**
- **Role filtering hides all buttons:** If user's role does not match any transition's `blanc:roles`, ActionsBlock renders empty. No "Actions" header shown.
- **Transition to terminal state (`<final>`):** Transition succeeds. ActionsBlock for the terminal state renders empty (no outgoing transitions).

---

### 2.5 SC-05: Manual Status Override

**Actor:** Admin with `fsm.override` role
**Precondition:** Job is in state `Job is Done`. Only transition available is `Job is Done -> Canceled`. User wants to move to `Submitted` (not a defined transition).

**Happy Path:**
1. ActionsBlock renders normal action buttons plus a "Change status..." link (visible only if user has `fsm.override` role, checked via Keycloak token claims on the frontend).
2. User clicks "Change status...".
3. A dropdown appears listing all possible states from the published SCXML (excluding the current state). States are rendered using `blanc:label` or `blanc:statusName` for display.
4. User selects "Submitted".
5. A confirmation dialog appears: "This is an override. It bypasses allowed transitions." with a mandatory "Reason" textarea.
6. User enters reason: "Customer requested restart" and confirms.
7. Frontend sends `POST /api/fsm/job/override` with `{ entityId: 123, targetState: "Submitted", reason: "Customer requested restart" }`.
8. Backend:
   a. Verifies user has `fsm.override` permission (middleware).
   b. Loads the job, verifies company ownership.
   c. Validates `targetState` exists in the published SCXML as a valid state ID or `blanc:statusName`.
   d. Calls `jobsService.updateBlancStatus(123, 'Submitted')` -- this still triggers Zenbooker outbound sync via `OUTBOUND_MAP` if applicable.
   e. Logs to `fsm_audit_log` (`action='override'`, payload: `{ from: 'Job is Done', to: 'Submitted', reason: 'Customer requested restart', entityId: 123 }`).
   f. Returns `{ ok: true, data: { previousState: 'Job is Done', newState: 'Submitted', entityId: 123 } }`.
9. Toast: "Status changed to Submitted (override)". Card re-renders.

**Error Cases:**
- **User lacks `fsm.override` role:** Backend returns `403`. "Change status..." link is hidden on frontend.
- **Target state does not exist in SCXML:** Backend returns `400 { error: "State 'InvalidState' does not exist in the published workflow" }`.
- **Empty reason:** Frontend prevents submission (button disabled). Backend returns `400 { error: "reason is required" }`.
- **No published FSM (fallback):** Override uses `BLANC_STATUSES` array as the list of valid target states.

**Edge Cases:**
- **Override to current state:** Backend returns `400 { error: "Entity is already in state 'Submitted'" }`.
- **Override to `<final>` state:** Allowed. Behaves same as normal transition to terminal state.

---

### 2.6 SC-06: View Version History and Restore

**Actor:** Admin with `fsm.editor` role

**Happy Path:**
1. User clicks "View history" in the version selector dropdown.
2. `<VersionHistory />` modal opens.
3. Frontend calls `GET /api/fsm/job/history` (mapped to `/api/fsm/job/versions` on backend).
4. Modal renders a list of versions: version_number, status badge (`published`/`archived`/`draft`), author (created_by), date (created_at or published_at), change_note (truncated with expand).
5. Versions sorted by version_number descending (newest first).
6. User selects a previous published version (e.g., v11) and clicks "Restore as draft".
7. Frontend sends `POST /api/fsm/job/versions/42/restore` (where 42 is the version_id of v11).
8. Backend:
   a. Loads version 42, verifies it belongs to the company.
   b. If a draft already exists, overwrites it with the selected version's `scxml_source`.
   c. If no draft exists, creates a new draft with `scxml_source` from version 42.
   d. Logs to `fsm_audit_log` (`action='restore'`, payload: `{ restored_from_version_id: 42, restored_from_version_number: 11 }`).
   e. Returns `{ ok: true, data: { version_id: <new_draft_id> } }`.
9. Modal closes. Editor reloads with the restored SCXML. Toast: "Version 11 restored as draft".

**Error Cases:**
- **Version not found / wrong company:** Returns `404`.
- **Restore the current active version as draft:** Allowed -- creates a draft identical to the published version (useful as a "start fresh from published" action).

**Edge Cases:**
- **Restore when unsaved changes exist in editor:** Frontend shows a confirmation: "You have unsaved changes. Restoring will replace them. Continue?" before sending the restore request.

---

### 2.7 SC-08: Transition with Confirmation Dialog

**Actor:** Agent viewing a Job card
**Precondition:** SCXML transition has `blanc:confirm="true"` and `blanc:confirmText="Are you sure you want to cancel this job?"`.

**Happy Path:**
1. User clicks the "Cancel" action button.
2. Frontend checks the action metadata: `confirm: true`, `confirmText: "Are you sure you want to cancel this job?"`.
3. A confirmation dialog appears with the configured text and "Confirm" / "Cancel" buttons.
4. User clicks "Confirm".
5. Frontend proceeds with `POST /api/fsm/job/apply` as in SC-04.
6. On "Cancel" (dialog dismiss), no action is taken.

**Edge Cases:**
- **`blanc:confirm="true"` but no `blanc:confirmText`:** Dialog shows default text: "Are you sure you want to proceed?"
- **Confirmation dialog + network error on apply:** Dialog closes, toast shows error.

---

## 3. API Contracts

All endpoints are mounted under `app.use('/api/fsm', authenticate, requireCompanyAccess, fsmRouter)`.
`company_id` is always derived from `req.companyFilter?.company_id`. Never from request body.
Auth: All endpoints require `authedFetch` (Bearer token in Authorization header).

---

### 3.1 GET /api/fsm/machines

**Description:** List all FSM machines for the tenant.
**Permission:** `fsm.viewer`
**Middleware chain:** `authenticate -> requireCompanyAccess -> requirePermission('fsm.viewer')`

**Request:** No body. No query parameters.

**Response (200):**
```json
{
  "ok": true,
  "data": [
    {
      "machine_key": "job",
      "title": "Job Workflow",
      "description": "Status transitions for jobs",
      "active_version": {
        "version_id": 42,
        "version_number": 12,
        "published_at": "2026-04-01T10:30:00Z",
        "published_by": "admin@company.com"
      },
      "has_draft": true,
      "created_at": "2026-01-15T08:00:00Z",
      "updated_at": "2026-04-01T10:30:00Z"
    },
    {
      "machine_key": "lead",
      "title": "Lead Workflow",
      "description": "Status transitions for leads",
      "active_version": {
        "version_id": 43,
        "version_number": 1,
        "published_at": "2026-01-15T08:00:00Z",
        "published_by": "system"
      },
      "has_draft": false,
      "created_at": "2026-01-15T08:00:00Z",
      "updated_at": "2026-01-15T08:00:00Z"
    }
  ]
}
```

**Response (403):** `{ "ok": false, "error": "Permission denied" }`
**Response (500):** `{ "ok": false, "error": "Internal server error" }`

**Data isolation:** Query filters by `company_id` from `req.companyFilter.company_id`. Only machines belonging to the tenant are returned.

---

### 3.2 GET /api/fsm/:machineKey/active

**Description:** Get the active (published) SCXML version for a machine.
**Permission:** `fsm.viewer`

**Path params:** `machineKey` -- `"job"` or `"lead"`

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "version_id": 42,
    "version_number": 12,
    "scxml_source": "<?xml version=\"1.0\"?>\n<scxml xmlns=\"http://www.w3.org/2005/07/scxml\" ...>...</scxml>",
    "published_at": "2026-04-01T10:30:00Z",
    "published_by": "admin@company.com",
    "change_note": "Added Rescheduled status"
  }
}
```

**Response (404):** `{ "ok": false, "error": "No published version found for machine 'job'" }`
**Response (403):** `{ "ok": false, "error": "Permission denied" }`

**Data isolation:** Finds `fsm_machines` row WHERE `company_id = $companyId AND machine_key = $machineKey`, then joins to `fsm_versions` via `active_version_id`.

---

### 3.3 GET /api/fsm/:machineKey/draft

**Description:** Get the current draft version for a machine, if one exists.
**Permission:** `fsm.editor`

**Response (200 -- draft exists):**
```json
{
  "ok": true,
  "data": {
    "version_id": 55,
    "scxml_source": "<?xml version=\"1.0\"?>\n<scxml ...>...</scxml>",
    "created_at": "2026-04-05T14:22:00Z",
    "created_by": "admin@company.com"
  }
}
```

**Response (200 -- no draft):**
```json
{
  "ok": true,
  "data": null
}
```

**Response (403):** `{ "ok": false, "error": "Permission denied" }`

**Data isolation:** Query: `SELECT * FROM fsm_versions WHERE machine_id = (SELECT id FROM fsm_machines WHERE company_id = $1 AND machine_key = $2) AND status = 'draft' ORDER BY created_at DESC LIMIT 1`

---

### 3.4 PUT /api/fsm/:machineKey/draft

**Description:** Save (create or update) a draft version.
**Permission:** `fsm.editor`

**Request body:**
```json
{
  "scxml_source": "<?xml version=\"1.0\"?>\n<scxml xmlns=\"http://www.w3.org/2005/07/scxml\" ...>...</scxml>"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `scxml_source` | string | Yes | Must be valid XML. Max 500 KB. |

**Response (200 -- success):**
```json
{
  "ok": true,
  "data": {
    "version_id": 55
  }
}
```

**Response (400 -- validation errors):**
```json
{
  "ok": false,
  "error": "SCXML validation failed",
  "data": {
    "errors": [
      { "line": 5, "col": 12, "message": "Transition target 'NonExistent' does not reference any state", "severity": "error" }
    ],
    "warnings": [
      { "line": 22, "col": 3, "message": "State 'Orphan' has no incoming transitions", "severity": "warning" }
    ]
  }
}
```

**Response (409 -- version conflict):**
```json
{
  "ok": false,
  "error": "Draft was modified by another user",
  "data": {
    "current_version_id": 56,
    "your_version_id": 55
  }
}
```

**Response (403):** `{ "ok": false, "error": "Permission denied" }`

**Behavior:**
- If no draft exists for `(company_id, machineKey)`: creates a new `fsm_versions` row with `status='draft'`, `version_number=0`.
- If a draft exists: updates `scxml_source`, `created_at`, `created_by` on the existing draft row.
- Validates SCXML before saving. If blocking errors found, returns `400` and does NOT save.
- Logs `save_draft` to `fsm_audit_log`.

---

### 3.5 POST /api/fsm/:machineKey/validate

**Description:** Validate an SCXML source without saving it.
**Permission:** `fsm.editor`

**Request body:**
```json
{
  "scxml_source": "<?xml version=\"1.0\"?>\n<scxml ...>...</scxml>"
}
```

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "valid": false,
    "errors": [
      { "line": 1, "col": 1, "message": "XML parse error: Unexpected end of input", "severity": "error" },
      { "line": 10, "col": 5, "message": "Forbidden element: <script>", "severity": "error" }
    ],
    "warnings": [
      { "line": 15, "col": 3, "message": "State 'Orphan' is unreachable from initial state", "severity": "warning" }
    ]
  }
}
```

**Response (200 -- valid):**
```json
{
  "ok": true,
  "data": {
    "valid": true,
    "errors": [],
    "warnings": []
  }
}
```

**Note:** This endpoint always returns `200`. The `valid` boolean indicates the result. Errors are in the response body, not HTTP status codes.

---

### 3.6 POST /api/fsm/:machineKey/publish

**Description:** Promote the current draft to published status.
**Permission:** `fsm.publisher`

**Request body:**
```json
{
  "change_note": "Added Rescheduled -> Follow Up transition"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `change_note` | string | Yes | Min 1 char, max 500 chars. |

**Response (200 -- success):**
```json
{
  "ok": true,
  "data": {
    "version_id": 55,
    "version_number": 13
  }
}
```

**Response (400 -- no draft / validation errors):**
```json
{
  "ok": false,
  "error": "Draft has validation errors",
  "data": {
    "errors": [
      { "line": 5, "col": 12, "message": "Transition target 'X' does not exist", "severity": "error" }
    ]
  }
}
```

**Response (404):** `{ "ok": false, "error": "No draft exists to publish" }`
**Response (400):** `{ "ok": false, "error": "change_note is required" }`
**Response (403):** `{ "ok": false, "error": "Permission denied" }`

---

### 3.7 GET /api/fsm/:machineKey/history

**Description:** List all versions for a machine.
**Permission:** `fsm.viewer`
**Backend route path:** `/api/fsm/:machineKey/versions`

**Query params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "versions": [
      {
        "version_id": 55,
        "version_number": 12,
        "status": "published",
        "created_by": "admin@company.com",
        "created_at": "2026-04-01T10:00:00Z",
        "published_by": "admin@company.com",
        "published_at": "2026-04-01T10:30:00Z",
        "change_note": "Added Rescheduled status"
      },
      {
        "version_id": 50,
        "version_number": 11,
        "status": "archived",
        "created_by": "admin@company.com",
        "created_at": "2026-03-20T09:00:00Z",
        "published_by": "admin@company.com",
        "published_at": "2026-03-20T09:15:00Z",
        "change_note": "Initial seed"
      }
    ],
    "total": 12,
    "offset": 0,
    "limit": 50
  }
}
```

**Data isolation:** All queries scoped by `company_id`.

---

### 3.8 POST /api/fsm/:machineKey/apply

**Description:** Apply a transition event to an entity (Job or Lead).
**Permission:** Any authenticated user (role-level filtering happens via `blanc:roles` on transitions).
**Backend route path:** `/api/fsm/:machineKey/apply`

**Request body:**
```json
{
  "entityId": 123,
  "event": "TO_FOLLOW_UP"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `entityId` | number | Yes | Must be a valid Job/Lead ID belonging to the company |
| `event` | string | Yes | Must match a transition event in the current state |

**Response (200 -- success):**
```json
{
  "ok": true,
  "data": {
    "previousState": "Submitted",
    "newState": "Follow Up with Client",
    "entityId": 123
  }
}
```

**Response (400 -- invalid transition):**
```json
{
  "ok": false,
  "error": "Transition 'TO_FOLLOW_UP' is not valid from state 'Canceled'"
}
```

**Response (400 -- role mismatch):**
```json
{
  "ok": false,
  "error": "User does not have required role for this transition"
}
```

**Response (404):** `{ "ok": false, "error": "Job not found" }`

**Behavior:**
1. Load entity from DB (via `jobsService.getJobById` or `leadsService.getLeadById`), verify `company_id`.
2. Get current state from entity (`blanc_status` for jobs, `Status` for leads).
3. Call `fsmService.resolveTransition(companyId, machineKey, currentState, event)`.
4. If no published FSM: fall back to hardcoded `ALLOWED_TRANSITIONS` (for jobs) or allow any transition (for leads).
5. If valid: call `jobsService.updateBlancStatus(entityId, targetState)` which handles Zenbooker sync.
6. Log to `fsm_audit_log`.
7. Return previous and new state.

---

### 3.9 POST /api/fsm/:machineKey/override

**Description:** Force a status change bypassing FSM transition rules.
**Permission:** `fsm.override`

**Request body:**
```json
{
  "entityId": 123,
  "targetState": "Submitted",
  "reason": "Customer requested restart"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `entityId` | number | Yes | Valid entity ID |
| `targetState` | string | Yes | Must be a valid state in the published SCXML |
| `reason` | string | Yes | Min 1 char, max 1000 chars |

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "previousState": "Job is Done",
    "newState": "Submitted",
    "entityId": 123,
    "override": true
  }
}
```

**Response (400):** `{ "ok": false, "error": "State 'InvalidState' does not exist in the published workflow" }`
**Response (400):** `{ "ok": false, "error": "reason is required" }`
**Response (400):** `{ "ok": false, "error": "Entity is already in state 'Submitted'" }`
**Response (403):** `{ "ok": false, "error": "Permission denied" }`
**Response (404):** `{ "ok": false, "error": "Job not found" }`

**Behavior:**
1. Verify `fsm.override` permission.
2. Load entity, verify `company_id`.
3. Validate `targetState` exists in published SCXML (or in `BLANC_STATUSES` as fallback).
4. Verify target is different from current state.
5. Call `jobsService.updateBlancStatus(entityId, targetState)` -- bypasses transition validation but still triggers Zenbooker outbound sync.
6. Log to `fsm_audit_log` (`action='override'`, payload includes `reason`).

---

### 3.10 GET /api/fsm/:machineKey/actions

**Description:** Get available action buttons for a given state and user roles. Used by `ActionsBlock` component.
**Permission:** Any authenticated user.

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `state` | string | Yes | Current entity state (e.g., `Submitted`) |
| `roles` | string | No | Comma-separated user roles (e.g., `agent,fsm.editor`). If omitted, returns all actions regardless of role filter. |

**Response (200):**
```json
{
  "ok": true,
  "data": [
    {
      "event": "TO_FOLLOW_UP",
      "target": "Follow Up with Client",
      "label": "Follow up",
      "icon": null,
      "confirm": false,
      "confirmText": null,
      "order": 10,
      "roles": null
    },
    {
      "event": "TO_WAITING_PARTS",
      "target": "Waiting for parts",
      "label": "Waiting for parts",
      "icon": null,
      "confirm": false,
      "confirmText": null,
      "order": 20,
      "roles": null
    },
    {
      "event": "TO_CANCELED",
      "target": "Canceled",
      "label": "Cancel",
      "icon": null,
      "confirm": true,
      "confirmText": "Are you sure you want to cancel this job?",
      "order": 90,
      "roles": null
    }
  ]
}
```

**Response (200 -- unknown state / no transitions):**
```json
{
  "ok": true,
  "data": []
}
```

**Response (400):** `{ "ok": false, "error": "state query parameter is required" }`

**Behavior:**
1. Load published SCXML (cached).
2. Find state matching `state` param (match by `id` or `blanc:statusName`).
3. Filter transitions: `blanc:action="true"` AND role match (if `roles` param provided and transition has `blanc:roles`).
4. Sort by `blanc:order` (ascending). Transitions without `blanc:order` sort last.
5. Map to action objects with `event`, `target` (resolved via `blanc:statusName`), `label`, `icon`, `confirm`, `confirmText`, `order`, `roles`.
6. **Fallback:** If no published FSM, derive actions from `ALLOWED_TRANSITIONS[state]` with simple labels (the target state name as label, no confirm, no icons).

---

## 4. SCXML Parser Specification

### 4.1 Input

Raw XML string (`scxml_source`), max 500 KB.

### 4.2 Output (Parsed Graph Structure)

```typescript
interface ParsedGraph {
  states: Map<string, ParsedState>;    // keyed by state ID
  transitions: ParsedTransition[];      // flat list of all transitions
  initialState: string;                 // ID of the initial state
  finalStates: Set<string>;            // IDs of <final> elements
  metadata: {
    machine: string | null;            // blanc:machine attribute
    title: string | null;              // blanc:title attribute
    xmlns_blanc: string | null;        // the blanc namespace URI
  };
}

interface ParsedState {
  id: string;                          // state id attribute
  label: string | null;                // blanc:label
  statusName: string | null;           // blanc:statusName (display name for DB storage; falls back to id if absent)
  isFinal: boolean;                    // true if <final> element
  transitions: ParsedTransition[];     // outgoing transitions from this state
}

interface ParsedTransition {
  source: string;                      // parent state ID
  target: string;                      // target state ID
  event: string;                       // event attribute
  action: boolean;                     // blanc:action="true"
  label: string | null;                // blanc:label
  icon: string | null;                 // blanc:icon
  hotkey: string | null;               // blanc:hotkey
  confirm: boolean;                    // blanc:confirm="true"
  confirmText: string | null;          // blanc:confirmText
  roles: string[] | null;             // blanc:roles split by comma, or null if absent
  order: number | null;                // blanc:order parsed as integer
}
```

### 4.3 Parsing Pipeline

1. **XML parse:** Use `fast-xml-parser` with options:
   - `ignoreAttributes: false`
   - `attributeNamePrefix: "@_"`
   - `allowBooleanAttributes: false`
   - `preserveOrder: false`
   If XML parse fails, return error with line/column from parser error.

2. **Root element check:** Verify root element is `scxml` with namespace `http://www.w3.org/2005/07/scxml`.

3. **Extract `initial` attribute** from `<scxml>`.

4. **Extract Blanc namespace attributes** from root: `blanc:machine`, `blanc:title`.

5. **Iterate child elements** of `<scxml>`:
   - For each `<state>`: extract `id`, `blanc:label`, `blanc:statusName`. Collect as non-final state.
   - For each `<final>`: extract `id`, `blanc:label`. Collect as final state.
   - For each other element: flag as forbidden (validation error).

6. **Iterate transitions** within each state:
   - Extract `event`, `target`, and all `blanc:*` attributes.
   - Parse `blanc:action` as boolean (default `false`).
   - Parse `blanc:confirm` as boolean (default `false`).
   - Parse `blanc:roles` as comma-split array (or `null` if absent).
   - Parse `blanc:order` as integer (or `null`).

7. **Build `ParsedGraph`** object from collected data.

### 4.4 State Name Resolution

When resolving the display name for a state (used for DB status values):
1. If `blanc:statusName` is present, use it.
2. Else if `blanc:label` is present, use it.
3. Else use the state `id`.

This is critical because state IDs use underscores (`Follow_Up_with_Client`) while DB status values use spaces (`Follow Up with Client`).

### 4.5 Validation Rules

#### Blocking Errors (prevent save and publish)

| # | Rule | Message Template |
|---|------|-----------------|
| E01 | XML is not well-formed | "XML parse error: {parser_message}" |
| E02 | Root element is not `<scxml>` | "Root element must be <scxml>" |
| E03 | Missing SCXML namespace | "Root <scxml> must have xmlns=\"http://www.w3.org/2005/07/scxml\"" |
| E04 | Missing `initial` attribute on `<scxml>` | "Attribute 'initial' is required on <scxml>" |
| E05 | `initial` references non-existent state | "Initial state '{initial}' does not exist" |
| E06 | Duplicate state ID | "Duplicate state id: '{id}'" |
| E07 | Transition `target` references non-existent state | "Transition target '{target}' does not reference any state" |
| E08 | Transition missing `event` attribute | "Transition in state '{stateId}' must have an 'event' attribute" |
| E09 | Forbidden SCXML element detected | "Forbidden element: <{elementName}>" |
| E10 | Blanc namespace URI mismatch | "Blanc namespace must be 'https://blanc.app/fsm', got '{uri}'" |

**Forbidden elements list:** `<script>`, `<invoke>`, `<send>`, `<onentry>`, `<onexit>`, `<parallel>`, `<history>`, `<datamodel>`, `<assign>`, `<raise>`, `<log>`, `<cancel>`, `<if>`, `<elseif>`, `<else>`, `<foreach>`.

#### Non-Blocking Warnings (informational, do not prevent save/publish)

| # | Rule | Message Template |
|---|------|-----------------|
| W01 | Unreachable state (no incoming transitions, not initial) | "State '{id}' has no incoming transitions and is not the initial state" |
| W02 | Non-final state with no outgoing transitions | "State '{id}' has no outgoing transitions but is not marked as <final>" |
| W03 | Duplicate event within same state | "Duplicate event '{event}' in state '{stateId}'" |
| W04 | `blanc:label` exceeds 50 characters | "Label on transition '{event}' in state '{stateId}' is very long ({length} chars)" |
| W05 | `blanc:confirmText` exceeds 200 characters | "Confirmation text on transition '{event}' is very long ({length} chars)" |
| W06 | `<final>` state has outgoing transitions | "Final state '{id}' has outgoing transitions (they will never fire)" |
| W07 | Blanc namespace declared but not used | "Blanc namespace declared but no blanc: attributes found" |

#### Line/Column References

Validation errors and warnings include `line` and `col` properties when determinable. The parser (`fast-xml-parser`) provides line numbers in error messages for parse failures. For structural validation (E05-E10, W01-W07), the line number is estimated by searching the raw SCXML string for the relevant element/attribute. If the line cannot be determined, `line: null, col: null`.

---

## 5. Frontend Component Behavior

### 5.1 WorkflowEditor

**File:** `frontend/src/components/workflows/WorkflowEditor.tsx`

**Layout:**
- Full height of the TabsContent area (100% of remaining viewport after page header).
- Fixed toolbar at top (height ~56px).
- Below toolbar: horizontal split-view with draggable divider.
  - Left pane (default 50%): Monaco editor + collapsible ProblemsPanel at bottom.
  - Right pane (default 50%): DiagramPreview.
- Minimum pane width: 300px.

**Toolbar (left to right):**
- Machine selector dropdown (Job | Lead).
- Version selector: "v12 (published)" / "draft" / "View history" link.
- Status pill: "Valid" (green) / "Has errors" (red) / "Draft has changes" (amber).
- Buttons:
  - "Validate" -- calls validate endpoint. Always enabled.
  - "Save Draft" -- enabled when editor content differs from last saved draft. Disabled during save. Permission: `fsm.editor`.
  - "Publish" -- enabled when a saved draft exists with no errors. Opens PublishDialog. Permission: `fsm.publisher`. Gated by `fsm_publishing_enabled` flag.
  - "Export" -- downloads current editor content as `.scxml` file. Always enabled.

**Monaco configuration:**
- Language: `xml`
- Theme: light (matches Blanc design system)
- Line numbers: on
- Minimap: on
- Word wrap: on
- Tab size: 2
- Read-only: false (unless user lacks `fsm.editor` role)
- Font: `'IBM Plex Mono', monospace` (or fallback)

**State management (via `useFsmEditor` hook):**
- `scxmlSource: string` -- current editor content
- `savedSource: string | null` -- last saved/loaded SCXML (for dirty detection)
- `isDirty: boolean` -- `scxmlSource !== savedSource`
- `validationResult: { valid, errors, warnings } | null`
- `draftVersionId: number | null`
- `activeVersionNumber: number | null`
- `isLoading, isSaving, isPublishing, isValidating: boolean`

**Debounce behavior:**
- On every Monaco `onChange`:
  1. Update `scxmlSource` state immediately.
  2. After 300ms debounce (no further changes), trigger diagram preview re-render.
  3. Diagram re-render is client-side only (no API call).

### 5.2 DiagramPreview

**File:** `frontend/src/components/workflows/DiagramPreview.tsx`

**Rendering pipeline:**
1. Receive SCXML string from parent (WorkflowEditor).
2. Pass SCXML to `state-machine-cat` library: `render(scxmlSource, { inputType: 'scxml', outputType: 'svg' })`.
3. If render succeeds: inject SVG into the component via `dangerouslySetInnerHTML` (or a ref-based approach). Clear any error overlay.
4. If render fails: show error overlay. Retain the last successfully rendered SVG underneath (dimmed).

**Error overlay:**
- Centered in the diagram pane.
- Background: `rgba(255, 253, 249, 0.9)` (semi-transparent blanc-bg).
- Title: "Can't render diagram" (16px, `--blanc-ink-1`).
- Error message: truncated to 2 lines (14px, `--blanc-ink-2`).
- Link: "See Problems" (clicks to expand ProblemsPanel).

**Pan/Zoom controls:**
- Toolbar inside pane: Zoom out (-), Zoom in (+), Fit to screen, Toggle event labels, Download SVG.
- Mouse wheel: zoom in/out.
- Mouse drag: pan.
- Implementation: CSS transform on the SVG container (scale + translate).
- Default: fit-to-screen on initial render and on SCXML change.

### 5.3 ProblemsPanel

**File:** `frontend/src/components/workflows/ProblemsPanel.tsx`

**Behavior:**
- Collapsible panel below the Monaco editor (bottom of left pane).
- Default: collapsed (only header bar visible, 32px).
- Auto-opens when validation returns errors.
- Header shows: "Problems" + count badge (e.g., "3 errors, 1 warning").

**Error display:**
- Each entry is a row: `[icon] [severity] [message] [line:col]`
- Error icon: red circle. Warning icon: yellow triangle.
- Message: full text from validation response.
- Line reference: clickable. On click, calls Monaco API `editor.revealLineInCenter(line)` and `editor.setPosition({ lineNumber: line, column: col })` and highlights the line.

**Sorting:** Errors first, then warnings. Within each group, sorted by line number ascending.

### 5.4 VersionHistory

**File:** `frontend/src/components/workflows/VersionHistory.tsx`

**Modal behavior:**
- Opens via "View history" link in toolbar version selector.
- Uses Shadcn Dialog (modal).
- Width: 600px max.
- Content: scrollable list of versions.

**Version list:**
- Each row: version number (bold), status badge, author, date, change note (truncated with "Show more" expand).
- Status badge colors: `published` = green, `archived` = gray, `draft` = amber.
- Currently active version highlighted with a subtle border.

**Restore flow:**
1. User clicks "Restore as draft" on a version row.
2. If editor has unsaved changes, confirmation dialog appears first.
3. On confirm: `POST /api/fsm/:machineKey/versions/:versionId/restore`.
4. On success: modal closes, editor reloads with restored SCXML, toast "Version N restored as draft".

### 5.5 ActionsBlock

**File:** `frontend/src/components/workflows/ActionsBlock.tsx`

**Props:**
```typescript
interface ActionsBlockProps {
  machineKey: 'job' | 'lead';
  entityId: number;
  currentState: string;
}
```

**Rendering logic:**
1. On mount and when `currentState` changes: fetch actions via `GET /api/fsm/:machineKey/actions?state={currentState}&roles={userRoles}`.
2. Render buttons sorted by `order`.
3. Each button:
   - Text: `label` from action.
   - Icon: optional, from `icon` field (mapped to Lucide icon component).
   - Style: Blanc secondary button style. Primary CTA for the first action, secondary for others.
   - `onClick`: If `confirm: true`, show confirmation dialog with `confirmText` first. Then call `POST /api/fsm/:machineKey/apply { entityId, event }`.
4. After successful apply: invalidate React Query cache for the entity. The card re-renders with new state. ActionsBlock re-fetches actions for the new state.
5. While applying: button shows loading spinner, all other buttons disabled.

**Role filtering:**
- User roles are extracted from Keycloak token claims (available in frontend auth context).
- Passed as `roles` query param to the actions endpoint.
- Backend filters. Frontend trusts the backend response (does not do additional role filtering).

**"Change status..." link (override):**
- Rendered below the action buttons only if user has `fsm.override` role.
- On click: opens a dropdown/dialog with all states from the workflow. User selects target, enters reason, confirms.
- Calls `POST /api/fsm/:machineKey/override`.

**Confirm dialog for transitions:**
- Uses Shadcn AlertDialog.
- Title: "Confirm action" or custom `blanc:confirmText`.
- Buttons: "Cancel" (secondary), "Confirm" (primary/destructive depending on action).

### 5.6 Tab Integration in LeadFormSettingsPage

**File:** `frontend/src/pages/LeadFormSettingsPage.tsx`

**Change:**
- Wrap entire page content in `<Tabs defaultValue="settings">`.
- Existing content (Job Types, Metadata Fields, Job Tags) moves into `<TabsContent value="settings">` with no other changes.
- New `<TabsContent value="workflows">` contains `<MachineList />` (and conditionally `<WorkflowEditor />` when a machine is selected).
- "Workflows" tab trigger is rendered conditionally: only when `fsm_editor_enabled` feature flag is `true`.
- Tab state is managed locally (no URL param for tab selection).

---

## 6. Data Isolation

### 6.1 How company_id Flows Through Every Layer

```
Frontend (authedFetch)
  └── Authorization: Bearer <keycloak_token>
       └── Token contains company_id claim

Backend middleware chain:
  authenticate(req)          → extracts user from token, sets req.user
  requireCompanyAccess(req)  → sets req.companyFilter = { company_id: <uuid> }

Route handler:
  const companyId = req.companyFilter?.company_id;   // ALWAYS from middleware
  // Never: req.body.company_id or req.query.company_id

Service layer (fsmService):
  All functions receive companyId as first parameter:
  - fsmService.listMachines(companyId)
  - fsmService.getActiveVersion(companyId, machineKey)
  - fsmService.getDraft(companyId, machineKey)
  - fsmService.saveDraft(companyId, machineKey, ...)
  - fsmService.publishDraft(companyId, machineKey, ...)
  - fsmService.resolveTransition(companyId, machineKey, ...)
  - fsmService.getAvailableActions(companyId, machineKey, ...)

Database queries:
  ALL queries include WHERE company_id = $companyId filter.
  fsm_machines: UNIQUE (company_id, machine_key) ensures tenant isolation.
  fsm_versions: company_id column duplicated from fsm_machines for direct filtering.
  fsm_audit_log: company_id column for audit isolation.

In-memory cache:
  Cache key: "${company_id}:${machine_key}"
  Each tenant has its own cache entries.
```

### 6.2 Fallback When Company Has No Published FSM

When `fsmService.getActiveVersion(companyId, machineKey)` returns `null` (no published FSM version exists for the tenant):

**For `machineKey = 'job'`:**
- `resolveTransition()`: Falls back to hardcoded `ALLOWED_TRANSITIONS` from `jobsService.js`. Checks if `newStatus` is in `ALLOWED_TRANSITIONS[currentState]`.
- `getAvailableActions()`: Falls back to `ALLOWED_TRANSITIONS[currentState]`. Returns each allowed target state as an action with `label = targetStateName`, `confirm = false`, `icon = null`, `event = null` (actions are target-state-based rather than event-based in fallback mode).
- `override()`: Falls back to `BLANC_STATUSES` array as the list of valid target states.

**For `machineKey = 'lead'`:**
- `resolveTransition()`: No hardcoded transitions exist for leads. Any status change is allowed (current implicit behavior).
- `getAvailableActions()`: Returns empty array (no action buttons). Lead status changes are handled via existing dropdown UI until FSM is published.
- `override()`: Any status string is accepted.

**After migration 073 runs:** All existing companies will have seeded published versions for both Job and Lead FSMs. The fallback only applies to companies created between migration deployment and application restart, or if seed data is manually deleted.

---

## 7. Zenbooker Sync Integration

### 7.1 OUTBOUND_MAP Continuity

The `OUTBOUND_MAP` in `jobsService.js` remains **unchanged and hardcoded**. It is NOT moved into SCXML. The FSM system does not own outbound side-effects.

```javascript
const OUTBOUND_MAP = {
    'Submitted': 'scheduled',
    'Waiting for parts': 'complete',
    'Job is Done': 'complete',
};
```

This mapping operates on **status names**, not FSM events or transition metadata. When a status change occurs (whether via FSM `apply`, FSM `override`, or legacy code paths), `jobsService.updateBlancStatus()` checks `OUTBOUND_MAP[newStatus]` and fires the Zenbooker API call if a mapping exists.

### 7.2 Where the Sync Hook Fires in the FSM Runtime Flow

```
POST /api/fsm/job/apply { entityId: 123, event: "TO_FOLLOW_UP" }
  │
  ├─ 1. fsmService.resolveTransition(companyId, 'job', 'Submitted', 'TO_FOLLOW_UP')
  │     └─ Returns: { targetState: 'Follow Up with Client', valid: true }
  │     └─ Pure validation only. No DB writes. No side-effects.
  │
  ├─ 2. jobsService.updateBlancStatus(123, 'Follow Up with Client')
  │     ├─ a. Validate newStatus is in BLANC_STATUSES (or skip if FSM already validated)
  │     ├─ b. Validate transition is allowed (ALLOWED_TRANSITIONS check — redundant with FSM, kept for fallback safety)
  │     ├─ c. UPDATE jobs SET blanc_status = 'Follow Up with Client'
  │     ├─ d. Check OUTBOUND_MAP['Follow Up with Client'] → undefined → NO Zenbooker sync
  │     └─ e. Check if newStatus === 'Canceled' → NO → skip cancel handling
  │
  └─ 3. fsmService.logAudit(...)
```

**Example where Zenbooker sync DOES fire:**

```
POST /api/fsm/job/apply { entityId: 456, event: "TO_JOB_DONE" }
  │
  ├─ 1. fsmService.resolveTransition(companyId, 'job', 'Visit completed', 'TO_JOB_DONE')
  │     └─ Returns: { targetState: 'Job is Done', valid: true }
  │
  ├─ 2. jobsService.updateBlancStatus(456, 'Job is Done')
  │     ├─ c. UPDATE jobs SET blanc_status = 'Job is Done'
  │     ├─ d. Check OUTBOUND_MAP['Job is Done'] → 'complete'
  │     │     └─ zenbookerClient.markJobComplete(job.zenbooker_job_id)
  │     └─ e. newStatus !== 'Canceled' → skip
  │
  └─ 3. fsmService.logAudit(...)
```

**Cancel special case:**

```
POST /api/fsm/job/apply { entityId: 789, event: "TO_CANCELED" }
  │
  ├─ 1. fsmService.resolveTransition(...) → { targetState: 'Canceled', valid: true }
  │
  ├─ 2. jobsService.updateBlancStatus(789, 'Canceled')
  │     ├─ c. UPDATE jobs SET blanc_status = 'Canceled'
  │     ├─ d. OUTBOUND_MAP['Canceled'] → undefined → skip main outbound
  │     └─ e. newStatus === 'Canceled' AND job.zenbooker_job_id exists
  │           └─ zenbookerClient.cancelJob(job.zenbooker_job_id)
  │
  └─ 3. fsmService.logAudit(...)
```

### 7.3 Inbound Zenbooker Sync (Unchanged)

`jobsService.syncFromZenbooker()` and `computeBlancStatusFromZb()` are NOT affected by the FSM system. Inbound sync from Zenbooker webhooks bypasses FSM validation entirely because:
- It is a system-level operation, not a user-initiated transition.
- Zenbooker events may set statuses that have no SCXML transition path (e.g., jumping directly to `Canceled` from any state via webhook).
- The `computeBlancStatusFromZb()` function maps Zenbooker event types/flags to Blanc statuses using its own priority rules, independent of FSM graph structure.

### 7.4 Zenbooker Pass-Through Actions (Preserved)

The following `jobsService` functions remain unchanged and are NOT replaced by FSM actions:
- `cancelJob()` -- calls `zenbookerClient.cancelJob()` then updates DB directly.
- `markEnroute()` -- calls `zenbookerClient.markJobEnroute()` then updates `zb_status` to `'en-route'`.
- `markInProgress()` -- calls `zenbookerClient.markJobInProgress()` then updates `zb_status` to `'in-progress'`.
- `markComplete()` -- calls `zenbookerClient.markJobComplete()` then updates `zb_status` and `blanc_status`.

These operate on `zb_status` (Zenbooker substatus), NOT on `blanc_status` (FSM parent status). The `zb_status` lifecycle (`scheduled` -> `en-route` -> `in-progress` -> `complete`) is orthogonal to the FSM-managed `blanc_status` lifecycle. The existing `JobOpsSection` component (in `JobStatusTags.tsx`) continues to render these Zenbooker-specific action buttons alongside the new FSM-driven `ActionsBlock`.

---

## 8. Audit Logging

Every FSM action is logged to `fsm_audit_log` with the following schema:

| Action | Trigger | Payload Fields |
|--------|---------|---------------|
| `save_draft` | `PUT /api/fsm/:machineKey/draft` | `{ version_id, scxml_length }` |
| `publish` | `POST /api/fsm/:machineKey/publish` | `{ version_id, version_number, change_note, previous_version_id }` |
| `apply` | `POST /api/fsm/:machineKey/apply` | `{ entity_id, from_state, to_state, event }` |
| `override` | `POST /api/fsm/:machineKey/override` | `{ entity_id, from_state, to_state, reason }` |
| `restore` | `POST /api/fsm/:machineKey/versions/:id/restore` | `{ restored_from_version_id, restored_from_version_number, new_draft_id }` |
| `validate` | `POST /api/fsm/:machineKey/validate` | `{ valid, error_count, warning_count }` |

All audit rows include: `company_id`, `machine_key`, `actor_id`, `actor_email`, `created_at`.

---

## 9. Feature Flag Behavior

| Flag | Default | Controls |
|------|---------|----------|
| `fsm_editor_enabled` | `false` | Visibility of "Workflows" tab in LeadFormSettingsPage. When `false`, the tab is not rendered. Backend FSM CRUD endpoints still function (for API/migration use) but the UI is hidden. |
| `fsm_publishing_enabled` | `false` | Visibility and availability of the "Publish" button. When `false`, drafts can be saved but not published. Backend returns `403` on publish attempts. |

Feature flags are checked on the frontend via the existing feature flag mechanism (Keycloak realm attributes or application config). Backend checks flags via a shared config module.

---

## 10. Interaction with Existing Code

### 10.1 jobsService.js Modification (updateBlancStatus)

The `updateBlancStatus()` function gains an FSM-aware path:

```
updateBlancStatus(jobId, newStatus, companyId):
  1. Load job from DB.
  2. Try FSM path:
     a. Call fsmService.getActiveVersion(companyId, 'job')
     b. If published version exists:
        - Call fsmService.resolveTransitionByTarget(companyId, 'job', job.blanc_status, newStatus)
        - If valid: proceed to step 3.
        - If invalid: throw "Transition not allowed"
     c. If NO published version: fall back to existing ALLOWED_TRANSITIONS check.
  3. UPDATE jobs SET blanc_status = newStatus
  4. OUTBOUND_MAP sync (unchanged)
  5. Cancel special case (unchanged)
```

**Critical:** `BLANC_STATUSES` and `ALLOWED_TRANSITIONS` constants are NOT removed. They remain as fallback. The FSM path is additive.

### 10.2 Jobs Route (PATCH /:id/status)

The existing `PATCH /api/jobs/:id/status` route continues to work. It calls `updateBlancStatus()` which now internally checks FSM. This route is the legacy path; the new `POST /api/fsm/job/apply` is the preferred path for FSM-driven transitions. Both routes ultimately call the same `updateBlancStatus()` function.

### 10.3 Protected Files

| File | Constraint |
|------|-----------|
| `src/server.js` | Only one line added: FSM router mount. No other changes. |
| `frontend/src/lib/authedFetch.ts` | Not modified. All FSM API calls use existing `authedFetch`. |
| `frontend/src/hooks/useRealtimeEvents.ts` | Not modified. No SSE events for FSM editor (MVP). |
