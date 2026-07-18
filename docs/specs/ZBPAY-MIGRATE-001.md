# ZBPAY-MIGRATE-001 — Zenbooker payment migration and imported invoices

**Status:** Owner/architect decisions settled; P1 implemented in this worktree, P2 remains planned and untouched.

## Goal

Before Zenbooker is disconnected, let the owner run a repeatable manual full-history sync flow that imports every returned Zenbooker transaction into Albusto without duplicates, links financially effective payments to their jobs, distinguishes every Zenbooker method from native Albusto methods, and prevents imported payments from creating false standalone Due credits.

P2 may synthesize a paid Albusto invoice only when the retained Zenbooker data is internally consistent. Ambiguous records remain payments-only and must never block the payment import.

## Release-blocking invariant

The signed-Due deploy must not ship without the source-aware guard in P1/T1:

```text
Paid = invoice amount paid + all completed standalone payments

Due = Invoiced - invoice amount paid
      - completed standalone payments whose external_source is NOT 'zenbooker'
```

A completed Zenbooker payment contributes to **Paid** and appears in the job payment list, but does not create standalone credit. A native/Stripe/manual standalone payment retains the existing signed-credit behavior.

Example with no invoice:

| Payment | Paid | Due |
|---|---:|---:|
| Native completed standalone $95 | $95.00 | −$95.00 |
| Zenbooker completed standalone $95 | $95.00 | $0.00 |

After P2 links an eligible Zenbooker payment to a synthesized paid invoice, the ledger row naturally leaves the standalone set and the invoice supplies **Invoiced $95.00 · Paid $95.00 · Due $0.00**.

## Settled decisions

1. Manual synchronization is sufficient. There is no realtime, webhook, scheduler, or progress-streaming requirement. The owner will run the full-history sync at cutoff/disconnect time.
2. Re-running range or full-history sync any number of times must not duplicate a Zenbooker transaction. The existing keys are the guarantee:
   - landing cache: `UNIQUE (company_id, transaction_id)`;
   - canonical ledger: unique `(company_id, external_id)` where `external_source='zenbooker'`.
3. Paid includes completed Zenbooker payments. Only non-Zenbooker standalone payments offset Due and can create a signed credit. Migration 181 remains unchanged; its partial-index predicate still covers the narrowed aggregate.
4. Canonical Zenbooker payment methods are `zb_card`, `zb_check`, `zb_cash`, `zb_ach`, `zb_venmo`, `zb_zelle`, and `zb_other`, labeled **Zenbooker · X**. Unknown/custom values map to `zb_other`; the original method, custom name, and card brand remain in metadata.
5. Stage every transaction returned by Zenbooker. Only reliably mapped, financially effective rows affect Finance. Completed payments are financial now. Refunds become financial only if implementation-time raw-payload evidence supports a deterministic mapping; otherwise they remain staged/canonical but non-completed/non-financial, with the finding appended to this spec.
6. Payment sync belongs only to `ZENBOOKER_DEFAULT_COMPANY_ID`. A non-default company receives 403 before any Zenbooker client/network call, even if it has another tenant key. All SQL remains company-scoped from `req.companyFilter?.company_id`.
7. Keep the existing range sync. Add full-history sync: a request with neither date is “all history”; `{ full_history: true }` is the explicit equivalent used by the UI. Full history processes bounded API-page chunks under an approximately 3.5-minute request budget and returns a continuation cursor when more pages remain. Supplying only one date is still 400.
8. P2 invoice eligibility is conservative: stable ZB invoice ID, one local company-scoped job, valid/consistent total, consistent paid state, and completed payment cents that reconcile to the total. Use one line item named **Imported Zenbooker invoice**. Link its ZB ledger rows through canonical `invoice_id`. Skip every ambiguous group.
9. The Job Finance 100-row limit and canonical Transactions-page `created_at` versus `processed_at` behavior are recorded debt and are not changed here.

## Current state, compressed

### Landing and projection

- `zb_payments` is the company-scoped Zenbooker landing/cache table. It stores ZB transaction, invoice, and job IDs; method/status/amount/date; invoice summary; and the raw transaction/invoice/job payloads (`backend/db/migrations/035_create_zb_payments.sql:5-52`).
- Migration 104 and the current write-through projector create canonical `payment_transactions` rows with:
  - `job_id = jobs.id` when the company-scoped ZB job join succeeds;
  - canonical `invoice_id = NULL`;
  - `transaction_type='payment'`;
  - `payment_method='zenbooker_sync'`;
  - `succeeded→completed`, `failed→failed`, `voided→voided`, everything else→pending;
  - ZB invoice ID in `reference_number`, transaction ID in `external_id`, and `external_source='zenbooker'` (`backend/db/migrations/104_consolidate_zb_payments_into_ledger.sql:20-64`; `backend/src/services/zenbookerPaymentsSyncService.js:516-546`).
- `reconcileJobLinks` recovers missing ZB job IDs from retained payloads, heals display data from local company-scoped jobs, and reprojects the whole company (`backend/src/services/zenbookerPaymentsSyncService.js:553-654`).

### Why the Due guard blocks deploy

The current job rollup and frontend summary treat every completed, invoice-less job payment as standalone money (`backend/src/services/jobsService.js:863-900`; `frontend/src/components/jobs/jobFinanceMath.ts:31-56`). Because projected Zenbooker rows have exactly that shape, a linked completed ZB payment currently produces a negative Due. The guard must separate “counted in Paid” from “allowed to offset Due.”

### Sync cadence and tenant defect

- The only payment-fetch seam is the manual `POST /api/zenbooker/payments/sync` route (`backend/src/routes/zenbooker/payments.js:17-47`) called by the Payments page (`frontend/src/hooks/usePaymentsPage.ts:51-55`). The current UI defaults to a current-month range.
- `FEATURE_ZENBOOKER_SYNC` does not schedule or trigger payment sync.
- The service currently calls global `getTransactions/getInvoice/getJob`, whose implementations use the shared `getClient()` (`backend/src/services/zenbookerPaymentsSyncService.js:344-369`; `backend/src/services/zenbookerClient.js:288-330`). It then stamps results with the request company. This is the cross-tenant hole P1 closes.

### Method and display debt

- The DB CHECK and backend/frontend vocabularies currently allow `zenbooker_sync` but no `zb_*` values (`backend/db/migrations/064_create_payment_transactions.sql:13-18`; `backend/src/services/paymentsService.js:33-35`; `frontend/src/services/paymentsCanonicalApi.ts:13-34`).
- Canonical method labels are duplicated in Transactions, transaction detail, and Job Finance (`frontend/src/pages/TransactionsPage.tsx:54-61`; `frontend/src/components/transactions/TransactionDetailPanel.tsx:26-33`; `frontend/src/components/jobs/JobFinancialsTab.tsx:44-50`).
- Analytics currently uses `payment_method='zenbooker_sync'` as provenance and must switch to `external_source='zenbooker'` before the method split (`backend/src/services/analyticsService.js:360-384`).

### Invoice feasibility

The landing row has a stable ZB invoice ID plus status/total/paid/due/paid-in-full fields and retained raw invoice JSON (`backend/db/migrations/035_create_zb_payments.sql:10-45`). Local jobs also retain ZB invoice total/status and `zb_raw` (`backend/db/migrations/031_create_jobs.sql:17-31`). Line-item and invoice-date payload shapes are not validated, and malformed/string-encoded invoice responses have occurred (`backend/src/services/zenbookerPaymentsSyncService.js:213-231`). Albusto invoices currently have no source/external-ID provenance key (`backend/db/migrations/057_create_invoices.sql:6-43`).

## API and data contracts

### Manual sync request

```http
POST /api/zenbooker/payments/sync
```

| Body | Mode | Result |
|---|---|---|
| `{ "date_from":"2026-01-01", "date_to":"2026-07-18" }` | Existing range | Sync the bounded range. |
| `{ "full_history":true }` | Full history | Fetch all API pages without transaction date bounds. This is the UI cutoff action. |
| `{}` | Full history | Server-side no-range equivalent. |
| `{ "full_history":true, "cursor":"<prior cursor>" }` | Continue | Resume after the last completed page returned by the prior call. |
| Only one of `date_from` / `date_to` | Invalid | 400 before network. |
| Dates plus `full_history:true` | Invalid/ambiguous | 400 before network. |

The response keeps the existing `{ ok:true, data:{...} }` envelope and adds `mode: 'range'|'full_history'`, `imported`, `skipped_existing`, `remaining`, `cursor`, and `last_range`. `skipped_existing` means the source transaction already occupied its company-scoped dedupe key; it may still be refreshed in place. Existing counters remain; P2 may add invoice-created/existing/skipped counters.

Full history uses an explicit server-owned budget (default about 210 seconds) and a small transaction-page size. It never starts another page after the budget is reached; the currently running page is allowed to finish. When Zenbooker has more pages, return:

```json
{
  "imported": 75,
  "skipped_existing": 25,
  "remaining": true,
  "cursor": "next-page-cursor",
  "last_range": { "from": "2025-01-01T00:00:00.000Z", "to": "2025-03-31T23:00:00.000Z" }
}
```

The UI retains that cursor and shows **Progress saved — run again to continue**. The next click posts the cursor and continues. Completion returns `remaining:false` and `cursor:null`. Imported rows are committed after every page, so restarting from the beginning after a reload is safe but may revisit deduped rows. No background job, scheduler, realtime progress endpoint, or timeout extension is added.

### Default-company gate

The route and service both enforce:

```text
companyId must exist
AND companyId === ZENBOOKER_DEFAULT_COMPANY_ID
```

- Company comes only from `req.companyFilter?.company_id`.
- Non-default company: 403.
- Missing company context: existing 403.
- The gate executes before `getClientForCompany`, `getTransactions`, invoice fetches, job fetches, or writes.
- After the gate, every Zenbooker call uses the client resolved for that same default company; no payment-sync code calls the unscoped global helpers.

### Method normalization

Normalize the raw `zb_raw_transaction.payment_method` case-insensitively:

| Raw value | Canonical method |
|---|---|
| `stripe`, `card`, `credit_card` | `zb_card` |
| `check`, `cheque` | `zb_check` |
| `cash` | `zb_cash` |
| `ach` | `zb_ach` |
| `venmo` | `zb_venmo` |
| `zelle` | `zb_zelle` |
| `custom`, empty, or any unknown value | `zb_other` |

For historical rows whose raw payload lacks `payment_method`, fall back to the retained `payment_methods` / `display_payment_method` strings only to recognize the same known values (including a `stripe (...)` prefix). An absent or ambiguous fallback remains `zb_other`; no custom label is promoted into a native-looking type.

The projector metadata includes, without customer PII:

```json
{
  "zb_payment_method": "custom",
  "zb_custom_payment_method_name": "Financing",
  "zb_card_brand": null
}
```

Keep existing job/invoice projector metadata. `external_source='zenbooker'` remains the authoritative provenance discriminator. The expanded CHECK retains legacy `zenbooker_sync` during rollout so existing rows stay valid before the first reproject; no new projector output uses it. The projector `DO UPDATE` retypes old rows in place without changing their ledger IDs.

### Financial status mapping

- A reliably identified ZB payment with status `succeeded` maps to canonical `transaction_type='payment'`, `status='completed'` and affects Paid.
- Failed, voided, pending, unknown, or unreliable transaction semantics never map to a completed payment/refund and do not affect Finance.
- **P1 implementation finding (2026-07-18):** committed fixtures contain only `succeeded` payment examples, and the official beta transactions-list reference does not publish a response schema or refund amount/sign convention. The local cache likewise stores the raw body but has no validated refund discriminator. Therefore P1 does **not** create completed refund rows. A row with a refund/reversal marker in `transaction_type`/`type`/`kind`/`action`, a refund/reversal status, or a negative retained amount is staged/projected as `transaction_type='adjustment'`, `status='pending'`; its raw kind/status remain metadata. This keeps it discoverable without changing Finance. A future completed-refund mapping requires a captured representative payload and a proven sign convention.

### Re-run guarantee

For the same company and ZB transaction ID, range/full-history overlap and repeated runs must converge to:

```text
1 zb_payments row
1 payment_transactions row with external_source='zenbooker'
0 duplicate invoice rows/items in P2
```

The sync always upserts landing rows on `(company_id, transaction_id)`. The projector always upserts on the existing source-scoped ledger key. Its conflict update refreshes job link, status, amount, normalized method, metadata, and processed date. It never inserts an additional source transaction.

## P2 imported-invoice contract

### Eligibility

Group landing rows by `(company_id, non-empty zb invoice_id)`. A group is eligible only when all conditions hold:

1. The group resolves to exactly one local job through `jobs.zenbooker_job_id`, with `jobs.company_id` equal to the import company.
2. Invoice total is finite, positive, and identical to the cent across retained summaries.
3. Retained status/paid-in-full data consistently says paid.
4. At least one linked canonical completed ZB payment exists.
5. The sum of completed ZB payment cents for the group equals the invoice total. No floating-point comparisons are allowed.
6. No completed refund/reversal is associated with the group, and no retained row contradicts the paid state.
7. No pre-existing imported-invoice provenance row points at a different job.

Missing job, conflicting jobs/totals/status, malformed values, partial/unpaid state, or a payment-total mismatch means **skip**, not error. One bad group never fails payment sync.

### Synthesized row

- Add explicit `invoices.external_source` and `invoices.external_id`, with a partial unique key on `(company_id, external_source, external_id)` for Zenbooker.
- Create one paid USD invoice per eligible ZB invoice: `subtotal=total=amount_paid`, `balance_due=0`, status `paid`, zero tax/discount, and `paid_at` from the latest completed payment date.
- Resolve `contact_id` from the local job when present; absence of a contact does not make an otherwise eligible financial import fail.
- Use a deterministic company-unique invoice number that satisfies the existing 50-character limit; preserve the complete ZB invoice ID in `external_id` rather than truncating provenance.
- Create exactly one non-taxable line item named **Imported Zenbooker invoice**, quantity 1, amount/unit price equal to total.
- `created_by`/`updated_by` stay null because this is a system import, not an acting-user mutation.
- On provenance conflict, reuse the existing synthesized invoice and ensure links; do not overwrite user-visible invoice fields or create another line item.
- Link canonical rows through a company-scoped join from `payment_transactions.external_id` to `zb_payments.transaction_id`, restricted to `external_source='zenbooker'` and the candidate ZB invoice ID. Do not infer the link from display text alone.
- Invoice creation, item creation, and ledger linking are one DB transaction. A failure rolls the group back and is counted/skipped without rolling back other payment groups.

The P2 rollback may unlink and delete only invoices explicitly tagged `external_source='zenbooker'`; it must never select or mutate a native invoice by number/title alone.

## Exact touch list

Line anchors describe the current worktree and must be rechecked immediately before implementation.

### P1 production files

| File and current lines | Planned change |
|---|---|
| `backend/db/migrations/NNN_zb_payment_methods.sql:new` + matching rollback | Next free number (current worktree and local `origin/master` both end at 181, so 182 is the present candidate). Expand the payment-method CHECK while retaining `zenbooker_sync`; rollback retypes `zb_*` rows to `zenbooker_sync` before restoring the old CHECK. Recheck both trees at implementation time. |
| `backend/src/services/jobsService.js:863-900` | Split standalone total into all completed Paid versus non-ZB Due offset; keep company scope and migration-181 predicate. |
| `backend/src/services/zenbookerPaymentsSyncService.js:75-89,257-337,344-508,516-546,615-654` | Add/export pure method/status normalization; accept range/full-history modes; use company-bound fetches; project `zb_*`, raw method metadata, and idempotent retyping; retain company-scoped reconciliation. |
| `backend/src/services/zenbookerClient.js:31-36,69-102,283-330,595-624` | Expose a safe default-company identity check and make transaction/invoice/job reads use a company-resolved client; no unscoped global payment reads. |
| `backend/src/routes/zenbooker/payments.js:17-47` | Default-company 403-before-network gate; validate range versus full-history body; preserve response envelope. |
| `backend/src/services/analyticsService.js:360-384` | Detect authoritative ZB rows by `external_source`, not legacy method. |
| `frontend/src/components/jobs/jobFinanceMath.ts:12-56` | Add source to the payment shape; include all completed standalone rows in Paid but only non-ZB rows in Due credit. |
| `frontend/src/components/jobs/JobFinancialsTab.tsx:44-50,144-154,362-380` | Use the shared mirror-method labels for canonical job payments; retain all completed rows in the visible list. |
| `frontend/src/services/paymentsCanonicalApi.ts:13-34` | Extend the read type with all `zb_*` methods; native create types remain unchanged. |
| `frontend/src/lib/paymentMethodLabels.ts:new` | One shared canonical label map/helper, including `Zenbooker · X` labels and legacy fallback. |
| `frontend/src/pages/TransactionsPage.tsx:54-61,210` | Replace the local label map with the shared helper. |
| `frontend/src/components/transactions/TransactionDetailPanel.tsx:26-33,116` | Replace the duplicate label map with the shared helper. |
| `frontend/src/components/transactions/RefundDialog.tsx:81` | Render the transaction method through the shared helper. |
| `frontend/src/components/invoices/InvoiceDetailPanel.tsx:742-748` | Render canonical invoice-payment methods through the shared helper. |
| `frontend/src/services/zenbookerPaymentsApi.ts:new` | Typed range/full-history sync client; full mode sends `{full_history:true}`. |
| `frontend/src/hooks/usePaymentsPage.ts:28-55,105-107` | Keep existing range action and add full-history action/state through the service client. |
| `frontend/src/pages/PaymentsPage.tsx:188-192` | Add one-click **Sync full history** beside the existing range **Sync** action; disable both during either request and show honest completion/error copy. |

The legacy `/payments` method column may continue showing source-native raw method/brand because that page is Zenbooker-only. Mirror labels are mandatory on mixed canonical/job surfaces.

### P2 production files

| File and current lines | Planned change |
|---|---|
| `backend/db/migrations/MMM_zb_imported_invoice_provenance.sql:new` + matching rollback | Next free number after P1. Add invoice provenance columns and company/source/external unique index; rollback targets only provenance-tagged imported invoices. |
| `backend/src/services/zenbookerInvoiceImportService.js:new` | Company-scoped candidate query, cents-based eligibility, transactional invoice/item creation, idempotent provenance reuse, and ledger linking. |
| `backend/src/db/invoicesQueries.js:186-251,336-382,508-548` | Add purpose-built query primitives that accept an existing transaction client; do not route imported totals through user draft creation. Every invoice/job/payment query includes company scope. |
| `backend/src/services/zenbookerPaymentsSyncService.js:478-508,516-546` | After landing reconciliation/projection, invoke P2 import best-effort and return additive created/existing/skipped counts. |

No P2 frontend change is expected: existing invoice and canonical-payment reads should reflect the new `invoice_id` links naturally.

### Test files

- `tests/jobsService.test.js` — extend signed rollup cases with ZB/non-ZB source separation.
- `tests/paymentsConsolidation.test.js` — normalized projector, source-based analytics, method metadata, and conflict-update contract.
- `tests/zenbookerPaymentsFullHistory.test.js:new` — route/service default-company gate, body modes, no-network-on-403, and all-pages client calls.
- `tests/zenbookerTenantIsolation.test.js` — retain the historical shared-key isolation controls.
- `tests/zenbookerPaymentsJobLink.test.js` — range/full sync still reconciles and links jobs.
- `tests/zenbookerPaymentsMigration.db.test.js:new` — migration double-apply/rollback plus same transaction/projector run twice equals one landing and one ledger row.
- `tests/zenbookerInvoiceImport.test.js:new` — P2 eligibility, exact cents, ambiguous skip, one-item invoice, company isolation, transaction rollback, and reuse.
- `frontend/src/components/jobs/jobFinanceMath.test.ts` — ZB Paid/Due guard and native signed-credit regression.
- `frontend/src/lib/paymentMethodLabels.test.ts:new` — exact seven labels and fallback.
- `frontend/src/services/zenbookerPaymentsApi.test.ts:new` — exact range/full request bodies and errors.
- `frontend/src/components/jobs/JobMobileCard.test.tsx` — backend `paid=95,due=0` renders Paid, not Credit; native negative Due still renders Credit.

### Explicit no-touch/debt boundary

- `backend/db/migrations/181_payment_tx_job_standalone_index.sql` and its rollback stay byte-unchanged.
- `backend/src/services/paymentsService.js:33-35` native create/record allowlists do not gain `zb_*`; only the trusted Zenbooker projector writes imported methods.
- No scheduler, webhook, SSE, polling-progress endpoint, or disconnect automation.
- Do not fix the `useJobFinancials` 100-row limits (`frontend/src/hooks/useJobFinancials.ts:22-38`).
- Do not change canonical Transactions filtering/sorting/display from `created_at` to `processed_at` (`backend/src/db/paymentsQueries.js:101-127`; `frontend/src/pages/TransactionsPage.tsx:220`).
- Do not delete `zb_payments`; it remains the reversible landing/audit cache.
- Do not change native Albusto payment methods or public Stripe payment behavior.

## Implementation tasks and estimates

Size guide: **S** = localized/low coupling, **M** = cross-file/stateful, **L** = broad migration/integration work.

Run every command below from the worktree root unless the command begins with `cd frontend`.

### P1 / T1 — Source-aware Due guard (**S**)

**Acceptance criteria**

- Backend list rollup returns ZB completed standalone money in `amount_paid` but does not subtract it from `balance_due`.
- Frontend Finance math produces Paid `$95.00`, Due `$0.00` for a lone completed ZB `$95` row.
- A null/native/Stripe source retains Paid `$95.00`, Due `−$95.00`.
- Pending, failed, refund, invoice-linked, and foreign-company rows remain excluded under existing rules.
- Migration 181 is unchanged and the query retains its indexed base predicate.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/jobsService.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/components/jobs/jobFinanceMath.test.ts src/components/jobs/JobMobileCard.test.tsx
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### P1 / T2 — Mirror vocabulary migration and projector (**M**)

**Acceptance criteria**

- Before choosing `NNN`, inspect current worktree and local `origin/master`; use the greater maximum plus one and add a matching rollback.
- The CHECK accepts all seven `zb_*` values and retains legacy `zenbooker_sync` for rollout safety.
- The pure normalizer implements the exact mapping table; unknown/custom→`zb_other` with raw method/custom name/brand metadata.
- Reprojection updates existing `zenbooker_sync` rows in place through the source-scoped conflict key.
- Analytics recognizes ZB authority through `external_source='zenbooker'` and does not depend on a method value.
- Refund payload evidence is recorded in this spec; only a deterministic mapping may become completed financial data.

**Verify**

```bash
find backend/db/migrations -maxdepth 1 -type f -name '[0-9]*.sql' -print | sort -V | tail -1
git ls-tree -r --name-only origin/master backend/db/migrations | grep -E '/[0-9]+_.*\.sql$' | sort -V | tail -1
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/paymentsConsolidation.test.js tests/zenbookerPaymentsJobLink.test.js tests/zenbookerPaymentsMigration.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

### P1 / T3 — Default-company sync hardening (**M**)

**Acceptance criteria**

- The route reads only `req.companyFilter?.company_id`; non-default company returns 403.
- Route and service independently reject a non-default company before any client/network fetch or DB write.
- Default-company payment reads resolve and use the company-bound client for transactions, invoices, and jobs.
- Existing list/detail reads remain company-scoped and are not broadened.
- Tests prove no network mock was called on the foreign-company branch.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/zenbookerPaymentsFullHistory.test.js tests/zenbookerTenantIsolation.test.js tests/zenbookerClient.test.js tests/paymentsRoute.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

### P1 / T4 — Range plus one-click full-history sync (**M**)

**Acceptance criteria**

- Existing two-date range requests behave as before.
- Empty/no-range and explicit `full_history:true` fetch all transaction pages without date filters.
- Full-history work is page-chunked under the server-owned budget; a partial response returns the next cursor, `remaining:true`, and the processed date range.
- One date only, or dates mixed with full-history, returns 400 before network.
- The Payments page exposes distinct **Sync** (current selected range) and **Sync full history** actions; a request locks both until completion. A partial response retains/sends the cursor and changes the action to continue.
- Partial copy is exactly **Progress saved — run again to continue**. Completion is explicit and clears the cursor.
- No realtime/progress subsystem is introduced. Success copy distinguishes newly imported rows from existing deduped rows.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/zenbookerPaymentsFullHistory.test.js tests/zenbookerPaymentsJobLink.test.js tests/paymentsRoute.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/services/zenbookerPaymentsApi.test.ts
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### P1 / T5 — Canonical mirror labels (**S**)

**Acceptance criteria**

- Mixed canonical/job surfaces show the exact labels `Zenbooker · Card/Check/Cash/ACH/Venmo/Zelle/Other`.
- One shared helper replaces all three duplicate label implementations.
- Read types accept all imported methods; native create/record forms do not offer `zb_*` choices.
- Unknown legacy values retain a safe title-cased fallback.

**Verify**

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/lib/paymentMethodLabels.test.ts src/components/jobs/jobFinanceMath.test.ts
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### P1 / T6 — Re-run/dedupe integration gate (**M**)

**Acceptance criteria**

- The same full-history transaction set can be staged and projected twice with one `zb_payments` row and one canonical ZB ledger row per transaction.
- A second run updates method/status/job metadata without changing canonical row identity.
- Two companies may use the same external transaction ID in storage without collision; only the default company may fetch the shared account.
- Migration and rollback are each double-apply safe where project migration conventions permit.
- A read-only cutoff audit reports counts and cents by stage/ledger/status/method/job-link state without customer PII.
- Every transaction with a resolvable ZB job ID and an existing same-company local job is linked canonically; any remainder is counted and documented rather than silently omitted.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/zenbookerPaymentsMigration.db.test.js tests/paymentsConsolidation.test.js tests/zenbookerPaymentsFullHistory.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

### P2 / T7 — Imported-invoice provenance and eligibility (**M**)

**Acceptance criteria**

- Add the next free migration/rollback for explicit invoice provenance and its company-scoped unique key.
- Eligibility uses integer cents and every settled criterion; no float equality or unscoped job/invoice/payment query.
- Ambiguous, partial, mismatched, malformed, missing-job, and cross-company candidates return categorized skips without writes.
- Existing native invoices are never matched by number/title or modified.

**Verify**

```bash
find backend/db/migrations -maxdepth 1 -type f -name '[0-9]*.sql' -print | sort -V | tail -1
git ls-tree -r --name-only origin/master backend/db/migrations | grep -E '/[0-9]+_.*\.sql$' | sort -V | tail -1
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/zenbookerInvoiceImport.test.js tests/zenbookerPaymentsMigration.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

### P2 / T8 — Transactional synthesis and ledger linking (**M/L**)

**Acceptance criteria**

- One eligible ZB invoice creates one paid Albusto invoice and exactly one **Imported Zenbooker invoice** item.
- All matching company/source ZB ledger rows receive that invoice ID; unrelated/foreign/native rows do not.
- Re-running returns/reuses the same invoice, item, and ledger rows without overwriting user-visible invoice fields.
- One candidate failure rolls back its invoice/item/link atomically, is reported non-fatally, and does not stop other payment groups.
- Existing Finance surfaces converge to Invoiced=Paid and Due=0 without P2-specific frontend arithmetic.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/zenbookerInvoiceImport.test.js tests/zenbookerPaymentsMigration.db.test.js tests/jobsService.test.js tests/paymentsConsolidation.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

### T9 — Full regression and cutoff rehearsal (**S**)

**Acceptance criteria**

- All affected backend suites and the complete frontend suite/build pass.
- On a production-data copy, dry audit totals reconcile ZB landing to the canonical source ledger to the cent.
- Range sync, full-history sync, and full-history rerun are rehearsed; the rerun creates zero duplicate landing, ledger, invoice, or item rows.
- The foreign-company 403 is verified before the owner’s cutoff run.
- Cutoff sequence is documented: full job sync if needed → full payment sync → reconciliation/audit → optional P2 import → rerun/audit → disconnect ZB.

**Verify**

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/jobsService.test.js tests/paymentsConsolidation.test.js tests/paymentsRoute.test.js tests/zenbookerClient.test.js tests/zenbookerPaymentsJobLink.test.js tests/zenbookerPaymentsFullHistory.test.js tests/zenbookerPaymentsMigration.db.test.js tests/zenbookerTenantIsolation.test.js tests/zenbookerInvoiceImport.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
cd frontend && env -u NODE_USE_SYSTEM_CA npm test
```

## Test plan

### Due and Finance

1. Backend aggregate: ZB completed standalone `$95` → total paid 95, total due 0; company scope and original base predicate present.
2. Native/null/Stripe source `$95` → paid 95, due -95.
3. Mixed invoice paid + ZB standalone + native standalone calculates Paid from all but subtracts only native standalone from Due.
4. Frontend pure math mirrors backend exactly, including U+2212 only for genuine non-ZB credits.
5. After P2 link, payment is excluded from standalone and invoice totals are counted once.

### Tenant isolation and sync modes

1. Non-default company → 403; transaction, invoice, job, and generic client/network mocks all remain untouched.
2. Direct service call with non-default company rejects before DB/network.
3. Default company range mode sends the two API bounds; full-history mode sends neither.
4. A simulated budget boundary returns `remaining:true` and the exact next cursor; the continuation request starts with that cursor and completion clears it.
5. Missing one date and dates+full flag return 400 before network.
6. All staging/projector/link SQL carries the default company parameter and foreign rows are unchanged.

### Vocabulary/status

1. Table-driven coverage of every approved raw→canonical method plus case/whitespace variants.
2. `custom` and unknown values become `zb_other` with original/custom/brand metadata.
3. Existing `zenbooker_sync` row becomes the mapped `zb_*` value on projection conflict without changing ID/count.
4. Completed-payment mapping is positive evidence; unknown/refund semantics cannot accidentally become completed payments.
5. Analytics source priority works across every `zb_*` method.

### Idempotency

1. Stage identical range twice and identical full history twice: one landing row per company/transaction.
2. Project twice: one canonical source row per company/external ID.
3. Overlapping range then full history converges to the same counts.
4. P2 runs twice: one imported invoice and one line item; all intended ledger rows point at it.
5. Same external ID under a different company does not conflict in storage, while its network sync remains forbidden.
6. Every resolvable same-company ZB job link heals on rerun; unresolved/no-local-job exceptions remain visible in reconciliation counts.

### P2 eligibility and failure isolation

1. Exact valid candidate creates paid invoice/item/link.
2. Conflicting totals/jobs/status, missing job, partial state, malformed amount, and cents mismatch each skip with no partial writes.
3. Contact present fills contact; contact absent still imports.
4. Foreign-company rows cannot influence eligibility or receive links.
5. Simulated item/link failure rolls back that candidate and the next eligible group still imports.

## Sabotage-minimum controls

| Named control | Invariant | How to break it deliberately | Test that must go red |
|---|---|---|---|
| `CTRL-ZBPAY-DUE-NO-CREDIT` | A completed standalone ZB `$95` row contributes to Paid but leaves Due at `$0`; a non-ZB row still creates `−$95`. | Remove `external_source IS DISTINCT FROM 'zenbooker'` from the Due-offset aggregate or calculate frontend Due from all Paid. | `jobsService.test.js` — **ZB standalone is paid but not credit**; `jobFinanceMath.test.ts` — **ZB Paid 95 / Due 0 while native Due is -95**. |
| `CTRL-ZBPAY-TENANT-GATE` | Non-default company gets 403 before every ZB network/client call and write. | Remove/invert the default-company comparison or move it below `getTransactions`. | `zenbookerPaymentsFullHistory.test.js` — **foreign company 403 before network** and **service defense-in-depth rejects before fetch**. |
| `CTRL-ZBPAY-RERUN-DEDUPE` | Re-running the same import leaves one landing row and one ZB ledger row, updating in place. | Remove either unique/conflict key, change the partial conflict predicate, or replace the projector upsert with a plain insert. | `zenbookerPaymentsFullHistory.test.js` — **second full run reports existing and keeps one logical landing id**; `zenbookerPaymentsMigration.db.test.js` — **second stage/project pass keeps count=1 and the same ledger id**, with both conflict keys structurally asserted when PostgreSQL is unavailable. |

Sabotage is performed on top of the implementation diff and restored by reversing only the sabotage edit; never restore with `git checkout`.

## Estimates

| Phase/task | Size | Expected effort |
|---|---|---|
| P1/T1 Due guard | S | 0.5 day |
| P1/T2 vocabulary/projector/refund audit | M | 1–2 days |
| P1/T3 tenant gate | M | 1 day |
| P1/T4 full-history backend/UI | M | 1–2 days |
| P1/T5 labels | S | 0.5 day |
| P1/T6 DB/idempotency gate | M | 1 day |
| **P1 total** | **L** | **5–7 days** |
| P2/T7 provenance/eligibility | M | 1–2 days |
| P2/T8 synthesis/linking/idempotency | M/L | 2–4 days |
| T9 regression/cutoff rehearsal | S | 0.5–1 day |
| **P2 + cutoff total** | **L** | **4–7 days** |

## Non-goals

- Realtime Zenbooker sync, webhooks, scheduled polling, background-job infrastructure, or progress streaming.
- Automatic Zenbooker disconnection or credential removal.
- Fixing Job Finance’s 100-row request cap.
- Changing canonical Transactions date filtering/sorting/display from import `created_at` to source `processed_at`.
- Creating detailed ZB invoice line items, PDFs, sending imported invoices, receipts, taxes, discounts, estimates, or customer-facing public links.
- Synthesizing invoices for ambiguous, partial, unpaid, malformed, jobless, or non-reconciling ZB data.
- Making unreliable refunds financially effective.
- Removing the `zb_payments` landing/audit cache or legacy `zenbooker_sync` compatibility in this rollout.
- Changing migration 181, native Albusto payment method values, or public Stripe behavior.

## Risks and implementation notes

1. A slow Zenbooker page can finish after the nominal 3.5-minute boundary because the budget is checked between pages; provider request timeouts remain the hard bound for an in-flight page. No new page starts after budget expiry.
2. Raw refund/type vocabulary is not yet proven. The safe default is non-financial, not an inferred refund.
3. The P2 consistency gate may intentionally skip many invoices. Payment completeness is P1’s goal; invoice coverage is secondary.
4. Existing staged rows may contain data stamped under the wrong company from the historical unscoped client. The cutoff dry audit must compare company binding before projection/import; the new gate prevents further contamination but does not prove old rows are clean.
5. Imported paid invoices are provenance-owned but visible in normal invoice UI. Re-runs must reuse them without overwriting later human edits.
