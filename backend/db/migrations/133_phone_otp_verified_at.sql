-- ============================================================================
-- 133: AUTH-FLOW-FIX-001 (B1/B3) — phone_otp.verified_at
--
-- Records when an OTP row was successfully verified, so sendCode's escalating
-- per-phone throttle can reset the ladder after a successful verification
-- ("count sends since the last verify"). Set alongside consumed_at on success.
--
-- Idempotent and additive.
-- ============================================================================

ALTER TABLE phone_otp ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
