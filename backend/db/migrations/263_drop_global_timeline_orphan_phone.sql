-- =============================================================================
-- TENANT-ISO-002, stage 2b (SEPARATE PRODUCTION GATE): after migration 262 and
-- application verification, remove the global orphan-phone uniqueness index.
-- The normal apply_migrations.js scan deliberately NO-OPs this file. An operator
-- must opt in in the same session/transaction before running it:
--   SET albusto.tenant_iso_263_approved = 'on';
-- This prevents shipping 262 and 263 together from collapsing the accepted
-- observation window. The tenant-aware index remains the only conflict target
-- after an approved run.
-- =============================================================================

DO $$
BEGIN
    IF current_setting('albusto.tenant_iso_263_approved', true) IS DISTINCT FROM 'on' THEN
        RAISE NOTICE 'TENANT_ISO_263_GATED: skipped; set albusto.tenant_iso_263_approved=on to apply stage 2b';
        RETURN;
    END IF;

    LOCK TABLE timelines IN SHARE ROW EXCLUSIVE MODE;

    IF to_regclass('public.uq_timelines_company_orphan_phone') IS NULL THEN
        RAISE EXCEPTION 'TENANT_ISO_263_PREFLIGHT: tenant-aware orphan-phone index is missing';
    END IF;
    IF EXISTS (SELECT 1 FROM timelines WHERE company_id IS NULL) THEN
        RAISE EXCEPTION 'TENANT_ISO_263_PREFLIGHT: timelines.company_id still contains NULL';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM timelines
        WHERE phone_e164 IS NOT NULL AND contact_id IS NULL
        GROUP BY company_id, phone_e164
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'TENANT_ISO_263_PREFLIGHT: duplicate tenant orphan-phone rows exist';
    END IF;

    DROP INDEX IF EXISTS uq_timelines_orphan_phone;
END $$;
