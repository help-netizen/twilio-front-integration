-- =============================================================================
-- Migration 023: Add contact_id FK to leads table
-- Links leads to contacts; backfills by matching phone numbers
-- =============================================================================

-- 1. Add the column
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_id BIGINT REFERENCES contacts(id);

CREATE INDEX IF NOT EXISTS idx_leads_contact_id ON leads(contact_id) WHERE contact_id IS NOT NULL;

-- 2. Backfill: match leads.phone → contacts.phone_e164
UPDATE leads l
SET contact_id = c.id
FROM contacts c
WHERE l.phone IS NOT NULL
  AND c.phone_e164 IS NOT NULL
  AND l.phone = c.phone_e164
  AND l.contact_id IS NULL;
