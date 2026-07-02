-- =============================================================================
-- Rollback 148: drop ONLY the constraints migration 148 itself may have
-- created (uq_* names). Historical uniques — the prod constraint
-- phone_number_settings_phone_number_key and mig-098's inline
-- company_telephony_twilio_subaccount_sid_key — are NOT touched.
--
-- Dedup data changes made by 148 on drifted environments (deleted duplicate
-- phone_number rows; NULLed duplicate twilio_subaccount_sid values) are NOT
-- restored — that data is not recorded anywhere.
--
-- On prod (where 148 was a no-op) both DROPs are no-ops too. Idempotent.
-- =============================================================================

ALTER TABLE phone_number_settings
    DROP CONSTRAINT IF EXISTS uq_phone_number_settings_phone_number;

ALTER TABLE company_telephony
    DROP CONSTRAINT IF EXISTS uq_company_telephony_twilio_subaccount_sid;
