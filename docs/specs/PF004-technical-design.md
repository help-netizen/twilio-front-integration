# Technical Design: PF004 — Payment Collection

**Дата:** 2026-03-24
**Статус:** Proposed
**Связанный functional spec:** `PF004-payment-collection.md`

---

## 1. Design intent

Текущий `Payments` модуль уже является полезным ledger UI. Технический дизайн `PF004` должен сохранить эту инвестицию и расширить её до полноценного collection layer.

Основная идея:

- canonical internal payment model;
- unified ledger read layer;
- compatibility with current Zenbooker-synced transactions.

Current phase constraint:

- no card processor integration yet;
- no saved cards or portal self-serve charging yet;
- initial write path is recorded/manual payment linked to estimate or invoice.

---

## 2. Target architecture

### Frontend

New / updated:

- `frontend/src/services/paymentsApi.ts` canonical service
- migrate `usePaymentsPage.ts` from `/api/zenbooker/payments` to `/api/payments`
- embed collection actions into:
  - estimate detail
  - invoice detail
  - job finance section

### Backend

Новые файлы:

- `backend/src/routes/payments.js`
- `backend/src/services/paymentCollectionService.js`
- `backend/src/services/paymentsLedgerService.js`
- `backend/src/db/paymentsQueries.js`

Legacy compatibility:

- `backend/src/routes/zenbooker/payments.js` stays as sync adapter until migration ends

---

## 3. Canonical ledger model

Unified ledger should expose one read contract for:

- legacy synced transactions
- new portal-collected transactions
- manual/offline payments

Ledger row contract:

- source type
- linked document
- contact/job context
- payment method
- status
- amount
- provider references

---

## 4. Recorded payment model

Collection service in current P0 is provider-free.

Design:

- invoice/estimate `Add Payment` writes canonical `payment_transactions`;
- initial `payment_type` is `check`;
- collection service updates linked document aggregates immediately;
- ledger service remains the single read model for current and future payment rows.

---

## 5. Write paths

### Recorded collection

- internal user records payment from invoice/job/payments detail
- collection service writes canonical transaction directly
- transaction is linked to estimate or invoice
- document aggregates are recalculated immediately
- optional receipt trigger

---

## 6. Read paths

### Canonical internal API

- `GET /api/payments`
- `GET /api/payments/:id`

### Compatibility

- current `/payments` page can temporarily call old API until new ledger endpoint is ready;
- after migration, `/api/zenbooker/payments` becomes sync-only backend surface.

---

## 7. Data model

Primary tables:

- `payment_transactions`
- `payment_receipts`

Linking:

- `estimate_id` optional
- `invoice_id` optional
- `job_id` optional
- `contact_id` required where possible

Rule:

- financial source of truth moves to canonical local transaction model;
- external sync rows are mapped, not treated as separate UI domain.

---

## 8. Receipts and history

Receipt generation should be service-owned, not page-owned.

New service responsibilities:

- build receipt payload
- persist receipt metadata
- send via email/SMS adapter
- expose receipt links in portal and internal payment detail

---

## 9. Failure handling

Current P0 correction rule:

- duplicate manual creation must be prevented with basic idempotency/UX guardrails;
- invoice and estimate aggregates must be recalculated from linked payment rows after every write;
- erroneous entries must be auditable.

---

## 10. Rollout plan

### Phase 1

- canonical payment tables + service
- recorded payments
- unified read model

### Phase 2

- estimate/invoice aggregate updates
- invoice/estimate payments section
- receipt sending

### Phase 3

- full `/payments` migration to canonical endpoint
- future provider integration preparation if needed

---

## 11. Main risks

- split brain between legacy synced payments and new local payments
- duplicate manual transaction creation
- status drift between linked documents and payment rows

### Mitigation

- single ledger read model
- canonical document link on every local payment row
- aggregate recalculation from linked payments after every write
