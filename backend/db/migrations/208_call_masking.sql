-- =============================================================================
-- 208: CALL-MASKING-001 — company settings, stable contact codes, call mapping
-- =============================================================================

ALTER TABLE company_telephony
    ADD COLUMN IF NOT EXISTS call_masking_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS call_masking_number VARCHAR(16) NOT NULL DEFAULT '+16174044425',
    ADD COLUMN IF NOT EXISTS next_call_masking_code INTEGER NOT NULL DEFAULT 1;

DO $$ BEGIN
    ALTER TABLE company_telephony
        ADD CONSTRAINT chk_company_telephony_masking_number_e164
        CHECK (call_masking_number ~ '^\+[1-9][0-9]{7,14}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE company_telephony
        ADD CONSTRAINT chk_company_telephony_next_masking_code
        CHECK (next_call_masking_code BETWEEN 1 AND 1000000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Supports composite FKs below, enforcing that a masking row cannot pair a
-- contact id with a different tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_company_id_id
    ON contacts (company_id, id);

CREATE TABLE IF NOT EXISTS contact_call_masking_codes (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id BIGINT NOT NULL,
    code INTEGER NOT NULL CHECK (code BETWEEN 1 AND 999999),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, contact_id),
    UNIQUE (company_id, code),
    FOREIGN KEY (company_id, contact_id)
        REFERENCES contacts(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_masking_sessions (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    call_sid VARCHAR(100) NOT NULL,
    contact_id BIGINT NOT NULL,
    provider_user_id UUID NOT NULL REFERENCES crm_users(id) ON DELETE RESTRICT,
    masking_number VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, call_sid),
    FOREIGN KEY (company_id, contact_id)
        REFERENCES contacts(company_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_call_masking_sessions_number_e164
        CHECK (masking_number ~ '^\+[1-9][0-9]{7,14}$')
);

-- Existing tenants need the feature permission on the provider role. Track
-- only rows inserted by this migration so rollback never removes a pre-existing
-- tenant customization.
CREATE TABLE IF NOT EXISTS call_masking_seeded_permissions (
    role_config_id UUID PRIMARY KEY
        REFERENCES company_role_configs(id) ON DELETE CASCADE
);

WITH inserted AS (
    INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
    SELECT id, 'call_masking.use', true
    FROM company_role_configs
    WHERE role_key = 'provider'
    ON CONFLICT (role_config_id, permission_key) DO NOTHING
    RETURNING role_config_id
)
INSERT INTO call_masking_seeded_permissions (role_config_id)
SELECT role_config_id FROM inserted
ON CONFLICT (role_config_id) DO NOTHING;
