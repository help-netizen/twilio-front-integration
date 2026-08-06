-- Roll back only a still-active system version created by migration 240.
-- A graph published after migration 240 is left untouched.

DO $$
DECLARE
    rec RECORD;
    prior_version_id UUID;
BEGIN
    FOR rec IN
        SELECT m.id AS machine_id, m.company_id, v.id AS version_id, v.version_number
        FROM fsm_machines m
        JOIN fsm_versions v
          ON v.id = m.active_version_id
         AND v.company_id = m.company_id
        WHERE m.machine_key = 'job'
          AND v.status = 'published'
          AND v.change_note = 'FSM-driven Job action buttons (FSM-JOB-ACTIONS-001)'
          AND v.created_by = 'system'
          AND v.published_by = 'system'
    LOOP
        SELECT id INTO prior_version_id
        FROM fsm_versions
        WHERE machine_id = rec.machine_id
          AND company_id = rec.company_id
          AND status = 'archived'
          AND version_number < rec.version_number
        ORDER BY version_number DESC
        LIMIT 1;

        IF prior_version_id IS NULL THEN
            CONTINUE;
        END IF;

        UPDATE fsm_versions
        SET status = 'archived'
        WHERE id = rec.version_id
          AND machine_id = rec.machine_id
          AND company_id = rec.company_id;

        UPDATE fsm_versions
        SET status = 'published'
        WHERE id = prior_version_id
          AND machine_id = rec.machine_id
          AND company_id = rec.company_id;

        UPDATE fsm_machines
        SET active_version_id = prior_version_id,
            updated_at = NOW()
        WHERE id = rec.machine_id
          AND company_id = rec.company_id;
    END LOOP;
END $$;
