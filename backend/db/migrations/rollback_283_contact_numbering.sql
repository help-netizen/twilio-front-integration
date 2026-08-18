-- Roll back CONTACT-NUMBERING-001.

BEGIN;

DROP TRIGGER IF EXISTS trg_contacts_assign_public_code ON contacts;
DROP FUNCTION IF EXISTS contacts_assign_public_code();
DROP FUNCTION IF EXISTS contact_public_code(BIGINT);

DROP INDEX IF EXISTS uq_contacts_public_code;

ALTER TABLE contacts
    DROP COLUMN IF EXISTS public_code;

COMMIT;
