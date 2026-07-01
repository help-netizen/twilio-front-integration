-- =============================================================================
-- Migration 140: TELEPHONY-AUTONOMOUS-MODE-001
--
-- Company-wide "Autonomous mode" for inbound calls. When ON, every inbound call
-- is forced down its existing After-Hours branch (business_hours edge is never
-- taken) regardless of the group's configured hours. Default OFF → behavior is
-- identical to today.
--
-- Stored on the per-company telephony row (company_telephony, PK company_id).
-- Additive & idempotent. Companies without a company_telephony row are treated
-- as OFF at read time (service COALESCEs a missing row to false) and get a row
-- lazily created by the PATCH upsert when the toggle is first flipped.
-- =============================================================================

ALTER TABLE company_telephony
    ADD COLUMN IF NOT EXISTS autonomous_mode BOOLEAN NOT NULL DEFAULT false;
