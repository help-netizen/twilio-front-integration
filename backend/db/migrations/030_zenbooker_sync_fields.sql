-- =============================================================================
-- Migration 030: Add Zenbooker sync fields for bi-directional sync
-- =============================================================================

-- 1. Sync metadata on contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zenbooker_account_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zenbooker_synced_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zenbooker_sync_status TEXT DEFAULT 'not_linked';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zenbooker_last_error TEXT;

COMMENT ON COLUMN contacts.zenbooker_account_id IS 'Zenbooker account ID from webhook payload';
COMMENT ON COLUMN contacts.zenbooker_synced_at IS 'Last successful sync timestamp';
COMMENT ON COLUMN contacts.zenbooker_sync_status IS 'Sync status: not_linked | linked | pending | error';
COMMENT ON COLUMN contacts.zenbooker_last_error IS 'Last sync error message';

-- Backfill: contacts that already have zenbooker_customer_id should be "linked"
UPDATE contacts
SET zenbooker_sync_status = 'linked'
WHERE zenbooker_customer_id IS NOT NULL
  AND (zenbooker_sync_status IS NULL OR zenbooker_sync_status = 'not_linked');

-- 2. Zenbooker address linkage on contact_addresses
ALTER TABLE contact_addresses ADD COLUMN IF NOT EXISTS zenbooker_address_id TEXT;
ALTER TABLE contact_addresses ADD COLUMN IF NOT EXISTS zenbooker_customer_id TEXT;

COMMENT ON COLUMN contact_addresses.zenbooker_address_id IS 'Zenbooker address ID for sync';
COMMENT ON COLUMN contact_addresses.zenbooker_customer_id IS 'Zenbooker customer ID for address sync';
