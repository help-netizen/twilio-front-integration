-- Rollback 181: drop the standalone-payments rollup index.
DROP INDEX IF EXISTS idx_payment_tx_job_standalone;
