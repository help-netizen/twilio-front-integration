-- 034_add_searchable_to_custom_fields.sql
-- Add is_searchable flag to metadata fields for search integration
ALTER TABLE lead_custom_fields ADD COLUMN IF NOT EXISTS is_searchable BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN lead_custom_fields.is_searchable IS 'Whether this field values are included in text search on Jobs/Leads pages';
