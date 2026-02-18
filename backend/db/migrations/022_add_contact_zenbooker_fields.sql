-- =============================================================================
-- Migration 022: Add Zenbooker fields to contacts table
-- Adds zenbooker_customer_id for sync linking and notes field
-- =============================================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zenbooker_customer_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_zenbooker_id
    ON contacts(zenbooker_customer_id) WHERE zenbooker_customer_id IS NOT NULL;

COMMENT ON COLUMN contacts.zenbooker_customer_id IS 'Zenbooker customer ID for sync';
COMMENT ON COLUMN contacts.notes IS 'Customer notes (synced from Zenbooker)';
