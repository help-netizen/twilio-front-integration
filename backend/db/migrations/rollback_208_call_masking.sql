-- =============================================================================
-- Rollback 208: CALL-MASKING-001
-- =============================================================================

DELETE FROM company_role_permissions p
USING call_masking_seeded_permissions seeded
WHERE p.role_config_id = seeded.role_config_id
  AND p.permission_key = 'call_masking.use';

DROP TABLE IF EXISTS call_masking_seeded_permissions;
DROP TABLE IF EXISTS call_masking_sessions;
DROP TABLE IF EXISTS contact_call_masking_codes;

DROP INDEX IF EXISTS uq_contacts_company_id_id;

ALTER TABLE company_telephony
    DROP CONSTRAINT IF EXISTS chk_company_telephony_masking_number_e164,
    DROP CONSTRAINT IF EXISTS chk_company_telephony_next_masking_code,
    DROP COLUMN IF EXISTS call_masking_enabled,
    DROP COLUMN IF EXISTS call_masking_number,
    DROP COLUMN IF EXISTS next_call_masking_code;
