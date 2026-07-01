-- Rollback for Migration 140: TELEPHONY-AUTONOMOUS-MODE-001.
-- Drop the autonomous_mode toggle; the rest of company_telephony is untouched.

ALTER TABLE company_telephony
    DROP COLUMN IF EXISTS autonomous_mode;
