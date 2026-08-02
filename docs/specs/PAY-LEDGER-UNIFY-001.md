# PAY-LEDGER-UNIFY-001 — Unified Payments Ledger

## Resolution

`/payments` lists every company-owned row from `payment_transactions`. The
table is authoritative for row identity, amount, transaction status, payment
method, event date, source, and check-deposit state. Zenbooker payments are
already projected into this table, so the read path never unions the landing
table with the canonical ledger.

The existing `/api/zenbooker/payments` URLs and frontend contract remain in
place during the Zenbooker transition. `zb_payments` has one permitted role on
the read path: a company-scoped, one-to-one presentation join for historical
Zenbooker attachments and invoice/job detail that do not exist in the canonical
schema. It never contributes a row, amount, status, id, date, or deposited flag.

The Zenbooker sync endpoints and all sync/webhook write paths are unchanged.

## Response contract

The list retains every existing field and envelope:

- `rows[]`: `id`, `transaction_id`, `invoice_id`, `job_id`, `job_number`,
  `client`, `job_type`, `status`, `payment_methods`,
  `display_payment_method`, `amount_paid`, `tags`, `payment_date`, `source`,
  `tech`, `transaction_status`, `missing_job_link`, invoice summary fields,
  `check_deposited`, and `custom_fields`.
- `aggregates`: `{ transaction_count, total_amount }`.
- `facets`: `{ payment_methods[], providers[], undeposited_check_count }`.
- `pagination`: the existing cursor/offset envelope and keyset behavior.
- Filters and sorts remain `date_from`, `date_to`, `payment_method`, `provider`,
  `paid_status`, `quick_filter=new_checks`, `search`, `sort_by`, and
  `sort_order`.

Canonical aliases are additive: `amount`, `currency`, `payment_method`,
`payment_status`, `transaction_type`, `contact_id`, `canonical_invoice_id`,
`canonical_job_id`, `reference_number`, `reference`, `memo`, `external_id`, and
`external_source`.

CSV export uses the same canonical projection and therefore contains every
source in the selected date range.

## Field mapping

| API field | Source |
|---|---|
| `id` | `payment_transactions.id` |
| `amount_paid`, `amount` | `payment_transactions.amount` |
| `payment_method` | `payment_transactions.payment_method` |
| `payment_methods`, `display_payment_method` | Existing ZB presentation label or a native label derived from the canonical method |
| `payment_date` | `COALESCE(processed_at, created_at)` |
| `payment_status` | Canonical `status` |
| `transaction_status` | Canonical status with compatibility display `completed -> succeeded` |
| `status` | Resolved job status, preserving the existing contract |
| `tech`, providers facet | Resolved company-owned `jobs.assigned_techs` |
| `check_deposited` | Boolean `metadata.check_deposited`, default `false` |
| contact/job/invoice linkage | Canonical foreign keys, with company-scoped invoice/job fallbacks |
| `transaction_id` | Canonical `external_id`, falling back to canonical row id |
| `reference_number`, `reference` | Canonical `reference_number` |
| `memo` | Canonical `memo` |
| `external_source` | Canonical `external_source` |
| invoice/job detail and attachments | Local canonical entities; ZB presentation fallback only where canonical data is absent |

Signed `SUM(amount)` and `COUNT(*)` retain the prior ledger semantics: matching
pending, failed, voided, refunded, and adjustment rows remain visible and count
once; negative adjustments reduce the total.

## Migration 227

Migration `227_unify_payments_ledger.sql`:

1. Copies `zb_payments.check_deposited` to the matching canonical Zenbooker
   row only when `metadata.check_deposited` is absent.
2. Marks only migrated values so rollback does not remove pre-existing
   canonical decisions.
3. Adds the `(company_id, COALESCE(processed_at, created_at), id)` cursor index.

All later deposited changes write the canonical metadata key and remove the
backfill marker, so rollback cannot erase an explicit post-migration decision. The existing
Zenbooker projector merges old canonical metadata with projected metadata, so
the key survives subsequent syncs.

## Tenancy and roles

| Surface | Tenant boundary | Required permission | Foreign result |
|---|---|---|---|
| List | `payment_transactions.company_id = req.companyFilter.company_id`; every joined tenant table is pinned to the owned row | `payments.view` | No foreign rows |
| Export | Same canonical projection and company predicate | `payments.view` | No foreign rows |
| Detail | `company_id = $1 AND id = $2` | `payments.view` | `404` |
| Deposited PATCH | `company_id = $1 AND id = $2` | `payments.collect_offline` | `404`, unchanged |
| ZB presentation join | `(company_id, external_id = transaction_id)` | Inherited from list/detail | Cannot cross tenant |

There is no default-company fallback on any ledger read or deposited write.

## Verification

- Mixed Zenbooker, Stripe, manual, and null-source transactions appear once.
- A matching ZB presentation row enriches but never duplicates its canonical row.
- Aggregates, facets, filters, sorts, and cursor continuation use canonical rows.
- Native `check` and Zenbooker `zb_check` both participate in `new_checks`.
- Existing response fields and detail JSON remain compatible.
- Export includes every canonical source.
- `T-own`, `T-foreign`, `T-blast`, and the permission deny matrix cover detail
  and deposited mutation.

### Named sabotage minimum

- `CTRL-PAY-LEDGER-NO-UNION`: add a matching ZB presentation row; count and sum
  must remain one canonical transaction.
- `CTRL-PAY-LEDGER-T-BLAST`: seed the same external id in two companies, PATCH
  one canonical id, and byte-compare the foreign metadata unchanged.
- `CTRL-PAY-LEDGER-BACKFILL-WINS`: pre-seed canonical
  `metadata.check_deposited`; migration reapplication must not overwrite it.
- `CTRL-PAY-LEDGER-NATIVE-CHECK`: a native undeposited check must appear in
  `new_checks`, then disappear after the canonical PATCH.
- `CTRL-PAY-LEDGER-MONEY`: failed/voided/pending/refund-like signed rows must
  remain one row each and produce the exact signed aggregate.
- `CTRL-PAY-LEDGER-CURSOR-GENERATION`: a pre-cutover cursor must fail with
  `INVALID_CURSOR`, never silently resume against canonical ids.
