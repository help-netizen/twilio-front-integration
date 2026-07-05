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

## Stripe Payments — Tenant Customer Payments (F018 / STRIPE-PAY-001, Phases 1–2)

A marketplace integration that lets each tenant company connect its own Stripe
account (Stripe Connect, direct charges, tenant = merchant of record, no application
fee) and collect customer payments. Strictly separate from platform subscription
billing (ADR-001): a dedicated `stripeConnectProvider` and a distinct webhook secret
(`STRIPE_CONNECT_WEBHOOK_SECRET`).

**Setup:** marketplace card `stripe-payments` → `/settings/integrations/stripe-payments`
(`tenant.integrations.manage`). A readiness state machine (`not_connected` →
`onboarding_incomplete` → `action_required` → `payments_disabled` → `payouts_disabled`
→ `connected_ready`) gates online collection; status is refreshed from Stripe via
`refresh-status` and `account.updated` webhooks.

**Collection:** authorized users create/reuse a Stripe Checkout payment link per
invoice (`payments.collect_online`); public customers pay via an opaque-token Pay-now
endpoint. Successful payments are written once to the canonical `payment_transactions`
ledger (`external_source='stripe'`) through `paymentsService.createTransaction`, with
invoice paid/balance updated via the canonical invoice path.

**Storage:** `stripe_connected_accounts` (one per company), `stripe_payment_sessions`,
`stripe_webhook_events`. Idempotency is enforced at two layers: per Stripe event id
(`stripe_webhook_events` unique) and per payment (`payment_transactions(company_id,
external_id) WHERE external_source='stripe'`). Webhook objects are tenant-scoped by
resolving the connected-account id to a company before any ledger mutation; unknown
accounts are rejected without mutation. Card data never touches Albusto (Stripe-hosted
Checkout only); secrets live in env, not tenant metadata.

**Out of scope (later phases):** manual card entry (Payment Element), Tap to Pay /
Terminal, refunds, dispute visibility, expanded reporting filters, application fees.

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

---

## Slot Recommendation Picker (SLOT-ENGINE-001)

When the slot-engine marketplace app is installed, the new-job slot picker (`CustomTimeModal`) surfaces engine recommendations as a side panel of cards. The standalone `slot-engine` service ranks candidate technician/time windows; each recommendation carries a `score`, a `confidence` tier (`high`/`medium`/`low`), an `explanation` string, and a `requires_dispatch_confirmation` flag. The engine I/O contract and ranking are unchanged by the UX polish — only how these signals are presented.

**Trust signal — temperature mini-bar.** A recommendation's quality is shown as a single thin vertical "temperature" mini-bar on the card edge: fill height scales with `score`, color maps to confidence tier (`high` → green / "Best match", `medium` → blue / "Good fit", `low` → amber-muted / "Worth a look"). The raw numeric score is off the card face, available only via the card `title`/`aria-label` for dispatchers. The earlier separate raw-score and confidence chips are gone.

**Vocabulary.** Engine recommendations use "Recommended" consistently — the panel header reads "Recommended times" and the engine tech-bar pill reads "Recommended". The pill for a technician preselected from a duplicate-job copy reads "Preselected" (distinct from engine recommendations).

**Explanation copy.** The card sub-text is a terse English reason composed by the engine's `explain(m)` from candidate metrics (e.g. "Tech already working nearby · little extra driving · comfortable schedule gap"), with the fallback "Good fit for this route". It contains no date/time/technician (the card already renders those) and no machine tokens — `snake_case` reason codes never leak to the UI. An "Approx. address — confirm" amber flag appears only when `requires_dispatch_confirmation` is set.

**Empty state.** When the app is enabled and the engine is reachable but returns zero recommendations, the panel shows "No nearby openings — try another day" rather than vanishing. The existing graceful degradation is preserved: when the app is disabled or the engine is unreachable, the panel stays absent and the modal is unchanged. The picker is new-job only; reschedule/edit mode does not render the panel or temperature bar.

---

## On-the-way ETA notification (ONWAY-001)

From a Job card in a pre-visit status (`Submitted` or `Rescheduled`), a technician or dispatcher with `messages.send` taps a primary **"On the way"** CTA. A modal does one device geolocation, optionally computes a Google travel-time ETA (device coords → job service address, via `routeDistanceService`), and offers preset minute tiles (10/15/20/30/45/60) plus a custom 1–600 entry. On **"Notify client"** Albusto sends an outbound SMS to the customer ("Hi! Your technician {tech} from {company} is on the way and should arrive in about {eta} minutes.") and **then** advances the job.

**New Job status — `On the way`.** A new non-terminal Job status (color `#0EA5E9`) joins the existing set (`Submitted`, `Waiting for parts`, `Follow Up with Client`, `Visit completed`, `Job is Done`, `Rescheduled`, `Canceled`). It is reachable **into** from `Submitted`/`Rescheduled` and **out** to `Visit completed`/`Canceled`. It has **no Zenbooker outbound mapping** and is orthogonal to the Zenbooker `en-route` substatus (`markEnroute`). The Job FSM is dual-sourced (hardcoded fallback in `jobsService.js` + per-company published SCXML); the status is injected idempotently into every company's active machine by migration `127_job_fsm_on_the_way.sql`, with mirrors in `fsm/job.scxml`, the `073` seed, and the fallback maps. Applying migration 127 on prod is a deploy prerequisite.

**Endpoints** (on the existing jobs router, both `requirePermission('messages.send')`, `company_id` from `req.companyFilter` only):
- `POST /api/jobs/:id/eta/estimate { origin:{lat,lng} }` → `{ eta_minutes|null }` — pure read; `null` when origin/address/Google key is missing.
- `POST /api/jobs/:id/eta/notify { eta_minutes }` → resolves customer phone (422 `NO_PHONE`) and a sending DID (MRU `sms_conversations` → `SOFTPHONE_CALLER_ID`, 422 `NO_PROXY`), then sends via `conversationsService.sendMessage` (wallet-gated; recorded to the customer timeline as outbound), then sets status. Ordering is **SMS first, status best-effort**: a failed/wallet-blocked SMS leaves status unchanged; a status failure after a sent SMS returns `{ ok:true, warning:'status_not_advanced' }` without rolling back the SMS.

The outbound ETA SMS reuses the canonical Conversations send path (the single wallet cost-enforcement point) and the timeline write; no new SSE event is added (the standard `job.status_changed` and conversation write drive existing real-time refresh).

---

## Email in Pulse (EMAIL-TIMELINE-001 → EMAIL-OUTBOUND-001)

Email is a first-class channel of the contact timeline, on a `MailProvider` seam (Gmail live via the `google-email` marketplace app, IMAP-ready). Inbound arrives in real time through Gmail Pub/Sub push, deduped by `provider_message_id`; outbound is sent from the Pulse composer, the standalone `/email` workspace, or Gmail itself — all three paths persist a contact link on the message (`email_messages.contact_id` / `on_timeline`, mig 129), so the timeline detail shows the thread regardless of who wrote first.

**Unified by-contact list.** The Pulse sidebar is ONE timeline-rooted, offset-paginated SQL query (`timelinesQueries.getUnifiedTimelinePage`) unifying calls + SMS + email: `last_interaction_at = GREATEST(call, sms, email)`, 3-band sort (Action-Required → unread → recency) fully in SQL. Email threads surface in **both directions**: the inbound leg text-matches `from_email` against `contact_emails` (mig 143 functional index), the outbound-first leg reads only the persisted mig-129 link — recipient JSON is never expanded in the hot query (PULSE-PERF-001 discipline). One row per contact; the newest thread across both directions wins. An outbound-first thread (dispatcher writes an email-only lead first) orders by send time, shows the outbound icon (MailCheck), and is never unread — `unread_count` grows only on inbound; a reply flips the row to inbound + unread. Migration 155 idempotently backfills links for historical outbound sends (TO-only recipient match, drafts excluded via `message_id_header`).

**Mail Secretary** — AI triage of inbound email as a marketplace app (`mail-secretary`). Hooked into the ingest path (`emailTimelineService` → `mailAgentService.reviewInboundEmail`), it creates tasks for attention-needed emails and logs exactly one decision per email in `mail_agent_reviews` (verdict/category/confidence; re-pushed notifications are no-ops). Per-company `mail_agent_settings` (migs 152–153): enabled flag, confidence threshold, unknown-sender contact creation, owner assignment, line-based exclusion rules — managed on the app's settings page, gated `tenant.integrations.manage`. It stores Gmail message references and derived triage results, never raw email bodies.

## Tasks nav badge (TASKS-COUNT-BADGE-001)

The Tasks nav item carries a live count badge of OPEN tasks visible to the current user — identical visibility to `GET /api/tasks` (managers with `tasks.manage` see the whole company; everyone else only their own). Served by `GET /api/tasks/count` (which shares `buildTaskListFilters` with `listTasks`, so count and list can never drift), refreshed on mount/route-change, a 60s poll, and a PII-free `task.changed` SSE ping (`{company_id}` only — the client refetches the server-scoped count, never computes it). Mirrors the Leads new-count badge.

## Contact email merge (CONTACT-EMAIL-MERGE-001)

Adding an email to a contact (multi-email list in the contact editor) merges any existing correspondence for that address into the contact — the email analogue of the phone-number merge. Inbox-only messages link onto the contact timeline; an address owned by an empty email-only auto-contact triggers a full contact merge (re-point + delete) via `contactEmailMergeService`; an address on a contact with its own data re-points only the emails. The whole PATCH is one transaction (a merge failure rolls back the email add); the merge is company-scoped and refuses cross-tenant.

## Email-only Pulse timelines (EMAIL-LEAD-ORIGIN-001)

A contact with an email but no phone (e.g. an email-auto-created contact) is now first-class in Pulse: the detail card renders on identity (`p.phone || p.contact?.id`), not phone; `PulseContactPanel` is phone-null-safe and carries a "+ Create Lead" action; a lead can be created from such a contact (phone optional — `POST /api/leads` accepts phone|email|contact_id origin; email-origin leads are lead-only since ZB job creation needs a phone). The card detects an existing open lead via `getLeadByContact` (mirrors `getLeadByPhone`, incl. the contact-has-job filter) so it shows the lead instead of offering a duplicate. The hot unified-list query is untouched (email-origin leads surface via the email signal + Leads page).

## Voice-agent slot recommendation (VAPI-SLOT-ENGINE-001)

The VAPI voice agent (Sara) offers engine-ranked arrival windows live on the call and turns the caller's pick into a schedule-blocking hold. A gated, safe-fail VAPI tool `recommendSlots` (in `backend/src/routes/vapi-tools.js`, behind `x-vapi-secret` + the `smart-slot-engine` marketplace gate, company hardwired to `DEFAULT_COMPANY_ID`) calls `slotEngineService.getRecommendations` directly and returns ≤3 keyed windows (`date|start|end`), with deeper-search via `excludeSlots`/`daysAhead`; any fault (app off, engine down, empty, throw) degrades to `{available:false,fallback:true}` at HTTP 200 so a live call is never crashed. On acceptance, `handleCreateLead` persists the chosen slot onto the lead — `LeadDateTime`/`LeadEndDateTime` (via `tzCombine`, a thin adapter over `companyTime.dateInTZ`) plus `Latitude`/`Longitude` — with no new entity and no migration; the lead schema already carries these columns. The held lead then occupies the engine's area-schedule: `slotEngineService.buildScheduledJobs` emits open, geo-located, in-window leads as occupancy so the same window is not re-offered, and both the occupancy sub-read and the Schedule UNION filter terminal status case-insensitively (`LOWER(status) NOT IN ('converted','lost','spam')`) so a dispatcher converting the lead→job or losing/cancelling it frees the slot. The live assistant config (`voice-agent/assistants/lead-qualifier-v2.json`) gains the tool + prompt in-repo, but pushing it to the live VAPI assistant is a separate owner-gated step.

## Agent-agnostic CRM skill layer + existing-customer skills (AGENT-SKILLS-001)

The CRM exposes its customer-service capabilities as a provider-neutral **skill layer** so the voice agent is swappable: all logic lives in `backend/src/services/agentSkills/`, and every agent (the VAPI voice adapter, an MCP client, any future agent) is a thin adapter over the same `runSkill(name, companyId, ctx, input)` choke-point. There is no business logic in an adapter. Fourteen skills are registered — the five relocated legacy VAPI tools at L0, plus nine existing-customer skills: `identifyCaller` (L0, branches the call), `getCustomerOverview`/`getJobStatus`/`getAppointments` (L1 reads), `getJobHistory`/`getEstimateSummary`/`getInvoiceSummary` (L2 sensitive reads), and `rescheduleAppointment`/`cancelAppointment` (L2 writes).

Verification is a single server-side gate (`verificationGate`): the level is re-derived from the DB every call from the identity block (phone/name/zip/street/contactId only), so a client- or LLM-asserted `verified` flag is structurally ignored — L1 needs a phone match to exactly one company-scoped contact, L2 additionally needs a confirmed name (≥2 tokens) and a ZIP/street match. `identityResolver` resolves across leads + contacts + jobs (covering the case where an existing customer's lead row is suppressed once a job exists). Reads below L2 disclose nothing sensitive (address is confirm-only, no amounts, no line items); writes and sensitive reads ownership-pre-check `getJobById(jobId, companyId)` + the verified `contactId` before any mutation or disclosure, keeping tenant isolation absolute even though some getters take a bare id. No payment is ever captured by voice.

Two adapters ship: the refactored `vapi-tools.js` (a thin generic dispatch, `DEFAULT_COMPANY_ID` for the VAPI transport; legacy tools stay byte-identical, verified by a golden capture), and a parallel `svc.*` MCP triplet (`agentSkillsMcp*` + routes/stdio, serverInfo `albusto-service-crm-mcp`) that reuses the sales `crmMcp*` validator/response as-is and leaves the sales stack untouched — tenant comes only from context, the framework write/confirmation gate composes as an outer gate over the inner L2, and public writes are off by default. Reschedule/cancel write the Albusto schedule and push Zenbooker (`rescheduleItem` gained the ZB write-through; the local write stays authoritative and a ZB failure reconciles-then-409 rather than diverging), with an "AI Phone" audit note on every write. No migration. Deploying the backend makes the skills callable; Sara only *uses* the new existing-customer skills once her assistant config declares them (new tool defs + prompt branching) and is pushed live — a separate owner-gated step.
