-- =============================================================================
-- Migration 217: Drop the per-user Call Masking profile toggle (#80)
--
-- Call masking is now decided entirely by ROLE on the company Call Masking
-- settings page (/settings/telephony/call-masking). The per-user
-- company_user_profiles.call_masking_enabled flag (added in migration 048) is
-- obsolete and no longer read or written by the app.
--
-- IMPORTANT: this is the PER-USER profile column only. The COMPANY-level
-- company_telephony.call_masking_enabled (migration 208) is a DIFFERENT column
-- on a DIFFERENT table and is the live source of truth — it is left untouched.
--
-- Idempotent: DROP ... IF EXISTS re-runs safely on every deploy.
-- =============================================================================

ALTER TABLE company_user_profiles
    DROP COLUMN IF EXISTS call_masking_enabled;
