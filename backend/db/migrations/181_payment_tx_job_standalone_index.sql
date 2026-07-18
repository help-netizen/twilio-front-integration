-- =============================================================================
-- Migration 181: partial index for the standalone-payments jobs rollup
-- (STRIPE-PAYFORM-UX-001 follow-up).
--
-- jobsService.listJobs now rolls up completed standalone payments
-- (invoice_id IS NULL) per job page to render Paid / signed Due on the jobs
-- list. payment_transactions had no index covering job_id — the query leaned
-- on idx_payment_tx_company_status and filtered job_id by hand. This partial
-- index matches the rollup predicate exactly, so the lookup stays index-driven
-- as the ledger grows. Additive + idempotent; no data or behavior change.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_payment_tx_job_standalone
    ON payment_transactions(job_id)
    WHERE invoice_id IS NULL
      AND transaction_type = 'payment'
      AND status = 'completed';
