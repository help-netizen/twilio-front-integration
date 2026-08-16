-- Migration 265: bounded lifetime for estimate public links.
--
-- `valid_until` is the proposal's commercial-validity date. Public-link access
-- has a different lifecycle: it must survive an approval/decline, but it must
-- not remain a bearer credential forever.

ALTER TABLE estimates
    ADD COLUMN IF NOT EXISTS public_token_expires_at TIMESTAMPTZ;

-- Migration 131 did not record when an existing token was minted. `sent_at` is
-- the closest durable issuance marker; created_at is the fail-closed fallback
-- for links that were minted without a completed send.
UPDATE estimates
SET public_token_expires_at = COALESCE(sent_at, created_at) + INTERVAL '18 months'
WHERE public_token IS NOT NULL
  AND public_token_expires_at IS NULL;

COMMENT ON COLUMN estimates.public_token_expires_at IS
    'Expiry of the bearer public_token; independent of proposal valid_until';
