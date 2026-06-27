-- Rollback for Migration 133: AUTH-FLOW-FIX-001 — phone_otp.verified_at
-- Drops the verified_at column.

ALTER TABLE phone_otp DROP COLUMN IF EXISTS verified_at;
