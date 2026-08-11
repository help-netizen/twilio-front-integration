-- Roll back FSM-SYSTEM-TRANSITIONS-001 by restoring the exact published Job
-- FSM version that preceded migration 249. This preserves whether each inbound
-- edge originally carried notify_on_the_way instead of guessing during rollback.

DO $$
DECLARE
    rec RECORD;
    prior_version_id UUID;
BEGIN
    FOR rec IN
        SELECT
            m.id AS machine_id,
            m.company_id,
            v.id AS version_id,
            v.version_number
        FROM fsm_machines m
        JOIN fsm_versions v
          ON v.id = m.active_version_id
         AND v.company_id = m.company_id
        WHERE m.machine_key = 'job'
          AND v.status = 'published'
          AND v.change_note =
              'Move Job arrival ETA operation to system state (FSM-SYSTEM-TRANSITIONS-001)'
          AND v.created_by = 'system'
          AND v.published_by = 'system'
    LOOP
        SELECT id INTO prior_version_id
        FROM fsm_versions
        WHERE machine_id = rec.machine_id
          AND company_id = rec.company_id
          AND status = 'archived'
          AND version_number < rec.version_number
          AND change_note IS DISTINCT FROM
              'Move Job arrival ETA operation to system state (FSM-SYSTEM-TRANSITIONS-001)'
        ORDER BY version_number DESC
        LIMIT 1;

        IF prior_version_id IS NULL THEN
            CONTINUE;
        END IF;

        UPDATE fsm_versions
        SET status = 'archived'
        WHERE id = rec.version_id
          AND machine_id = rec.machine_id
          AND company_id = rec.company_id
          AND status = 'published';

        UPDATE fsm_versions
        SET status = 'published'
        WHERE id = prior_version_id
          AND machine_id = rec.machine_id
          AND company_id = rec.company_id
          AND status = 'archived';

        UPDATE fsm_machines
        SET active_version_id = prior_version_id,
            updated_at = NOW()
        WHERE id = rec.machine_id
          AND company_id = rec.company_id;
    END LOOP;
END $$;
