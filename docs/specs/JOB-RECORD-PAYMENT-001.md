# JOB-RECORD-PAYMENT-001 — Offline payment recording from the Job card

**Status:** spec (orchestration run, Codex implementer)
**Owner decisions:** visibility = reduce job Due + payments list on the card · attribution = job-level (no invoice picker) · methods = Cash + Check only · button layout = Option A (full-width split footer inside the summary card).

## 1. Problem & goal

The Job financials card can only take **card** payments (Stripe ad-hoc, "Collect payment"). The owner needs to **record offline payments (cash / check)** against a job — amount, method, reference number, payment date, internal note — landing in the **same canonical payments ledger** (`payment_transactions`) as card payments, with the method persisted. Recorded payments (and the existing job-level card payments, which today don't show) must **reduce the job's Due** and appear as a **payments list** on the card.

## 2. Functional requirements

- FR1 — Rename the existing "Collect payment" button → **"Pay by Card"**. Behavior unchanged (opens `CollectPaymentDialog`, gated `canCollect && stripeReady`).
- FR2 — Add a **"Record Payment"** button (offline). Visible when the user has `payments.collect_offline`; **does NOT require Stripe**.
- FR3 — Button row = **Option A**: footer INSIDE the ESTIMATED/INVOICED/DUE card, `mt-px` hairline over `bg-[var(--blanc-line)]`, `grid grid-cols-2 gap-2 bg-[var(--blanc-panel-surface,#fffdf9)] px-4 py-3`; "Pay by Card" = primary violet (CreditCard), "Record Payment" = `variant="outline"` (Banknote), both `w-full`. If only one button applies → it spans full width (single column). Footer renders if either applies.
- FR4 — "Record Payment" opens a **right-side panel** (FORM-CANON) with fields: **Amount** (number, prefill = job Due, reject ≤ 0), **Payment method** (FloatingSelect Cash/Check, default Cash), **Reference number** (text), **Payment date** (date, default today), **Internal note** (textarea). Footer: Cancel (ghost) + "Record payment" (primary).
- FR5 — On save → the payment is written to `payment_transactions` as a **job-level** row (`job_id` set, `invoice_id` NULL, `transaction_type='payment'`, `status='completed'`, `payment_method` ∈ {cash,check}, `reference_number`, `memo`, `processed_at` = the chosen date, `recorded_by` = crm user, `external_source` NULL/manual).
- FR6 — The job's **Due** = `max(totalInvoiced − (Σ invoice.amount_paid + Σ job-level ledger payments with invoice_id NULL), 0)`. Job-level ledger payments (cash/check AND card) appear in a **Payments list** on the card (method · amount · date · reference).
- FR7 — Server validates: `payment_method ∈ {cash, check}` (reject others incl. credit_card/other), `amount > 0`, job belongs to the caller's company (foreign → 404).

## 3. Architecture (files, data flow)

**Storage:** reuse `payment_transactions` (mig 064) — no new table/migration. `processed_at` is the payment-date column (no `payment_date` column exists).

**Backend**
- `backend/src/services/paymentsService.js` — `createTransaction` currently hardcodes `processed_at: new Date().toISOString()` (~L81). Thread an optional `processed_at`/`payment_date` from `data` through `recordManualPayment` → `createTransaction`; when absent default to now. Keep existing method validation (extend nothing — cash/check already allowed).
- `backend/src/routes/jobs.js` — new `POST /:id/record-payment`, `requirePermission('payments.collect_offline')`. `companyId = req.companyFilter?.company_id`; verify job∈company (reuse the existing job-lookup pattern used by the sibling stripe routes ~L1037-1073) → 404 foreign; `actorId = req.user?.crmUser?.id || null` (**NEVER `req.user.sub`** — recorded_by → crm_users FK); validate `payment_method ∈ {cash,check}` and `amount > 0`; delegate to `paymentsService.recordManualPayment(companyId, actorId, { job_id: <path id>, amount, payment_method, reference_number, memo, processed_at })`. Return the created transaction.

**Frontend**
- `frontend/src/services/paymentsCanonicalApi.ts` — add optional `processed_at?: string` to `CreateTransactionData`; add a `recordJobPayment(jobId, data)` call → `POST /api/jobs/:id/record-payment` (or reuse the canonical manual call with job_id — implementer picks the job route for scoping). Ensure `fetchTransactions({ job_id, transaction_type, status })` is available.
- `frontend/src/components/jobs/JobRecordPaymentDialog.tsx` (NEW) — FORM-CANON panel, the 5 fields, props `{ open, onOpenChange, jobId, outstanding, onSuccess }` (mirror `CollectPaymentDialog.tsx`). Amount prefill = `outstanding`; date default = today (local `YYYY-MM-DD`).
- `frontend/src/hooks/useJobFinancials.ts` — additionally fetch completed job-level ledger payments (`fetchTransactions({ job_id, transaction_type:'payment', status:'completed' })`); expose them (e.g. `jobPayments`).
- `frontend/src/components/jobs/JobFinancialsTab.tsx` — rename button → "Pay by Card"; Option-A footer with both buttons + gating (FR2/FR3); mount `JobRecordPaymentDialog`; compute `totalPaid = Σ invoice.amount_paid + Σ jobPayments(invoice_id NULL).amount`; `totalDue = max(totalInvoiced − totalPaid, 0)`; render a **Payments** list (the job-level ledger rows) in/adjacent to the "Invoices & payments" section.

## 4. API contract

`POST /api/jobs/:id/record-payment` (auth, `payments.collect_offline`)
Body: `{ amount: number>0, payment_method: 'cash'|'check', reference_number?: string, payment_date?: 'YYYY-MM-DD', memo?: string }`
- 200 → `{ ok: true, data: <transaction row> }` (job-level, invoice_id null, method persisted, processed_at = payment_date or now)
- 400 → amount ≤ 0, or payment_method ∉ {cash,check}
- 404 → job not found for this company (foreign/absent)
- 401/403 → unauth / missing perm

## 5. Edge cases

- Empty payment_date → `processed_at` = now.
- No invoice on the job → Due stays clamped at 0 (payment still recorded + shown in the Payments list).
- Do **not** double-count: only job-level rows with `invoice_id NULL` are subtracted from Due (invoice payments are already in `invoice.amount_paid`).
- Amount prefilled from Due but editable (partial/overpayment allowed to record; Due clamps at 0).
- Reference/note optional.

## 6. Test cases (Jest)

- P0 TC-RP-1 (route) — valid cash payment on own job → 200, ledger row: job_id set, invoice_id null, payment_method='cash', amount, reference_number, memo, processed_at = body date, recorded_by = crm user.
- P0 TC-RP-2 (tenant) — record-payment on another company's job → 404; no ledger row.
- P0 TC-RP-3 (validation) — amount ≤ 0 → 400; payment_method='credit_card'/'other'/missing → 400.
- P0 TC-RP-4 (recorded_by) — actor from crmUser.id, never sub (FK-safe; null when crmUser absent).
- P1 TC-RP-5 (date) — body payment_date honored → processed_at = that date; absent → now.
- P1 TC-RP-6 (service) — `createTransaction` threads processed_at (default now).
- P1 TC-RP-7 (FE Due) — job-level ledger payment (invoice_id null) reduces `totalDue`; invoice payments not double-counted.
- P2 TC-RP-8 (perm) — no `payments.collect_offline` → 403.

## 7. Task plan (Codex implementer)

- **T1 (backend, paymentsService):** thread `processed_at` through `recordManualPayment`/`createTransaction` (default now). No behavior change when absent.
- **T2 (backend, jobs route + tests):** `POST /:id/record-payment` per §3/§4; backend Jest covering TC-RP-1..6, TC-RP-8.
- **T3 (FE api):** `paymentsCanonicalApi` — `processed_at` in `CreateTransactionData` + `recordJobPayment(jobId,data)` + confirm `fetchTransactions` job filter.
- **T4 (FE dialog):** `JobRecordPaymentDialog.tsx` (FORM-CANON, 5 fields, prefill/date-default).
- **T5 (FE card):** `JobFinancialsTab` rename + Option-A footer + gating + mount dialog; `useJobFinancials` fetch job payments; Due calc + Payments list. FE `npm run build` passes.

Waves: T1→T2 (backend, sequential — T2 uses T1). T3→T4→T5 (frontend; T5 depends on T3/T4). Backend group before frontend group (FE consumes the route).
