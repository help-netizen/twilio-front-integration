/**
 * Timelines Query Module
 * Extracted from queries.js — RF006
 *
 * Covers: timeline CRUD, unread state, action required, tasks, thread assignment
 */
const db = require('./connection');
const { toE164 } = require('../utils/phoneUtils');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Sentinel phone_e164 value for the single shared "Anonymous" timeline.
 * All calls with privacy-blocked / unknown caller ID are aggregated here.
 */
const ANONYMOUS_PHONE_SENTINEL = 'ANONYMOUS';

// =============================================================================
// Timeline unread state
// =============================================================================

async function markTimelineUnread(timelineId) {
    const result = await db.query(
        `UPDATE timelines SET has_unread = true, updated_at = now() WHERE id = $1 RETURNING *`,
        [timelineId]
    );
    return result.rows[0] || null;
}

async function markTimelineRead(timelineId) {
    const result = await db.query(
        `UPDATE timelines SET has_unread = false, last_read_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [timelineId]
    );
    return result.rows[0] || null;
}

// =============================================================================
// Timeline find/create
// =============================================================================

/**
 * Find or create the single shared orphan timeline used for anonymous /
 * privacy-blocked calls. There is no contact to associate, so we keep
 * contact_id NULL and use a sentinel string in phone_e164.
 *
 * The orphan unique-index `uq_timelines_orphan_phone` (UNIQUE on phone_e164
 * WHERE contact_id IS NULL) guarantees a single row.
 */
async function findOrCreateAnonymousTimeline(companyId = null) {
    const result = await db.query(
        `INSERT INTO timelines (phone_e164, company_id)
         VALUES ($1, $2)
         ON CONFLICT (phone_e164) WHERE phone_e164 IS NOT NULL AND contact_id IS NULL
         DO UPDATE SET updated_at = now()
         RETURNING *`,
        [ANONYMOUS_PHONE_SENTINEL, companyId || DEFAULT_COMPANY_ID]
    );
    return result.rows[0];
}

/**
 * ORPHAN-TASK-REHOME-001 — re-home OPEN tasks stranded on a contactless "shadow"
 * orphan timeline onto the surviving contact-linked timeline.
 *
 * getUnifiedTimelinePage (the Pulse sidebar page) drops a contactless orphan
 * timeline whose phone is already covered by a contact-linked timeline in the
 * same company — the "one row per person" dedup. But an OPEN task is keyed on the
 * orphan's timeline id (tasks.thread_id), so once that orphan row is hidden the
 * task's Action-Required row silently disappears. Historically adoption only ever
 * re-pointed calls.contact_id, never tasks.thread_id, so such a task was stranded.
 *
 * Every path that resolves a contact to its canonical timeline while a shadow
 * orphan may still exist (the two findOrCreate* helpers, the ensure-timeline
 * route) calls this to move the open tasks across FIRST. Matching mirrors the
 * dedup predicate exactly: an orphan whose phone digits equal THIS contact's
 * primary OR secondary digits (NULLIF guards stop '' matching a digit-less row).
 *
 * One statement; idempotent (once a task is homed onto a contact-linked timeline
 * it no longer sits on an `o.contact_id IS NULL` orphan, so a re-run moves
 * nothing). Non-transactional, matching the surrounding autocommit adoption code:
 * a partial failure at worst leaves a task on the orphan, which the mig-144
 * backfill or the next resolution retries — never data loss. `o.id <> $1` keeps
 * an in-place-adopted orphan from being treated as its own shadow.
 *
 * @param {number|string} survivingTimelineId  contact-linked timeline id to keep
 * @param {number|string} contactId            the contact being resolved
 * @param {string}        companyId
 * @param {{query: Function}} [client=db]       pool or a tx client
 * @returns {Promise<number>} number of open tasks re-homed
 */
async function reassignShadowOrphanOpenTasks(survivingTimelineId, contactId, companyId, client = db) {
    if (!survivingTimelineId || !contactId) return 0;
    const res = await client.query(
        `UPDATE tasks t
            SET thread_id = $1, updated_at = now()
           FROM timelines o
           JOIN contacts c ON c.id = $2 AND c.company_id = $3
          WHERE t.thread_id = o.id
            AND t.status = 'open'
            AND o.id <> $1
            AND o.contact_id IS NULL
            AND o.company_id = $3
            AND NULLIF(regexp_replace(o.phone_e164, '\\D', '', 'g'), '') IN (
                    NULLIF(regexp_replace(c.phone_e164, '\\D', '', 'g'), ''),
                    NULLIF(regexp_replace(c.secondary_phone, '\\D', '', 'g'), '')
                )`,
        [survivingTimelineId, contactId, companyId]
    );
    if (res.rowCount > 0) {
        console.log(`[Timeline] Re-homed ${res.rowCount} open task(s) from shadow orphan(s) onto contact timeline ${survivingTimelineId}`);
    }
    return res.rowCount || 0;
}

async function findOrCreateTimeline(phoneE164, companyId = null) {
    // Sentinel: route through the dedicated anonymous helper so we don't
    // accidentally try to match contacts by the literal "ANONYMOUS" string.
    if (phoneE164 === ANONYMOUS_PHONE_SENTINEL) {
        return findOrCreateAnonymousTimeline(companyId);
    }
    const digits = phoneE164.replace(/\D/g, '');
    // Tenant scope (PF007-HARDENING-001): a phone match must never resolve to
    // another company's contact or timeline.
    const cid = companyId || DEFAULT_COMPANY_ID;

    const contactResult = await db.query(
        `SELECT * FROM contacts
         WHERE company_id = $2
           AND (regexp_replace(phone_e164, '\\D', '', 'g') = $1
            OR regexp_replace(secondary_phone, '\\D', '', 'g') = $1)
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1`,
        [digits, cid]
    );
    const contact = contactResult.rows[0] || null;

    if (contact) {
        let tl = await db.query(
            `SELECT * FROM timelines WHERE contact_id = $1 AND company_id = $2 LIMIT 1`,
            [contact.id, cid]
        );
        if (tl.rows[0]) {
            // Contact already has its canonical timeline. A shadow orphan on the
            // contact's OTHER number can still hold an open task the sidebar dedup
            // would hide — pull those onto the canonical row first (REHOME-001).
            await reassignShadowOrphanOpenTasks(tl.rows[0].id, contact.id, cid);
            return { ...tl.rows[0], contact_id: contact.id };
        }

        const orphan = await db.query(
            `SELECT id FROM timelines
             WHERE contact_id IS NULL
               AND company_id = $2
               AND regexp_replace(phone_e164, '\\D', '', 'g') = $1
             ORDER BY updated_at DESC NULLS LAST
             LIMIT 1`,
            [digits, cid]
        );
        if (orphan.rows[0]) {
            await db.query(
                `UPDATE timelines SET contact_id = $1, phone_e164 = NULL, updated_at = now() WHERE id = $2`,
                [contact.id, orphan.rows[0].id]
            );
            await db.query(
                `UPDATE calls SET contact_id = $1 WHERE timeline_id = $2 AND contact_id IS NULL`,
                [contact.id, orphan.rows[0].id]
            );
            // The adopted orphan keeps its id, so its own tasks stay valid; but a
            // SECOND shadow orphan (the contact's other number) can still strand an
            // open task — re-home those onto the just-adopted canonical row.
            await reassignShadowOrphanOpenTasks(orphan.rows[0].id, contact.id, cid);
            console.log(`[Timeline] Adopted orphan timeline ${orphan.rows[0].id} for contact ${contact.id}`);
            tl = await db.query(`SELECT * FROM timelines WHERE id = $1`, [orphan.rows[0].id]);
            return { ...tl.rows[0], contact_id: contact.id };
        }

        tl = await db.query(
            `INSERT INTO timelines (contact_id, company_id)
             VALUES ($1, $2)
             ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL
             DO UPDATE SET updated_at = now()
             RETURNING *`,
            [contact.id, companyId || contact.company_id || DEFAULT_COMPANY_ID]
        );
        // Fresh canonical timeline (no linked timeline, no orphan on the incoming
        // number) — an orphan on the contact's OTHER number may still exist, so
        // sweep any stranded open tasks onto it.
        await reassignShadowOrphanOpenTasks(tl.rows[0].id, contact.id, cid);
        return { ...tl.rows[0], contact_id: contact.id };
    }

    let tl = await db.query(
        `SELECT * FROM timelines
         WHERE contact_id IS NULL
           AND company_id = $2
           AND regexp_replace(phone_e164, '\\D', '', 'g') = $1
         LIMIT 1`,
        [digits, cid]
    );
    if (tl.rows[0]) return tl.rows[0];

    const normalizedPhone = toE164(phoneE164) || phoneE164;
    tl = await db.query(
        `INSERT INTO timelines (phone_e164, company_id)
         VALUES ($1, $2)
         ON CONFLICT (phone_e164) WHERE phone_e164 IS NOT NULL AND contact_id IS NULL
         DO UPDATE SET updated_at = now()
         RETURNING *`,
        [normalizedPhone, companyId || DEFAULT_COMPANY_ID]
    );
    return tl.rows[0];
}

/**
 * Phone-less analogue of findOrCreateTimeline: resolve the timeline for an
 * already-known contact (e.g. inbound/outbound email, where the contact is
 * matched by email address upstream — EMAIL-TIMELINE-001 §3d step 1).
 *
 * Mirrors the contactId branch of `pulse.js POST /ensure-timeline`:
 *   1. return the contact's existing linked timeline, else
 *   2. adopt an orphan timeline (contact_id IS NULL) matching the contact's
 *      phone / secondary_phone, else
 *   3. INSERT a fresh contact-linked timeline.
 *
 * Because timelines carry a partial-unique index on (contact_id) WHERE
 * contact_id IS NOT NULL, this resolves to the SAME single row that the SMS
 * path (findOrCreateTimeline → match contact by phone → contact_id) reaches —
 * so email and SMS for a contact share one timeline. Company-scoped: a contact
 * from another tenant resolves to nothing (returns null).
 *
 * @param {string|number} contactId
 * @param {string|null} companyId
 * @param {{query: Function}} [client=db]  pool (default) or a tx client, so a
 *   caller inside a BEGIN/COMMIT can resolve the timeline within its transaction
 *   (CONTACT-EMAIL-MERGE-001 FK-order recipe step 1). Additive: existing callers
 *   omit it and keep the byte-for-byte pool behavior. Threaded through the inner
 *   queries and the reassignShadowOrphanOpenTasks calls; logic is unchanged.
 * @returns {Promise<object|null>} the timeline row, or null if the contact does
 *   not exist within the given company.
 */
async function findOrCreateTimelineByContact(contactId, companyId = null, client = db) {
    const cid = companyId || DEFAULT_COMPANY_ID;

    // Contact must live in the current tenant (data isolation). Also pull the
    // phones up-front so we can hunt for an adoptable orphan below.
    const contactResult = await client.query(
        `SELECT id, phone_e164, secondary_phone
         FROM contacts WHERE id = $1 AND company_id = $2`,
        [contactId, cid]
    );
    const contact = contactResult.rows[0];
    if (!contact) return null;

    // 1. Existing timeline already linked to this contact.
    const existing = await client.query(
        `SELECT * FROM timelines WHERE contact_id = $1 AND company_id = $2 LIMIT 1`,
        [contactId, cid]
    );
    if (existing.rows[0]) {
        // Heal a shadow orphan on this contact's number(s) whose open task the
        // Pulse dedup would hide (REHOME-001).
        await reassignShadowOrphanOpenTasks(existing.rows[0].id, contactId, cid, client);
        return existing.rows[0];
    }

    // 2. No linked timeline yet — adopt an orphan timeline for the contact's
    //    phone(s), so an email-first contact reuses any call/SMS timeline.
    const phonesToCheck = [contact.phone_e164, contact.secondary_phone]
        .filter(Boolean)
        .map(p => p.replace(/\D/g, ''));

    if (phonesToCheck.length > 0) {
        const orphan = await client.query(
            `SELECT id FROM timelines
             WHERE contact_id IS NULL
               AND company_id = $2
               AND regexp_replace(phone_e164, '\\D', '', 'g') = ANY($1)
             ORDER BY updated_at DESC NULLS LAST
             LIMIT 1`,
            [phonesToCheck, cid]
        );
        if (orphan.rows[0]) {
            const adopted = await client.query(
                `UPDATE timelines SET contact_id = $1, phone_e164 = NULL, updated_at = now()
                 WHERE id = $2 RETURNING *`,
                [contactId, orphan.rows[0].id]
            );
            await client.query(
                `UPDATE calls SET contact_id = $1 WHERE timeline_id = $2 AND contact_id IS NULL`,
                [contactId, orphan.rows[0].id]
            );
            // Re-home any open task stranded on a SECOND shadow orphan (the
            // contact's other number) onto the just-adopted canonical row.
            await reassignShadowOrphanOpenTasks(orphan.rows[0].id, contactId, cid, client);
            console.log(`[Timeline] Adopted orphan timeline ${orphan.rows[0].id} for contact ${contactId}`);
            return adopted.rows[0];
        }
    }

    // 3. No orphan — create a fresh contact-linked timeline. The partial-unique
    //    index on (contact_id) makes this idempotent under a race.
    const created = await client.query(
        `INSERT INTO timelines (contact_id, company_id)
         VALUES ($1, $2)
         ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL
         DO UPDATE SET updated_at = now()
         RETURNING *`,
        [contactId, cid]
    );
    // Fresh canonical timeline — sweep any shadow orphan's stranded open task
    // (contact's phone matched no orphan above but a secondary-number orphan may
    // exist) onto it.
    await reassignShadowOrphanOpenTasks(created.rows[0].id, contactId, cid, client);
    return created.rows[0];
}

/**
 * LIST-PAGINATION-001 — the ONE timeline-rooted, SQL-ordered, offset/limit
 * page that backs the Pulse sidebar (`GET /api/calls/by-contact`).
 *
 * Unifies THREE channels into a single ordered query so pagination is correct
 * (≤ limit rows per page, no JS over-fetch/re-sort/dedup):
 *   • calls  — latest root call on the timeline
 *   • SMS    — latest sms_conversations row for the timeline's phone digits
 *   • email  — EMAIL-OUTBOUND-001: latest email_threads row per contact,
 *              direction-agnostic via a two-leg UNION ALL:
 *                leg 1 (inbound)  — threads with an INBOUND message whose
 *                normalized from_email maps (via contact_emails) to this
 *                timeline's contact; a text re-match over ALL history,
 *                byte-identical to the original Scope A predicates (the
 *                mig 143 index and the d56db8f search fix pin that text);
 *                leg 2 (outbound) — threads with an OUTBOUND message already
 *                linked to the contact through the persisted mig-129 columns
 *                (em.contact_id + em.on_timeline, stamped by the send paths
 *                and backfilled by mig 155). Outbound reads the persisted
 *                link ONLY — pre-link history was never text-matched, and
 *                per-row recipient-JSON expansion is banned from this hot
 *                query.
 *              Contactless email threads are NOT surfaced (no synthetic rows).
 *
 * Everything is company-scoped (mandatory, not conditional): outer
 * `tl.company_id = $companyId`, `sms.company_id = tl.company_id`,
 * `eml.company_id = tl.company_id`, and the lead-name search subquery carries
 * `l.company_id`. This closes the pre-existing cross-tenant SMS leak.
 *
 * `total_count = COUNT(*) OVER()` over the full company-scoped unified set.
 *
 * SURFACING + AR: a timeline surfaces if it has ANY signal — call, SMS, email,
 * an OPEN TASK, the legacy is_action_required flag, or unread. The AR band (sort
 * tier 0) pins on the SAME canonical signal the frontend pins on: `open_task.id`
 * (has an open task) AND not snoozed — NOT is_action_required, which AR-TASK-
 * UNIFY-001 deprecated as a pin (kept here only as a surfacing signal so the old
 * route's rows still appear). WHERE and ORDER BY therefore reference one AR
 * definition.
 *
 * DEDUP: one row per person, enforced in SQL BEFORE the LIMIT (never in JS after,
 * which would shrink a page below `limit` and break the frontend's
 * `pageSize < limit ⇒ no more pages` logic). A contactless orphan timeline whose
 * phone is already covered by a contact-linked timeline (primary or secondary) in
 * the same company is excluded, so a contact with a leftover orphan on a secondary
 * number does not appear twice.
 *
 * PERFORMANCE: because ORDER BY must see all rows before LIMIT, the per-timeline
 * work runs for every company timeline. The email match is therefore hoisted
 * into a single pre-aggregated CTE (`email_by_contact`) that resolves
 * contact_id → latest email thread ONCE for the whole company, instead of a
 * correlated EXISTS re-scanned per timeline row. Leg 1 is served by the
 * mig 143 functional index (company_id, lower(trim(from_email))); leg 2 by
 * the mig 129 partial index on the persisted link. See the route/spec notes
 * for EXPLAIN reasoning.
 *
 * @param {object} opts
 * @param {number} opts.limit
 * @param {number} opts.offset
 * @param {string} opts.companyId  MANDATORY — caller must reject a missing tenant.
 * @param {string|null} opts.search
 * @returns {Promise<Array>} unified rows (already ordered); each carries
 *   total_count for the envelope.
 */
async function getUnifiedTimelinePage({ limit = 50, offset = 0, companyId, search = null, mutedEmails = [], mutedDomains = [] } = {}) {
    // $1 companyId, $2 limit, $3 offset. companyId is always param $1 so the
    // company scope is present on every code path (hard requirement).
    // MAIL-MUTE-001: $4 = mutedEmails (text[]), $5 = mutedDomains (text[]).
    // Both default to [] so every existing caller (LIST-PAGINATION-001 sync
    // callers, etc.) is byte-for-byte unaffected — an empty set makes
    // `email_muted` always false (ANY(ARRAY[]::text[]) = false) → zero behavior
    // change when nothing is muted. Bound BEFORE the search params so any search
    // terms shift to $6+ via the existing `params.length + 1` idiom (unchanged).
    const params = [companyId, limit, offset, mutedEmails, mutedDomains];

    let searchFilter = '';
    if (search && String(search).trim().length > 0) {
        const searchTerm = String(search).trim();
        const digits = searchTerm.replace(/\D/g, '');
        const conditions = [];
        const textIdx = params.length + 1;
        params.push('%' + searchTerm + '%');
        // contact name / lead name (company-scoped) / sms friendly_name / email subject
        conditions.push('co.full_name ILIKE $' + textIdx);
        conditions.push('latest_call.call_sid ILIKE $' + textIdx);
        conditions.push(
            "EXISTS (SELECT 1 FROM leads l WHERE l.company_id = tl.company_id AND regexp_replace(l.phone, E'\\\\D', '', 'g') = regexp_replace(co.phone_e164, E'\\\\D', '', 'g') AND (l.first_name ILIKE $" + textIdx + " OR l.last_name ILIKE $" + textIdx + " OR CONCAT(l.first_name, ' ', l.last_name) ILIKE $" + textIdx + "))"
        );
        conditions.push(
            "EXISTS (SELECT 1 FROM leads l WHERE l.company_id = tl.company_id AND regexp_replace(l.phone, E'\\\\D', '', 'g') = regexp_replace(tl.phone_e164, E'\\\\D', '', 'g') AND (l.first_name ILIKE $" + textIdx + " OR l.last_name ILIKE $" + textIdx + " OR CONCAT(l.first_name, ' ', l.last_name) ILIKE $" + textIdx + "))"
        );
        conditions.push('sms.friendly_name ILIKE $' + textIdx);
        // NB: the email CTE exposes the thread subject as `email_subject` (aliased from
        // et.subject), so the search predicate must use eml.email_subject — `eml.subject`
        // does not exist on the CTE and 500s the search path.
        conditions.push('eml.email_subject ILIKE $' + textIdx);
        if (digits.length > 0) {
            const digitIdx = params.length + 1;
            params.push('%' + digits + '%');
            conditions.push("regexp_replace(co.phone_e164, E'\\\\D', '', 'g') LIKE $" + digitIdx);
            conditions.push("regexp_replace(latest_call.from_number, E'\\\\D', '', 'g') LIKE $" + digitIdx);
            conditions.push("regexp_replace(latest_call.to_number, E'\\\\D', '', 'g') LIKE $" + digitIdx);
            conditions.push("regexp_replace(tl.phone_e164, E'\\\\D', '', 'g') LIKE $" + digitIdx);
        }
        searchFilter = 'AND (' + conditions.join(' OR ') + ')';
    }

    const result = await db.query(
        `WITH email_by_contact AS (
             -- EMAIL-OUTBOUND-001: direction-agnostic pre-aggregation. For this
             -- company, resolve each contact to its single most-recent email
             -- thread across TWO legs, computed ONCE (not per-timeline) so the
             -- ORDER-BY-before-LIMIT scan stays cheap.
             --   Leg 1 (inbound): text re-match over ALL history — threads with
             --   an INBOUND message whose normalized from_email maps (via
             --   contact_emails) to the contact. Predicates byte-identical to
             --   the original Scope A CTE: the mig 143 functional index and the
             --   d56db8f search fix depend on exactly this text.
             --   Leg 2 (outbound): persisted-link read — threads with an
             --   OUTBOUND message the send paths (or the mig 155 backfill)
             --   already linked to the contact via the mig-129 columns.
             --   Historical outbound was never text-matched, so the persisted
             --   link is the only correct source; expanding recipient JSON per
             --   row is banned from this hot query.
             SELECT DISTINCT ON (contact_id)
                    contact_id,
                    email_thread_id,
                    email_subject,
                    last_message_at,
                    last_message_direction,
                    unread_count
             FROM (
                 SELECT ce.contact_id, et.id AS email_thread_id, et.subject AS email_subject,
                        et.last_message_at, et.last_message_direction, et.unread_count
                 FROM email_messages em
                 JOIN contact_emails ce ON ce.email_normalized = lower(trim(em.from_email))
                 JOIN email_threads et ON et.id = em.thread_id
                 WHERE em.company_id = $1 AND et.company_id = $1
                   AND em.direction = 'inbound' AND em.from_email IS NOT NULL
                 UNION ALL
                 SELECT em.contact_id, et.id, et.subject,
                        et.last_message_at, et.last_message_direction, et.unread_count
                 FROM email_messages em
                 JOIN email_threads et ON et.id = em.thread_id
                 WHERE em.company_id = $1 AND et.company_id = $1
                   AND em.direction = 'outbound' AND em.contact_id IS NOT NULL
                   AND em.on_timeline = true
             ) legs
             -- A mixed thread emits identical tuples from both legs; DISTINCT ON
             -- collapses them. The email_thread_id DESC tie-break is NEW and
             -- deliberate: it makes equal-timestamp thread selection
             -- deterministic (previously plan-dependent). Non-semantic ordering
             -- fix, not a behavior change.
             ORDER BY contact_id, last_message_at DESC NULLS LAST, email_thread_id DESC
         )
         SELECT
             latest_call.*,
             to_json(co) as contact,
             tl.id as tl_id,
             tl.id as timeline_id,
             tl.has_unread as tl_has_unread,
             COALESCE(tl.phone_e164, co.phone_e164) as tl_phone,
             tl.sms_last_at,
             tl.is_action_required,
             tl.action_required_reason,
             tl.action_required_set_at,
             tl.action_required_set_by,
             tl.snoozed_until,
             tl.owner_user_id,
             co.has_unread as contact_has_unread,
             open_task.id as open_task_id,
             open_task.title as open_task_title,
             open_task.description as open_task_description,
             open_task.due_at as open_task_due_at,
             open_task.priority as open_task_priority,
             open_task.kind as open_task_kind,
             open_task.agent_output as open_task_agent_output,
             open_task.actions as open_task_actions,
             -- SLOTPICK-001 (SP-03): expose the open task's parent (job) id/type so the
             -- Pulse AR robot-call button can getJob(jobId) for coords. Mirrors the
             -- getTaskById SELECT_TASK projection. Additive — WHERE/ORDER/params unchanged.
             open_task.parent_id as open_task_parent_id,
             open_task.parent_type as open_task_parent_type,
             COALESCE(open_task.task_count, 0) as open_task_count,
             sms.last_message_at as sms_last_message_at,
             sms.last_message_direction as sms_last_message_direction,
             sms.last_message_preview as sms_last_message_preview,
             sms.friendly_name as sms_friendly_name,
             sms.has_unread as sms_has_unread,
             sms.sms_conversation_id,
             eml.email_thread_id,
             eml.email_subject,
             eml.last_message_at as email_last_message_at,
             eml.last_message_direction as email_last_message_direction,
             eml.unread_count as email_unread_count,
             -- MAIL-MUTE-001: expose the per-row mute flag (computed once in the
             -- em LATERAL below) so consumers can inspect it; also referenced by
             -- name in the surfacing WHERE and the ORDER BY (Postgres forbids
             -- referencing a SELECT-list alias there, hence the LATERAL).
             em.email_muted AS email_muted,
             -- MAIL-MUTE-001: a muted email must not bump ordering — drop its
             -- last_message_at from the GREATEST when email_muted.
             GREATEST(latest_call.started_at, sms.last_message_at, CASE WHEN NOT em.email_muted THEN eml.last_message_at END) AS last_interaction_at,
             (tl.has_unread OR COALESCE(sms.has_unread, false)
              OR (COALESCE(eml.unread_count, 0) > 0 AND NOT em.email_muted) OR COALESCE(co.has_unread, false)) AS any_unread,
             COUNT(*) OVER() AS total_count
         FROM timelines tl
         LEFT JOIN contacts co ON tl.contact_id = co.id
         LEFT JOIN LATERAL (
             SELECT c2.*
             FROM calls c2
             WHERE c2.timeline_id = tl.id
               AND c2.parent_call_sid IS NULL
             ORDER BY c2.started_at DESC NULLS LAST
             LIMIT 1
         ) latest_call ON true
         LEFT JOIN LATERAL (
             SELECT ot.id, ot.title, ot.description, ot.due_at, ot.priority,
                    ot.kind, ot.agent_output, ot.actions,
                    -- SLOTPICK-001 (SP-03): derive parent_type/_id via the SAME CASE the
                    -- getTaskById SELECT_TASK projection uses (job/lead/estimate/invoice/
                    -- contact/timeline), so a Pulse AR consumer resolves the job id exactly
                    -- as the Job-card TaskCard does.
                    CASE
                        WHEN ot.job_id      IS NOT NULL THEN 'job'
                        WHEN ot.lead_id     IS NOT NULL THEN 'lead'
                        WHEN ot.estimate_id IS NOT NULL THEN 'estimate'
                        WHEN ot.invoice_id  IS NOT NULL THEN 'invoice'
                        WHEN ot.contact_id  IS NOT NULL THEN 'contact'
                        WHEN ot.thread_id   IS NOT NULL THEN 'timeline'
                    END AS parent_type,
                    COALESCE(ot.job_id, ot.lead_id, ot.estimate_id, ot.invoice_id, ot.contact_id, ot.thread_id) AS parent_id,
                    (SELECT count(*) FROM tasks tc
                      WHERE tc.thread_id = tl.id AND tc.status = 'open') AS task_count
             FROM tasks ot
             WHERE ot.thread_id = tl.id AND ot.status = 'open'
             ORDER BY ot.due_at ASC NULLS LAST, ot.created_at ASC
             LIMIT 1
         ) open_task ON true
         LEFT JOIN LATERAL (
             SELECT sc.last_message_at, sc.last_message_direction,
                    sc.last_message_preview, sc.friendly_name, sc.has_unread,
                    sc.id as sms_conversation_id
             FROM sms_conversations sc
             WHERE sc.company_id = tl.company_id
               AND sc.customer_digits IN (
                 regexp_replace(COALESCE(tl.phone_e164, co.phone_e164), '[^0-9]', '', 'g'),
                 CASE WHEN co.secondary_phone IS NOT NULL
                      THEN regexp_replace(co.secondary_phone, '[^0-9]', '', 'g')
                      ELSE NULL END
             )
             ORDER BY sc.last_message_at DESC NULLS LAST
             LIMIT 1
         ) sms ON true
         LEFT JOIN email_by_contact eml ON eml.contact_id = tl.contact_id
         -- MAIL-MUTE-001: compute the per-row email_muted scalar ONCE here so it
         -- can be referenced by name in the SELECT, the surfacing WHERE, and the
         -- ORDER BY (a SELECT-list alias is not visible in WHERE/ORDER BY). The
         -- muted set ($4 emails / $5 domains) was parsed from THIS company's
         -- settings, and this only ever evaluates on rows already scoped by
         -- tl.company_id = $1 (FR-7). email_muted is TRUE when the contact's own
         -- co.email -- or ANY of its contact_emails.email_normalized -- is an
         -- exact member of the muted emails set, OR its domain part is a member of
         -- the muted domains set. Empty sets => ANY(ARRAY[]::text[]) = false =>
         -- email_muted is always false (feature-off parity, no plan change). The
         -- EXISTS is a PK-indexed lookup on contact_emails(contact_id) -- no regex,
         -- no Seq Scan (PULSE-PERF-001 discipline).
         LEFT JOIN LATERAL (
             SELECT (
                 lower(co.email) = ANY($4)
                 OR split_part(lower(co.email), '@', 2) = ANY($5)
                 OR EXISTS (
                      SELECT 1 FROM contact_emails ce2
                      WHERE ce2.contact_id = tl.contact_id
                        AND ( ce2.email_normalized = ANY($4)
                           OR split_part(ce2.email_normalized, '@', 2) = ANY($5) )
                    )
             ) AS email_muted
         ) em ON true
         WHERE tl.company_id = $1
           -- Surfacing predicate: a timeline appears if it has ANY signal. This
           -- mirrors the pre-rewrite /by-contact WHERE exactly, including
           -- open_task.id IS NOT NULL — a timeline whose ONLY signal is an open
           -- task (dispatcher follow-up on a contact that never called/texted/
           -- emailed; is_action_required stays false because task creation does
           -- NOT set it, per AR-TASK-UNIFY-001) must still surface, since the AR
           -- band below pins exactly those rows.
           AND (latest_call.id IS NOT NULL
                OR sms.sms_conversation_id IS NOT NULL
                -- MAIL-MUTE-001: a muted email no longer surfaces the timeline, so
                -- an email-ONLY muted contact (no call/SMS/task/unread) drops out
                -- of the list entirely — and, because it fails this predicate, it
                -- never enters the COUNT(*) OVER() window either (page stays
                -- <= limit; pagination integrity — FR-5).
                OR (eml.email_thread_id IS NOT NULL AND NOT em.email_muted)
                OR open_task.id IS NOT NULL
                OR tl.is_action_required = true OR tl.has_unread = true)
           -- Orphan-shadow dedup (done in SQL, BEFORE the LIMIT, so the page stays
           -- exactly <= limit — a post-LIMIT JS dedup would shrink a page below the
           -- frontend "pageSize < limit => no more pages" threshold and break
           -- pagination). Drops a contactless orphan timeline (contact_id IS NULL,
           -- created by activity on a phone before that phone was linked) when a
           -- contact-linked timeline in the SAME company already covers that phone
           -- via its primary OR secondary number. The contact-linked row is
           -- canonical (carries the name; its SMS lateral surfaces the same
           -- conversation because customer_digits matches the secondary). Only
           -- orphans with a real (non-empty) phone-digit match are dropped — the
           -- NULLIF guards stop '' = '' from matching a digit-less orphan/contact.
           AND NOT (
                tl.contact_id IS NULL
                AND EXISTS (
                    SELECT 1 FROM timelines tl2
                    JOIN contacts c2 ON c2.id = tl2.contact_id
                    WHERE tl2.company_id = tl.company_id
                      AND NULLIF(regexp_replace(tl.phone_e164, '\\D', '', 'g'), '') IS NOT NULL
                      AND (
                           NULLIF(regexp_replace(c2.phone_e164, '\\D', '', 'g'), '')      = regexp_replace(tl.phone_e164, '\\D', '', 'g')
                        OR NULLIF(regexp_replace(c2.secondary_phone, '\\D', '', 'g'), '') = regexp_replace(tl.phone_e164, '\\D', '', 'g')
                      )
                )
           )
           ${searchFilter}
         ORDER BY
           -- Tier 0 = Action Required. Canonical AR signal = open_task.id (has an
           -- open task) AND not currently snoozed. This is the SAME signal the WHERE
           -- surfaces on (open_task.id above) and the SAME signal the frontend pins
           -- on (PulsePage sidebar builds its "Action Required" section from
           -- has_open_task = !!open_task_id, NOT from is_action_required — see
           -- AR-TASK-UNIFY-001, which deprecated is_action_required as a pin signal).
           -- is_action_required is kept only as a *surfacing* signal (row appears)
           -- to match the old route, never as a pin — so nothing the old route
           -- pinned is un-pinned and nothing it showed is hidden.
           CASE WHEN open_task.id IS NOT NULL
                 AND (tl.snoozed_until IS NULL OR tl.snoozed_until <= now())
                THEN 0
                WHEN tl.has_unread = true OR COALESCE(sms.has_unread, false) = true
                     OR (COALESCE(eml.unread_count, 0) > 0 AND NOT em.email_muted) OR COALESCE(co.has_unread, false) = true
                THEN 1
                ELSE 2
           END ASC,
           CASE WHEN open_task.id IS NOT NULL
                 AND (tl.snoozed_until IS NULL OR tl.snoozed_until <= now())
                THEN tl.action_required_set_at END DESC NULLS LAST,
           -- MAIL-MUTE-001: mirror the SELECT last_interaction_at exactly (drop a
           -- muted email's last_message_at) -- otherwise the recency rank would
           -- desync from the value the row reports.
           GREATEST(latest_call.started_at, sms.last_message_at, CASE WHEN NOT em.email_muted THEN eml.last_message_at END) DESC NULLS LAST,
           tl.id DESC
         LIMIT $2 OFFSET $3`,
        params
    );
    return result.rows;
}

// =============================================================================
// Action Required + Tasks
// =============================================================================

async function setActionRequired(timelineId, reason, setBy = 'system') {
    const result = await db.query(
        `UPDATE timelines SET
            is_action_required = true,
            action_required_reason = $2,
            action_required_set_at = now(),
            action_required_set_by = $3,
            snoozed_until = NULL,
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [timelineId, reason, setBy]
    );
    return result.rows[0] || null;
}

async function markThreadHandled(timelineId) {
    const tl = await db.query(
        `UPDATE timelines SET
            is_action_required = false,
            action_required_reason = NULL,
            action_required_set_at = NULL,
            action_required_set_by = NULL,
            snoozed_until = NULL,
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [timelineId]
    );
    await db.query(
        `UPDATE tasks SET status = 'done', completed_at = now()
         WHERE thread_id = $1 AND status = 'open'`,
        [timelineId]
    );
    return tl.rows[0] || null;
}

async function snoozeThread(timelineId, snoozedUntil) {
    const result = await db.query(
        `UPDATE timelines SET
            snoozed_until = $2,
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [timelineId, snoozedUntil]
    );
    return result.rows[0] || null;
}

async function unsnoozeExpiredThreads() {
    // AR-TASK-UNIFY-001: "Action Required" is now derived from open tasks, so a
    // snoozed thread is one that has an open task (or the legacy flag). Expire
    // the snooze for either.
    const result = await db.query(
        `UPDATE timelines SET
            snoozed_until = NULL,
            updated_at = now()
         WHERE (is_action_required = true
                OR EXISTS (SELECT 1 FROM tasks WHERE tasks.thread_id = timelines.id AND tasks.status = 'open'))
           AND snoozed_until IS NOT NULL
           AND snoozed_until <= now()
         RETURNING id`
    );
    return result.rows.map(r => r.id);
}

async function assignThread(timelineId, ownerUserId) {
    const tl = await db.query(
        `UPDATE timelines SET
            owner_user_id = $2,
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [timelineId, ownerUserId]
    );
    await db.query(
        `UPDATE tasks SET owner_user_id = $2
         WHERE thread_id = $1 AND status = 'open'`,
        [timelineId, ownerUserId]
    );
    return tl.rows[0] || null;
}

async function createTask({ companyId, threadId, subjectType, subjectId, title, description, priority, dueAt, ownerUserId, createdBy, kind, agentType, agentInput, agentOutput, agentStatus }) {
    const provenance = createdBy || 'user';
    // MAIL-AGENT-001: agent callers stamp the mig-100 agent columns (kind,
    // agent_type, agent_input/output, agent_status). User path passes none of
    // them and keeps writing kind's DB default ('user').
    const taskKind = kind || (provenance === 'agent' ? 'agent' : 'user');
    // AR-TASK-UNIFY-001: a timeline can now hold MANY open tasks (the v1
    // one-open-per-thread unique index was dropped in mig 139). Auto callers
    // (inbound SMS/call/email, rules, agent) still keep a SINGLE open task per
    // thread — upserted here at the app layer instead of via ON CONFLICT. A
    // user-created task is always additive and is never clobbered by an auto
    // upsert (we only ever update an existing AUTO-provenance open task).
    const AUTO = ['system', 'automation', 'agent'];
    if (AUTO.includes(provenance)) {
        const existing = await db.query(
            `SELECT id FROM tasks
              WHERE thread_id = $1 AND status = 'open' AND created_by = ANY($2::text[])
              ORDER BY created_at ASC
              LIMIT 1`,
            [threadId, AUTO]
        );
        if (existing.rows[0]) {
            const upd = await db.query(
                `UPDATE tasks SET
                    title = $2,
                    description = $3,
                    priority = $4,
                    due_at = $5,
                    owner_user_id = COALESCE($6, owner_user_id),
                    kind = $7,
                    agent_type = COALESCE($8, agent_type),
                    agent_input = COALESCE($9::jsonb, agent_input),
                    agent_output = COALESCE($10::jsonb, agent_output),
                    agent_status = COALESCE($11, agent_status),
                    updated_at = now()
                 WHERE id = $1
                 RETURNING *`,
                [existing.rows[0].id, title, description || null, priority || 'p2', dueAt || null, ownerUserId || null,
                    taskKind, agentType || null,
                    agentInput ? JSON.stringify(agentInput) : null,
                    agentOutput ? JSON.stringify(agentOutput) : null,
                    agentStatus || null]
            );
            return upd.rows[0];
        }
    }
    const result = await db.query(
        `INSERT INTO tasks (company_id, thread_id, subject_type, subject_id, title, description, priority, due_at, owner_user_id, created_by,
                            kind, agent_type, agent_input, agent_output, agent_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15)
         RETURNING *`,
        [companyId, threadId, subjectType || 'contact', subjectId || null, title, description || null, priority || 'p2', dueAt || null, ownerUserId || null, provenance,
            taskKind, agentType || null,
            agentInput ? JSON.stringify(agentInput) : null,
            agentOutput ? JSON.stringify(agentOutput) : null,
            agentStatus || null]
    );
    // TASKS-COUNT-BADGE-001: a fresh INSERT can add an open task that the badge
    // counts — but ONLY when it satisfies HAS_ENTITY_PARENT's timeline clause,
    // i.e. created_by IN ('user','agent'). system/automation timeline tasks reach
    // THIS insert too (when no existing AUTO open task exists) and are Pulse-only /
    // count-excluded, so the guard must be EXPLICIT here, not implied by branch.
    // The AUTO-upsert-UPDATE branch above never emits (updating an existing open
    // task leaves the count unchanged). Lazy require avoids a circular import;
    // best-effort — a broadcast failure never fails the task write.
    if (['user', 'agent'].includes(provenance)) {
        try {
            require('../services/tasksService').emitTaskChange(companyId);
        } catch (err) {
            console.warn('[timelinesQueries] task.changed emit failed:', err.message);
        }
    }
    return result.rows[0];
}

async function getOpenTaskByThread(threadId) {
    const result = await db.query(
        `SELECT * FROM tasks WHERE thread_id = $1 AND status = 'open' LIMIT 1`,
        [threadId]
    );
    return result.rows[0] || null;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    markTimelineUnread,
    markTimelineRead,
    findOrCreateTimeline,
    findOrCreateTimelineByContact,
    findOrCreateAnonymousTimeline,
    reassignShadowOrphanOpenTasks,
    ANONYMOUS_PHONE_SENTINEL,
    getUnifiedTimelinePage,
    setActionRequired,
    markThreadHandled,
    snoozeThread,
    unsnoozeExpiredThreads,
    assignThread,
    createTask,
    getOpenTaskByThread,
};
