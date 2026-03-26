# Спецификация: PF101 — P0 DB Tables & API Contracts

**Дата:** 2026-03-24
**Статус:** Proposed
**Основа:** `PF001..PF006`

---

## Цель

Зафиксировать единый proposed blueprint для:

- новых и расширяемых таблиц;
- HTTP API contracts;
- совместимости с текущими routes и data flows.

Этот документ не заменяет детальные PF-specific specs, а собирает их в одну инженерную карту.

---

## Общие правила

1. Не вводить параллельные primary tables для уже существующих `contacts`, `leads`, `jobs`, `tasks`, `payments`.
2. Новые таблицы добавляются только там, где появляется новый домен:
   - documents
   - payment collection
   - portal
   - automations
3. `Schedule` строится как aggregated read/write layer поверх существующих сущностей.
4. Canonical business events должны сохраняться отдельно от HTTP-response side effects.

---

## Existing Tables Reused

### Reuse without replacement

- `contacts`
- `timelines`
- `tasks`
- `calls`
- `recordings`
- `transcripts`
- existing jobs-related tables / Zenbooker sync storage
- existing leads-related tables
- existing payment sync storage behind `/api/zenbooker/payments`

### Existing tables that likely need extension

- `tasks`
  - добавить schedule-related fields, если текущего `due_at` недостаточно
- job storage
  - нормализованный доступ к `start_at`, `end_at`, `assigned providers`, если сейчас это только в raw payload
- contact/payment linkage
  - возможность хранить portal token ownership и связанный payment history

---

## Proposed Tables

## PF001 — Schedule / Dispatcher

### `dispatch_settings`

- `id`
- `company_id`
- `timezone`
- `day_start_hour`
- `day_end_hour`
- `slot_interval_minutes`
- `default_view`
- `created_at`
- `updated_at`

Назначение:

- company-level dispatch settings;
- не дублирует telephony business hours.

### `tasks` extension

Добавить при необходимости:

- `start_at`
- `end_at`
- `assigned_provider_id`
- `show_on_schedule`

Назначение:

- позволить задачам жить на unified schedule без отдельной `schedule_tasks` таблицы.

## PF002 — Estimates

### `estimates`

- `id`
- `company_id`
- `contact_id`
- `lead_id`
- `job_id`
- `status`
- `document_number`
- `currency`
- `subtotal_amount`
- `discount_amount`
- `tax_amount`
- `total_amount`
- `deposit_required`
- `deposit_type`
- `deposit_value`
- `deposit_paid_amount`
- `signature_required`
- `signed_at`
- `client_note`
- `internal_note`
- `expires_at`
- `sent_at`
- `approved_at`
- `declined_at`
- `created_by`
- `updated_by`
- `created_at`
- `updated_at`

Notes:

- `contact_id` is always required;
- at least one of `lead_id` or `job_id` is required;
- `lead_id` and `job_id` may coexist on the same estimate;
- lead conversion to job updates relationships, not estimate lifecycle stage.

### `estimate_items`

- `id`
- `estimate_id`
- `sort_order`
- `name`
- `description`
- `quantity`
- `unit`
- `unit_price`
- `taxable`
- `line_total`

### `estimate_revisions`

- `id`
- `estimate_id`
- `revision_number`
- `snapshot_json`
- `created_by`
- `created_at`

### `estimate_events`

- `id`
- `estimate_id`
- `event_type`
- `payload_json`
- `created_at`
- `actor_type`
- `actor_id`

## PF003 — Invoices

### `invoices`

- `id`
- `company_id`
- `contact_id`
- `lead_id`
- `job_id`
- `estimate_id`
- `status`
- `document_number`
- `currency`
- `subtotal_amount`
- `discount_amount`
- `tax_amount`
- `total_amount`
- `amount_paid`
- `balance_due`
- `due_at`
- `payment_terms_code`
- `client_note`
- `internal_note`
- `sent_at`
- `voided_at`
- `created_by`
- `updated_by`
- `created_at`
- `updated_at`

Notes:

- invoice may preserve `lead_id`, `estimate_id`, and `job_id` together when sales and work context must remain traceable;
- invoice remains a separate document lifecycle even when linked to job and estimate.

### `invoice_items`

- `id`
- `invoice_id`
- `sort_order`
- `name`
- `description`
- `quantity`
- `unit`
- `unit_price`
- `taxable`
- `line_total`

### `invoice_revisions`

- `id`
- `invoice_id`
- `revision_number`
- `snapshot_json`
- `created_by`
- `created_at`

### `invoice_events`

- `id`
- `invoice_id`
- `event_type`
- `payload_json`
- `created_at`
- `actor_type`
- `actor_id`

## PF002 + PF003 shared delivery/attachment layer

### `document_deliveries`

- `id`
- `company_id`
- `document_type`
- `document_id`
- `channel`
- `recipient_phone`
- `recipient_email`
- `message_body`
- `portal_token_id`
- `delivery_status`
- `provider_message_id`
- `sent_by`
- `sent_at`

### `document_attachments`

- `id`
- `document_type`
- `document_id`
- `attachment_kind`
- `revision_number`
- `storage_key`
- `filename`
- `content_type`
- `checksum_sha256`
- `size_bytes`
- `uploaded_by`
- `created_at`

### `document_delivery_attachments`

- `id`
- `document_delivery_id`
- `document_attachment_id`
- `disposition`
- `created_at`

Notes:

- email deliveries may reference one or more generated PDF attachments;
- SMS deliveries usually do not have attachment rows and rely on portal link only.
- the same shared layer is used for both estimate PDFs and invoice PDFs.

## PF004 — Payment Collection

### `payment_transactions`

- `id`
- `company_id`
- `contact_id`
- `estimate_id`
- `invoice_id`
- `job_id`
- `source_type`
- `method_type`
- `reference_number`
- `memo`
- `provider`
- `provider_transaction_id`
- `status`
- `amount`
- `currency`
- `posted_at`
- `recorded_by`
- `created_at`
- `updated_at`

### `payment_receipts`

- `id`
- `payment_transaction_id`
- `receipt_number`
- `receipt_url`
- `sent_via`
- `sent_at`

## PF005 — Client Portal

### `portal_access_tokens`

- `id`
- `company_id`
- `contact_id`
- `token_hash`
- `scope_type`
- `scope_id`
- `expires_at`
- `revoked_at`
- `created_by`
- `created_at`

### `portal_sessions`

- `id`
- `portal_access_token_id`
- `contact_id`
- `started_at`
- `last_seen_at`
- `ip_address`
- `user_agent`

### `portal_events`

- `id`
- `portal_session_id`
- `contact_id`
- `event_type`
- `entity_type`
- `entity_id`
- `payload_json`
- `created_at`

## PF006 — Automation Engine

### `domain_events`

- `id`
- `company_id`
- `event_family`
- `event_type`
- `entity_type`
- `entity_id`
- `occurred_at`
- `payload_json`
- `dedupe_key`

### `automation_rules`

- `id`
- `company_id`
- `name`
- `status`
- `trigger_family`
- `time_mode`
- `cooldown_minutes`
- `created_by`
- `updated_by`
- `created_at`
- `updated_at`

### `automation_rule_conditions`

- `id`
- `rule_id`
- `field_key`
- `operator`
- `value_json`
- `sort_order`

### `automation_rule_actions`

- `id`
- `rule_id`
- `action_type`
- `config_json`
- `sort_order`

### `automation_dispatch_queue`

- `id`
- `rule_id`
- `domain_event_id`
- `scheduled_for`
- `status`
- `attempt_count`
- `locked_at`
- `locked_by`
- `last_error`

### `automation_executions`

- `id`
- `rule_id`
- `domain_event_id`
- `queue_id`
- `status`
- `started_at`
- `finished_at`
- `result_json`
- `error_message`

---

## API Contracts

## PF001 — Schedule

### Internal Auth Required

- `GET /api/schedule/items`
- `GET /api/schedule/items/:entityType/:entityId`
- `PATCH /api/schedule/items/:entityType/:entityId/reschedule`
- `PATCH /api/schedule/items/:entityType/:entityId/reassign`
- `POST /api/schedule/items/from-slot`
- `GET /api/schedule/settings`
- `PATCH /api/schedule/settings`

### Notes

- `entityType` in P0: `job | lead | task`
- canonical consumer: `/schedule`

## PF002 — Estimates

### Internal Auth Required

- `GET /api/estimates`
- `POST /api/estimates`
- `GET /api/estimates/:id`
- `PATCH /api/estimates/:id`
- `POST /api/estimates/:id/send`
- `GET /api/estimates/:id/pdf`
- `POST /api/estimates/:id/approve`
- `POST /api/estimates/:id/decline`
- `POST /api/estimates/:id/link-job`
- `POST /api/estimates/:id/sync-to-job`
- `POST /api/estimates/:id/copy-to-job`
- `POST /api/estimates/:id/copy-to-invoice`
- `GET /api/estimates/:id/payments`

### Public / Portal

- `GET /api/portal/estimates/:token/:estimateId`
- `POST /api/portal/estimates/:token/:estimateId/approve`
- `POST /api/portal/estimates/:token/:estimateId/decline`

## PF003 — Invoices

### Internal Auth Required

- `GET /api/invoices`
- `POST /api/invoices`
- `GET /api/invoices/:id`
- `PATCH /api/invoices/:id`
- `POST /api/invoices/:id/send`
- `GET /api/invoices/:id/pdf`
- `POST /api/invoices/:id/void`
- `POST /api/invoices/:id/sync-items`
- `GET /api/invoices/:id/payments`

### Public / Portal

- `GET /api/portal/invoices/:token/:invoiceId`

## PF004 — Payments

### Canonical Internal Auth Required

- `GET /api/payments`
- `GET /api/payments/:id`
- `POST /api/payments/manual`
- `POST /api/estimates/:id/payments`
- `POST /api/invoices/:id/payments`
- `POST /api/payments/:id/send-receipt`

### Compatibility Layer

- current `/api/zenbooker/payments*` remains supported during migration;
- `/payments` frontend should move to canonical `/api/payments` after unified ledger is ready.

## PF005 — Portal

### Public Token-Based

- `POST /api/portal/links`
- `GET /api/portal/session/:token`
- `GET /api/portal/inbox/:token`
- `GET /api/portal/bookings/:token`
- `PATCH /api/portal/profile/:token`
- `GET /api/portal/payments/:token`

## PF006 — Automations

### Internal Auth Required

- `GET /api/automations`
- `POST /api/automations`
- `GET /api/automations/:id`
- `PATCH /api/automations/:id`
- `POST /api/automations/:id/pause`
- `POST /api/automations/:id/resume`
- `GET /api/automations/:id/executions`
- `GET /api/automations/templates`

---

## Canonical Domain Events

### Schedule / Jobs / Leads / Tasks

- `job.created`
- `job.updated`
- `job.rescheduled`
- `job.assigned`
- `lead.created`
- `lead.updated`
- `lead.scheduled`
- `task.created`
- `task.updated`
- `task.completed`

### Estimates

- `estimate.sent`
- `estimate.viewed`
- `estimate.approved`
- `estimate.declined`
- `estimate.deposit_paid`

### Invoices

- `invoice.sent`
- `invoice.viewed`
- `invoice.overdue`
- `invoice.paid`
- `invoice.voided`

### Payments

- `payment.recorded_manually`
- `receipt.sent`

### Portal

- `portal.opened`
- `contact.updated_by_client`

### Communications

- `message.inbound`
- `call.missed`
- `voicemail.received`

---

## Compatibility / Migration Notes

1. `Schedule` не получает отдельную `schedule_items` таблицу.
2. `/payments` мигрирует на canonical payment API, но legacy Zenbooker routes не ломаются сразу.
3. `Actions & Notifications` остаётся UI surface, но backend logic постепенно переезжает на `automation_rules`.
4. `Portal` не создаёт отдельный customer account domain.
5. `Estimate` и `Invoice` используют совместимый item contract, чтобы потом без боли подключить `Price Book`.
