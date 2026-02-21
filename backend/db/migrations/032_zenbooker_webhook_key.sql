-- =============================================================================
-- Migration 032: Add zenbooker_webhook_key to companies
-- Each company gets a unique key for Zenbooker webhook URL
-- =============================================================================

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS zenbooker_webhook_key VARCHAR(64) UNIQUE;

-- Seed existing company with a key (64 hex chars from two UUIDs)
UPDATE companies
SET zenbooker_webhook_key = md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND zenbooker_webhook_key IS NULL;
