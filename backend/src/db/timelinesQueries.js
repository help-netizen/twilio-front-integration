/**
 * Timelines Query Module
 * Extracted from queries.js — RF006
 *
 * Covers: timeline CRUD, unread state, action required, tasks, thread assignment
 */
const db = require('./connection');
const { toE164 } = require('../utils/phoneUtils');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

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

async function findOrCreateTimeline(phoneE164, companyId = null) {
    const digits = phoneE164.replace(/\D/g, '');

    const contactResult = await db.query(
        `SELECT * FROM contacts
         WHERE regexp_replace(phone_e164, '\\D', '', 'g') = $1
            OR regexp_replace(secondary_phone, '\\D', '', 'g') = $1
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1`,
        [digits]
    );
    const contact = contactResult.rows[0] || null;

    if (contact) {
        let tl = await db.query(
            `SELECT * FROM timelines WHERE contact_id = $1 LIMIT 1`,
            [contact.id]
        );
        if (tl.rows[0]) return { ...tl.rows[0], contact_id: contact.id };

        const orphan = await db.query(
            `SELECT id FROM timelines
             WHERE contact_id IS NULL
               AND regexp_replace(phone_e164, '\\D', '', 'g') = $1
             ORDER BY updated_at DESC NULLS LAST
             LIMIT 1`,
            [digits]
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
        return { ...tl.rows[0], contact_id: contact.id };
    }

    let tl = await db.query(
        `SELECT * FROM timelines
         WHERE contact_id IS NULL
           AND regexp_replace(phone_e164, '\\D', '', 'g') = $1
         LIMIT 1`,
        [digits]
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

async function getCallsByTimeline({ limit = 20, offset = 0, companyId = null, search = null } = {}) {
    const companyFilter = companyId ? `AND tl.company_id = $3` : '';
    const params = [limit, offset];
    if (companyId) params.push(companyId);

    let searchFilter = '';
    if (search) {
        const searchTerm = search.trim();
        const digits = searchTerm.replace(/\D/g, '');
        const conditions = [];
        const textIdx = params.length + 1;
        params.push('%' + searchTerm + '%');
        conditions.push('co.full_name ILIKE $' + textIdx);
        conditions.push('latest_call.call_sid ILIKE $' + textIdx);
        conditions.push(
            "EXISTS (SELECT 1 FROM leads l WHERE regexp_replace(l.phone, E'\\\\D', '', 'g') = regexp_replace(co.phone_e164, E'\\\\D', '', 'g') AND (l.first_name ILIKE $" + textIdx + " OR l.last_name ILIKE $" + textIdx + " OR CONCAT(l.first_name, ' ', l.last_name) ILIKE $" + textIdx + "))"
        );
        conditions.push(
            "EXISTS (SELECT 1 FROM leads l WHERE regexp_replace(l.phone, E'\\\\D', '', 'g') = regexp_replace(tl.phone_e164, E'\\\\D', '', 'g') AND (l.first_name ILIKE $" + textIdx + " OR l.last_name ILIKE $" + textIdx + " OR CONCAT(l.first_name, ' ', l.last_name) ILIKE $" + textIdx + "))"
        );
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
        `SELECT
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
             open_task.id as open_task_id,
             open_task.title as open_task_title,
             open_task.due_at as open_task_due_at,
             open_task.priority as open_task_priority,
             sms.last_message_at as sms_last_message_at,
             sms.last_message_direction as sms_last_message_direction,
             sms.last_message_preview as sms_last_message_preview,
             sms.has_unread as sms_has_unread,
             sms.sms_conversation_id
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
         LEFT JOIN tasks open_task ON open_task.thread_id = tl.id AND open_task.status = 'open'
         LEFT JOIN LATERAL (
             SELECT sc.last_message_at, sc.last_message_direction,
                    sc.last_message_preview, sc.has_unread, sc.id as sms_conversation_id
             FROM sms_conversations sc
             WHERE sc.customer_digits IN (
                 regexp_replace(COALESCE(tl.phone_e164, co.phone_e164), '[^0-9]', '', 'g'),
                 CASE WHEN co.secondary_phone IS NOT NULL
                      THEN regexp_replace(co.secondary_phone, '[^0-9]', '', 'g')
                      ELSE NULL END
             )
             ORDER BY sc.last_message_at DESC NULLS LAST
             LIMIT 1
         ) sms ON true
         WHERE (latest_call.id IS NOT NULL OR sms.sms_conversation_id IS NOT NULL
                OR tl.is_action_required = true OR tl.has_unread = true)
           ${companyFilter}
           ${searchFilter}
         ORDER BY
           CASE WHEN tl.is_action_required = true
                 AND (tl.snoozed_until IS NULL OR tl.snoozed_until <= now())
                THEN 0
                WHEN tl.has_unread = true OR sms.has_unread = true
                THEN 1
                ELSE 2
           END ASC,
           GREATEST(latest_call.started_at, sms.last_message_at) DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        params
    );
    return result.rows;
}

async function getTimelinesWithCallsCount(companyId = null) {
    const companyFilter = companyId ? `AND calls.company_id = $1` : '';
    const params = companyId ? [companyId] : [];
    const result = await db.query(
        `SELECT COUNT(DISTINCT timeline_id) FROM calls
         WHERE timeline_id IS NOT NULL
           AND parent_call_sid IS NULL
           ${companyFilter}`,
        params
    );
    return parseInt(result.rows[0].count, 10);
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
    const result = await db.query(
        `UPDATE timelines SET
            snoozed_until = NULL,
            updated_at = now()
         WHERE is_action_required = true
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

async function createTask({ companyId, threadId, subjectType, subjectId, title, description, priority, dueAt, ownerUserId, createdBy }) {
    const result = await db.query(
        `INSERT INTO tasks (company_id, thread_id, subject_type, subject_id, title, description, priority, due_at, owner_user_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (thread_id) WHERE status = 'open'
         DO UPDATE SET
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            priority = EXCLUDED.priority,
            due_at = EXCLUDED.due_at,
            owner_user_id = COALESCE(EXCLUDED.owner_user_id, tasks.owner_user_id)
         RETURNING *`,
        [companyId, threadId, subjectType || 'contact', subjectId || null, title, description || null, priority || 'p2', dueAt || null, ownerUserId || null, createdBy || 'user']
    );
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
    getCallsByTimeline,
    getTimelinesWithCallsCount,
    setActionRequired,
    markThreadHandled,
    snoozeThread,
    unsnoozeExpiredThreads,
    assignThread,
    createTask,
    getOpenTaskByThread,
};
