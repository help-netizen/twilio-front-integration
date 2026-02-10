-- 007_add_leads_metadata.sql
-- Add JSONB column for custom metadata fields
ALTER TABLE leads ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

COMMENT ON COLUMN leads.metadata IS 'Custom metadata fields defined in lead_custom_fields settings';
