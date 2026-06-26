-- ONWAY-001 — add the "On the way" job status to each company's active published
-- Job FSM (machine_key='job'). Additive only: no existing state/transition removed.
--
-- The Job FSM is dual-sourced (hardcoded fallback in jobsService.js + per-company
-- published SCXML in fsm_machines/fsm_versions). At runtime updateBlancStatus calls
-- fsmService.resolveTransition first, so for already-seeded tenants the DB graph is
-- authoritative — editing only fsm/job.scxml or the 073 heredoc would NOT reach
-- existing companies. This migration rewrites their published SCXML in place.
--
-- Modeled EXACTLY on 095_add_review_lead_status.sql: join the active published
-- version, idempotency guard via NOT LIKE, RAISE NOTICE + CONTINUE if markers are
-- missing, archive the current published row, INSERT version_number+1 as published,
-- repoint fsm_machines.active_version_id.
--
-- NOTE: the migration runner (apply_migrations.js) executes plain .sql via db.query
-- and cannot require() JS, so the SCXML transform is kept inline here as two
-- replace() passes. The byte-identical logic also lives in the DB-free helper
-- backend/src/services/fsm/onTheWayTransform.js (injectOnTheWay) used by the unit
-- tests (TASK-ONWAY-3). Keep the two in lockstep.
--
-- Transitions added (ONWAY-001 §5.5):
--   Submitted   --TO_ON_THE_WAY-->     On_the_way
--   Rescheduled --TO_ON_THE_WAY-->     On_the_way
--   On_the_way  --TO_VISIT_COMPLETED--> Visit_completed
--   On_the_way  --TO_CANCELED-->        Canceled
--
-- State id = On_the_way (SCXML id rules); status name/label = "On the way".

DO $$
DECLARE
    rec RECORD;
    new_scxml TEXT;
    new_version_id UUID;
BEGIN
    FOR rec IN
        SELECT
            m.id AS machine_id,
            m.company_id,
            v.scxml_source
        FROM fsm_machines m
        JOIN fsm_versions v ON v.id = m.active_version_id
        WHERE m.machine_key = 'job'
          AND v.scxml_source NOT LIKE '%id="On_the_way"%'
    LOOP
        -- (A) Insert the new On_the_way state immediately BEFORE the Canceled <final>.
        -- (B) Inject the inbound TO_ON_THE_WAY transition as first child of both
        --     Submitted and Rescheduled. Chained so a single equality check below
        --     covers "no markers found".
        new_scxml := replace(
            replace(
                replace(
                    rec.scxml_source,
                    '  <final id="Canceled" blanc:label="Canceled" />',
                    '  <state id="On_the_way" blanc:label="On the way" blanc:statusName="On the way">
    <transition event="TO_VISIT_COMPLETED" target="Visit_completed" blanc:action="true" blanc:label="Visit completed" blanc:order="1" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:order="2" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>

  <final id="Canceled" blanc:label="Canceled" />'
                ),
                '  <state id="Submitted" blanc:label="Submitted">',
                '  <state id="Submitted" blanc:label="Submitted">
    <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label="On the way" blanc:order="0" />'
            ),
            '  <state id="Rescheduled" blanc:label="Rescheduled">',
            '  <state id="Rescheduled" blanc:label="Rescheduled">
    <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label="On the way" blanc:order="0" />'
        );

        IF new_scxml = rec.scxml_source THEN
            RAISE NOTICE 'Job FSM % was not updated: state markers not found', rec.machine_id;
            CONTINUE;
        END IF;

        UPDATE fsm_versions
        SET status = 'archived'
        WHERE machine_id = rec.machine_id
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
            'Add On the way status (ONWAY-001)',
            'system',
            'system',
            NOW()
        FROM fsm_versions
        WHERE machine_id = rec.machine_id
        RETURNING id INTO new_version_id;

        UPDATE fsm_machines
        SET active_version_id = new_version_id,
            updated_at = NOW()
        WHERE id = rec.machine_id;
    END LOOP;
END $$;
