-- JOB-FSM-PART-ARRIVED-FORWARD-001 — make "Part arrived" a NON-BLOCKING job status.
--
-- Bug (owner report): once a job is in "Part arrived" the technician cannot move it
-- FORWARD. Migration 156 seeded Part_arrived with only three outbound transitions
-- (Rescheduled, Follow_Up_with_Client, Canceled) — there was no path to "On the way"
-- (head out to finish the visit) or "Visit completed", and Cancel needs jobs.close
-- (which a field provider lacks), so the provider was effectively trapped.
--
-- Fix: widen Part_arrived's outbound transitions so it behaves like the other
-- operational states — forward (On the way, Visit completed), lateral (Reschedule),
-- back (Waiting for parts, Submitted), plus the existing Follow up / Cancel. Additive
-- only: no state removed; the three original edges are preserved (reordered).
--
-- The Job FSM is dual-sourced (hardcoded ALLOWED_TRANSITIONS fallback in jobsService.js
-- + per-company published SCXML in fsm_machines/fsm_versions). updateBlancStatus calls
-- fsmService.resolveTransition FIRST, so for seeded tenants the DB graph is authoritative
-- — this migration rewrites their published SCXML in place. The static fallback is
-- updated in the same changeset (jobsService.js) for tenants with no published graph.
--
-- Modeled EXACTLY on 156_job_fsm_part_arrived.sql / 127_job_fsm_on_the_way.sql: join the
-- active published version, transform via replace(), skip (RAISE NOTICE + CONTINUE) when
-- the exact source block is absent (already applied OR the graph was re-serialized by the
-- FSM editor — handled manually then), archive the current published row, INSERT
-- version_number+1 as published, repoint fsm_machines.active_version_id. Idempotent: the
-- exact 3-edge block is only present pre-migration, so a re-run is a no-op.
--
-- All target state ids + event names already exist in the graph (On_the_way/TO_ON_THE_WAY,
-- Visit_completed/TO_VISIT_COMPLETED, Waiting_for_parts/TO_WAITING_PARTS, Submitted/
-- TO_SUBMITTED are used by Submitted/On_the_way/Rescheduled today) — no new state added.
--
-- No automatic rollback (FSM versions are append-only): to revert, re-publish the prior
-- archived fsm_version (set status='published', repoint fsm_machines.active_version_id).

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
          AND v.scxml_source LIKE '%id="Part_arrived"%'
    LOOP
        -- Replace the exact 3-edge Part_arrived block (as written by migration 156)
        -- with the widened 7-edge block. If the exact block is absent (already applied
        -- or re-serialized), replace() is a no-op → caught by the equality check below.
        new_scxml := replace(
            rec.scxml_source,
'<state id="Part_arrived" blanc:label="Part arrived" blanc:statusName="Part arrived">
    <transition event="TO_RESCHEDULED" target="Rescheduled" blanc:action="true" blanc:label="Reschedule" blanc:order="1" />
    <transition event="TO_FOLLOW_UP" target="Follow_Up_with_Client" blanc:action="true" blanc:label="Follow up with client" blanc:order="2" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:order="3" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>',
'<state id="Part_arrived" blanc:label="Part arrived" blanc:statusName="Part arrived">
    <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label="On the way" blanc:order="1" />
    <transition event="TO_VISIT_COMPLETED" target="Visit_completed" blanc:action="true" blanc:label="Visit completed" blanc:order="2" />
    <transition event="TO_RESCHEDULED" target="Rescheduled" blanc:action="true" blanc:label="Reschedule" blanc:order="3" />
    <transition event="TO_WAITING_PARTS" target="Waiting_for_parts" blanc:action="true" blanc:label="Back to waiting for parts" blanc:order="4" />
    <transition event="TO_FOLLOW_UP" target="Follow_Up_with_Client" blanc:action="true" blanc:label="Follow up with client" blanc:order="5" />
    <transition event="TO_SUBMITTED" target="Submitted" blanc:action="true" blanc:label="Back to Submitted" blanc:order="6" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:order="7" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>'
        );

        IF new_scxml = rec.scxml_source THEN
            RAISE NOTICE 'Job FSM % not updated: Part_arrived 3-edge block not found (already applied or re-serialized)', rec.machine_id;
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
            'Part arrived: allow forward/back transitions (JOB-FSM-PART-ARRIVED-FORWARD-001)',
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
