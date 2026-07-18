BEGIN;

CREATE TABLE IF NOT EXISTS telephony_blacklist_numbers (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL CHECK (phone_e164 ~ '^[+]1[0-9]{10}$'),
  created_by UUID REFERENCES crm_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_telephony_blacklist_company_phone
  ON telephony_blacklist_numbers (company_id, phone_e164);

CREATE INDEX IF NOT EXISTS idx_telephony_blacklist_company_created
  ON telephony_blacklist_numbers (company_id, created_at DESC, id DESC);

COMMIT;
