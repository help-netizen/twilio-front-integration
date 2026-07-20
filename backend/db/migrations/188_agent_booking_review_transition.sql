-- AGENT-BOOKING-FAIL-001 — allow the outbound lead caller to put a booked lead
-- into Review without bypassing the DB-driven lead workflow.
--
-- OLC-POSTCALL-001 added Status='Review' to confirmLeadBooking's atomic hold
-- update. Migration 095 had added the Review state, but only gave Review outbound
-- transitions; every existing state still lacked an inbound edge to Review.
-- leadsService.updateLead therefore rejected the entire hold with
-- FSM_TRANSITION_DENIED before writing LeadDateTime/LeadEndDateTime.
--
-- Add one HIDDEN system edge to Review from every non-final state except Review.
-- Omitting blanc:action keeps the transition out of human action menus while
-- fsmService.resolveTransition can still validate the system's target-state write.
-- Final states are <final>, not <state>, so they remain closed. Each company's
-- active graph is transformed independently and versioned using the established
-- append-only FSM migration pattern. Re-application is a no-op.

DO $$
DECLARE
    rec RECORD;
    state_rec RECORD;
    new_scxml TEXT;
    state_start INTEGER;
    state_close INTEGER;
    state_block TEXT;
    new_version_id UUID;
    transition_line CONSTANT TEXT :=
        '    <transition event="AI_BOOKING_TO_REVIEW" target="Review" />';
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
          AND v.scxml_source ~ '<state[^>]*[[:space:]]id="Review"'
    LOOP
        new_scxml := rec.scxml_source;

        FOR state_rec IN
            SELECT
                captures[1] AS opening_tag,
                captures[2] AS state_id
            FROM regexp_matches(
                rec.scxml_source,
                '(<state[^>]*[[:space:]]id="([^"]+)"[^>]*>)',
                'g'
            ) AS matches(captures)
        LOOP
            IF state_rec.state_id = 'Review' THEN
                CONTINUE;
            END IF;

            state_start := strpos(new_scxml, state_rec.opening_tag);
            IF state_start = 0 THEN
                CONTINUE;
            END IF;
            state_close := strpos(substring(new_scxml FROM state_start), '</state>');
            IF state_close = 0 THEN
                CONTINUE;
            END IF;
            state_block := substring(
                new_scxml FROM state_start
                FOR state_close + length('</state>') - 1
            );
            IF state_block LIKE '%target="Review"%' THEN
                CONTINUE;
            END IF;

            new_scxml := replace(
                new_scxml,
                state_rec.opening_tag,
                state_rec.opening_tag || E'\n' || transition_line
            );
        END LOOP;

        IF new_scxml = rec.scxml_source THEN
            RAISE NOTICE 'Lead FSM % not updated: every non-final state already reaches Review',
                rec.machine_id;
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
            'Allow AI-booked leads to enter Review (AGENT-BOOKING-FAIL-001)',
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
