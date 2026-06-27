-- =============================================================================
-- Migration 131: Public access token for estimates.
--
-- Adds an optional `public_token` column to `estimates`. The token is generated
-- lazily — on first call to the "generate public link" endpoint — and embedded
-- in a tokenized URL like:
--     {APP_URL}/e/{public_token}
--
-- The public page is unauthenticated; possessing the token grants read-only
-- access to a customer-safe view of the estimate (and its rendered PDF) only.
--
-- Mirrors migration 087 (invoices.public_token). Additive + idempotent.
-- =============================================================================

ALTER TABLE estimates
    ADD COLUMN IF NOT EXISTS public_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_public_token
    ON estimates (public_token)
    WHERE public_token IS NOT NULL;
