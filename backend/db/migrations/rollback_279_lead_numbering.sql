-- Roll back LEAD-NUMBERING-001.

BEGIN;

DROP TRIGGER IF EXISTS trg_leads_assign_identifiers ON leads;
DROP FUNCTION IF EXISTS leads_assign_identifiers();
DROP FUNCTION IF EXISTS lead_public_code(BIGINT);

DROP TABLE IF EXISTS company_lead_counters;

DROP INDEX IF EXISTS uq_leads_company_lead_seq;
DROP INDEX IF EXISTS uq_leads_public_code;

ALTER TABLE leads
    DROP COLUMN IF EXISTS lead_seq,
    DROP COLUMN IF EXISTS public_code;

COMMIT;
