# TXN-STATUS-VOID-001 — Transaction status + manual payment void

**STATUS: APPROVED FOR BUILD**

**Tandem:** Codex owns backend + backend tests. Team lead owns design, frontend, and final gates.

## 1. CURRENT STATE

### Canonical ledger

- Finance transaction history is backed by `payment_transactions`.
- `transaction_type` CHECK: `payment | refund | adjustment`.
- `status` CHECK: `pending | processing | completed | failed | refunded | voided`.
- Source is free text; known values are `manual`, `stripe`, `zenbooker`, plus legacy
  null/empty rows.
- Schema: `backend/db/migrations/064_create_payment_transactions.sql:6-29`.
- ZB payment methods: `backend/db/migrations/182_zb_payment_methods.sql:9-20`.
- ZB is projected from staging `zb_payments` into the canonical ledger:
  `backend/src/services/zenbookerPaymentsSyncService.js:714-808`.

Status is persisted automatically by write/sync/refund/void paths. There is no payment-status
edit endpoint and this feature must not add one.

### Current finance-history UI

The Job and Invoice surfaces are **two implementations**, not a shared component.

- **Job:** `useJobFinancials` fetches only
  `transaction_type='payment' AND status='completed'`:
  `frontend/src/hooks/useJobFinancials.ts:22-38`.
- **Job row:** method/date/reference/amount + existing kebab
  (Review / Email receipt / View in Stripe), but no status:
  `frontend/src/components/jobs/JobFinancialsTab.tsx:142-155,223-270`.
- **Invoice:** local `payments` state calls `/api/invoices/:id/payments`:
  `frontend/src/components/invoices/InvoiceDetailPanel.tsx:181-189`.
- **Invoice row:** no kebab; manual rows have an inline Ban icon. Only a voided row receives
  `· Voided` and a line-through amount; other statuses are not shown:
  `frontend/src/components/invoices/InvoiceDetailPanel.tsx:761-835`.

### Paid / Due today

**Job panel reducer**

```text
Paid = Σ invoice.amount_paid
     + Σ standalone payment.amount where status=completed

Due  = Σ invoice.total
     - Σ invoice.amount_paid
     - Σ native standalone payment.amount where status=completed
```

- Invoice-linked ledger rows are excluded to avoid double count.
- ZB standalone payments count in Paid but do not create Due credit.
- Due is signed; current code does not clamp it to zero.
- Frontend: `frontend/src/components/jobs/jobFinanceMath.ts:32-69`.
- Backend Jobs-list equivalent: `backend/src/db/jobFinanceQueries.js:18-60`.
- Both already exclude voided rows through `status='completed'`; the backend also requires
  `voided_at IS NULL`.

**Invoice**

- `invoices.amount_paid` and `balance_due` are materialized on writes:
  `backend/src/db/invoicesQueries.js:718-735`.
- Read invariant is `balance_due = total - amount_paid`:
  `backend/src/db/invoicesQueries.js:13-33`.
- A void must decrement `amount_paid`; there is no invoice read-time ledger aggregation.

### Existing invoice void path

This is not greenfield:

1. Migration 197 added `voided_at`, `voided_by` and backfilled legacy manual invoice payments:
   `backend/db/migrations/197_invoice_payment_void.sql:5-98`.
2. Existing endpoint:
   `POST /api/invoices/:invoiceId/payments/:paymentId/void`,
   permission `payments.collect_offline`, transaction-wrapped:
   `backend/src/routes/invoices.js:250-279`.
3. `invoicesService.voidPayment` delegates to `paymentsService.voidInvoicePayment`:
   `backend/src/services/invoicesService.js:828-847`.
4. Service validates CRM actor, tenant-owned invoice/payment, manual origin, completed payment
   state, and repeat-idempotency:
   `backend/src/services/paymentsService.js:366-463`.
5. One SQL CTE locks the row, sets `status='voided'`, updates void fields, subtracts the amount
   from the tenant-owned invoice, reopens invoice status, and clears `paid_at` when needed:
   `backend/src/db/paymentsQueries.js:485-557`.
6. First transition logs `payment.voided` and `invoice.payment_voided`; repeat writes no audit:
   `backend/src/services/paymentsService.js:465-496`.

There is also an existing generic `POST /api/payments/:id/void`, but it currently uses
`payments.refund`, accepts no reason, has weaker standalone idempotency, and returns only the row:
`backend/src/routes/payments.js:261-281`,
`backend/src/services/paymentsService.js:308-364`.

## 2. STATUS TAXONOMY

Approved user-visible set:

| Ledger state | Type qualifier | UI label | PALETTE-V2 chip | Financial state | Terminal |
|---|---|---|---|---|---|
| `pending` | any | **Pending** | `--blanc-surface-muted`, `--blanc-ink-2`, `--blanc-line` | not counted | No |
| `processing` | any | **Processing** | `--blanc-accent-soft`, `--blanc-accent` | not counted | No |
| `completed` | `payment` | **Succeeded** | `--blanc-surface-muted`, `--blanc-success` | counted | Reversible |
| `completed` | `refund` | **Refunded** | `--blanc-accent-soft`, `--blanc-accent` | negative offset | Yes |
| `failed` | any | **Failed** | `--blanc-surface-muted`, `--blanc-danger` | not counted | Yes |
| `refunded` | `payment` | **Refunded** | `--blanc-accent-soft`, `--blanc-accent` | see §4 defect | Yes today |
| `voided` | `payment` | **Voided** | `--blanc-surface-muted`, `--blanc-ink-3` | not counted | Yes |

Rules:

- `completed` is displayed as **Succeeded**; do not expose the internal label “Completed”.
- Status chip is derived from server `status + transaction_type`; never editable.
- Existing six states need no status migration.
- The model cannot express **Partially refunded**. This task deliberately maps a partially
  refunded original to **Refunded** and keeps the math correct through its refund offset row.
  A distinct derived label is future scope.
- The ledger also cannot distinctly express **Disputed**, **Canceled**, chargeback resolution, or
  Stripe failed attempts. Disputes currently set the payment to `processing`
  (`backend/src/services/stripePaymentsService.js:1669-1705`); Stripe failures often exist only in
  session/activity records (`backend/src/services/stripePaymentsService.js:1585-1639`).

## 3. THE JOB-VIEW BUG

On initial load and every refresh, Job finance requests only:

```ts
fetchTransactions({
  job_id: jobId,
  transaction_type: 'payment',
  status: 'completed',
  limit: 100,
})
```

Source: `frontend/src/hooks/useJobFinancials.ts:22-38`.

The row renderer repeats the `status === 'completed'` predicate:
`frontend/src/components/jobs/JobFinancialsTab.tsx:142-150`.

After void, the same row becomes `status='voided'`; the next refresh therefore removes it from
`jobPayments` before rendering. The ledger row still exists, but the Job history appears to delete it.

**Fix**

- Fetch all Job transaction states and types:
  `fetchTransactions({ job_id: jobId, limit: 100 })`.
- Keep all rows in the hook for money math and history.
- Render standalone payment history with
  `invoice_id == null && transaction_type === 'payment'`, **without a status predicate**.
- Keep money reducers status-aware; only financially effective rows count.
- Voided row remains visible, receives a Voided chip, and its readable amount is struck through.

Required FE regression:

- Completed manual row is visible and counted.
- Same row changed to voided remains visible but no longer changes Paid/Due.

## 4. THE REFUND INCONSISTENCY

### What the write path does

Both generic and Stripe refund paths:

1. Insert a separate negative `transaction_type='refund', status='completed'` row.
2. Change the original positive payment from `completed` to `refunded`.

Generic: `backend/src/db/paymentsQueries.js:354-399`.
Stripe: `backend/src/services/stripePaymentsService.js:1005-1065`.

### What is wrong

- **Invoice totals:** correct today because refund code separately decrements materialized
  `invoice.amount_paid`.
- **Job Paid/Due:** wrong for partial standalone refunds. Job rollup counts only positive
  `payment + completed` rows and ignores refund rows. Once the original becomes `refunded`,
  the entire original disappears:
  - $100 payment, $30 refund → Paid becomes $0, not $70.
  - Full refund happens to produce the correct $0.
- **Company summary / analytics:** worse. They drop the original because it is no longer completed,
  then subtract the negative refund row:
  - $100 payment, $30 refund → net −$30, not $70.
  - $100 full refund → net −$100, not $0.
- Summary predicate: `backend/src/db/paymentsQueries.js:606-617`.
- Analytics predicate: `backend/src/services/analyticsService.js:360-389`.

### Approved repair — D1=A

- **Build now:**
  - gross payments count `payment` rows with status `completed OR refunded`;
  - net subtracts completed `refund` rows;
  - voided rows remain excluded;
  - apply consistently to Job frontend math, Job backend rollup, summary, and analytics;
  - add partial/full refund DB fixtures.
Shipping Refunded is blocked until this repair and its partial/full fixtures pass.

## 5. VOID SEMANTICS

### Canonical effect

- Keep the original `payment_transactions` row.
- Do not insert a negative reversal entry: an offline/manual payment did not move money.
- First void atomically sets:
  - `status='voided'`
  - `voided_at=NOW()`
  - `voided_by=req.user.crmUser.id`
  - `void_reason=<validated reason>`
- Invoice-linked payment: subtract exactly that payment from materialized invoice `amount_paid`,
  recalculate `balance_due`, invoice status, and `paid_at`.
- Standalone Job payment: no Job counter write; status-aware Job reducers stop counting it.
- Repeat void: `200`, byte-stable payment/invoice, `idempotent:true`, no second activity.
- Concurrent repeats must also converge to the same no-op result, not a 500.

### Approved eligibility

Required base predicate:

```text
transaction_type = payment
status = completed
manual/offline origin
CRM actor exists
```

Recommended boundary:

- Native manual/offline (`external_source='manual'`): voidable.
- Stripe-captured (`external_source='stripe'`): never voidable; use Stripe Refund.
- ZB (`external_source='zenbooker'`): never locally voidable; ZB is master.
- Null/empty source: never voidable; classification/backfill is future work.
- Refund/adjustment rows: never voidable.
- Pending/processing/failed/refunded/voided payments: no Void action.

For non-voidable rows, **hide** “Void transaction”; do not render a disabled dead-end item or tooltip.

Canonical endpoint should be the existing:

```http
POST /api/payments/:id/void
Content-Type: application/json

{ "reason": "Bounced check" }
```

Use `payments.collect_offline`, matching the existing invoice path. Keep the nested invoice endpoint
as a compatibility adapter until FE callers migrate; both must delegate to the same service/query.

## 6. REASON PERSISTENCE

Migration **211**:

```sql
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS void_reason TEXT;
```

Rollback 211 drops `void_reason`. It is nullable for historical rows, but the new API should require a
trimmed 1–500-character reason.

The nested invoice compatibility endpoint may temporarily omit the reason so the existing Invoice
Ban action keeps working before its FE migration; that transition writes null. A supplied reason is
always trimmed/validated/persisted.

Do **not** reuse `memo`:

- `memo` already holds original payment/source context.
- Overwriting or concatenating makes provenance and repeat-idempotency unclear.
- A dedicated column is directly queryable and does not require JSON mutation.

Surfaces:

- Compact row: status chip + amount treatment; do not crowd it with free text.
- Transaction Review/detail: show **Void reason** when present.
- Canonical activity log: first transition logs `payment.voided` with safe
  `{status, amount, currency}` only.
- Free-form reason is **not** copied to `audit_log.details`; ACTIVITY-LOG-001 forbids arbitrary
  message/note text. The activity surface says “Payment voided.” and the transaction detail owns the
  reason.
- Logger seam: `backend/src/services/financialActivityService.js:112-149`.
- Description: `backend/src/services/eventService.js:94-102`.

## 7. UX

The Void dialog is a short destructive confirmation, so a centered
`<DialogContent variant="dialog" size="sm">` is correct under `CLAUDE.md` /
`docs/specs/FORM-CANON.md`. It is not an entity panel.

Invoice copy:

```text
Void payment
This will remove the payment from the invoice and recalculate the invoice's balance.

Reason
E.g. bounced check

[Void payment] [Cancel]
```

Job standalone copy replaces “invoice” with:

```text
This will remove the payment from the job balance and recalculate Paid and Due.
```

Implementation rules:

- Reason uses `FloatingField` textarea/floating-label canon.
- Footer uses Cancel (ghost) + Void payment (destructive); exact labels above.
- Put the status chip in the transaction row beside the payment/refund identity, before the amount.
- Reuse/extract the Job row kebab for both Job and Invoice; do not maintain a second action-menu
  implementation.
- Void menu item label: **Void transaction**.
- Voided amount: `line-through`, decoration `--blanc-ink-3`, text `--blanc-ink-2`, full opacity.
  It must remain readable.
- Refunded amounts remain normal; strikethrough is reserved for Voided.
- Tokens only; no new hardcoded colors.

## 8. IMPL SKETCH + TASK LIST

### Tenancy & roles

| Surface | Company source | Key/predicate | Permission | Default roles | Blast risk |
|---|---|---|---|---|---|
| `POST /api/payments/:id/void` | `req.companyFilter.company_id` | payment `id AND company_id`; linked invoice `id AND company_id` | `payments.collect_offline` | admin/manager/provider allow; dispatcher deny | foreign payment/invoice, legacy source ambiguity |
| Job/Invoice transaction reads | `req.companyFilter.company_id` | `job_id/invoice_id AND company_id` | `payments.view` | finance-enabled roles | cross-tenant history |

Every backend surface requires T-own, T-foreign (404 + byte-stable), T-blast, full R-matrix deny
cells, and a real tenant-guard sabotage.

### T1 — migration 211: void reason (Codex/backend)

Files:

- `backend/db/migrations/211_payment_transaction_void_reason.sql`
- `backend/db/migrations/rollback_211_payment_transaction_void_reason.sql`
- `tests/invoicePaymentVoid.db.test.js`

Acceptance:

- Column applies idempotently and rollback removes only the column.
- Historical voided rows remain valid with null reason.
- New service flow persists the supplied reason.

Verify:

```bash
node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js \
  --runTestsByPath tests/invoicePaymentVoid.db.test.js \
  --testPathIgnorePatterns "/node_modules/" --runInBand
```

Sabotage `SAB-VOID-REASON`: remove `void_reason` from the UPDATE → persistence assertion goes red.

### T2 — canonical atomic void service + route (Codex/backend)

Files:

- `backend/src/db/paymentsQueries.js`
- `backend/src/services/paymentsService.js`
- `backend/src/routes/payments.js`
- `backend/src/routes/invoices.js` only for compatibility delegation/body threading
- `tests/invoicePaymentVoid.db.test.js`
- `tests/invoicePaymentVoid.routes.test.js`
- `tests/jobPaymentVoid.db.test.js` (new)
- `tests/paymentsRoute.test.js`
- `tests/financialPaymentsActivity.test.js`

Acceptance:

- Generic route accepts `{reason}` and uses `payments.collect_offline`.
- One row-locking path handles invoice-linked and standalone Job payments.
- Actor is `crmUser.id`, never Keycloak `sub`.
- Manual completed payment only; Stripe/ZB/refund/adjustment rejected `409`.
- First void updates ledger/money/activity atomically.
- Repeat and concurrent repeat are 200 no-ops; no second audit.
- Foreign ID is 404 and both tenants are byte-unchanged.

Sabotages:

- `SAB-VOID-TENANT`: remove a `company_id` predicate → T-foreign/T-blast DB test red.
- `SAB-VOID-ORIGIN`: remove manual-source guard → Stripe/ZB byte-snapshot tests red.
- `SAB-VOID-IDEMPOTENCY`: permit a second UPDATE/audit → repeat/concurrent test red.
- `SAB-VOID-AUDIT-ATOMIC`: force activity INSERT failure → payment/invoice rollback test red.

### T3 — refund accounting repair (Codex/backend + shared FE math contract)

Files:

- `backend/src/db/jobFinanceQueries.js`
- `backend/src/db/paymentsQueries.js`
- `backend/src/services/analyticsService.js`
- `frontend/src/components/jobs/jobFinanceMath.ts` (team lead applies FE edit)
- `tests/paymentRefundAccounting.db.test.js` (new)
- `frontend/src/components/jobs/jobFinanceMath.test.ts`

Acceptance:

- $100 payment − $30 refund = Paid/net $70.
- $100 payment − $100 refund = Paid/net $0.
- Gross collected retains the original $100.
- Voided payments remain $0 effect.
- Invoice and standalone Job cases agree with their intended models.

Sabotage `SAB-REFUND-NET`: revert payment inclusion to `status='completed'` only → partial/full
refund fixtures go red.

### T4 — shared transaction presentation + API types (Team lead/frontend)

Files:

- `frontend/src/services/paymentsCanonicalApi.ts`
- New shared component/helper under `frontend/src/components/payments/`
- `frontend/src/components/jobs/JobFinancialsTab.tsx`
- `frontend/src/components/invoices/InvoiceDetailPanel.tsx`

Acceptance:

- Typed void fields include `voided_at`, `voided_by`, `void_reason`.
- One status mapper implements §2.
- One shared row/menu is used by both finance surfaces.
- Status is display-only.
- Non-voidable rows do not render Void.

Sabotage `SAB-STATUS-DERIVATION`: map completed payment to raw “Completed” → status mapper test red.

### T5 — Job history retention + money invariants (Team lead/frontend)

Files:

- `frontend/src/hooks/useJobFinancials.ts`
- `frontend/src/components/jobs/JobFinancialsTab.tsx`
- `frontend/src/components/jobs/jobFinanceMath.ts`
- `frontend/src/components/jobs/jobFinanceMath.test.ts`
- Focused new row-visibility test if practical

Acceptance:

- Fetch no longer filters history to completed only.
- Voided standalone row remains visible after refresh, marked Voided, amount struck through.
- Voided row contributes $0 to Paid/Due.
- Completed row still contributes once; invoice-linked rows are not double-counted.

Sabotages:

- `SAB-JOB-VOID-VISIBLE`: restore `status:'completed'` fetch filter → voided-row fixture disappears
  and visibility test goes red.
- `SAB-JOB-VOID-PAID-DUE`: count all payment statuses → Paid/Due void fixture goes red.

### T6 — Invoice reuse + dialog (Team lead/frontend)

Files:

- `frontend/src/components/invoices/InvoiceDetailPanel.tsx`
- `frontend/src/services/invoicesApi.ts` or canonical payments API after caller migration
- Shared row/status/dialog files from T4

Acceptance:

- Existing inline Ban action is replaced by the shared kebab.
- Dialog matches §7 and sends reason.
- Successful void refreshes invoice and transactions.
- Row remains visible; amount is readable/struck; Paid/Balance/status reopen correctly.
- Visibility uses `payments.collect_offline`, not “online OR offline”.

Sabotage `SAB-INVOICE-VOID-BALANCE`: suppress invoice refresh/reversal fixture → amount-paid/balance
assertion goes red.

### T7 — full gates (Team lead; Codex supplies backend evidence)

Backend:

```bash
node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js \
  --runTestsByPath \
  tests/invoicePaymentVoid.db.test.js \
  tests/invoicePaymentVoid.routes.test.js \
  tests/jobPaymentVoid.db.test.js \
  tests/paymentsRoute.test.js \
  tests/financialPaymentsActivity.test.js \
  tests/paymentRefundAccounting.db.test.js \
  --testPathIgnorePatterns "/node_modules/" --runInBand
```

Frontend:

```bash
cd frontend && npm run build
cd frontend && npm test
```

For every named sabotage: BREAK the real production predicate/path → prove the named test red → restore
the exact uncommitted implementation → rerun green. SQL-string/mock-only controls do not count.

## DECISIONS TAKEN

- **D1:** repair refund math now in Job rollup, company summary, and analytics; partial/full fixtures required.
- **D2:** ship the six labels in §2; no separate Partially refunded label in this task.
- **D3:** every exact `external_source='manual'` payment is voidable regardless of offline method.
- **D4:** null/empty source is ineligible; classification/backfill is future scope.
- **D5:** only Voided amounts are struck through; Refunded amounts render normally.
- **Deploy:** bundle with later card-flow commits; do not deploy this task independently.
