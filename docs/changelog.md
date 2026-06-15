# Blanc Contact Center — Changelog

> Лог изменений проекта.

---

## 2026-06-14 — SCHED-ROUTE-001: Schedule routes & address geocoding (SR-09…SR-12)

Completes the route-scheduling feature on top of the backend foundation
(migration 107, route engine, workers). Branch-only — NOT deployed; migrations
107 + 108 and the seed script run on prod only after explicit approval.

### Backend
- **C-3 tz-aware day filter** (`scheduleQueries.getScheduleItems`) — jobs/leads/
  tasks day boundaries are grouped in the company timezone (sargable `AT TIME
  ZONE` on the date bounds only) so the route day matches the visible day.
  Validated against ephemeral postgres (a 22:00-local job no longer leaks into
  the next UTC day).
- **Schedule read exposes geocoding state** — `lat/lng/normalized_address/
  geocoding_status` added to the unified UNION (jobs real, leads lat/lng, tasks
  null) plus a generated `google_maps_url`; zero Google calls on read.
- **SR-10 backfill** — migration 108 marks coord-bearing jobs
  `geocoding_status='success'` with no paid call (idempotent); `scripts/
  backfill-route-segments.js` seeds today+future tech-days per company-local tz
  via the idempotent `reconcileTechDay` (with `--dry-run`).

### Frontend
- Clickable Google Maps address on schedule cards (stopPropagation) + job
  detail panel; subtle geocoding hint (Locating… / Approx. / No location).
- Route connectors between consecutive jobs in List / Timeline-Week (stacked)
  and Timeline (hourly grid — leg label anchored to each card, pointer-events
  -none); shows `distance · duration` or a human status. Pure formatters in
  `utils/routeFormat.ts`. No client-side Google calls.
- New Job modal (title + AddressAutocomplete) on slot click → `createFromSlot`
  with address/coords (server skips paid geocode when coords present). Created
  unassigned by design (slot ids are ZenBooker ids, not crm_users.id).

### Tests
- SR-12 fills recalc edge cases: address-change re-stale+recalc, reconcile
  idempotency, multi-tech fan-out + before/after dedupe, schedule-read makes
  zero Google calls. Full suite 85/85 green. Frontend: `tsc` + production build
  clean (no frontend test runner in this project).

### Gap closure (SR-13…SR-16) — full implementation before deploy
- **FR-002 job location editing** — `PATCH /api/jobs/:id/location` +
  `jobsService.updateJobLocation`: edits the service address (and/or coords from
  AddressAutocomplete), sets `geocoding_status`, enqueues async geocode when an
  address arrives without coords, and recalcs the affected technician/day
  segments (capturing before-tech-days so a moved job repairs its old sequence).
  `/:id/coords` is now recalc-aware. Inline AddressAutocomplete editor added to
  the job detail Location section.
- **FR-001.4 assign-on-create** — NewJobModal passes the lane provider (ZenBooker
  shape); `createManualJob` resolves the internal crm_users.id mirror via the
  provider bridge, so a job created in a lane is both assigned and routed
  correctly (C-2).
- **C-12 ZenBooker best-effort sync** (enabled) — `FEATURE_ZENBOOKER_SYNC`
  (default ON) + async `zb_job_sync` agent: one-shot, dedupe-guarded (skips if a
  `zenbooker_job_id` already exists), stores the returned id, marks
  `jobs.zb_sync_status`, and never rolls back the local job on ZB failure.
  Migration 109 adds `jobs.zb_sync_status`.
- **C-13 retention** — `purgeStaleSegments(>30d)` + `pruneRouteCache(>180d)` +
  `scripts/purge-route-data.js` (`--dry-run`) so neither table grows unbounded.
- Tests: +10 gap cases (location edit, assign resolve, ZB dedupe/success/failure,
  flag default, retention SQL). Full SCHED-ROUTE-001 suite 95/95 green; migration
  109 idempotency verified on ephemeral postgres; frontend `tsc` + build clean.
- Known follow-up: distance units still `mi`-only (no company unit/locale field
  yet); ZB job-address PATCH not available in their API, so address edits on an
  already-synced job are recorded locally only.

---

## 2026-06-14 — AUTH-2FA-GATE: global 2FA re-verification gate (P1 lockout fix)

Functional testing of new-tenant signup found a P1 bug: the frontend had ZERO
handling of `401 PHONE_VERIFICATION_REQUIRED`, so a user with a verified phone
got locked out of the whole app (raw "HTTP 401") once the trusted-device cookie
expired (30d) or on a new device.

### Frontend
- `services/twoFactorGate.ts` — coordinator deduping concurrent 401s into one
  in-flight re-verification.
- `services/apiClient.ts` `authedFetch` — intercepts 401
  `PHONE_VERIFICATION_REQUIRED`, surfaces the gate, awaits re-trust, retries once.
- `components/auth/TwoFactorGate.tsx` — Blanc overlay; auto-sends a code to the
  user's stored phone (masked hint, no re-entry), 6-digit input + resend, verify
  -> trust-device (30d cookie) -> unblock. Mounted at App root.

### Confirmed (no change needed)
- Phone reuse across accounts already works (identity = email; trusted-device
  keyed by user.id; no phone uniqueness constraint or "in use" check).

### Backend
- Unchanged (authDevice.js endpoints already existed, 2FA-exempt).

### Validation
- tsc clean; browser E2E on prod (qa-test): gate -> auto-send -> resend -> verify
  -> trusted -> billing loaded seamlessly, no re-login; device stays trusted.

---

## 2026-06-13 — PAY-CONS-001: consolidate zb_payments into the canonical ledger (debt #6)

Zenbooker is the master payment system, so its data is authoritative. The legacy
`zb_payments` cache is now projected into the canonical `payment_transactions`
ledger, removing the dual-source read in analytics. `zb_payments` is kept as the
Zenbooker staging cache (the payments UI reads its denormalised fields).

### Backend
- Migration `104_consolidate_zb_payments_into_ledger.sql` — partial unique index
  `uq_payment_tx_external_zb (company_id, external_id) WHERE external_source='zenbooker'`
  + idempotent backfill of `zb_payments` → `payment_transactions`
  (`payment_method='zenbooker_sync'`, status mapped succeeded→completed /
  failed / voided, job resolved via `jobs.zenbooker_job_id`). Zenbooker-priority
  on conflict. Does NOT touch `fact_payments`/marts (external /pulse ETL).
- `zenbookerPaymentsSyncService.projectCompanyLedger(companyId)` — write-through
  called after each sync so the ledger stays current (idempotent, non-fatal).
- `analyticsService.listJobs` now reads only `payment_transactions` with
  Zenbooker-priority (prefer `zenbooker_sync` rows when present, else native);
  the `zb_payments` fallback is gone.

### Validation (prod-data copy)
- Backfill 1027 rows; ran twice — idempotent. Per-job paid totals **0/1164
  mismatches** vs the legacy path; grand total $197,253.26 identical to the cent.
- Write-through projection re-verified independently: 1027 rows, ledger total =
  zb succeeded total.

### Tests
- `tests/paymentsConsolidation.test.js` — projection SQL (Zenbooker-priority
  upsert, status mapping, company scope) + analytics single-source read. Full
  suite: 699 pass, 22 pre-existing failures unchanged (no new regressions).

### Decisions (owner-confirmed mapping; recommended defaults elsewhere)
- Master = Zenbooker → zb data wins on conflict (owner, 2026-06-13).
- Keep `zb_payments` as staging (not dropped) — reversible, UI depends on it.
- `fact_payments`/marts untouched (fed externally).

---

## 2026-06-13 — ARM-001: faithful AR-config → rules migration (debt #3)

Closes the un-blocked half of refactor debt #3 so flipping
`FEATURE_RULES_ENGINE_AR` on prod no longer silently resets customised
action-required behaviour.

### Backend
- `ruleActions.create_task` now accepts `sla_minutes` → computes a relative
  `due_at` (an explicit `due_at` still wins). Carries the legacy AR
  `task_sla_minutes` faithfully.
- `rulesSeed.js` refactored around a shared `buildRulesFromConfig(config)`:
  - `seedDefaultRules` — static defaults for fresh companies, `ON CONFLICT DO
    NOTHING` (never clobbers admin edits).
  - `migrateCompanyARConfig` — reads the company's real
    `action_required_config` (priority / SLA / enabled) and upserts the system
    rules `DO UPDATE` (authoritative cutover).
- `POST /api/automation/rules/migrate-ar` (`tenant.company.manage`) triggers the
  per-company cutover.
- `voicemail` trigger intentionally not migrated — no domain-event source yet
  (documented in REFACTOR-REPORT §7).

### Tests
- `tests/arConfigMigration.test.js` — 8 tests: config→rule mapping (custom
  priority/SLA, disabled propagation, legacy defaults), `migrate-ar` DO UPDATE +
  scope, `seed-defaults` DO NOTHING, and `create_task` SLA→dueAt (relative,
  explicit-wins, null). Existing `automationE2E` still green. Full suite: 696
  pass, 22 pre-existing failures unchanged (no new regressions).

### Still open (not done tonight)
- Debt #3 physical removal: gated on prod verification of
  `FEATURE_RULES_ENGINE_AR` (no deploy per owner).
- Debt #5 (Redis/BullMQ queue): deferred until load grows.
- Debt #6 (`payment_transactions`↔`zb_payments` consolidation): needs owner
  sign-off on mapping semantics — analytics-regression risk.

---

## 2026-06-12 — BILLING-UI: subscription & billing cabinet (tenant-admin)

UX-first subscription cabinet at `/settings/billing` (`tenant.company.manage`),
completing the Stripe foundation from ADR-001 / commit 588c0d8.

### Frontend
- New `frontend/src/pages/BillingPage.tsx` — owner-facing cabinet on the Blanc
  design system: plan + status (trial "N days left", human "Free until <date>"),
  this-month usage bars (Text messages / Call minutes / Automations run) with
  green/amber/red thresholds against per-plan allowances, plan cards with Stripe
  Checkout upgrade, and an invoice list (date · amount · status · hosted link).
  No technical IDs (customer_id / subscription_id) surfaced.
- `frontend/src/services/billingApi.ts` client; route in `App.tsx`; "Billing"
  entry in the settings nav (`appLayoutNavigation.tsx`).
- Degraded mode: when online payments aren't enabled, upgrade buttons disable
  with an explanatory note; status/usage/invoices still render.

### Backend
- Migration `103_billing_included_units.sql` — `billing_plans.included_units`
  jsonb allowances (sms / call_minutes / agent_runs) backfilled for
  trial/starter/pro. Idempotent; verified on a prod-schema copy.
- `billingService.getInvoices`, `providerConfigured`; `GET /api/billing` now
  returns `invoices` + `billing_enabled`; new `GET /api/billing/invoices`.
- `routes/billingWebhook.js` — Stripe webhook (raw body, no auth, signature
  verified), mounted in `src/server.js` before `express.json` (path-scoped, no
  effect on other routes).
- `createCheckout` returns 422 `PROVIDER_NOT_CONFIGURED` when `STRIPE_SECRET_KEY`
  is absent (degraded mode).
- `bootstrapCompany` starts the 14-day trial on signup (idempotent, non-blocking).
- Hardened `stripeProvider.parseWebhook`: length-guard before `timingSafeEqual`
  (a malformed signature now rejects cleanly instead of throwing `RangeError`)
  and a try/catch around `JSON.parse`.

### Tests
- `tests/billingUI.test.js` — 8 tests: trial start idempotency, usage/invoice
  mapping + tenant scope, degraded-mode 422, webhook signature accept/reject,
  route isolation. Full suite: no new regressions vs `master` (22 pre-existing
  failures unchanged, unrelated to billing).

---

## 2026-06-03 — CRM-SALES-MCP Stage 6 Testing and Rollout

### Backend
- Mounted `/api/crm` and `/api/crm/mcp` in `src/server.js` behind `authenticate, requireCompanyAccess`.
- Mounted public `/mcp/crm` transport separately with token/env-context guards.
- Hardened MCP error detail sanitization so arrays containing objects are redacted instead of leaking nested data.

### Tests
- Added rollout gate coverage for CRM/MCP route mounts, 401/403 behavior, tenant isolation SQL scopes, write permission gates, no delete tools, secret redaction, stale activity queries, slippage/history calculations, and predefined Sales workflow lists.
- Full rollout run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Stage 5 Sales Workflow Selections

### Backend
- Added `crm.list_sales_workflows` discovery metadata for ready-made Sales workflow selections.
- Centralized Sales workflow keys and defaults in `crmListsService`.
- Exposed explicit read-only MCP workflow aliases for my open deals, closing this month/quarter, deals without activity, deals without next step, risky deals, top accounts by pipeline, accounts needing follow-up, contacts missing role/title/email, and tasks due this week.
- Changed `crm.find_deals_without_activity` to support the workflow default inactivity window when `days` is omitted.
- Made `tasks_due_this_week` use the current calendar week instead of a rolling seven-day window.
- Closed Stage 5 gaps: workflow date windows now use company timezone, `my_open_deals` requires current actor scope and rejects cross-owner scope, and invalid explicit `days` values are no longer masked by defaults.

### Tests
- Full CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Stage 4 Write Tools

### Backend
- Added typed MCP write tools for the allowed update surface: `deal.next_step`, `deal.stage`, `deal.forecast_category`, `deal.close_date`, `deal.amount`, `deal.risk_summary`, `deal.competitor`, and `task.status`.
- Kept writes routed through CRM services so tenant scope, allowlist checks, before/after responses, request id propagation, and audit logging stay centralized.
- Added runtime schema support for `number` and nullable typed write values; `amount` rejects negative/non-number values and `close_date` rejects invalid calendar dates before dispatch.
- Closed Stage 4 gaps: executor now generates `crm-mcp-*` request ids when upstream context is missing, generic `crm.update_deal_field` validates `value` by selected field, create task/note write tools return before/after envelopes, and empty `forecast_category` clears to `null`.
- Confirmed no bulk/delete MCP tools are registered.

### Tests
- Full CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Cross-stage Audit

### Backend
- Verified Stage 0-3 CRM/MCP alignment across `/api/crm`, MCP registry/executor, public/SSE/stdio transports, read-only tools, and pipeline/forecast analytics.
- Tightened MCP runtime schema validation so required typed fields reject `null`; nullable typed write values remain allowed only for explicit field clearing.
- Confirmed registry has 40 read tools and 11 write tools; all write tools require confirmation and `sales.crm.write`; no bulk/delete tools are registered.

### Tests
- Targeted CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

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

## AUTO-001 — Automation/Rules Engine E2E (2026-06-13)
Делает заложенный в ADR-001 rules-engine рабочим end-to-end.
- **eventCatalog.js** + `GET /api/automation/catalog` — каталог событий/действий/agent-типов для редактора.
- **agentWorker.js** + **agentHandlers.js** — фоновый исполнитель kind=agent задач (atomic claim FOR UPDATE SKIP LOCKED, queued→running→succeeded/failed, эмит agent_task.*); хендлеры mcp_tool (вызов CRM MCP в tenant-контексте), summarize_thread, noop.
- **rulesSeed.js** + `POST /rules/seed-defaults` — AR-эквивалентные системные правила (sms.inbound, call.missed), идемпотентно.
- conversationsService/inboxWorker эмитят `sms.inbound`/`call.missed`; legacy AR за флагом FEATURE_RULES_ENGINE_AR; arConfigHelper → @deprecated.
- Frontend: AutomationPage + RuleEditor (trigger→conditions→actions, превью шаблонов) + run history + nav `/settings/automation` (tenant.company.manage).
- API: agent-tasks list + retry (409 на running, 404 на чужой).
- Миграция 102 (is_system marker). Тесты: 13 новых (worker claim, handlers, route guards 422/404/409, seed идемпотентность). Полный сьют 687 pass.
