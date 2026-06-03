# Blanc Contact Center — Changelog

> Лог изменений проекта.

---

## 2026-05-10 — INV-001 Invoices MVP (with manual payment recording)

### Goal
Allow users to create invoices from approved estimates with full UX parity to the new estimate detail panel (inline edit, auto-save, item search combobox, document-templates PDF). Manual payment recording reflects directly in invoice status and balance.

### Backend
- Migration `backend/db/migrations/086_document_templates_invoice.sql`: extends `document_templates.document_type` CHECK to `('estimate','invoice')` and seeds a default invoice template per company.
- `backend/src/services/documentTemplates/factory.js`: added `INVOICE_FACTORY` with the teal accent (`#0f766e`) to visually distinguish invoices from estimates. **Terms & Warranty body is now shared with estimates** (`DEFAULT_INVOICE_TERMS = DEFAULT_TERMS_AND_WARRANTY`) per product spec.
- `backend/src/services/documentTemplates/invoiceAdapter.js`: renderer adapter for `document_type='invoice'`, registered alongside the estimate adapter in `documentTemplates/index.js`.
- `backend/src/services/documentTemplates/invoicePdfDocument.js`: react-pdf Document mirroring estimate layout. Section headings: "Summary", "Items", "Totals", "Terms & Warranty". Totals additionally show Amount paid (green), Balance Due with status badge (PAID / PARTIALLY PAID / OVERDUE / AMOUNT DUE / VOID).
- `backend/src/services/invoicesService.js`: added `generatePdf(companyId, id)`; `updateInvoice` now recalculates totals when `tax_rate` or `discount_amount` change.
- `backend/src/db/invoicesQueries.js`: `updateInvoice` allowedFields now includes `discount_amount`.
- `backend/src/routes/invoices.js`: replaced 501 PDF stub with working `GET /:id/pdf`. Added `getCompanyId(req)` helper and applied to every route (fix for a latent bug — old code read `req.companyId` which was never set by middleware). `POST /:id/sync-items` falls back to the invoice's linked `estimate_id` when body is empty.

### Frontend
- Rewrote `frontend/src/components/invoices/InvoiceDetailPanel.tsx` for full UX parity with `EstimateDetailPanel`:
    - Two-column layout (main + aside); header shows invoice number (linked to Job when present), status, Balance Due / Total.
    - Inline auto-save (no separate editor dialog) via `updateInvoice` + optimistic state.
    - Summary section (Notes field, labeled "Summary") with pencil-to-edit dialog (reuses `EstimateSummaryDialog`).
    - Items list with pencil-edit + trash-delete; per-item dialog reuses `EstimateItemDialog`.
    - `ItemPresetSearchCombobox` for adding items (shared catalog with estimates via `estimate_item_presets`).
    - Inline editable Tax rate, Discount, Due date, Payment terms.
    - **Manual payment recording** is behind a footer button → opens a `Popover` with Amount + Full-balance shortcut + Method (Card / Cash / Check / ACH / Other) + Submit. Recording immediately refreshes invoice totals, balance, and status.
    - "Preview PDF" button opens `/api/invoices/:id/pdf` in a new tab.
- `frontend/src/pages/InvoicesPage.tsx`: switched `FloatingDetailPanel` to `wide`; passes `onChanged` to refresh the list; added `?openId=<id>` URL param handler that auto-opens an invoice on arrival.
- `frontend/src/components/estimates/EstimateDetailPanel.tsx`: fixed missing `FileText` icon import; `Create Invoice` button now navigates to `/invoices?openId=<id>` so the new invoice opens automatically.
- `frontend/src/services/invoicesApi.ts`: corrected endpoint paths (`record-payment`, `sync-items`) to match backend routes.

### Decisions
- **PDF via F015 document templates**, not the legacy hardcoded builder. One adapter per document type; per-tenant customization is through stored descriptors.
- **Shared item catalog** between estimates and invoices via `estimate_item_presets` (table name kept to avoid migration churn; data is genuinely per-company shared).
- **Manual payment recording only** — no payment-gateway integration in this iteration. Recorded payments are stored as `invoice_events` of type `payment_recorded` plus immediate `amount_paid` / `balance_due` / `status` updates.
- Invoices share Terms & Warranty text with estimates — companies want one canonical warranty disclosure across both documents.

---

## 2026-05-07 — TWC-001 Twilio API Client Singleton

### Backend
- Added `backend/src/services/twilioClient.js` — process-wide lazy singleton via `getTwilioClient()`. One `twilio(sid, token)` instance per process; one `https.Agent` keep-alive pool toward `api.twilio.com`.
- Removed per-call `twilio(sid, token)` instantiation in `backend/src/services/reconcileStale.js`, `backend/src/services/callAvailability.js`, `backend/src/services/inboxWorker.js`, and `backend/src/routes/phoneSettings.js` — all now resolve the client lazily via `getTwilioClient()`.
- Migrated existing module-level singletons in `backend/src/services/conversationsService.js`, `backend/src/services/twilioSync.js`, and `backend/src/services/reconcileService.js` to thin lazy `Proxy` wrappers around `getTwilioClient()`. Public surface (`client.calls`, `client.conversations`, etc.) unchanged at every call site.
- Webhook signature validation (`backend/src/webhooks/twilioWebhooks.js`, `backend/src/webhooks/conversationsWebhooks.js`, `src/routes/webhooks.js`) and JWT minting (`backend/src/services/voiceService.js`) untouched — they use static `twilio.validateRequest` / `twilio.jwt.AccessToken` factories, not REST clients.

### Documentation
- Added requirement TWC-001 to `docs/requirements.md` (resource NFRs, multi-tenant scope guard).
- Added architecture section TWC-001 to `docs/architecture.md` (module map, failure modes, operational acceptance check).
- Added spec `docs/specs/TWC-001-twilio-client-singleton.md`.
- Added test cases `docs/test-cases/TWC-001-twilio-client-singleton.md` (9 cases, 5 P0 / 3 P1 / 1 P2).
- Added task plan to `docs/tasks.md`.

### Tests / Verification
- Added `tests/services/twilioClient.test.js` — 5 unit tests (singleton identity, lazy init, missing-env errors, recovery after env becomes available).
- Added `tests/services/twilioClient.regression.test.js` — guard against re-introducing per-request `twilio(process.env...)` in the four hot-spot files.
- Added `tests/services/twilioClient.bootstrap.test.js` — confirms requiring Twilio-using modules without `TWILIO_*` env does not throw.
- All 16 new tests pass. Adjacent suites verified green: `tests/zenbookerSyncService.test.js`, `tests/routes/integrations-analytics.test.js`, `tests/middleware/integrationScopes.test.js`.

### Decisions
- Singleton is process-global only. Per-tenant Twilio credentials (analogue of `getClientForCompany` in `zenbookerClient.js`) are out of scope for TWC-001.
- Deferred: custom `https.Agent` tuning. Twilio SDK defaults are sufficient once a single agent is shared across the process.

### Operational acceptance (post-deploy on `abc-metrics`)
- Steady-state outbound HTTPS connections to Twilio CloudFront should drop from ~199 to ≤20.
- CLOSE_WAIT count should drop from ~28 to ≤5.
- No expected change in node memory footprint or in Twilio API behavior at call sites.

---

## 2026-04-27 — PF002-R2 Estimates Composer Refresh

### PDF Generation
- Implemented `GET /api/estimates/:id/pdf` for client-facing estimate PDFs.
- PDF output includes ABC Homes company details, customer/job context, Summary, items, totals, default Terms & Warranty, and ACH payment details.
- Added `PDF` action to estimate detail and `tests/estimatePdfService.test.js`.

### Product / UX
- Reworked estimates around Lead/Job-context creation rather than global creation.
- Added Summary-before-items flow, Add custom item dialog, client-facing Preview, read-only default Terms & Warranty, discount controls, signature toggle, and disabled `Deposit required: No`.
- `/estimates` is now a searchable list/detail workspace with `Only Open / All` archive visibility, not a global create surface.

### Backend
- Added migration `082_pf002_r2_estimates_refresh.sql` for `summary`, discount type/value, archive fields, approved snapshots, signature fields, estimate sequence, and future Price Book item references.
- Rebuilt estimate queries/service/routes around `approved`, archive/restore, non-mutating send stub, decline reason, company-scoped Lead/Job numbering, and draft reset after edits.
- Portal document access now rejects archived estimates.

### Frontend
- Updated `estimatesApi` types/actions for `approved`, archive/restore, Summary, discount type/value, and signature fields.
- Rebuilt editor/detail/send/preview components and integrated them into Lead/Job Financials plus `/estimates`.

### Tests
- Added `tests/estimatesLifecycleR2.test.js`.
- Updated `tests/estimatesConvert.test.js` from `accepted` to `approved`.
- Targeted estimate tests pass; frontend production build passes. Full Jest still has pre-existing unrelated failures in payments/Twilio worker/webhook/state-machine suites.

---

## 2026-04-22 — F014: Ads Analytics Microservice

### New Feature
- **External read-only analytics API** for Google Ads / ABC Homes weekly reporting
- 4 token-authenticated endpoints under `/api/v1/integrations/analytics/*`:
  - `GET /summary` — aggregated funnel metrics (calls → leads → jobs → revenue)
  - `GET /calls`, `GET /leads`, `GET /jobs` — paged raw rows for drill-down
- New scope `analytics:read` — keeps Ads reporting key isolated from `leads:create`
- Period in `America/New_York` (ABC Homes TZ); hard cap 92 days
- Default tracking DID `+16176444408`; overridable via `tracking_number` query param

### Database
- Migration 080: `COMMENT ON COLUMN api_integrations.scopes` — no-op DDL marker documenting the canonical scope list (`leads:create`, `analytics:read`)

### Backend
- `backend/src/services/analyticsService.js` — `getSummary`/`listCalls`/`listLeads`/`listJobs` with shared CTE trio `tracked_calls → period_leads → attributed_leads`
- `backend/src/routes/integrations-analytics.js` — 4 GET endpoints mirroring `integrations-leads` middleware chain (`rejectLegacyAuth → validateHeaders → authenticateIntegration → rateLimiter`) + `requireScope('analytics:read')` guard
- `src/server.js` — 3-point patch (require, mount at `/api/v1/integrations`, boot log)
- `backend/scripts/issue-analytics-key.js` — CLI to generate and persist `analytics:read` API keys (peppered SHA-256 hash, secret printed once)

### Tests
- `tests/routes/integrations-analytics.test.js` — 11 tests (happy path, 403 scope, 400 validation pass-through, 500 on unexpected, paged list endpoints)
- `tests/services/analyticsService.test.js` — 4 tests for pure helpers (`parsePeriod` cases, `normalizePhone` cases)
- Full Jest run: **15 / 15 passing**

### Docs
- Added F014 entry to `docs/requirements.md`
- Added F014 slice to `docs/architecture.md`
- Added `docs/test-cases/F014-ads-analytics-microservice.md`
- Added F014 task breakdown (8 tasks) to `docs/tasks.md`

---

## 2026-04-17 — F013 Schedule Finalization Sprint Scope

### Documentation
- Создан consolidated closing spec: `docs/specs/F013-schedule-finalization-sprint.md`
- Создан test-cases пакет: `docs/test-cases/F013-schedule-finalization-sprint.md`
- В `docs/feature-backlog.md` schedule gap больше не размазан по старым `F013` sprint-итерациям
- В `docs/current_functionality.md` schedule updated как implemented core + one remaining finalization sprint

### Product Planning Decision
- Все оставшиеся недоработки `F013 Schedule` сведены в один sprint scope
- После завершения этого scope `F013` должен считаться закрытым
- Дальнейшие schedule-улучшения должны идти уже отдельными enhancement-пакетами

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


## 2026-05-09 — F015: Document Templates Customization (estimates)

**Added**
- New backend module `backend/src/services/documentTemplates/` with factory descriptor (estimate), inline JSON-Schema validator (no Ajv dep), renderer registry, and estimate adapter.
- DB layer `backend/src/db/documentTemplatesQueries.js`; service `backend/src/services/documentTemplatesService.js` with `resolveTemplate`, list/get/update/reset.
- REST API at `/api/document-templates` (list, get, update, reset, factory, preview), mounted in `src/server.js` behind `tenant.integrations.manage` (P0; dedicated `tenant.documents.manage` to follow).
- Migration `backend/db/migrations/084_create_document_templates.sql` — table + unique partial index for one default per (company, document_type) + idempotent factory seed per existing company.
- Frontend Settings: `pages/DocumentTemplatesPage.tsx` (list grouped by document type), `pages/DocumentTemplateEditorPage.tsx` (form-based editor: brand / theme / sections visibility / Terms & Warranty Markdown / reset). Routes `/settings/document-templates[/:id]`. Typed API client in `services/documentTemplatesApi.ts`; types in `types/documentTemplates.ts`.

**Changed**
- `backend/src/services/estimatePdfService.js` now accepts an optional `descriptor` parameter (DocumentTemplateDescriptor v1); falls back to factory when omitted; legacy exports `COMPANY_PROFILE` and `DEFAULT_TERMS_AND_WARRANTY` preserved (now derived from factory). Section rendering iterates `descriptor.sections` honoring per-section `visible` flag.
- `backend/src/services/estimatesService.js#generatePdf` resolves the company's default template via `documentTemplatesService.resolveTemplate('estimate')` and passes it to the renderer.

**Tests**
- `tests/services/documentTemplatesService.test.js` — validator + service unit tests (12 cases).
- `tests/services/estimatePdfRendererTemplate.test.js` — renderer integration: factory fallback, descriptor parity, section toggling, brand override (5 cases).
- Existing `tests/estimatePdfService.test.js` continues to pass.

**Notes**
- No new runtime dependencies (validator is hand-rolled, ~80 lines).
- Designed for `invoice` and `work_order`: extending `document_type` CHECK + adding a factory + registering an adapter is sufficient; the Settings page already lists by registered type label.

## 2026-06-03 — F016: VAPI AI Marketplace Integration + Call Flow Gating

**Added**
- New marketplace app `vapi-ai` registered via `backend/db/migrations/088_seed_vapi_ai_marketplace_app.sql` (provisioning_mode: none, category: telephony, status: published).
- `backend/src/db/marketplaceQueries.js` — migration 088 added to `ensureMarketplaceSchema`, idempotent seed runs on startup.
- `frontend/src/services/vapiApi.ts` — typed API client for `/api/vapi/*`: `getConnections`, `createConnection`, `getResources`, `createResource`.
- `frontend/src/pages/VapiSettingsPage.tsx` — full settings page at `/settings/integrations/vapi-ai`: step 1 API key verify, step 2 SIP resource, Finish Setup → marketplace install. View mode when already connected. Disconnect with confirmation.
- Route `/settings/integrations/vapi-ai` registered in `App.tsx` with `tenant.integrations.manage` permission.

**Changed**
- `frontend/src/pages/IntegrationsPage.tsx` — VAPI AI tile shows "Configure"/"Manage" button that navigates to `VapiSettingsPage` instead of opening the generic `MarketplaceConnectDialog`.
- `frontend/src/pages/telephony/CallFlowBuilderPage.tsx` — `vapi_agent` node gated behind active VAPI connection: on mount fetches `GET /api/vapi/connections`, hides node from insert picker if no active connection found.

**Tests**
- `tests/routes/vapi.test.js` — 8 test cases covering: connections list, missing api_key (400), invalid key (400), network error (400), missing resource fields (400), API key not exposed in response, server mount middleware.
- `tests/routes/marketplaceMount.test.js` — 2 new cases: migration 088 file content check, marketplaceQueries.js loads 088.

**Architecture**
- Connection flow: `POST /api/vapi/connections` → `POST /api/vapi/resources` → `POST /api/marketplace/apps/vapi-ai/install` (provisioning_mode: none → instant connected).
- Disconnect: standard `POST /api/marketplace/installations/:id/disconnect`.
