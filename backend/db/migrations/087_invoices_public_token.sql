-- =============================================================================
-- Migration 087: Public access token for invoices.
--
-- Adds an optional `public_token` column to `invoices`. The token is generated
-- lazily — on first call to the "generate public link" endpoint — and embedded
-- in a tokenized URL like:
--     {APP_URL}/api/public/invoices/{public_token}/pdf
--
-- The route is unauthenticated; possessing the token grants read-only access
-- to the rendered PDF only.
-- =============================================================================

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS public_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_public_token
    ON invoices (public_token)
    WHERE public_token IS NOT NULL;
