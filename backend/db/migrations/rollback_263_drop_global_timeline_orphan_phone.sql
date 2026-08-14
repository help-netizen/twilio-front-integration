-- TENANT-ISO-002 stage 2b rollback. This intentionally aborts if two companies
-- have since created the same orphan phone: restoring global uniqueness would
-- otherwise require deleting or merging tenant data.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM timelines
        WHERE phone_e164 IS NOT NULL AND contact_id IS NULL
        GROUP BY phone_e164
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'TENANT_ISO_263_ROLLBACK: cross-company duplicate phones exist; manual data-safe rollback required';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_timelines_orphan_phone
    ON timelines(phone_e164)
    WHERE phone_e164 IS NOT NULL AND contact_id IS NULL;

