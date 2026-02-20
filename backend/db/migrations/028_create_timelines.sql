-- =============================================================================
-- 028: Create timelines table + add timeline_id to calls
-- Timelines decouple interaction history from contacts.
-- One timeline per phone number, optionally linked to a contact.
-- =============================================================================

-- 1. Create timelines table
CREATE TABLE IF NOT EXISTS timelines (
  id          BIGSERIAL PRIMARY KEY,
  phone_e164  TEXT NOT NULL,
  contact_id  BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  company_id  UUID REFERENCES companies(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_timelines_phone
  ON timelines(phone_e164);

CREATE INDEX IF NOT EXISTS idx_timelines_contact_id
  ON timelines(contact_id);

COMMENT ON TABLE timelines IS 'Groups call/SMS interactions by phone number, optionally linked to a contact';

-- 2. Add timeline_id to calls
ALTER TABLE calls ADD COLUMN IF NOT EXISTS timeline_id BIGINT REFERENCES timelines(id);
CREATE INDEX IF NOT EXISTS idx_calls_timeline_id ON calls(timeline_id);
