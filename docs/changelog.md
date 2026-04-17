# Blanc Contact Center — Changelog

> Лог изменений проекта.

---

## 2026-04-17 — EMAIL-001 Implementation (Full Stack)

### Backend
- Created migration `079_create_email_tables.sql`: 5 tables (`email_mailboxes`, `email_threads`, `email_messages`, `email_attachments`, `email_sync_state`), 12 indexes, 4 triggers
- Created `backend/src/db/emailQueries.js`: full CRUD + sync queries with tenant isolation
- Created `backend/src/services/emailMailboxService.js`: AES-256-GCM token encryption, HMAC-signed OAuth state, mailbox lifecycle
- Created `backend/src/routes/email-settings.js`: 4 settings endpoints (GET status, POST connect, POST disconnect, POST sync)
- Created `backend/src/routes/email-oauth.js`: public Google OAuth callback with state validation
- Created `backend/src/services/emailSyncService.js`: Gmail backfill, incremental history sync, interval scheduler
- Created `backend/src/services/emailService.js`: raw MIME send/reply, sent-message hydration, attachment proxy
- Created `backend/src/routes/email.js`: 7 workspace endpoints (mailbox, threads, thread detail, mark-read, compose, reply, attachment download)
- Modified `src/server.js`: mounted 3 route groups + email sync scheduler at boot

### Frontend
- Created `frontend/src/services/emailApi.ts`: typed API wrapper for all email endpoints
- Created `frontend/src/pages/EmailSettingsPage.tsx`: mailbox status, connect/reconnect/disconnect, manual sync
- Created `frontend/src/pages/EmailPage.tsx`: three-pane workspace (rail, thread list, thread detail)
- Created email components: `MailboxRail`, `EmailThreadList`, `EmailThreadRow`, `EmailThreadPane`, `EmailMessageItem`, `EmailComposer`
- Modified `frontend/src/App.tsx`: added `/settings/email` and `/email` routes
- Modified `frontend/src/components/layout/appLayoutNavigation.tsx`: added Email to Settings dropdown

### Tests
- Created 3 test suites (41 tests): `emailMailboxService.test.js`, `emailSyncService.test.js`, `email.test.js`
- Coverage: encryption round-trip, OAuth state signing, parsing helpers, route guards, CRUD operations

### Dependencies
- Added `googleapis` npm package

---

## 2026-04-17 — EMAIL-001 Pipeline Docs

### Architecture
- В `docs/architecture.md` добавлен полноценный architecture slice для `EMAIL-001`.
- Зафиксированы:
  - отдельные backend routes/services/query-layer для Gmail mailbox, sync и `/email`
  - отдельная `email_mailboxes` persistence layer для encrypted OAuth credentials
  - локальная thread/message/attachment sync-модель вместо live-only Gmail reads
  - отдельный `/email` workspace без изменения top-level navigation

### Spec / Test Cases / Tasks
- Создан новый spec: `docs/specs/EMAIL-001-gmail-shared-mailbox-workspace.md`
- Создан новый test-cases файл: `docs/test-cases/EMAIL-001-gmail-shared-mailbox-workspace.md`
- В `docs/tasks.md` добавлен полный task breakdown для `EMAIL-001`:
  - migration
  - OAuth/settings
  - sync service
  - send/reply service
  - backend routes
  - frontend settings page
  - `/email` workspace UI
  - verification

### Requirements Alignment
- В `docs/requirements.md` уточнён persistence slice:
  - `company_settings` оставлен для non-secret email prefs / UI metadata
  - добавлена отдельная `email_mailboxes` table для mailbox state и secure token storage

## 2026-04-16 — EMAIL-001 Requirements Alignment

### Documentation
- В `docs/requirements.md` добавлен новый formalized requirement `EMAIL-001: Gmail Shared Mailbox + Email Workspace`.
- Зафиксированы продуктовые решения для первой итерации:
  - отдельный route `/email`, без выноса в top navigation
  - отдельная settings page для подключения Gmail в `Settings`
  - один shared Gmail mailbox на компанию
  - scope v1 ограничен `send / receive / thread / search / attachments`
  - personal mailbox, delegated access, comments, shared drafts, assignment, snooze/later/done остаются вне scope

### Backlog
- В `docs/feature-backlog.md` обновлён email-эпик:
  - вместо `Email in Pulse` теперь зафиксирован отдельный `Gmail shared mailbox + /email workspace`
  - сохранена связь с текущими `Pulse`/Contacts/Leads/Jobs через deep-links, без слияния email в существующий `Pulse` timeline на этой фазе

## 2026-04-16 — Backlog Status Refresh

### Documentation
- Актуализирован `docs/feature-backlog.md` под фактическое состояние продукта на 2026-04-16.
- Добавлены:
  - legend по статусам `done / partial / planned`
  - отдельный status-summary по backlog-эпикам
  - обновлённый раздел "Что уже есть как база"
- Стало явно видно, что уже не является чистым backlog:
  - `Schedule` уже в активной разработке
  - `Estimates / Invoices / Transactions` уже существуют как реальные routes/pages
  - `Client Portal` уже имеет backend/API foundation
  - `AI communication` уже частично реализован через summary/transcript/polish
  - `Automation`, `Tasks`, `Voicemail`, `Phone ops` имеют partial baseline, а не zero-state

### Current Functionality
- Обновлён `docs/current_functionality.md`
- Добавлен новый раздел с кратким статусом более новых модулей:
  - `Schedule`
  - `Estimates / Invoices / Transactions`
  - `Client Portal foundation`
  - `Company / Admin / Territory management`
  - `Workflow editor / FSM builder`


## 2026-04-15 — RL-001: Routing Logs — Real Data + Day Grouping

### Improvement
- **Routing Logs page** (`/settings/telephony/routing-logs`) now displays real call data from `GET /api/calls` instead of mock data
- **Day grouping** — calls grouped by date with Pulse-style DateSeparator headings (no lines)
- **Redesigned UI** — Blanc design system: call rows with direction icons, contact names, result badges, duration, time
- **Detail panel** — click a call to see session ID, flow path, and latency
- **200 most recent calls** loaded by default

### Files Modified
- `frontend/src/pages/telephony/RoutingLogsPage.tsx` — full rewrite with day grouping and Blanc design
- `frontend/src/services/telephonyApi.ts` — `listLogs()` now calls real `/api/calls` endpoint, maps to `RoutingLogEntry`
- `frontend/src/types/telephony.ts` — added `direction` and `contact_name` fields to `RoutingLogEntry`

---

## 2026-04-15 — SCHED-LIST-001: Schedule List View

### New Feature
- **List view mode** for Schedule page — vertical job lists per technician column
- Jobs grouped by day with Pulse-style DateSeparator headings (no lines/borders)
- Each job tile shows time slot (start – end) via existing `ScheduleItemCard`
- Provider columns sorted alphabetically, "Unassigned" always last
- Empty days are not rendered (no empty headings)
- DnD reassign between provider columns supported
- Week-based navigation (same as Team Week view)

### Files Added
- `frontend/src/components/schedule/ListView.tsx` — new list view component

### Files Modified
- `frontend/src/hooks/useScheduleData.ts` — added `'list'` to ViewMode, dateRange, navigateDate
- `frontend/src/components/schedule/CalendarControls.tsx` — added List to VIEW_OPTIONS and getDateLabel
- `frontend/src/pages/SchedulePage.tsx` — added `case 'list'` with ListView import

---

## 2026-04-15 — IMG-001: Fullscreen Image Viewer

### New Feature
- **Shared fullscreen image viewer** (lightbox) component at `frontend/src/components/shared/FullscreenImageViewer.tsx`
- Opens on click in AttachmentsSection preview area (Telegram-like UX)
- Arrow key navigation between images, side buttons
- 90-degree rotation with scale compensation for sideways images
- Thumbnail strip at bottom, body scroll lock
- Close via Escape / backdrop click / X button
- Open original in new tab

### Files Added
- `frontend/src/components/shared/FullscreenImageViewer.tsx` — exports `FullscreenImageViewer`, `RotatableImage`

### Files Modified
- `frontend/src/components/payments/PaymentDetailPanel.tsx` — removed inline `FullscreenViewer` + `RotatableImage`, imports from shared

---

## 2026-04-06 — ELK-LAYOUT-001: Production ELK Layered Auto Layout

### Improvement
- **Replaced basic ELK layout** with production-grade `layoutWithElkLayered()` per `elk_layered_auto_layout_spec.md`
- **Layer constraints**: Root/initial nodes → FIRST_SEPARATE (top), Final nodes → LAST_SEPARATE (bottom)
- **Improved config**: ORTHOGONAL edge routing, NETWORK_SIMPLEX layering, BRANDES_KOEPF node placement, TWO_SIDED greedy switch, PREFER_NODES model order
- **Real node sizes**: Uses `node.measured.width/height` with 220×72 fallback (was hardcoded 200×60)
- **Stable ordering**: Nodes sorted by `data.order` then `id` before layout for deterministic results
- **Port support**: Multi-handle nodes use ELK ports with FIXED_ORDER constraint
- **Disconnected components**: `elk.separateConnectedComponents = true`
- **fitView after layout**: Canvas auto-fits viewport after layout recalculation via `ReactFlowInstance.fitView()`

### Files Changed
- `frontend/src/utils/workflowElkLayout.ts` — Full rewrite (spec-compliant `layoutWithElkLayered`)
- `frontend/src/pages/workflows/WorkflowBuilderPage.tsx` — `useReactFlow` instance for fitView, updated layout calls

---

## 2026-04-06 — Visual Workflow Builder

### New Feature
- **Full-screen visual FSM editor** at `/settings/workflows/:machineKey` replacing embedded Monaco editor
- **@xyflow/react canvas** with custom WorkflowStateNode, WorkflowFinalNode, WorkflowInsertableEdge components
- **Inspector sidebar** (300px): Flow properties, State inspector, Transition inspector with full SCXML attribute editing
- **SCXML codec**: Bidirectional `scxmlToGraph()` / `graphToScxml()` conversion
- **Toolbar**: Undo/Redo, Auto Layout, Add State, Validate, Save, Publish, Export
- **Edge insertion**: "+" button on edge hover to splice new states
- **Edge healing**: Deleting a node reconnects incoming→outgoing edges

### Files Added
- `frontend/src/pages/workflows/WorkflowBuilderPage.tsx`
- `frontend/src/pages/workflows/workflowScxmlCodec.ts`
- `frontend/src/pages/workflows/workflowNodeTypes.tsx`
- `frontend/src/pages/workflows/workflowInspectors.tsx`
- `frontend/src/utils/workflowElkLayout.ts`

### Files Modified
- `frontend/src/App.tsx` — Route `/settings/workflows/:machineKey`
- `frontend/src/components/workflows/MachineList.tsx` — Navigate to full-screen builder
- `frontend/src/pages/LeadFormSettingsPage.tsx` — Simplified Workflows tab

---

## 2026-04-06 — FSM-001: FSM/SCXML Workflow Editor

### New Features
- **SCXML-based workflow engine** replacing hardcoded status constants for Jobs and Leads
- **Admin Workflow Editor** (tab inside Lead & Job Settings):
  - Monaco SCXML editor with live diagram preview via state-machine-cat
  - Validation with error/warning display and click-to-navigate
  - Draft/Publish version management with audit logging
  - Version history with restore capability
- **Dynamic action buttons** (ActionsBlock) in Job cards driven by published SCXML transitions
- **Manual status override** for users with `fsm.override` permission
- **Feature flags**: `FSM_EDITOR_ENABLED`, `FSM_PUBLISHING_ENABLED` (default: true)

### Database
- Migration 072: `fsm_machines`, `fsm_versions`, `fsm_audit_log` tables
- Migration 073: Seed Job and Lead FSM machines per company
- Migration 074: FSM permission roles (`fsm.viewer`, `fsm.editor`, `fsm.publisher`, `fsm.override`)

### Backend
- `backend/src/services/fsmService.js` — SCXML parser, validator, CRUD, runtime (transition resolution, action filtering, caching)
- `backend/src/routes/fsm.js` — 12 API endpoints (read, write, runtime)
- `jobsService.js` — FSM delegation with hardcoded fallback
- `leadsService.js` — FSM validation on status changes with fallback

### Frontend
- `WorkflowEditor.tsx` — Split-pane SCXML editor + diagram preview
- `DiagramPreview.tsx` — SCXML→smcat→SVG rendering with zoom/pan
- `MachineList.tsx` — Machine selector in Workflows tab
- `ProblemsPanel.tsx` — Validation errors/warnings display
- `VersionHistory.tsx` + `PublishDialog.tsx` — Modals
- `ActionsBlock.tsx` — Dynamic FSM-driven action buttons with confirmation dialogs
- `useFsmEditor.ts` + `useFsmActions.ts` — React Query hooks

### Tests
- 98 tests (58 parser/runtime unit tests + 40 API integration tests) — all passing

### Dependencies
- Backend: `fast-xml-parser`
- Frontend: `@monaco-editor/react`, `state-machine-cat`
