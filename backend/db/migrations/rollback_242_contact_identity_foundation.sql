-- rollback_241_contact_identity_foundation.sql
-- Safe only before archived contact donors become authoritative.

DROP TABLE IF EXISTS contact_phones;
DROP TABLE IF EXISTS contact_external_identities;

ALTER TABLE contacts
    DROP COLUMN IF EXISTS deleted_at;
