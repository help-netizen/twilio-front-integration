-- =============================================================================
-- Migration 144: ORPHAN-TASK-REHOME-001 — re-home OPEN tasks stranded on shadow
-- orphan timelines onto the surviving contact-linked timeline.
--
-- The Pulse sidebar page (timelinesQueries.getUnifiedTimelinePage → GET
-- /api/calls/by-contact) drops a contactless orphan timeline (contact_id IS NULL)
-- whose phone is already covered by a contact-linked timeline in the SAME company
-- via its primary OR secondary number — the "one row per person" dedup. An OPEN
-- task, however, is keyed on the orphan's timeline id (tasks.thread_id), so once
-- that orphan row is hidden the task's Action-Required entry silently disappears
-- from Pulse. Adoption historically re-pointed only calls.contact_id, never
-- tasks.thread_id, so tasks created before a contact-linked timeline shadowed the
-- orphan can be stranded on it.
--
-- Going forward the adoption / merge / ensure-timeline paths re-home these tasks
-- at resolution time (timelinesQueries.reassignShadowOrphanOpenTasks). This is the
-- one-time backfill for tasks stranded BEFORE that fix shipped.
--
-- The match mirrors the dedup predicate exactly: an orphan whose phone digits
-- equal some contact's primary OR secondary digits in the same company (NULLIF
-- guards stop '' matching a digit-less row). '[^0-9]' is used in place of '\D' to
-- avoid any backslash-escaping ambiguity in raw SQL (identical result; same idiom
-- as the getUnifiedTimelinePage SMS lateral). DISTINCT ON picks one deterministic
-- surviving timeline in the rare case an orphan's phone matches multiple contacts.
--
-- Idempotent / re-runnable: after the move the task sits on a contact-linked
-- timeline, so it is no longer selected (the orphan side requires contact_id IS
-- NULL + an open task on the orphan). Logs how many tasks it moved. The prior
-- thread_id is not recorded — see rollback_144 (undo needs a PITR restore).
-- =============================================================================
DO $$
DECLARE
    moved INTEGER;
BEGIN
    WITH surviving AS (
        SELECT DISTINCT ON (o.id)
               o.id     AS orphan_id,
               canon.id AS surviving_id
        FROM timelines o
        JOIN contacts c
          ON c.company_id = o.company_id
         AND (
              NULLIF(regexp_replace(c.phone_e164,      '[^0-9]', '', 'g'), '') = regexp_replace(o.phone_e164, '[^0-9]', '', 'g')
           OR NULLIF(regexp_replace(c.secondary_phone, '[^0-9]', '', 'g'), '') = regexp_replace(o.phone_e164, '[^0-9]', '', 'g')
         )
        JOIN timelines canon
          ON canon.contact_id = c.id
         AND canon.company_id = o.company_id
        WHERE o.contact_id IS NULL
          AND NULLIF(regexp_replace(o.phone_e164, '[^0-9]', '', 'g'), '') IS NOT NULL
          AND canon.id <> o.id
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.thread_id = o.id AND t.status = 'open')
        ORDER BY o.id, canon.id
    )
    UPDATE tasks t
       SET thread_id = s.surviving_id, updated_at = now()
      FROM surviving s
     WHERE t.thread_id = s.orphan_id
       AND t.status = 'open';

    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'ORPHAN-TASK-REHOME-001 (mig 144): re-homed % open task(s) off shadow orphan timelines onto contact-linked timelines', moved;
END $$;
