-- TENANT-ISO-002 stage 2a rollback.
-- The ownership backfill is intentionally one-way; only the constraint/index
-- are reverted. Roll back 263 first if stage 2b has already run.

DO $$
BEGIN
    IF to_regclass('public.uq_timelines_orphan_phone') IS NULL THEN
        RAISE EXCEPTION 'TENANT_ISO_262_ROLLBACK: restore stage 2b/global index first';
    END IF;
END $$;

DROP INDEX IF EXISTS uq_timelines_company_orphan_phone;

ALTER TABLE timelines
    ALTER COLUMN company_id DROP NOT NULL;

