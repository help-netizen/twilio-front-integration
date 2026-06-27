-- =============================================================================
-- Rollback 131: Remove the public access token for estimates.
-- Drops the unique partial index, then the column. Idempotent.
-- =============================================================================

DROP INDEX IF EXISTS uq_estimates_public_token;

ALTER TABLE estimates
    DROP COLUMN IF EXISTS public_token;
