# Technical Design: PF002 — Estimates

**Дата:** 2026-03-24
**Статус:** Proposed
**Связанный functional spec:** `PF002-estimates.md`

---

## 1. Design intent

`Estimate` должен быть первым полноценным client-facing document domain, но строиться поверх текущих `Contacts`, `Leads`, `Jobs`, `Pulse`, `Quick Messages`.

Техническая цель:

- document domain without second CRM;
- finance flow parallel to operational `Lead -> Job` flow;
- delivery through portal links;
- canonical render pipeline for portal HTML and PDF artifact;
- strong event model for approvals and follow-ups.

---

## 2. Target architecture

### Frontend

Новые файлы:

- `frontend/src/pages/EstimatesPage.tsx`
- `frontend/src/components/estimates/*`
- `frontend/src/hooks/useEstimatesPage.ts`
- `frontend/src/hooks/useEstimateEditor.ts`
- `frontend/src/services/estimatesApi.ts`

Extensions:

- `LeadDetailPanel`
- `JobDetailPanel`
- `ContactsPage`
- `Pulse` action surfaces

### Backend

Новые файлы:

- `backend/src/routes/estimates.js`
- `backend/src/services/estimatesService.js`
- `backend/src/services/documentDeliveryService.js`
- `backend/src/services/documentRenderService.js`
- `backend/src/db/estimatesQueries.js`

Optional shared layer:

- `backend/src/db/documentDeliveriesQueries.js`

---

## 3. Domain model

### Primary records

- `estimates`
- `estimate_items`
- `estimate_revisions`
- `estimate_events`

### Shared infrastructure

- `document_deliveries`
- `document_attachments`

### Associations

Every estimate links to:

- `contact_id` mandatory
- `lead_id` optional
- `job_id` optional

Rules:

- at least one of `lead_id` or `job_id` must be present;
- `lead_id` and `job_id` may coexist on the same estimate;
- linking estimate to a job must not require recreating the estimate;
- estimate lifecycle and job lifecycle stay separate even when linked.

---

## 4. Item model strategy

Estimate items are the canonical first version of future finance item model.

Required fields:

- `name`
- `description`
- `quantity`
- `unit`
- `unit_price`
- `taxable`
- `line_total`
- `sort_order`

Rule:

- estimate items are document snapshots;
- they are not live pointers to mutable job fields.

---

## 5. Delivery design

### Send channels

- SMS through existing messaging infrastructure
- email through new outbound email adapter

### Composition

Send modal should reuse:

- current `Quick Messages` concepts
- existing custom-field placeholder resolution

### Channel rules

- SMS send uses portal link only;
- email send uses portal link plus attached estimate PDF;
- generated PDF must reference the exact estimate revision being sent.

### Output

Every send creates:

- `document_delivery`
- generated PDF attachment for email sends
- `estimate.sent` event
- Pulse timeline entry
- portal access link

---

## 6. Preview and portal handoff

Technical rule:

- internal preview, public portal, and PDF generation use the same canonical render contract;
- estimate detail page exposes this preview continuously for internal users;
- only access wrapper and output target differ.

That avoids two separate document renderers.

PDF rule:

- PDF is generated from canonical estimate render data, then stored as document attachment;
- PDF should be printable and suitable for email delivery;
- SMS does not require PDF generation at send time unless it is needed for internal download.

Minimum PDF render contract should expose:

- company header data
- customer block data
- estimate metadata block
- item table rows
- totals and deposit summary
- notes / terms block
- signature / approval block
- footer metadata for page numbering and contact reminder

Render quality rule:

- PDF output should target formal printable document quality, not browser-export quality;
- the sample `estimate+Kenny+Ducoste.pdf` is an acceptable styling reference for attachment-grade output.

---

## 7. Approval and deposit flow

### Estimate approval

Portal action calls estimate service:

- validate token
- validate document state
- update status
- emit domain event
- write Pulse event

### Deposit

Estimate service delegates to payment collection layer:

- request deposit
- generate checkout link
- receive payment result via payment provider/webhook
- update `deposit_paid_amount`
- emit `estimate.deposit_paid`

---

## 8. Related business flows

### Lead -> Convert/Sync to Job -> Job

- existing `convertLead` flow remains canonical job creation path;
- estimate is not a required stage of this flow;
- if lead has an estimate, created job may later be linked to that estimate;
- lead context may stay on the estimate even after `job_id` is assigned.

### Estimate -> Approval/Deposit -> Invoice

- estimate service owns approval/deposit lifecycle;
- invoice service should be able to snapshot estimate items and deposit context directly;
- invoice creation does not require estimate to be the same lifecycle object as the job.

### Estimate <-> Job relationship maintenance

- `link-job` assigns a job relationship to an existing estimate;
- `sync-to-job` explicitly pushes estimate finance context into linked job data;
- `copy-to-job` remains available for flows where a new job is created from estimate context.

---

## 9. API design

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

---

## 10. Event publishing

Estimate service publishes:

- `estimate.sent`
- `estimate.viewed`
- `estimate.approved`
- `estimate.declined`
- `estimate.deposit_paid`
- `estimate.job_linked`
- `estimate.job_synced`

These events must go to:

- `domain_events`
- Pulse timeline writer
- realtime broadcaster when relevant
- automation matcher

---

## 11. Rollout plan

### Phase 1

- draft CRUD
- list/detail page
- item editor

### Phase 2

- persistent detail preview + send
- SMS/email delivery
- Pulse events

### Phase 3

- approval + deposit
- estimate -> invoice and job-link/sync paths

---

## 12. Main risks

- duplicated message templating if estimate send flow invents its own placeholder system
- weak portal coupling if preview and client render diverge
- item model churn if not aligned with future invoices/price book

### Mitigation

- reuse `Quick Messages` concepts
- single render contract
- single item schema shared with invoices
