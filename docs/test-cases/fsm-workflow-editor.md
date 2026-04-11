# Test Cases: FSM-001 -- FSM/SCXML Workflow Editor

**Spec ref:** `Docs/specs/fsm-workflow-editor.md`
**Requirements ref:** `Docs/requirements.md` section FSM-001
**Architecture ref:** `Docs/architecture.md` section FSM-001

---

## Coverage

- Total test cases: 32
- P0: 8 | P1: 11 | P2: 8 | P3: 5
- Unit: 14 | Integration: 15 | E2E: 3

---

## P0 -- Critical (must pass before merge)

---

### TC-FSM-001: SCXML parser -- valid SCXML produces correct graph

- **Priority:** P0
- **Type:** Unit
- **Related scenario:** SC-01, Spec 4.2 (Parsed Graph Structure)
- **Preconditions:** `fsmService.parseSCXML` function is available
- **Input data:**
  - `scxml_source`: The seed Job FSM SCXML from migration 073 (7 states, all transitions)
- **Mocks:** None (pure function)
- **Steps:**
  1. Call `parseSCXML(jobScxmlSource)`
  2. Inspect the returned `ParsedGraph` object
- **Expected result:**
  - `states` map has 7 entries: `Submitted`, `Waiting_for_parts`, `Follow_Up_with_Client`, `Visit_completed`, `Job_is_Done`, `Rescheduled`, `Canceled`
  - `initialState` equals `"Submitted"`
  - `finalStates` contains exactly `"Canceled"`
  - `metadata.machine` equals `"job"`
  - `metadata.title` equals `"Job Workflow"`
  - Each state's `transitions` array matches the seed SCXML (e.g. `Submitted` has 3 outgoing transitions: `TO_FOLLOW_UP`, `TO_WAITING_PARTS`, `TO_CANCELED`)
  - Total transition count matches `ALLOWED_TRANSITIONS` map
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-002: SCXML parser -- forbidden elements rejected

- **Priority:** P0
- **Type:** Unit
- **Related scenario:** NFR-01 (Security), Spec 4.4 (Validation rules)
- **Preconditions:** `fsmService.validateSCXML` function is available
- **Input data:**
  - `scxml_source`: Valid SCXML skeleton with a `<script>alert('xss')</script>` element inside a `<state>`
- **Mocks:** None (pure function)
- **Steps:**
  1. Call `validateSCXML(scxmlWithScript)`
- **Expected result:**
  - Returns `{ valid: false, errors: [{ message: "Forbidden element: <script>", severity: "error", ... }], warnings: [] }`
  - Error includes line/column reference to the `<script>` element
- **Additional cases to cover with same pattern:**
  - `<invoke>` element -> error "Forbidden element: `<invoke>`"
  - `<send>` element -> error "Forbidden element: `<send>`"
  - `<onentry>` element -> error "Forbidden element: `<onentry>`"
  - `<onexit>` element -> error "Forbidden element: `<onexit>`"
  - `<parallel>` element -> error "Forbidden element: `<parallel>`"
  - `<history>` element -> error "Forbidden element: `<history>`"
  - `<datamodel>` element -> error "Forbidden element: `<datamodel>`"
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-003: SCXML parser -- missing initial state produces error

- **Priority:** P0
- **Type:** Unit
- **Related scenario:** Spec 4.4 (Validation rules)
- **Preconditions:** `fsmService.validateSCXML` function is available
- **Input data:**
  - `scxml_source`: SCXML root element without `initial` attribute: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"><state id="A"/></scxml>`
- **Mocks:** None (pure function)
- **Steps:**
  1. Call `validateSCXML(scxmlWithoutInitial)`
- **Expected result:**
  - Returns `{ valid: false, errors: [{ message: contains "initial", severity: "error" }], warnings: [] }`
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-004: SCXML parser -- blanc namespace attributes extracted correctly

- **Priority:** P0
- **Type:** Unit
- **Related scenario:** Spec 4.2 (ParsedTransition, ParsedState), Constraint 4
- **Preconditions:** `fsmService.parseSCXML` function is available
- **Input data:**
  - `scxml_source`: SCXML with `xmlns:blanc="https://blanc.app/fsm"`, containing a state with `blanc:label="My Label"`, `blanc:statusName="My Status Name"`, and a transition with `blanc:action="true"`, `blanc:label="Do It"`, `blanc:confirm="true"`, `blanc:confirmText="Sure?"`, `blanc:roles="agent,admin"`, `blanc:order="10"`, `blanc:icon="check"`
- **Mocks:** None (pure function)
- **Steps:**
  1. Call `parseSCXML(scxmlSource)`
  2. Inspect state and transition metadata
- **Expected result:**
  - State object has `label: "My Label"`, `statusName: "My Status Name"`
  - Transition object has `action: true`, `label: "Do It"`, `confirm: true`, `confirmText: "Sure?"`, `roles: ["agent", "admin"]`, `order: 10`, `icon: "check"`
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-005: FSM runtime -- valid transition applied correctly

- **Priority:** P0
- **Type:** Unit
- **Related scenario:** SC-04 (Status transition via hot action button)
- **Preconditions:** Published Job FSM version exists in DB for `company_id = "comp-a"`
- **Input data:**
  - `companyId`: `"comp-a"`
  - `machineKey`: `"job"`
  - `currentState`: `"Submitted"`
  - `event`: `"TO_FOLLOW_UP"`
- **Mocks:**
  - DB query for `fsm_versions` (published, company_id=comp-a, machine_key=job) -> returns seed Job SCXML
  - Graph cache miss -> parse and cache
- **Steps:**
  1. Call `fsmService.resolveTransition("comp-a", "job", "Submitted", "TO_FOLLOW_UP")`
- **Expected result:**
  - Returns `{ valid: true, targetState: "Follow Up with Client" }` (using `blanc:statusName` for display)
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-006: FSM runtime -- invalid transition rejected

- **Priority:** P0
- **Type:** Unit
- **Related scenario:** SC-04 error case (invalid event for current state)
- **Preconditions:** Published Job FSM version exists for `company_id = "comp-a"`
- **Input data:**
  - `companyId`: `"comp-a"`
  - `machineKey`: `"job"`
  - `currentState`: `"Canceled"` (terminal / final state)
  - `event`: `"TO_FOLLOW_UP"`
- **Mocks:**
  - DB query returns seed Job SCXML (Canceled is `<final>`, no outgoing transitions)
- **Steps:**
  1. Call `fsmService.resolveTransition("comp-a", "job", "Canceled", "TO_FOLLOW_UP")`
- **Expected result:**
  - Returns `{ valid: false }` or throws error with message containing "not valid from state 'Canceled'"
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-007: API middleware -- 401 without token, 403 without permission

- **Priority:** P0
- **Type:** Integration
- **Related scenario:** NFR-01 (Security)
- **Preconditions:** Express app mounted with `authenticate`, `requireCompanyAccess`, `requirePermission` middleware on `/api/fsm/*`
- **Input data:** None
- **Mocks:**
  - Keycloak token validation -> reject (for 401 case)
  - Keycloak token valid but user has no `fsm.viewer` role (for 403 case)
- **Steps:**
  1. Send `GET /api/fsm/machines` with no `Authorization` header
  2. Send `GET /api/fsm/machines` with a valid token but user lacks `fsm.viewer` role
  3. Send `PUT /api/fsm/job/draft` with a valid token but user lacks `fsm.editor` role
  4. Send `POST /api/fsm/job/publish` with a valid token but user lacks `fsm.publisher` role
  5. Send `POST /api/fsm/job/override` with a valid token but user lacks `fsm.override` role
- **Expected result:**
  - Step 1: `401 Unauthorized`
  - Steps 2-5: `403 { ok: false, error: "Permission denied" }`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-008: Data isolation -- company A cannot access company B's FSM data

- **Priority:** P0
- **Type:** Integration
- **Related scenario:** NFR-01 (Security), Constraint 7 (Multi-tenant isolation)
- **Preconditions:**
  - Company A (`comp-a`) has a published Job FSM version (version_id=100)
  - Company B (`comp-b`) has a published Job FSM version (version_id=200)
  - User is authenticated as Company A user
- **Input data:**
  - Token for Company A user
- **Mocks:**
  - `req.companyFilter.company_id` set to `"comp-a"`
  - DB seeded with FSM data for both companies
- **Steps:**
  1. `GET /api/fsm/machines` as Company A -> returns only Company A machines
  2. `GET /api/fsm/job/active` as Company A -> returns Company A's published SCXML, NOT Company B's
  3. `GET /api/fsm/job/history` as Company A -> returns only Company A's versions
  4. `POST /api/fsm/job/apply` as Company A with `entityId` belonging to Company B -> returns 404
  5. `POST /api/fsm/job/override` as Company A with `entityId` belonging to Company B -> returns 404
- **Expected result:**
  - Steps 1-3: Only Company A data returned, zero Company B records
  - Steps 4-5: `404` (not `200` or `403`; entity simply "does not exist" from Company A's perspective)
- **File for test:** `tests/routes/fsm.test.js`

---

## P1 -- High (should pass)

---

### TC-FSM-009: API CRUD -- save draft, load draft, load active version

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-02 (Validate and save a draft)
- **Preconditions:** Company A has a published Job FSM. User has `fsm.editor` role.
- **Input data:**
  - Modified SCXML (valid, adds a new state `<state id="InReview">`)
- **Mocks:**
  - DB with seed data for Company A
  - Auth middleware passes with `fsm.editor` role
- **Steps:**
  1. `PUT /api/fsm/job/draft` with `{ scxml_source: modifiedScxml }` -> 200
  2. `GET /api/fsm/job/draft` -> 200, verify `scxml_source` matches what was saved
  3. `GET /api/fsm/job/active` -> 200, verify `scxml_source` is still the original published SCXML (draft did not affect active)
- **Expected result:**
  - Draft saved with `version_number=0`, `status='draft'`
  - Active version unchanged
  - `fsm_audit_log` has a `save_draft` entry
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-010: API publish -- draft promoted, version incremented, active_version_id updated

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-03 (Publish a workflow version)
- **Preconditions:** Company A has a valid draft and an existing published version (v12). User has `fsm.publisher` role.
- **Input data:**
  - `{ change_note: "Added InReview state" }`
- **Mocks:**
  - DB with Company A draft + published v12
  - Auth middleware passes with `fsm.publisher` role
- **Steps:**
  1. `POST /api/fsm/job/publish` with `{ change_note: "Added InReview state" }`
  2. Verify response `{ ok: true, data: { version_number: 13 } }`
  3. `GET /api/fsm/job/active` -> verify it returns the newly published SCXML
  4. Query DB: previous published version (v12) now has `status='archived'`
  5. Query DB: `fsm_machines.active_version_id` points to the new version
  6. Query DB: `fsm_audit_log` has a `publish` entry with `change_note` in payload
- **Expected result:**
  - New version has `version_number=13`, `status='published'`
  - Old version archived
  - Machine `active_version_id` updated
  - Audit log recorded
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-011: API publish -- blocked when validation errors exist

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-03 error case (draft has blocking errors)
- **Preconditions:** Company A has a draft with invalid SCXML (transition target references non-existent state). User has `fsm.publisher` role.
- **Input data:**
  - Draft SCXML contains `<transition target="NonExistent" />`
  - `{ change_note: "Trying to publish bad draft" }`
- **Mocks:**
  - DB with invalid draft for Company A
- **Steps:**
  1. `POST /api/fsm/job/publish` with `{ change_note: "..." }`
- **Expected result:**
  - Returns `400 { ok: false, error: "Draft has validation errors", data: { errors: [...] } }`
  - Active version unchanged
  - No audit log entry for `publish`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-012: API history -- returns versions in order

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-06 (View version history)
- **Preconditions:** Company A has 3 versions: v1 (archived), v2 (archived), v3 (published). User has `fsm.viewer` role.
- **Input data:** None
- **Mocks:**
  - DB with 3 versions for Company A, machine_key=job
- **Steps:**
  1. `GET /api/fsm/job/history`
- **Expected result:**
  - Returns `{ ok: true, data: { versions: [...], total: 3 } }`
  - Versions sorted by `version_number` descending: v3, v2, v1
  - Each version has `version_id`, `version_number`, `status`, `created_by`, `created_at`, `change_note`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-013: API apply -- entity status updated in DB

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-04 (Status transition via hot action button)
- **Preconditions:** Company A has published Job FSM. Job #123 belongs to Company A with `blanc_status='Submitted'`. User is authenticated.
- **Input data:**
  - `{ entityId: 123, event: "TO_FOLLOW_UP" }`
- **Mocks:**
  - `jobsService.getJobById(123, companyId)` -> returns job with `blanc_status: "Submitted"`
  - `jobsService.updateBlancStatus(123, "Follow Up with Client")` -> success
  - DB: published Job FSM for Company A
- **Steps:**
  1. `POST /api/fsm/job/apply` with `{ entityId: 123, event: "TO_FOLLOW_UP" }`
- **Expected result:**
  - Returns `200 { ok: true, data: { previousState: "Submitted", newState: "Follow Up with Client", entityId: 123 } }`
  - `jobsService.updateBlancStatus` called with `(123, "Follow Up with Client")`
  - `fsm_audit_log` has an `apply` entry with `from`, `to`, `event`, `entityId` in payload
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-014: API apply -- Zenbooker outbound sync fires on mapped statuses

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-04, Requirements 5.1 (Zenbooker Outbound Sync)
- **Preconditions:** Job #456 has `blanc_status='Submitted'` and a `zenbooker_job_id`. Published FSM exists.
- **Input data:**
  - `{ entityId: 456, event: "TO_WAITING_PARTS" }` (Waiting for parts maps to `complete` in OUTBOUND_MAP)
- **Mocks:**
  - `jobsService.getJobById(456, companyId)` -> returns job with `blanc_status: "Submitted"`, `zenbooker_job_id: "zb-789"`
  - `jobsService.updateBlancStatus` -> internally triggers Zenbooker sync
  - Zenbooker API mock -> success
- **Steps:**
  1. `POST /api/fsm/job/apply` with `{ entityId: 456, event: "TO_WAITING_PARTS" }`
  2. Verify `jobsService.updateBlancStatus` was called with new status `"Waiting for parts"`
- **Expected result:**
  - Transition succeeds
  - `jobsService.updateBlancStatus` is called (which internally fires Zenbooker sync via `OUTBOUND_MAP`)
  - Zenbooker sync logic is not broken by FSM integration
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-015: API override -- only fsm.override role can use

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-05 (Manual status override), NFR-01
- **Preconditions:** Job #123 belongs to Company A, `blanc_status='Job is Done'`.
- **Input data:**
  - `{ entityId: 123, targetState: "Submitted", reason: "Customer requested restart" }`
- **Mocks:**
  - Auth middleware: user has `fsm.editor` but NOT `fsm.override`
- **Steps:**
  1. `POST /api/fsm/job/override` with the input data (user lacks `fsm.override`)
- **Expected result:**
  - Returns `403 { ok: false, error: "Permission denied" }`
  - Entity status unchanged
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-016: API override -- successful override with audit log

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-05 (Manual status override)
- **Preconditions:** Job #123 belongs to Company A, `blanc_status='Job is Done'`. User has `fsm.override` role. Published FSM contains state `Submitted`.
- **Input data:**
  - `{ entityId: 123, targetState: "Submitted", reason: "Customer requested restart" }`
- **Mocks:**
  - Auth middleware passes with `fsm.override`
  - `jobsService.getJobById` -> job with `blanc_status: "Job is Done"`
  - `jobsService.updateBlancStatus` -> success
  - DB: published FSM with `Submitted` state
- **Steps:**
  1. `POST /api/fsm/job/override` with the input data
  2. Query `fsm_audit_log` for the override entry
- **Expected result:**
  - Returns `200 { ok: true, data: { previousState: "Job is Done", newState: "Submitted", entityId: 123, override: true } }`
  - Audit log entry: `action='override'`, `payload_json` contains `reason: "Customer requested restart"`, `from: "Job is Done"`, `to: "Submitted"`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-017: API override -- missing reason rejected

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-05 error case (empty reason)
- **Preconditions:** User has `fsm.override` role. Job #123 exists.
- **Input data:**
  - `{ entityId: 123, targetState: "Submitted", reason: "" }`
- **Mocks:** Auth middleware passes with `fsm.override`
- **Steps:**
  1. `POST /api/fsm/job/override` with empty `reason`
- **Expected result:**
  - Returns `400 { ok: false, error: "reason is required" }`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-018: Fallback -- when no published FSM, hardcoded constants used

- **Priority:** P1
- **Type:** Unit
- **Related scenario:** NFR-04 (Data Integrity), Constraint 6 (Backward compatibility)
- **Preconditions:** No published FSM version exists for `(company_id, "job")` in the database
- **Input data:**
  - `companyId`: `"comp-new"` (no FSM data)
  - `machineKey`: `"job"`
  - `currentState`: `"Submitted"`
  - `event` / `targetState`: `"Follow Up with Client"`
- **Mocks:**
  - DB query for published FSM returns null / empty
  - Hardcoded `ALLOWED_TRANSITIONS` in `jobsService.js` is intact
- **Steps:**
  1. Call `fsmService.resolveTransition("comp-new", "job", "Submitted", "TO_FOLLOW_UP")` -- should fall back
  2. Call `fsmService.getAvailableActions("comp-new", "job", "Submitted", [])` -- should derive from `ALLOWED_TRANSITIONS`
- **Expected result:**
  - Step 1: Returns `{ valid: true, targetState: "Follow Up with Client" }` (from hardcoded constants)
  - Step 2: Returns action list matching `ALLOWED_TRANSITIONS["Submitted"]` entries with simple labels
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-019: API apply -- entity not found returns 404

- **Priority:** P1
- **Type:** Integration
- **Related scenario:** SC-04 error case (Job not found / wrong company)
- **Preconditions:** Job #999 does not exist or belongs to another company.
- **Input data:**
  - `{ entityId: 999, event: "TO_FOLLOW_UP" }`
- **Mocks:**
  - `jobsService.getJobById(999, companyId)` -> returns null
- **Steps:**
  1. `POST /api/fsm/job/apply` with `{ entityId: 999, event: "TO_FOLLOW_UP" }`
- **Expected result:**
  - Returns `404 { ok: false, error: "Job not found" }`
- **File for test:** `tests/routes/fsm.test.js`

---

## P2 -- Medium

---

### TC-FSM-020: Validation warnings -- unreachable states detected

- **Priority:** P2
- **Type:** Unit
- **Related scenario:** Spec 4.4 (Validation warnings)
- **Preconditions:** `fsmService.validateSCXML` function is available
- **Input data:**
  - SCXML with an orphan state `<state id="Orphan"/>` that has no incoming transitions and is not the initial state
- **Mocks:** None (pure function)
- **Steps:**
  1. Call `validateSCXML(scxmlWithOrphan)`
- **Expected result:**
  - Returns `{ valid: true, errors: [], warnings: [{ message: contains "unreachable" or "no incoming transitions", severity: "warning" }] }`
  - Warning does NOT block saving or publishing
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-021: Validation warnings -- duplicate events in same state

- **Priority:** P2
- **Type:** Unit
- **Related scenario:** Spec 4.4 (Validation warnings)
- **Preconditions:** `fsmService.validateSCXML` function is available
- **Input data:**
  - SCXML where state `A` has two transitions with the same `event="GO"` but different targets
- **Mocks:** None (pure function)
- **Steps:**
  1. Call `validateSCXML(scxmlWithDuplicateEvents)`
- **Expected result:**
  - Returns warning about duplicate event `GO` in state `A`
  - `valid: true` (warning, not error)
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-022: ActionsBlock -- buttons filtered by role

- **Priority:** P2
- **Type:** Integration
- **Related scenario:** SC-04 (role filtering), Spec 3.10
- **Preconditions:** Published Job FSM has a transition with `blanc:roles="admin"` on one transition and no `blanc:roles` on another.
- **Input data:**
  - `GET /api/fsm/job/actions?state=Submitted&roles=agent`
- **Mocks:**
  - Published SCXML with:
    - Transition `TO_FOLLOW_UP` with `blanc:roles="admin"`
    - Transition `TO_WAITING_PARTS` with no `blanc:roles` (visible to all)
- **Steps:**
  1. `GET /api/fsm/job/actions?state=Submitted&roles=agent`
- **Expected result:**
  - Returns only `TO_WAITING_PARTS` action (agent does not have `admin` role)
  - `TO_FOLLOW_UP` is excluded from the response
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-023: ActionsBlock -- confirm dialog metadata returned

- **Priority:** P2
- **Type:** Integration
- **Related scenario:** SC-08 (Transition with confirmation dialog)
- **Preconditions:** Published Job FSM has transition with `blanc:confirm="true"` and `blanc:confirmText="Are you sure you want to cancel this job?"`
- **Input data:**
  - `GET /api/fsm/job/actions?state=Submitted`
- **Mocks:**
  - Seed Job FSM (has confirm on TO_CANCELED transition)
- **Steps:**
  1. `GET /api/fsm/job/actions?state=Submitted`
  2. Find the `TO_CANCELED` action in response
- **Expected result:**
  - `TO_CANCELED` action has `confirm: true`, `confirmText: "Are you sure you want to cancel this job?"`
  - Other actions have `confirm: false`, `confirmText: null`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-024: Version history -- restore as draft creates new draft

- **Priority:** P2
- **Type:** Integration
- **Related scenario:** SC-06 (View version history and restore)
- **Preconditions:** Company A has v1 (archived) and v2 (published). No draft exists. User has `fsm.editor` role.
- **Input data:**
  - `POST /api/fsm/job/versions/v1_id/restore`
- **Mocks:**
  - DB with versions for Company A
  - Auth middleware passes with `fsm.editor`
- **Steps:**
  1. `POST /api/fsm/job/versions/{v1_version_id}/restore`
  2. `GET /api/fsm/job/draft`
  3. `GET /api/fsm/job/active`
- **Expected result:**
  - Step 1: Returns `200 { ok: true, data: { version_id: <new_draft_id> } }`
  - Step 2: Draft `scxml_source` matches v1's SCXML
  - Step 3: Active version is still v2 (unchanged)
  - Audit log has `restore` entry with `restored_from_version_id`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-025: API override -- target state does not exist in SCXML

- **Priority:** P2
- **Type:** Integration
- **Related scenario:** SC-05 error case
- **Preconditions:** User has `fsm.override` role. Published FSM exists. Job #123 exists.
- **Input data:**
  - `{ entityId: 123, targetState: "InvalidState", reason: "Testing" }`
- **Mocks:** Auth middleware passes with `fsm.override`
- **Steps:**
  1. `POST /api/fsm/job/override` with `targetState: "InvalidState"`
- **Expected result:**
  - Returns `400 { ok: false, error: "State 'InvalidState' does not exist in the published workflow" }`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-026: API override -- override to current state rejected

- **Priority:** P2
- **Type:** Integration
- **Related scenario:** SC-05 edge case
- **Preconditions:** Job #123 has `blanc_status='Submitted'`. User has `fsm.override` role.
- **Input data:**
  - `{ entityId: 123, targetState: "Submitted", reason: "Testing" }`
- **Mocks:**
  - `jobsService.getJobById` -> `blanc_status: "Submitted"`
- **Steps:**
  1. `POST /api/fsm/job/override` with `targetState: "Submitted"` (same as current)
- **Expected result:**
  - Returns `400 { ok: false, error: "Entity is already in state 'Submitted'" }`
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-027: API save draft -- version conflict returns 409

- **Priority:** P2
- **Type:** Integration
- **Related scenario:** SC-01 edge case (concurrent edits)
- **Preconditions:** Company A has an existing draft (version_id=55). Admin B saves a new draft (version_id becomes 56). Admin A still has version_id=55 reference.
- **Input data:**
  - `PUT /api/fsm/job/draft` with `{ scxml_source: "...", version_id: 55 }` (optional conflict detection field)
- **Mocks:**
  - DB: draft has been updated by another user (version_id now 56)
- **Steps:**
  1. Admin A sends `PUT /api/fsm/job/draft` while holding stale version_id
- **Expected result:**
  - Returns `409 { ok: false, error: "Draft was modified by another user", data: { current_version_id: 56, your_version_id: 55 } }`
- **File for test:** `tests/routes/fsm.test.js`

---

## P3 -- Low

---

### TC-FSM-028: CLI -- smcat generates SVG from SCXML

- **Priority:** P3
- **Type:** E2E
- **Related scenario:** SC-07 (Export SCXML and generate diagrams via CLI)
- **Preconditions:** `state-machine-cat` (`smcat`) is installed as devDependency. Seed SCXML file exists at `./fsm/job.scxml`.
- **Input data:**
  - Seed Job SCXML written to `./fsm/job.scxml`
- **Mocks:** None (CLI tool)
- **Steps:**
  1. Run `npm run fsm:build`
- **Expected result:**
  - `./fsm/out/job.svg` is created
  - SVG file is non-empty and contains valid SVG markup
  - SVG contains text references to state names (e.g. "Submitted", "Canceled")
- **File for test:** Manual / CI script

---

### TC-FSM-029: Diagram rendering -- large graph renders under 300ms

- **Priority:** P3
- **Type:** Unit
- **Related scenario:** NFR-02 (Performance)
- **Preconditions:** `state-machine-cat` library available. A generated SCXML with 100 states and 300 transitions.
- **Input data:**
  - Programmatically generated SCXML with 100 `<state>` elements and 300 `<transition>` elements
- **Mocks:** None
- **Steps:**
  1. Generate large SCXML programmatically
  2. Measure time to call `parseSCXML` + SVG render via `state-machine-cat`
- **Expected result:**
  - Total parse + render time < 300ms
- **File for test:** `tests/services/fsmService.test.js` (performance suite)

---

### TC-FSM-030: SCXML parser -- malformed XML returns parse error

- **Priority:** P3
- **Type:** Unit
- **Related scenario:** SC-01 error case (malformed XML during editing)
- **Preconditions:** `fsmService.validateSCXML` function is available
- **Input data:**
  - `scxml_source`: `"<scxml><state id='A'><transition target='B'></state>"` (unclosed tags, missing closing)
- **Mocks:** None
- **Steps:**
  1. Call `validateSCXML(malformedXml)`
- **Expected result:**
  - Returns `{ valid: false, errors: [{ message: contains "XML parse error" or "Unexpected", severity: "error" }] }`
- **File for test:** `tests/services/fsmService.test.js`

---

### TC-FSM-031: API actions -- fallback actions from hardcoded constants

- **Priority:** P3
- **Type:** Integration
- **Related scenario:** Spec 3.10 fallback behavior
- **Preconditions:** No published FSM for Company A. Hardcoded `ALLOWED_TRANSITIONS` has `Submitted -> [Follow Up with Client, Waiting for parts, Canceled]`.
- **Input data:**
  - `GET /api/fsm/job/actions?state=Submitted`
- **Mocks:**
  - DB: no FSM data for company
  - `ALLOWED_TRANSITIONS` in `jobsService.js` is the fallback
- **Steps:**
  1. `GET /api/fsm/job/actions?state=Submitted`
- **Expected result:**
  - Returns actions derived from `ALLOWED_TRANSITIONS["Submitted"]`
  - Labels are the target state names (simple fallback labels)
  - `confirm: false` for all (no metadata in fallback mode)
- **File for test:** `tests/routes/fsm.test.js`

---

### TC-FSM-032: API actions -- missing state query parameter returns 400

- **Priority:** P3
- **Type:** Integration
- **Related scenario:** Spec 3.10 error case
- **Preconditions:** User is authenticated.
- **Input data:**
  - `GET /api/fsm/job/actions` (no `state` query param)
- **Mocks:** Auth middleware passes
- **Steps:**
  1. `GET /api/fsm/job/actions` without `state` parameter
- **Expected result:**
  - Returns `400 { ok: false, error: "state query parameter is required" }`
- **File for test:** `tests/routes/fsm.test.js`
