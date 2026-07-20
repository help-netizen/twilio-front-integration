-- Rollback 188: publish a new lead-FSM version without the hidden
-- AI_BOOKING_TO_REVIEW transitions added by AGENT-BOOKING-FAIL-001.

DO $$
DECLARE
    rec RECORD;
    new_scxml TEXT;
    new_version_id UUID;
    transition_with_newline CONSTANT TEXT :=
        E'\n    <transition event="AI_BOOKING_TO_REVIEW" target="Review" />';
BEGIN
    FOR rec IN
        SELECT
            m.id AS machine_id,
            m.company_id,
            v.id AS version_id,
            v.scxml_source
        FROM fsm_machines m
        JOIN fsm_versions v ON v.id = m.active_version_id
        WHERE m.machine_key = 'lead'
          AND v.status = 'published'
          AND v.scxml_source LIKE '%event="AI_BOOKING_TO_REVIEW" target="Review"%'
    LOOP
        new_scxml := replace(rec.scxml_source, transition_with_newline, '');
        IF new_scxml = rec.scxml_source THEN
            CONTINUE;
        END IF;

        UPDATE fsm_versions
        SET status = 'archived'
        WHERE id = rec.version_id
          AND machine_id = rec.machine_id
          AND company_id = rec.company_id
          AND status = 'published';

        INSERT INTO fsm_versions (
            machine_id,
            company_id,
            version_number,
            status,
            scxml_source,
            change_note,
            created_by,
            published_by,
            published_at
        )
        SELECT
            rec.machine_id,
            rec.company_id,
            COALESCE(MAX(version_number), 0) + 1,
            'published',
            new_scxml,
            'Rollback AGENT-BOOKING-FAIL-001 Review entry transitions',
            'system',
            'system',
            NOW()
        FROM fsm_versions
        WHERE machine_id = rec.machine_id
          AND company_id = rec.company_id
        RETURNING id INTO new_version_id;

        UPDATE fsm_machines
        SET active_version_id = new_version_id,
            updated_at = NOW()
        WHERE id = rec.machine_id
          AND company_id = rec.company_id;
    END LOOP;
END $$;
