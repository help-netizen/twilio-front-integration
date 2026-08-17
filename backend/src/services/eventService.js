/**
 * eventService.js — Legacy domain-event logging and entity History read-model.
 *
 * logEvent() remains for pre-cutover callers. getEntityHistory() merges canonical
 * audit_log actions, parent financial actions, legacy domain events, and notes.
 */

const db = require('../db/connection');
let activityLogCutoverPromise = null;

// ─── Log Event (fire-and-forget) ─────────────────────────────────────────────

/**
 * @param {string} companyId - UUID
 * @param {string} aggregateType - 'job' | 'lead' | 'contact'
 * @param {string|number} aggregateId - entity ID
 * @param {string} eventType - e.g. 'status_changed', 'created', 'note_added'
 * @param {object} eventData - { description, from, to, actor_name, ... }
 * @param {string} actorType - 'user' | 'system' | 'webhook'
 * @param {string|null} actorId - user sub or null
 */
function logEvent(companyId, aggregateType, aggregateId, eventType, eventData = {}, actorType = 'system', actorId = null) {
    if (!companyId) return;
    db.query(
        `INSERT INTO domain_events (company_id, aggregate_type, aggregate_id, event_type, event_data, actor_type, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [companyId, aggregateType, String(aggregateId), eventType, JSON.stringify(eventData), actorType, actorId]
    ).catch(err => {
        console.error('[EventService] logEvent failed:', err.message);
    });
}

// ─── Helper: build actor display name ────────────────────────────────────────

function actorName(req) {
    if (!req?.user) return 'Unknown';
    return req.user.name?.split(' ')[0] || req.user.email || 'Unknown';
}

// ─── Helper: build description for event type ────────────────────────────────

function describeEvent(eventType, data) {
    switch (eventType) {
        case 'status_changed': {
            const description = `Status: ${data.from || '?'} → ${data.to || '?'}`;
            return data.reason ? `${description}. Reason: ${data.reason}` : description;
        }
        case 'created': return data.description || 'Created';
        case 'canceled': return data.reason ? `Canceled: ${data.reason}` : 'Canceled';
        case 'rescheduled': return 'Rescheduled';
        case 'marked_lost': return 'Marked as Lost';
        case 'reactivated': return 'Reactivated';
        case 'converted': {
            const jobNumber = data.job_seq ?? data.job_id;
            return jobNumber ? `Converted to Job #${jobNumber}` : 'Converted to Job';
        }
        case 'team_assigned': return `Assigned: ${data.user_name || 'team member'}`;
        case 'team_unassigned': return `Unassigned: ${data.user_name || 'team member'}`;
        case 'tags_changed': return 'Tags updated';
        case 'synced': return 'Synced from Zenbooker';
        case 'updated': return data.fields ? `Updated: ${data.fields.join(', ')}` : 'Updated';
        default: return eventType.replace(/_/g, ' ');
    }
}

const ACTIVITY_DESCRIPTIONS = Object.freeze({
    'estimate.created': 'Estimate created.',
    'estimate.updated': 'Estimate updated.',
    'estimate.sent': 'Estimate sent.',
    'estimate.approved': 'Estimate approved.',
    'estimate.declined': 'Estimate declined.',
    'estimate.client_accepted': 'Client accepted the estimate.',
    'estimate.client_declined': 'Client declined the estimate.',
    'estimate.converted': 'Estimate converted to an invoice.',
    'estimate.linked_job': 'Estimate linked to a job.',
    'estimate.archived': 'Estimate archived.',
    'estimate.restored': 'Estimate restored.',
    'estimate.link_created': 'Estimate link created.',
    'estimate.viewed': 'Client viewed the estimate.',
    'estimate.send_failed': 'Estimate could not be sent.',
    'invoice.created': 'Invoice created.',
    'invoice.updated': 'Invoice updated.',
    'invoice.sent': 'Invoice sent.',
    'invoice.voided': 'Invoice voided.',
    'invoice.deleted': 'Draft invoice deleted.',
    'invoice.payment_recorded': 'Invoice payment recorded.',
    'invoice.payment_voided': 'Invoice payment voided.',
    'invoice.link_created': 'Invoice link created.',
    'invoice.link_sent': 'Invoice payment link sent.',
    'invoice.card_session_started': 'Invoice card-payment session started.',
    'invoice.payment_succeeded': 'Invoice payment succeeded.',
    'invoice.payment_failed': 'Invoice payment failed.',
    'invoice.refunded': 'Invoice payment refunded.',
    'invoice.items_synced': 'Invoice items synced from the estimate.',
    'invoice.viewed': 'Client viewed the invoice.',
    'invoice.send_failed': 'Invoice could not be sent.',
    'payment.recorded': 'Payment recorded.',
    'payment.portal_submitted': 'Client submitted a payment.',
    'payment.session_started': 'Payment session started.',
    'payment.session_canceled': 'Payment session canceled.',
    'payment.succeeded': 'Payment succeeded.',
    'payment.failed': 'Payment failed.',
    'payment.refunded': 'Payment refunded.',
    'payment.voided': 'Payment voided.',
    'payment.disputed': 'Payment disputed.',
    'payment.receipt_sent': 'Payment receipt sent.',
    'payment.receipt_send_failed': 'Payment receipt could not be sent.',
    'payment.check_deposited': 'Check marked as deposited.',
    'payment.check_deposit_reopened': 'Check marked as not deposited.',
    'refund.failed': 'Refund failed.',
    'job.created': 'Job created.',
    'job.updated': 'Job updated.',
    'job.status_changed': 'Job status changed.',
    'job.rescheduled': 'Job rescheduled.',
    'job.assigned': 'Job assigned.',
    'job.unassigned': 'Job unassigned.',
    'job.eta_notified': 'Arrival estimate sent.',
    'job.rating_link_created': 'Rating link created.',
    'job.rating_link_sent': 'Rating link sent.',
    'job.synced': 'Job synced from Zenbooker.',
    'lead.created': 'Lead created.',
    'lead.updated': 'Lead updated.',
    'lead.status_changed': 'Lead status changed.',
    'lead.lost': 'Lead marked as lost.',
    'lead.reactivated': 'Lead reactivated.',
    'lead.assigned': 'Lead assigned.',
    'lead.unassigned': 'Lead unassigned.',
    'lead.converted': 'Lead converted to a job.',
    'contact.created': 'Contact created.',
    'contact.updated': 'Contact updated.',
    'contact.merged': 'Contacts merged.',
    'contact.phone_moved': 'Phone moved to this contact.',
    'contact.email_moved': 'Email moved to this contact.',
    'contact.address_set': 'Default address updated.',
    'contact.portal_profile_updated': 'Client updated the contact profile.',
    'contact.synced': 'Contact synced from Zenbooker.',
    'job.sync_completed': 'Zenbooker job sync completed.',
    'contact.sync_completed': 'Zenbooker contact sync completed.',
    'payment.sync_completed': 'Zenbooker payment sync completed.',
});

function describeActivity(action, details = {}) {
    let description = ACTIVITY_DESCRIPTIONS[action];
    if (!description) {
        const [entity, ...actionParts] = String(action).split('.');
        if (actionParts.length === 0) return `${String(action).replace(/_/g, ' ')}.`;
        const entityLabel = entity.charAt(0).toUpperCase() + entity.slice(1);
        description = `${entityLabel} ${actionParts.join(' ').replace(/_/g, ' ')}.`;
    }

    const channel = details?.summary?.channel;
    if (channel && ['sent', 'created', 'notified'].some(word => action.endsWith(word))) {
        return `${description.slice(0, -1)} by ${String(channel).toUpperCase()}.`;
    }
    return description;
}

function isoTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function paginationValue(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
}

async function getActivityLogCutoverAt() {
    if (!activityLogCutoverPromise) {
        activityLogCutoverPromise = db.query(
            `SELECT value AS cutover_at
             FROM activity_log_config
             WHERE key = 'cutover_at'`
        ).then(({ rows }) => {
            const cutoverAt = rows[0]?.cutover_at;
            if (!cutoverAt || Number.isNaN(new Date(cutoverAt).getTime())) {
                throw new Error('[EventService] activity_log cutover_at is not configured');
            }
            return cutoverAt;
        }).catch(error => {
            activityLogCutoverPromise = null;
            throw error;
        });
    }
    return activityLogCutoverPromise;
}

function resetActivityLogCutoverCache() {
    activityLogCutoverPromise = null;
}

// ─── Get Entity History (canonical + legacy events + notes) ─────────────────

async function getEntityHistory(companyId, aggregateType, aggregateId, entityNotes = [], options = {}) {
    if (!companyId) throw new Error('[EventService] companyId is required');
    if (!['job', 'lead', 'contact'].includes(aggregateType)) {
        throw new Error('[EventService] aggregateType must be job, lead, or contact');
    }

    const limit = paginationValue(options.limit, 100, 1, 200);
    const offset = paginationValue(options.offset, 0, 0, 10000);
    const cutoverAt = await getActivityLogCutoverAt();
    // The global top K cannot contain a row ranked below K in either DB source.
    // Fetching offset + limit from each leg therefore preserves merge pagination
    // while avoiding an unbounded audit/domain-event read.
    const auditParams = [companyId, aggregateType, String(aggregateId), offset + limit];
    const legacyParams = [...auditParams, cutoverAt];
    const auditPromise = db.query(
        `WITH requested_parent AS (
            SELECT
                $2::text AS parent_type,
                $3::text AS history_id,
                CASE
                    WHEN $2 = 'lead' THEN COALESCE(
                        (
                            SELECT l.id::text
                            FROM leads l
                            WHERE l.company_id = $1
                              AND (l.id::text = $3 OR l.serial_id::text = $3)
                            LIMIT 1
                        ),
                        $3::text
                    )
                    ELSE $3::text
                END AS entity_id
        ),
        estimate_parents AS (
            SELECT
                e.company_id,
                'estimate'::text AS child_type,
                e.id::text AS child_id,
                CASE
                    WHEN e.job_id IS NOT NULL THEN 'job'
                    WHEN e.lead_id IS NOT NULL THEN 'lead'
                    WHEN e.contact_id IS NOT NULL THEN 'contact'
                    ELSE NULL
                END AS parent_type,
                COALESCE(e.job_id, e.lead_id, e.contact_id)::text AS parent_id
            FROM estimates e
            WHERE e.company_id = $1
        ),
        invoice_parents AS (
            SELECT
                i.company_id,
                'invoice'::text AS child_type,
                i.id::text AS child_id,
                CASE
                    WHEN COALESCE(i.job_id, ie.job_id) IS NOT NULL THEN 'job'
                    WHEN COALESCE(i.lead_id, ie.lead_id) IS NOT NULL THEN 'lead'
                    WHEN COALESCE(i.contact_id, ie.contact_id) IS NOT NULL THEN 'contact'
                    ELSE NULL
                END AS parent_type,
                CASE
                    WHEN COALESCE(i.job_id, ie.job_id) IS NOT NULL
                        THEN COALESCE(i.job_id, ie.job_id)::text
                    WHEN COALESCE(i.lead_id, ie.lead_id) IS NOT NULL
                        THEN COALESCE(i.lead_id, ie.lead_id)::text
                    ELSE COALESCE(i.contact_id, ie.contact_id)::text
                END AS parent_id
            FROM invoices i
            LEFT JOIN estimates ie
              ON ie.id = i.estimate_id
             AND ie.company_id = i.company_id
            WHERE i.company_id = $1
        ),
        payment_parents AS (
            SELECT
                p.company_id,
                'payment'::text AS child_type,
                p.id::text AS child_id,
                CASE
                    WHEN COALESCE(p.job_id, pi.job_id, pie.job_id, pe.job_id) IS NOT NULL THEN 'job'
                    WHEN COALESCE(pi.lead_id, pie.lead_id, pe.lead_id) IS NOT NULL THEN 'lead'
                    WHEN COALESCE(p.contact_id, pi.contact_id, pie.contact_id, pe.contact_id) IS NOT NULL THEN 'contact'
                    ELSE NULL
                END AS parent_type,
                CASE
                    WHEN COALESCE(p.job_id, pi.job_id, pie.job_id, pe.job_id) IS NOT NULL
                        THEN COALESCE(p.job_id, pi.job_id, pie.job_id, pe.job_id)::text
                    WHEN COALESCE(pi.lead_id, pie.lead_id, pe.lead_id) IS NOT NULL
                        THEN COALESCE(pi.lead_id, pie.lead_id, pe.lead_id)::text
                    ELSE COALESCE(p.contact_id, pi.contact_id, pie.contact_id, pe.contact_id)::text
                END AS parent_id
            FROM payment_transactions p
            LEFT JOIN invoices pi
              ON pi.id = p.invoice_id
             AND pi.company_id = p.company_id
            LEFT JOIN estimates pie
              ON pie.id = pi.estimate_id
             AND pie.company_id = p.company_id
            LEFT JOIN estimates pe
              ON pe.id = p.estimate_id
             AND pe.company_id = p.company_id
            WHERE p.company_id = $1
        ),
        current_children AS (
            SELECT * FROM estimate_parents
            UNION ALL
            SELECT * FROM invoice_parents
            UNION ALL
            SELECT * FROM payment_parents
        ),
        matching_audit_ids AS (
            SELECT al.id
            FROM audit_log al
            CROSS JOIN requested_parent rp
            WHERE al.company_id = $1
              AND al.target_type = rp.parent_type
              AND al.target_id IN (rp.history_id, rp.entity_id)

            UNION

            SELECT al.id
            FROM audit_log al
            CROSS JOIN requested_parent rp
            WHERE al.company_id = $1
              AND al.target_type IN ('estimate', 'invoice', 'payment')
              AND al.details->>'parent_type' = rp.parent_type
              AND al.details->>'parent_id' IN (rp.history_id, rp.entity_id)

            UNION

            SELECT al.id
            FROM audit_log al
            JOIN current_children child
              ON child.company_id = al.company_id
             AND child.child_type = al.target_type
             AND child.child_id = al.target_id
            CROSS JOIN requested_parent rp
            WHERE al.company_id = $1
              AND child.parent_type = rp.parent_type
              AND child.parent_id = rp.entity_id
        )
        SELECT
            al.id,
            al.action,
            al.details,
            al.actor_id,
            al.actor_email,
            al.target_type,
            al.target_id,
            al.created_at,
            actor.full_name AS actor_name,
            actor.email AS actor_user_email
        FROM audit_log al
        JOIN matching_audit_ids matched ON matched.id = al.id
        LEFT JOIN company_memberships actor_membership
          ON actor_membership.user_id = al.actor_id
         AND actor_membership.company_id = al.company_id
         AND actor_membership.status = 'active'
        LEFT JOIN crm_users actor ON actor.id = actor_membership.user_id
        WHERE al.company_id = $1
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT $4`,
        auditParams
    );
    const legacyPromise = db.query(
        `SELECT id, event_type, event_data, actor_type, actor_id, created_at
         FROM domain_events
         WHERE company_id = $1
           AND aggregate_type = $2
           AND aggregate_id = $3
           AND event_type NOT IN ('note_added', 'note_edited', 'note_deleted')
           AND created_at < $5
         ORDER BY created_at DESC, id DESC
         LIMIT $4`,
        legacyParams
    );
    const [{ rows: auditRows }, { rows: legacyEvents }] = await Promise.all([
        auditPromise,
        legacyPromise,
    ]);

    const auditItems = [...new Map(auditRows.map(row => [String(row.id), row])).values()]
        .map(row => {
            const details = row.details || {};
            const actorType = details.actor_type || (row.actor_id ? 'user' : 'system');
            const actorLabel = actorType === 'user' ? null : (details.actor_label || 'Albusto');
            const actorUserName = actorType === 'user'
                ? (row.actor_name || row.actor_user_email || row.actor_email || 'Unknown')
                : null;
            const actor = actorUserName || actorLabel;
            return {
                id: `audit_${row.id}`,
                type: 'event',
                event_type: row.action,
                action: row.action,
                description: describeActivity(row.action, details),
                actor,
                actor_type: actorType,
                actor_label: actorLabel,
                actor_name: actorUserName,
                target_type: row.target_type,
                target_id: row.target_id,
                created_at: isoTimestamp(row.created_at),
                data: details,
            };
        });

    const legacyItems = legacyEvents
        .filter(event => !['note_added', 'note_edited', 'note_deleted'].includes(event.event_type))
        .map(event => ({
            id: `evt_${event.id}`,
            type: 'event',
            event_type: event.event_type,
            action: event.event_type,
            description: describeEvent(event.event_type, event.event_data || {}),
            actor: event.event_data?.actor_name
                || (event.actor_type === 'system' || event.actor_type === 'webhook' ? 'Albusto' : 'Unknown'),
            actor_type: event.actor_type,
            actor_label: event.actor_type === 'user'
                ? null
                : (event.event_data?.actor_name || 'Albusto'),
            actor_name: event.actor_type === 'user'
                ? (event.event_data?.actor_name || 'Unknown')
                : null,
            target_type: aggregateType,
            target_id: String(aggregateId),
            created_at: isoTimestamp(event.created_at),
            data: event.event_data || {},
        }));

    const noteItems = (entityNotes || []).filter(note => !note?.deleted_at).map((note, i) => ({
        id: `note_${i}`,
        type: 'note',
        event_type: 'note',
        text: note.text || '',
        author: note.author || (note.migrated ? 'Albusto' : null),
        attachments: note.attachments || [],
        actor: note.author || (note.migrated ? 'Albusto' : ''),
        created_at: note.created || null,
        data: {},
    }));

    const merged = [...auditItems, ...legacyItems, ...noteItems].sort((a, b) => {
        const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (aTime !== bTime) return bTime - aTime;
        return String(b.id).localeCompare(String(a.id));
    });
    return merged.slice(offset, offset + limit);
}

module.exports = {
    logEvent,
    actorName,
    describeActivity,
    getEntityHistory,
    resetActivityLogCutoverCache,
};
