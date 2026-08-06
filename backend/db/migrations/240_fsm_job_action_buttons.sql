-- FSM-JOB-ACTIONS-001 — annotate forward actions in the system default Job FSM.
--
-- Only machines whose entire published history is system-authored are eligible.
-- A company that has ever published a custom graph is deliberately untouched,
-- even if an older system migration later became its active version.

DO $$
DECLARE
    rec RECORD;
    new_scxml TEXT;
    new_version_id UUID;
BEGIN
    FOR rec IN
        SELECT m.id AS machine_id, m.company_id, v.id AS version_id, v.scxml_source
        FROM fsm_machines m
        JOIN fsm_versions v
          ON v.id = m.active_version_id
         AND v.company_id = m.company_id
        WHERE m.machine_key = 'job'
          AND v.status = 'published'
          AND v.created_by = 'system'
          AND v.published_by = 'system'
          AND NOT EXISTS (
              SELECT 1
              FROM fsm_versions custom
              WHERE custom.machine_id = m.id
                AND custom.company_id = m.company_id
                AND custom.status IN ('published', 'archived')
                AND (
                    custom.created_by IS DISTINCT FROM 'system'
                    OR custom.published_by IS DISTINCT FROM 'system'
                )
          )
    LOOP
        new_scxml := rec.scxml_source;

        -- Inbound "On the way" actions need both prominent-button metadata and
        -- the retained ETA notification operation.
        new_scxml := replace(
            new_scxml,
            'event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:button="true" blanc:label=',
            'event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:button="true" blanc:op="notify_on_the_way" blanc:label='
        );
        new_scxml := replace(
            new_scxml,
            'event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label=',
            'event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:button="true" blanc:op="notify_on_the_way" blanc:label='
        );

        -- The remaining forward operational actions are prominent buttons.
        new_scxml := replace(
            new_scxml,
            'event="TO_PART_ARRIVED" target="Part_arrived" blanc:action="true" blanc:label=',
            'event="TO_PART_ARRIVED" target="Part_arrived" blanc:action="true" blanc:button="true" blanc:label='
        );
        new_scxml := replace(
            new_scxml,
            'event="TO_VISIT_COMPLETED" target="Visit_completed" blanc:action="true" blanc:label=',
            'event="TO_VISIT_COMPLETED" target="Visit_completed" blanc:action="true" blanc:button="true" blanc:label='
        );
        new_scxml := replace(
            new_scxml,
            'event="TO_JOB_DONE" target="Job_is_Done" blanc:action="true" blanc:label=',
            'event="TO_JOB_DONE" target="Job_is_Done" blanc:action="true" blanc:button="true" blanc:label='
        );

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
            'FSM-driven Job action buttons (FSM-JOB-ACTIONS-001)',
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
