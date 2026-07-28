# RECEIPT-REVIEW-001 — Custom payment receipts and richer transaction review

**Status:** APPROVED FOR BUILD
**Owner:** Product / Payments
**Approved:** 2026-07-28

## Goal

Replace Stripe-hosted/native receipts with one Albusto-branded receipt email for
all completed payments, and enrich the existing payment-detail API so the Job
Finance and Transactions review panels can show complete transaction context and
inline Send Receipt / Void actions.

Frontend review-panel work is owned by the team lead. This build covers backend
detail data, receipt rendering/delivery/history, and compatibility wiring only.

## Decisions

- Receipt delivery uses an Albusto-branded HTML email for card and manual
  payments. Stripe's native receipt email and hosted `receipt_url` are removed.
- An invoice-linked receipt attaches the existing canonical invoice PDF generated
  by `invoicesService.generatePdf`. A standalone job payment is HTML-only and
  shows a payment summary without invented invoice line items or totals.
- The existing `GET /api/payments/:id` response stays flat and keeps all existing
  transaction fields. It adds:
  `brand`, `last4`, `invoice_number`, `customer_name`, `created_by_name`,
  `territory`, `stripe_customer_id`, `voided_by_name`, and
  `receipt_history: [{ to, sent_at, channel }]` newest-first.
- `created_by_name` is the tenant operator display name from
  `payment_transactions.recorded_by` or the matched Stripe payment-session
  creator. A Stripe payment with no operator is labeled `Customer (online)`.
- `stripe_payment_id` remains visible for Stripe card payments.
  `stripe_customer_id` is nullable and is never fabricated.
- Void behavior is unchanged. The frontend reuses `isVoidablePayment` and the
  canonical void endpoint/dialog.
- Receipt idempotency is pragmatic: callers may send an `Idempotency-Key`; the
  backend claims a tenant-owned `payment_receipts` row before Gmail and stamps
  `sent_at` only after Gmail returns. The same completed key returns the recorded
  success without a second send. No outbox or provider-deduplication system is in
  scope.
- The residual crash window between Gmail accepting a message and the database
  writing `sent_at` is accepted for this release.
- `receipt_number` is internal/best-effort and is not rendered in the customer
  receipt or Review.
- Receipt dates use the company timezone, default
  `America/New_York`.

## API contracts

### Transaction detail

`GET /api/payments/:id`

- Mount: `authenticate, requireCompanyAccess`
- Permission: `payments.view`
- Tenant: `req.companyFilter?.company_id`
- Foreign/missing transaction: `404`
- Success: `{ ok: true, data: PaymentTransactionDetail }`

`PaymentTransactionDetail` is exactly:

```text
id: string
company_id: string
contact_id: string | null
estimate_id: string | null
invoice_id: string | null
job_id: string | null
transaction_type: "payment" | "refund" | "adjustment"
payment_method: "credit_card" | "ach" | "check" | "cash" | "other" | "zenbooker_sync"
  | "zb_card" | "zb_check" | "zb_cash" | "zb_ach" | "zb_venmo" | "zb_zelle" | "zb_other"
status: "pending" | "processing" | "completed" | "failed" | "refunded" | "voided"
amount: string
currency: string
reference_number: string | null
external_id: string | null
external_source: string | null
memo: string | null
metadata: Record<string, unknown>
processed_at: string | null
recorded_by: string | null
created_at: string
updated_at: string
voided_at: string | null
voided_by: string | null
void_reason: string | null
brand: string | null
last4: string | null
invoice_number: string | null
customer_name: string | null
created_by_name: string | null
territory: string | null
stripe_payment_id: string | null
stripe_livemode: boolean | null
stripe_customer_id: string | null
voided_by_name: string | null
receipt_history: Array<{
  to: string | null
  sent_at: string
  channel: "email" | "sms" | "portal"
}>
```

Dates are ISO-8601 strings after JSON serialization. PostgreSQL `BIGINT` ids and
the numeric `amount` stay their existing JSON string representation. Internal connected-account/session ids, recipient
fallback email, company timezone, job service name, and job number are render
context only and are not returned.

Stripe card enrichment is best-effort. A Stripe read failure leaves
`brand`, `last4`, and `stripe_customer_id` nullable and never makes owned detail
unavailable. Manual rows never trigger Stripe enrichment even if malicious Stripe
ids are present.

### Send receipt

Canonical endpoint:

`POST /api/payments/:id/receipt/email`

Headers:

```text
Idempotency-Key: <8..128 chars; recommended and stable for one UI send action>
```

Body:

```json
{ "email": "optional@example.com" }
```

When `email` is omitted, the owned transaction's current customer email is used.
The key remains optional for compatibility; an omitted key receives a
server-generated one and therefore has no cross-request retry deduplication.

Success:

```json
{
  "ok": true,
  "data": {
    "sent": true,
    "delivery": "email",
    "contact_email_saved": false,
    "idempotent": false,
    "receipt_history_entry": {
      "to": "customer@example.com",
      "sent_at": "2026-07-28T16:00:00.000Z",
      "channel": "email"
    }
  }
}
```

The response never contains `receipt_url`, connected-account ids, secrets, or
payment-method ids.

Errors:

- `400 INVALID_EMAIL` / `INVALID_IDEMPOTENCY_KEY`
- `403` without any existing payment collection permission
- `404` foreign/missing payment before email validation or external work
- `409 MAILBOX_NOT_CONNECTED`
- `409 RECEIPT_SEND_IN_PROGRESS` for a claimed-but-not-completed matching key
- `409 RECEIPT_UNAVAILABLE` unless the row is a completed payment
- `422 NO_EMAIL` when no recipient is available

The keyed-card compatibility endpoint
`POST /api/payments/manual-card-sessions/:sessionId/receipt` resolves its
company-owned canonical ledger payment and delegates to the same sender. A
successful session with no canonical ledger row returns retryable
`409 PAYMENT_NOT_SYNCED`; it never falls back to Stripe-native email.

## Receipt model and rendering

The renderer reuses:

- `documentTemplatesService.resolveTemplate(companyId, "invoice")` for the same
  logo/name/DBA brand source as invoice preview/PDF;
- the shared `buildEmailBody` helper and `emailService.sendEmail` seam;
- `invoicesService.generatePdf`, which uses the canonical invoice item/totals
  query and invoice PDF renderer.

All template-sourced strings are HTML-escaped. The logo is fetched through the
existing storage-only/SSRF-safe PDF-logo helper and embedded with a MIME
Content-ID; the brand name is the fallback.

Invoice-linked HTML distinguishes invoice total from this transaction's amount.
If the payment contains a tip, the payment block shows the tip separately.
Standalone job HTML shows the job number/service and payment amount only.

## Receipt history and migration

Migration 213 adds:

- `payment_receipts.idempotency_key TEXT`
- `payment_receipts.provider_message_id TEXT`
- a partial unique index on `(transaction_id, idempotency_key)` for non-null keys

`sent_at` remains the successful-send marker and `pdf_storage_key` remains
available without schema change. Review history includes only rows with
`sent_at IS NOT NULL`, newest first. Pending claims are removed when delivery
definitively fails before Gmail acceptance.

## Tenancy & Roles

| surface | scoped by | key used | permission | roles | blast-radius risk |
|---|---|---|---|---|---|
| `GET /api/payments/:id` | `req.companyFilter.company_id` | payment id | `payments.view` | catalog allow / all deny cells | joined job/contact/invoice/operator/history |
| `POST /api/payments/:id/receipt/email` | `req.companyFilter.company_id` | payment id + email + idempotency key | any existing payment collect permission | catalog allow / all deny cells | same email/key in two tenants |
| `POST /api/payments/manual-card-sessions/:sessionId/receipt` | `req.companyFilter.company_id` | session id → PaymentIntent id | `payments.collect_keyed` | keyed allow / all deny cells | same external id in two tenants |
| receipt-history claim/complete/release | explicit `companyId` | payment id + receipt id/key | service-only | route-gated | foreign transaction/receipt mutation |

Tests cover T-own, T-foreign (404 + no provider/write), T-blast with the same
email/external id/idempotency key in two tenants, and every applicable R-matrix
deny cell.

## Backend tasks

### T1 — Enriched detail

Extend the existing detail query/service with the approved flat fields and
newest-first sent history. Best-effort Stripe enrichment cannot fail the detail
request.

Sabotage: `DETAIL-TENANT-CUT` removes an owned-row/join predicate; T-foreign or
T-blast must fail.

### T2 — Receipt model/template

Build the escaped branded email model, invoice-linked PDF attachment, standalone
job fallback, timezone formatting, and partial-payment/tip copy.

Sabotages:

- `RECEIPT-TOTAL-SWAP` maps invoice total from payment amount; the totals test fails.
- `RECEIPT-HTML-INJECT` removes escaping; the hostile customer/item test fails.

### T3 — Canonical Gmail delivery/history/idempotency

Deliver every receipt through `emailService.sendEmail`, retain mailbox 409,
persist successful history after Gmail, preserve contact fill-empty/job note/
financial activity, and dedupe completed idempotency keys.

Sabotages:

- `STRIPE-NATIVE-RESURRECTION`
- `MAILBOX-409-BYPASS`
- `HISTORY-BEFORE-SEND`
- `DUPLICATE-KEY`

Each sabotage must make its real service/query test red before restoration.

### T4 — Compatibility cleanup

Delegate manual-card receipt delivery to the canonical payment sender, make the
legacy receipt-send path perform real email delivery, and remove hosted
`receipt_url` from the receipt-view/send contracts.

Sabotages:

- `SESSION-TENANT-CUT`
- `HOSTED-URL-RETURN`

## Out of scope

- Frontend Review redesign and frontend hosted-receipt cleanup
- Public receipt page/token or SMS rich-receipt delivery
- Stripe Customer creation/reuse
- Receipt-specific PDF renderer for standalone payments
- Outbox, Gmail delivery webhook, or exactly-once provider semantics
- Changes to payment void/refund behavior
