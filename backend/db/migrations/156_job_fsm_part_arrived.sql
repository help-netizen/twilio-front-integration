-- OUTBOUND-PARTS-CALL-001 (OPC1-T1) — add the "Part arrived" job status to each
-- company's active published Job FSM (machine_key='job'). Additive only: no existing
-- state/transition removed.
--
-- The Job FSM is dual-sourced (hardcoded fallback in jobsService.js + per-company
-- published SCXML in fsm_machines/fsm_versions). At runtime updateBlancStatus calls
-- fsmService.resolveTransition first, so for already-seeded tenants the DB graph is
-- authoritative — this migration rewrites their published SCXML in place.
--
-- Modeled EXACTLY on 127_job_fsm_on_the_way.sql: join the active published version,
-- idempotency guard via NOT LIKE, RAISE NOTICE + CONTINUE if markers are missing,
-- archive the current published row, INSERT version_number+1 as published, repoint
-- fsm_machines.active_version_id.
--
-- The migration runner executes plain .sql via db.query and cannot require() JS, so the
-- SCXML transform is kept inline here as two replace() passes (self-contained SQL — no
-- JS helper is required, mirroring the pattern of 127_job_fsm_on_the_way.sql).
--
-- No automatic rollback: FSM versions are append-only (archive + insert + repoint), so
-- this rewrite is not trivially reversible — exactly as 127_job_fsm_on_the_way.sql (which
-- likewise ships no rollback_*.sql). To revert, re-publish the prior archived fsm_version
-- (set it back to 'published' and repoint fsm_machines.active_version_id).
--
-- Transitions added (OUTBOUND-PARTS-CALL-001 §5.5):
--   Waiting_for_parts --TO_PART_ARRIVED-->  Part_arrived   (dispatcher action button)
--   Part_arrived      --TO_RESCHEDULED-->    Rescheduled
--   Part_arrived      --TO_CANCELED-->       Canceled
--   Part_arrived      --TO_FOLLOW_UP-->      Follow_Up_with_Client
--
-- State id = Part_arrived (SCXML id rules); status name/label = "Part arrived".

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
          AND v.scxml_source NOT LIKE '%id="Part_arrived"%'
    LOOP
        -- (A) Insert the new Part_arrived state immediately BEFORE the Canceled <final>.
        -- (B) Inject the inbound TO_PART_ARRIVED transition as first child of
        --     Waiting_for_parts. Chained so a single equality check below covers
        --     "no markers found".
        new_scxml := replace(
            replace(
                rec.scxml_source,
                '  <final id="Canceled" blanc:label="Canceled" />',
                '  <state id="Part_arrived" blanc:label="Part arrived" blanc:statusName="Part arrived">
    <transition event="TO_RESCHEDULED" target="Rescheduled" blanc:action="true" blanc:label="Reschedule" blanc:order="1" />
    <transition event="TO_FOLLOW_UP" target="Follow_Up_with_Client" blanc:action="true" blanc:label="Follow up with client" blanc:order="2" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:order="3" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>

  <final id="Canceled" blanc:label="Canceled" />'
            ),
            '  <state id="Waiting_for_parts" blanc:label="Waiting for parts">',
            '  <state id="Waiting_for_parts" blanc:label="Waiting for parts">
    <transition event="TO_PART_ARRIVED" target="Part_arrived" blanc:action="true" blanc:label="Part arrived" blanc:order="0" />'
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
            'Add Part arrived status (OUTBOUND-PARTS-CALL-001)',
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
