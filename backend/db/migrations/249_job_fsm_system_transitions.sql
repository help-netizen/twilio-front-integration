-- FSM-SYSTEM-TRANSITIONS-001: identify reserved Job states, attach the arrival
-- ETA operation to On the way, and retire the fragile per-edge notification op.
-- Each active published Job FSM is versioned using the established append-only
-- migration pattern. Every individual rewrite is marker-guarded, so replay is
-- a no-op and custom graphs are changed only where the reserved markers exist.

DO $$
DECLARE
    rec RECORD;
    edge_rec RECORD;
    new_scxml TEXT;
    state_open TEXT;
    new_state_open TEXT;
    new_edge TEXT;
    new_version_id UUID;
BEGIN
    FOR rec IN
        SELECT
            m.id AS machine_id,
            m.company_id,
            v.id AS version_id,
            v.scxml_source
        FROM fsm_machines m
        JOIN fsm_versions v
          ON v.id = m.active_version_id
         AND v.company_id = m.company_id
        WHERE m.machine_key = 'job'
          AND v.status = 'published'
    LOOP
        new_scxml := rec.scxml_source;

        SELECT captures[1] INTO state_open
        FROM regexp_matches(
            new_scxml,
            '(<state[^>]*[[:space:]]id="Submitted"[^>]*>)'
        ) AS matches(captures)
        LIMIT 1;
        IF state_open IS NOT NULL
           AND state_open NOT LIKE '%blanc:system="start"%'
        THEN
            new_state_open := regexp_replace(
                state_open,
                '>$',
                ' blanc:system="start">'
            );
            new_scxml := replace(new_scxml, state_open, new_state_open);
        END IF;

        SELECT captures[1] INTO state_open
        FROM regexp_matches(
            new_scxml,
            '(<state[^>]*[[:space:]]id="Visit_completed"[^>]*>)'
        ) AS matches(captures)
        LIMIT 1;
        IF state_open IS NOT NULL
           AND state_open NOT LIKE '%blanc:system="visit_completed"%'
        THEN
            new_state_open := regexp_replace(
                state_open,
                '>$',
                ' blanc:system="visit_completed">'
            );
            new_scxml := replace(new_scxml, state_open, new_state_open);
        END IF;

        SELECT captures[1] INTO state_open
        FROM regexp_matches(
            new_scxml,
            '(<state[^>]*[[:space:]]id="On_the_way"[^>]*>)'
        ) AS matches(captures)
        LIMIT 1;
        IF state_open IS NOT NULL
           AND state_open NOT LIKE '%blanc:system="on_the_way"%'
        THEN
            new_state_open := regexp_replace(
                state_open,
                '>$',
                ' blanc:system="on_the_way">'
            );
            new_scxml := replace(new_scxml, state_open, new_state_open);
        END IF;

        SELECT captures[1] INTO state_open
        FROM regexp_matches(
            new_scxml,
            '(<state[^>]*[[:space:]]id="On_the_way"[^>]*>)'
        ) AS matches(captures)
        LIMIT 1;
        IF state_open IS NOT NULL
           AND state_open NOT LIKE '%blanc:op="arrival_eta"%'
        THEN
            new_state_open := regexp_replace(
                state_open,
                '>$',
                ' blanc:op="arrival_eta">'
            );
            new_scxml := replace(new_scxml, state_open, new_state_open);
        END IF;

        SELECT captures[1] INTO state_open
        FROM regexp_matches(
            new_scxml,
            '(<final[^>]*[[:space:]]id="Job_is_Done"[^>]*>)'
        ) AS matches(captures)
        LIMIT 1;
        IF state_open IS NOT NULL
           AND state_open NOT LIKE '%blanc:system="job_done"%'
        THEN
            new_state_open := regexp_replace(
                state_open,
                '[[:space:]]*/?>$',
                ' blanc:system="job_done" />'
            );
            new_scxml := replace(new_scxml, state_open, new_state_open);
        END IF;

        FOR edge_rec IN
            SELECT captures[1] AS opening_tag
            FROM regexp_matches(
                new_scxml,
                '(<transition[^>]*>)',
                'g'
            ) AS matches(captures)
        LOOP
            IF edge_rec.opening_tag LIKE '%event="TO_ON_THE_WAY"%'
               AND edge_rec.opening_tag LIKE '%target="On_the_way"%'
               AND edge_rec.opening_tag LIKE '%blanc:op="notify_on_the_way"%'
            THEN
                new_edge := regexp_replace(
                    edge_rec.opening_tag,
                    '[[:space:]]+blanc:op="notify_on_the_way"',
                    '',
                    'g'
                );
                new_scxml := replace(new_scxml, edge_rec.opening_tag, new_edge);
            END IF;
        END LOOP;

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
            'Move Job arrival ETA operation to system state (FSM-SYSTEM-TRANSITIONS-001)',
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
