-- Rollback 265: remove estimate public-link expiry metadata.

ALTER TABLE estimates
    DROP COLUMN IF EXISTS public_token_expires_at;
