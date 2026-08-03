DROP TABLE IF EXISTS native_voice_registrations;

ALTER TABLE company_telephony
    DROP COLUMN IF EXISTS ios_push_credential_sid;
