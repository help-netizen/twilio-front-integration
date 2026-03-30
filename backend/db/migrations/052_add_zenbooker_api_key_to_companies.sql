-- =============================================================================
-- Migration 052: Add per-tenant Zenbooker API key to companies
--
-- Bug #3 fix: Zenbooker API key was stored as a global env var
-- (ZENBOOKER_API_KEY), shared across all tenants. This caused
-- jobs/contacts from one tenant's Zenbooker account to leak into
-- another tenant's data. Each company must configure its own API key.
-- =============================================================================

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS zenbooker_api_key TEXT;

COMMENT ON COLUMN companies.zenbooker_api_key IS 'Per-tenant Zenbooker API key for data isolation';

-- Seed existing company with current env var value (will be done at app level)
-- The global ZENBOOKER_API_KEY env var becomes a fallback for backward compatibility.
