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
