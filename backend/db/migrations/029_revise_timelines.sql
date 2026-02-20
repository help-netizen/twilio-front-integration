-- =============================================================================
-- 029: Revise timelines — one per contact OR one per orphan phone
-- =============================================================================

-- 1. Drop the unique phone index (phones are no longer unique identifiers)
DROP INDEX IF EXISTS uq_timelines_phone;

-- 2. Allow phone_e164 to be NULL (contact-linked timelines don't need it)
ALTER TABLE timelines ALTER COLUMN phone_e164 DROP NOT NULL;

-- 3. Unique: one timeline per contact
CREATE UNIQUE INDEX IF NOT EXISTS uq_timelines_contact
  ON timelines(contact_id) WHERE contact_id IS NOT NULL;

-- 4. Unique: one orphan timeline per phone
CREATE UNIQUE INDEX IF NOT EXISTS uq_timelines_orphan_phone
  ON timelines(phone_e164) WHERE phone_e164 IS NOT NULL AND contact_id IS NULL;

-- 5. At least one of contact_id or phone_e164 must be set
ALTER TABLE timelines ADD CONSTRAINT chk_timelines_identity
  CHECK (contact_id IS NOT NULL OR phone_e164 IS NOT NULL);

COMMENT ON TABLE timelines IS 'One timeline per contact (all their phones) or per orphan phone number';
