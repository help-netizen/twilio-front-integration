-- Roll back INVOICE-ESTIMATE-NUMBERING-001.

BEGIN;

DROP TRIGGER IF EXISTS trg_estimates_assign_public_code ON estimates;
DROP TRIGGER IF EXISTS trg_invoices_assign_public_code ON invoices;
DROP FUNCTION IF EXISTS estimates_assign_public_code();
DROP FUNCTION IF EXISTS invoices_assign_public_code();
DROP FUNCTION IF EXISTS estimate_public_code(BIGINT);
DROP FUNCTION IF EXISTS invoice_public_code(BIGINT);

DROP INDEX IF EXISTS uq_estimates_public_code;
DROP INDEX IF EXISTS uq_invoices_public_code;

ALTER TABLE estimates
    DROP COLUMN IF EXISTS public_code;

ALTER TABLE invoices
    DROP COLUMN IF EXISTS public_code,
    DROP COLUMN IF EXISTS public_token_expires_at;

COMMIT;
