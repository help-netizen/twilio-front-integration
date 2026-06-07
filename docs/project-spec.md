# Blanc Contact Center — Project Spec

> Обзор проекта, стек технологий, деплой, интеграции.

---

## Estimates

Estimates are client-facing repair documents created from Lead or Job financial contexts. The canonical display number is `ESTIMATE L-{leadNumber}-{sequence}`; for Job-created estimates, the sequence is scoped to the Job. The estimate UUID/database id is stable; the display number may change when the estimate is linked to a different Lead/Job context.

Core storage is relational PostgreSQL, not XML. Estimate rows hold document-level fields such as Summary, tax rate, discount type/value, archive metadata, signature requirement, and approved snapshot. Estimate items are generic custom rows with future-compatible Price Book references; item type/category may exist internally but is not shown in the estimate composer.

Lifecycle:
- Active statuses: `draft`, `sent`, `viewed`, `approved`, `declined`
- P0 send is a workflow stub that asks for `Email` or `Text` and does not mutate status.
- Approve requires at least one item and stores an approved snapshot.
- Editing any non-draft estimate resets it to `draft`; editing an approved estimate preserves the approved version in history.
- Archive sets `archived_at`/`archived_by` without changing status. Archived estimates are read-only, hidden from public portal access, and visible internally only when `All` is selected.

Client-facing Preview/PDF content includes optional Summary, items, totals, tax as an aggregate line only, and Blanc default Terms & Warranty. Per-item taxable markers are internal UI only.

---

## External Integrations API

Token-authenticated HTTP surface mounted at `/api/v1/integrations`. All endpoints share the same auth chain (`rejectLegacyAuth → validateHeaders → authenticateIntegration → rateLimiter`) and the same error envelope `{ success, code, message, request_id }`.

| Method | Path | Scope | Purpose |
|--------|------|-------|---------|
| POST | `/leads` | `leads:create` | External lead ingestion (Workiz-compatible) |
| GET  | `/analytics/summary` | `analytics:read` | Ads funnel metrics for a period |
| GET  | `/analytics/calls` | `analytics:read` | Paged inbound calls to tracking DID |
| GET  | `/analytics/leads` | `analytics:read` | Paged leads in period + tracking-call attribution |
| GET  | `/analytics/jobs` | `analytics:read` | Paged jobs linked to period's leads |

Keys are generated via:
- `backend/scripts/issue-analytics-key.js` for `analytics:read`
- the admin UI (`/api/admin/integrations`) for `leads:create`

Secrets are stored as `SHA-256(secret + BLANC_SERVER_PEPPER)` and never logged. Per-company isolation is enforced via `api_integrations.company_id` → `req.integrationCompanyId`.

---

## Twilio API Client (TWC-001)

All backend code obtains the Twilio Node SDK REST client via a single shared accessor: `getTwilioClient()` from `backend/src/services/twilioClient.js`. The first call reads `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` and constructs one `twilio(sid, token)` instance for the lifetime of the process; every subsequent caller reuses that instance and its underlying `https.Agent` keep-alive pool toward `api.twilio.com`.

Direct construction of a Twilio REST client (`twilio(sid, token)`) inside service or route functions is forbidden — a regression test enforces this for the four historical hot-spots (`reconcileStale`, `callAvailability`, `inboxWorker`, `phoneSettings`). Static helpers (`twilio.validateRequest`, `twilio.jwt.AccessToken`) are unaffected and continue to be used directly by webhook signature validators and the voice token route.

---

## Document Templates (F015)

Per-company, versioned, JSON-encoded descriptors that drive client-facing document rendering. P0 covers `document_type='estimate'`; the registry, factory, and Settings UI are designed so adding `invoice` and `work_order` is a data-only follow-up.

**Storage:** `document_templates(id, company_id, document_type, name, slug, is_default, schema_version, content JSONB, archived_at, created_*, updated_*)`. Unique partial index ensures exactly one active default per `(company_id, document_type)`. Migration `084_create_document_templates.sql` seeds the factory descriptor for every existing company.

**Descriptor (v1):** `{ schema_version, brand, theme, sections[], footer }`. Free-text fields (`terms.body_md`, `footer.text_md`) use a CommonMark Markdown subset. Validation is enforced by an inline JSON-Schema validator (`backend/src/services/documentTemplates/validator.js`) — no new runtime dependency.

**Renderer wiring:** `estimatePdfService.renderEstimatePdf(estimate, descriptor)` reads brand/theme/sections from the descriptor, falling back to the frozen factory in `services/documentTemplates/factory.js` when none is supplied. `estimatesService.generatePdf` calls `documentTemplatesService.resolveTemplate(companyId, 'estimate')` for every PDF request. Renderer adapters are pluggable via `services/documentTemplates/rendererRegistry.js` (`register(documentType, adapter)`).

**API:** `/api/document-templates` (list, get `:id`, PUT `:id`, POST `:id/reset`, POST `:id/preview`, GET `factory/:document_type`). Mounted with `authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess` (P0 reuses the integrations permission until a dedicated `tenant.documents.manage` is seeded).

**Settings UI:** `/settings/document-templates` (list grouped by `document_type`) and `/settings/document-templates/:id` (form editor: Brand, ACH, Theme color pickers, Section visibility toggles, Terms & Warranty Markdown textarea, Reset to default).

---

## Sales CRM MCP

Sales CRM MCP adds a backend CRM core plus MCP-compatible tool access for seller workflows.

**Storage:** `crm_accounts`, `crm_deals`, `crm_deal_contacts`, `crm_deal_history`, `crm_activities`, `crm_notes`, CRM metadata tables, sales task links, and optional `crm_pipeline_weekly_snapshots`.

**API:** `/api/crm` is mounted with authenticated company access and provides account/contact/deal cards, pipeline, activities, tasks, notes, metadata, predefined lists, and allowlisted writes. Direct entity access is tenant-scoped.

**MCP:** `/api/crm/mcp`, `/mcp/crm`, legacy SSE, and stdio expose the same tool registry and executor. Tools are marked `read` or `write`; write tools require `sales.crm.write` plus confirmation. Typed write tools are limited to the allowed deal fields and `task.status`, return before/after values, generate or propagate request id, and write audit. Bulk/delete tools are not registered.

**Analytics:** pipeline/forecast tools support owner/team/period scope, stage and forecast grouping, total and weighted pipeline, commit/best case/pipeline totals, changes, risky deals, and slippage. Current truth is `crm_deals`; change truth is `crm_deal_history`; snapshots are optional comparison baselines.

**Sales Workflows:** `crm.list_sales_workflows` discovers ready-made workflow selections. `crm.get_sales_list` and explicit alias tools cover my open deals, closing this month/quarter, deals without activity, deals without next step, risky deals, top accounts by pipeline, accounts needing follow-up, contacts missing role/title/email, and tasks due this week.

**Rollout:** CRM REST and authenticated MCP are mounted behind `authenticate, requireCompanyAccess`; public MCP is token-gated and fail-closed by env config. Regression tests cover auth/tenant gates, tenant isolation, write allowlist/audit, no delete tools, secret redaction, slippage/history, stale activity, and workflow lists.
