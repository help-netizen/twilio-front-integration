-- =============================================================================
-- Migration 155: EMAIL-OUTBOUND-001 — backfill timeline links for historical
-- OUTBOUND emails (pre-fix rows: direction='outbound', contact_id IS NULL,
-- on_timeline = false, genuinely sent).
--
-- Live path (already shipped): Gmail push → linkOutboundMessage
-- (backend/src/services/email/emailTimelineService.js) matches TO-recipients to
-- a contact (emailQueries.findEmailContact), resolves the contact's timeline
-- (timelinesQueries.findOrCreateTimelineByContact), stamps the link
-- (emailQueries.linkMessageToContact). Rows sent BEFORE that path shipped were
-- never linked, so outbound-first threads cannot surface in the Pulse unified
-- by-contact list (the list roots on timelines + the persisted mig-129 link).
-- This migration is the one-shot pure-SQL mirror of that live path.
--
-- Candidate set = the draft-safe discriminator canonized in
-- emailQueries.listUnlinkedOutboundForTimeline (comment quoted verbatim):
--     draft-safe: genuinely-sent emails carry a Message-ID header; a draft
--     being composed has none. email_messages stores no label, so this is the
--     discriminator that keeps drafts off the timeline on the poll/backfill path
--     (the push path excludes drafts via labelIds ∩ {DRAFT}).
-- i.e. direction = 'outbound' AND contact_id IS NULL AND on_timeline = false
--      AND message_id_header IS NOT NULL AND message_id_header <> ''.
-- The contact_id IS NULL / on_timeline = false gates are also what make a
-- re-run a no-op: rows linked by the first run no longer qualify (idempotent).
--
-- Recipient→contact match mirrors extractRecipientEmails + findEmailContact:
--   • TO recipients ONLY (to_recipients_json) — CC/BCC are never matched;
--   • non-array to_recipients_json is skipped (the Array.isArray guard in
--     extractRecipientEmails returns [] for it);
--   • address = lower(trim(elem->>'email')), NULL/empty skipped;
--   • contact match is company-scoped (c.company_id = em.company_id — a
--     cross-tenant link is impossible by construction) against
--     lower(contacts.email) OR contact_emails.email_normalized, tie-break
--     c.updated_at DESC NULLS LAST, c.id ASC;
--   • one contact per message, FIRST MATCHING RECIPIENT wins (the live loop
--     breaks on the first findEmailContact hit):
--     DISTINCT ON (em.id) ORDER BY em.id, ord ASC, c.updated_at DESC NULLS
--     LAST, c.id ASC.
--
-- Timeline resolution is the FULL SQL mirror of findOrCreateTimelineByContact
-- (backend/src/db/timelinesQueries.js), NOT a bare INSERT:
--   (a) reuse the contact's existing timeline in the same company;
--   (b) else ADOPT the newest phone-digit-matching orphan (contact_id IS NULL,
--       same company, orphan digits = contact primary/secondary digits;
--       '[^0-9]' in place of '\D' — same idiom and NULLIF guards as mig 144):
--       set contact_id, clear phone_e164, bump updated_at, AND re-point the
--       adopted orphan's calls that lack contact_id. A bare INSERT here would
--       fork the person across two timelines and the Pulse orphan-shadow dedup
--       would then hide their call history — the exact ORPHAN-TASK-REHOME-001
--       bug class. Two matched contacts sharing one orphan resolve
--       deterministically via a double DISTINCT ON (one pick per contact, then
--       one winner per orphan; stable ORDER BY); the losing contact falls
--       through to (c). Ordering carries an o.id DESC tie-break so DISTINCT ON
--       stays deterministic when updated_at ties (non-semantic: newest wins).
--   (c) else INSERT a fresh contact-linked timeline. Two deliberate deltas from
--       the JS helper, both required here: the conflict arbiter MUST carry
--       WHERE contact_id IS NOT NULL (without it Postgres cannot infer the
--       mig-029 partial unique index uq_timelines_contact), and a conflict is
--       DO NOTHING + re-select (at the stamping join) instead of the helper's
--       single-round-trip upsert-RETURNING convenience — a migration must not
--       bump updated_at on rows it did not touch.
--
-- Stamping mirrors linkMessageToContact: contact_id, timeline_id,
-- on_timeline = true, updated_at = now(). Deliberately NOT mirrored from the
-- live path: markThreadRead — unread_count is untouched everywhere in this file
-- (retroactively zeroing it could erase legitimate unread state from a later
-- inbound reply; unread model unchanged — D2/FR-3) — and SSE publish (pure SQL;
-- the list is correct at the next fetch).
--
-- Final step re-runs the mig-144 open-task re-home sweep: steps (b)/(c) can
-- newly shadow orphan timelines, and the project invariant since
-- ORPHAN-TASK-REHOME-001 is that every canonical-timeline-creating path sweeps
-- (the JS helper does via reassignShadowOrphanOpenTasks). The WITH … UPDATE
-- statement is copied verbatim from 144_rehome_orphan_open_tasks.sql (only its
-- DO wrapper is stripped — DO blocks cannot nest — and the NOTICE label names
-- this migration).
--
-- Idempotent / re-runnable / safe on empty data: every step no-ops and every
-- NOTICE prints 0 when there is nothing to do. Runs inside the standard
-- migration transaction — any failure aborts the whole block (no partial
-- links). See rollback_155 for the (documented one-way) rollback posture.
--
-- NOTE on the repeated CTE: `matched` below is written out verbatim in steps
-- 2b, 2c and 3. It reads only email_messages / contacts / contact_emails, none
-- of which this block modifies before step 3 stamps — so every repetition
-- yields the identical, deterministic set within the single transaction.
-- =============================================================================
DO $$
DECLARE
    candidates_examined INTEGER;
    orphans_adopted     INTEGER;
    calls_repointed     INTEGER;
    timelines_created   INTEGER;
    messages_linked     INTEGER;
    moved               INTEGER;
BEGIN
    ------------------------------------------------------------------
    -- Step 1: candidate set size (observability) — the exact
    -- listUnlinkedOutboundForTimeline predicate, without LIMIT.
    ------------------------------------------------------------------
    SELECT count(*)
      INTO candidates_examined
      FROM email_messages em
     WHERE em.direction = 'outbound'
       AND em.contact_id IS NULL
       AND em.on_timeline = false
       AND em.message_id_header IS NOT NULL
       AND em.message_id_header <> '';

    RAISE NOTICE 'EMAIL-OUTBOUND-001 (mig 155) step 1: examined % candidate outbound email(s) (unlinked, non-draft)', candidates_examined;

    ------------------------------------------------------------------
    -- Step 2b: ADOPT orphan timelines for matched contacts that have no
    -- timeline yet, and re-point the adopted orphans' contactless calls.
    -- (Step 2a — reuse — needs no write: contacts whose timeline already
    -- exists simply resolve at the stamping join in step 3.)
    ------------------------------------------------------------------
    WITH matched AS (
        SELECT DISTINCT ON (em.id)
               em.id         AS email_id,
               em.company_id AS company_id,
               c.id          AS contact_id
          FROM email_messages em
         CROSS JOIN LATERAL (
                SELECT NULLIF(lower(trim(x.elem->>'email')), '') AS addr,
                       x.ord
                  FROM jsonb_array_elements(em.to_recipients_json) WITH ORDINALITY AS x(elem, ord)
               ) r
          JOIN contacts c
            ON c.company_id = em.company_id
          LEFT JOIN contact_emails ce
            ON ce.contact_id = c.id
         WHERE em.direction = 'outbound'
           AND em.contact_id IS NULL
           AND em.on_timeline = false
           AND em.message_id_header IS NOT NULL
           AND em.message_id_header <> ''
           AND jsonb_typeof(em.to_recipients_json) = 'array'
           AND r.addr IS NOT NULL
           AND (lower(c.email) = r.addr OR ce.email_normalized = r.addr)
         ORDER BY em.id, r.ord ASC, c.updated_at DESC NULLS LAST, c.id ASC
    ),
    matched_contacts AS (
        SELECT DISTINCT m.contact_id, m.company_id FROM matched m
    ),
    need_timeline AS (
        SELECT mc.contact_id, mc.company_id, c.phone_e164, c.secondary_phone
          FROM matched_contacts mc
          JOIN contacts c
            ON c.id = mc.contact_id
           AND c.company_id = mc.company_id
         WHERE NOT EXISTS (
                SELECT 1 FROM timelines t
                 WHERE t.contact_id = mc.contact_id
                   AND t.company_id = mc.company_id
               )
    ),
    pick_per_contact AS (
        -- newest matching orphan per contact (mirror of the helper's
        -- ORDER BY updated_at DESC NULLS LAST LIMIT 1; o.id DESC tie-break
        -- keeps DISTINCT ON deterministic)
        SELECT DISTINCT ON (n.contact_id)
               n.contact_id,
               o.id AS orphan_id
          FROM need_timeline n
          JOIN timelines o
            ON o.company_id = n.company_id
           AND o.contact_id IS NULL
           AND regexp_replace(o.phone_e164, '[^0-9]', '', 'g') IN (
                 NULLIF(regexp_replace(n.phone_e164,      '[^0-9]', '', 'g'), ''),
                 NULLIF(regexp_replace(n.secondary_phone, '[^0-9]', '', 'g'), '')
               )
         ORDER BY n.contact_id, o.updated_at DESC NULLS LAST, o.id DESC
    ),
    pick_per_orphan AS (
        -- one orphan can be won by only one contact; the loser falls through
        -- to step 2c (creation)
        SELECT DISTINCT ON (p.orphan_id)
               p.orphan_id,
               p.contact_id
          FROM pick_per_contact p
         ORDER BY p.orphan_id, p.contact_id ASC
    ),
    adopted AS (
        UPDATE timelines t
           SET contact_id = p.contact_id,
               phone_e164 = NULL,
               updated_at = now()
          FROM pick_per_orphan p
         WHERE t.id = p.orphan_id
        RETURNING t.id AS orphan_id, t.contact_id
    ),
    repointed AS (
        UPDATE calls cl
           SET contact_id = a.contact_id
          FROM adopted a
         WHERE cl.timeline_id = a.orphan_id
           AND cl.contact_id IS NULL
        RETURNING 1
    )
    SELECT (SELECT count(*) FROM adopted),
           (SELECT count(*) FROM repointed)
      INTO orphans_adopted, calls_repointed;

    RAISE NOTICE 'EMAIL-OUTBOUND-001 (mig 155) step 2b: adopted % orphan timeline(s) (re-pointed % call(s))', orphans_adopted, calls_repointed;

    ------------------------------------------------------------------
    -- Step 2c: CREATE timelines for matched contacts that still have none
    -- (email-only contacts; also the losers of orphan contention above —
    -- this statement's snapshot already sees step 2b's adoptions).
    ------------------------------------------------------------------
    WITH matched AS (
        SELECT DISTINCT ON (em.id)
               em.id         AS email_id,
               em.company_id AS company_id,
               c.id          AS contact_id
          FROM email_messages em
         CROSS JOIN LATERAL (
                SELECT NULLIF(lower(trim(x.elem->>'email')), '') AS addr,
                       x.ord
                  FROM jsonb_array_elements(em.to_recipients_json) WITH ORDINALITY AS x(elem, ord)
               ) r
          JOIN contacts c
            ON c.company_id = em.company_id
          LEFT JOIN contact_emails ce
            ON ce.contact_id = c.id
         WHERE em.direction = 'outbound'
           AND em.contact_id IS NULL
           AND em.on_timeline = false
           AND em.message_id_header IS NOT NULL
           AND em.message_id_header <> ''
           AND jsonb_typeof(em.to_recipients_json) = 'array'
           AND r.addr IS NOT NULL
           AND (lower(c.email) = r.addr OR ce.email_normalized = r.addr)
         ORDER BY em.id, r.ord ASC, c.updated_at DESC NULLS LAST, c.id ASC
    ),
    matched_contacts AS (
        SELECT DISTINCT m.contact_id, m.company_id FROM matched m
    ),
    need_creation AS (
        SELECT mc.contact_id, mc.company_id
          FROM matched_contacts mc
         WHERE NOT EXISTS (
                SELECT 1 FROM timelines t
                 WHERE t.contact_id = mc.contact_id
                   AND t.company_id = mc.company_id
               )
    ),
    created AS (
        INSERT INTO timelines (contact_id, company_id)
        SELECT nc.contact_id, nc.company_id
          FROM need_creation nc
        ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL DO NOTHING
        RETURNING id
    )
    SELECT count(*) INTO timelines_created FROM created;

    RAISE NOTICE 'EMAIL-OUTBOUND-001 (mig 155) step 2c: created % timeline(s) for email-only contact(s)', timelines_created;

    ------------------------------------------------------------------
    -- Step 3: stamp the links (mirror of linkMessageToContact). The join on
    -- timelines is the re-select: it resolves reused (2a), adopted (2b) and
    -- created (2c) rows alike, company-scoped; the mig-029 partial unique
    -- index guarantees at most one timeline per contact, so no fan-out.
    -- unread_count is not touched; no SSE (pure SQL).
    ------------------------------------------------------------------
    WITH matched AS (
        SELECT DISTINCT ON (em.id)
               em.id         AS email_id,
               em.company_id AS company_id,
               c.id          AS contact_id
          FROM email_messages em
         CROSS JOIN LATERAL (
                SELECT NULLIF(lower(trim(x.elem->>'email')), '') AS addr,
                       x.ord
                  FROM jsonb_array_elements(em.to_recipients_json) WITH ORDINALITY AS x(elem, ord)
               ) r
          JOIN contacts c
            ON c.company_id = em.company_id
          LEFT JOIN contact_emails ce
            ON ce.contact_id = c.id
         WHERE em.direction = 'outbound'
           AND em.contact_id IS NULL
           AND em.on_timeline = false
           AND em.message_id_header IS NOT NULL
           AND em.message_id_header <> ''
           AND jsonb_typeof(em.to_recipients_json) = 'array'
           AND r.addr IS NOT NULL
           AND (lower(c.email) = r.addr OR ce.email_normalized = r.addr)
         ORDER BY em.id, r.ord ASC, c.updated_at DESC NULLS LAST, c.id ASC
    ),
    stamped AS (
        UPDATE email_messages em
           SET contact_id  = m.contact_id,
               timeline_id = tl.id,
               on_timeline = true,
               updated_at  = now()
          FROM matched m
          JOIN timelines tl
            ON tl.contact_id = m.contact_id
           AND tl.company_id = m.company_id
         WHERE em.id = m.email_id
        RETURNING 1
    )
    SELECT count(*) INTO messages_linked FROM stamped;

    RAISE NOTICE 'EMAIL-OUTBOUND-001 (mig 155) step 3: linked % outbound email(s) to contact timelines', messages_linked;

    ------------------------------------------------------------------
    -- Step 4: mig-144 open-task re-home sweep, verbatim (see header). Steps
    -- 2b/2c can newly shadow orphans whose open tasks the Pulse dedup would
    -- hide; every canonical-timeline-creating path sweeps (REHOME-001).
    ------------------------------------------------------------------
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
    RAISE NOTICE 'EMAIL-OUTBOUND-001 (mig 155) step 4: re-homed % open task(s) off shadow orphan timelines (mig-144 sweep re-run)', moved;

    ------------------------------------------------------------------
    -- Summary (single line for prod-copy dry-run capture).
    ------------------------------------------------------------------
    RAISE NOTICE 'EMAIL-OUTBOUND-001 (mig 155) summary: candidates=% linked=% adopted=% created=% tasks_rehomed=%',
        candidates_examined, messages_linked, orphans_adopted, timelines_created, moved;
END $$;
