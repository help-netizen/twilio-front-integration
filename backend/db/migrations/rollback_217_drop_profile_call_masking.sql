-- =============================================================================
-- Rollback 217: restore the per-user Call Masking profile column.
--
-- The column is re-created with its original default (false). Prior per-user
-- values are NOT restored — masking became role-driven, so the flag is expected
-- to be unused. The company-level company_telephony.call_masking_enabled is
-- unaffected by this rollback.
-- =============================================================================

ALTER TABLE company_user_profiles
    ADD COLUMN IF NOT EXISTS call_masking_enabled BOOLEAN NOT NULL DEFAULT false;
