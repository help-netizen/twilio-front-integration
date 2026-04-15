-- Structured notes for leads and contacts (with attachment support)
-- Existing text comments/notes columns are preserved for backward compatibility
ALTER TABLE leads ADD COLUMN IF NOT EXISTS structured_notes JSONB DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS structured_notes JSONB DEFAULT '[]';
