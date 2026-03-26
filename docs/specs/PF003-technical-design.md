# Technical Design: PF003 — Invoices

**Дата:** 2026-03-24
**Статус:** Proposed
**Связанный functional spec:** `PF003-invoices.md`

---

## 1. Design intent

`Invoice` закрывает finance lifecycle поверх estimate/work context и будущего payment collection layer.

Основная техническая задача:

- invoice как отдельный document domain;
- first-class link to estimate and optional link to job/lead context;
- сильная связь с `/payments`;
- canonical render pipeline for portal HTML and PDF artifact;
- отсутствие двусмысленного live sync с job/estimate после отправки.

---

## 2. Target architecture

### Frontend

Новые файлы:

- `frontend/src/pages/InvoicesPage.tsx`
- `frontend/src/components/invoices/*`
- `frontend/src/hooks/useInvoicesPage.ts`
- `frontend/src/services/invoicesApi.ts`

Extensions:

- `JobDetailPanel` finance section
- estimate detail actions
- payments detail cross-links

### Backend

Новые файлы:

- `backend/src/routes/invoices.js`
- `backend/src/services/invoicesService.js`
- `backend/src/db/invoicesQueries.js`

Reuse:

- `documentDeliveryService`
- `documentRenderService`
- payment ledger read model

---

## 3. Domain model

### Primary records

- `invoices`
- `invoice_items`
- `invoice_revisions`
- `invoice_events`

### Shared infrastructure

- `document_deliveries`
- `document_attachments`

### Associations

Invoice links to:

- `contact_id` mandatory
- `lead_id` optional
- `job_id` preferred but not mandatory
- `estimate_id` optional

Rules:

- `estimate_id` and `job_id` may coexist;
- `lead_id` may remain for sales traceability if estimate/invoice started before job creation;
- linking invoice to a later-created job must not destroy estimate lineage.

---

## 4. Snapshot strategy

Invoices must be snapshots, not live mirrors.

Rule:

- invoice copies source items on creation;
- later source edits do not mutate sent invoice silently;
- explicit `sync-items` action is the only allowed refresh path.

This prevents accidental financial drift.

---

## 5. Payment integration design

Invoice is the main payable document for `PF004`.

Technical requirements:

- invoice exposes `amount_paid` and `balance_due`;
- invoice detail exposes `Add Payment` action when `balance_due > 0`;
- payment layer writes canonical linked transactions and updates invoice aggregates;
- ledger reads can join invoice summary efficiently.

Current `/payments` page becomes the canonical reconciliation surface, not the invoice page itself.

Current P0 rule:

- no card processing or saved payment methods yet;
- initial payment recording path is internal-only and uses manual/recorded transactions with `payment_type = check`.

---

## 6. Job integration design

### In Job Detail

Job detail should show:

- linked invoices count
- latest invoice status
- total invoiced
- total paid
- balance due

### Actions

- create invoice
- open latest invoice
- sync items from job
- add payment

---

## 7. Send flow

Invoice send flow mirrors estimate send flow:

- choose SMS/email
- editable body
- preview
- portal link
- generated PDF attachment for email sends
- write `document_delivery`
- emit `invoice.sent`

Channel rules:

- SMS send uses portal link only;
- email send uses portal link plus attached invoice PDF;
- generated PDF must reference the exact invoice revision being sent.

Preview/render rule:

- internal preview, public portal, and PDF generation use the same canonical render contract;
- invoice detail page exposes this preview continuously for internal users;
- only access wrapper and output target differ.

PDF rule:

- PDF is generated from canonical invoice render data, then stored as document attachment;
- PDF should be printable and suitable for email delivery;
- SMS does not require PDF generation at send time unless it is needed for internal download.

Minimum PDF render contract should expose:

- company header data
- customer block data
- invoice metadata block
- item table rows
- totals, paid amount and balance due summary
- notes / terms block
- payment instruction block
- footer metadata for page numbering and contact reminder

Render quality rule:

- PDF output should target formal printable document quality, not browser-export quality.

---

## 8. API design

- `GET /api/invoices`
- `POST /api/invoices`
- `GET /api/invoices/:id`
- `PATCH /api/invoices/:id`
- `POST /api/invoices/:id/send`
- `GET /api/invoices/:id/pdf`
- `POST /api/invoices/:id/void`
- `POST /api/invoices/:id/sync-items`
- `GET /api/invoices/:id/payments`

---

## 9. Event model

Invoice service publishes:

- `invoice.sent`
- `invoice.viewed`
- `invoice.overdue`
- `invoice.paid`
- `invoice.voided`

Consumers:

- Pulse timeline
- automations
- portal history
- payments ledger summary refresh

---

## 10. Rollout plan

### Phase 1

- invoice CRUD
- estimate/job-connected create flow
- list/detail UI

### Phase 2

- persistent detail preview + send
- portal visibility
- job detail integration

### Phase 3

- recorded payment-linked status updates
- overdue automation hooks

---

## 11. Main risks

- status drift if invoice aggregates are not driven by linked payment records
- source document sync ambiguity
- too much standalone usage reducing reporting quality

### Mitigation

- canonical `invoice <-> payment_transactions` link with invoice payments section and shared `/payments` ledger read model
- explicit snapshot rules
- job-connected and estimate-derived paths as explicit first-class UX
