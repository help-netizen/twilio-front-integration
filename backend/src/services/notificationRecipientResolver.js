'use strict';

/**
 * NOTIF-REWORK-001 M1.T3 recipient isolation.
 *
 * This service resolves eligible users, every active push destination owned by
 * each user, and one logical delivery claim per destination channel. It does
 * not send anything; producer wiring and transport delivery belong to M1.T4/T5.
 */

const db = require('../db/connection');
const authorizationService = require('./authorizationService');
const tasksQueries = require('../db/tasksQueries');
const { resolveTaskContentScope } = require('../middleware/taskContentScope');
const {
    providerHasActiveJobForContact,
    listProvidersWithActiveJobForContact,
} = require('../db/providerContactAccessQueries');
const { getNotificationCatalogEntry } = require('./notificationEventCatalog');

const IMPORTANT_JOB_STATUSES = new Set([
    'On the way',
    'Waiting for parts',
    'Part arrived',
    'Visit completed',
    'Job is Done',
    'Canceled',
]);
const PRE_CHANGE_EVENTS = new Set(['job.unassigned', 'lead.unassigned', 'task.reassigned']);
const MAX_PREVIOUS_RECIPIENTS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class NotificationRecipientResolutionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'NotificationRecipientResolutionError';
        this.code = code;
    }
}

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function payloadFor(event) {
    const payload = event?.payload ?? event?.event_data ?? {};
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function normalizeRecordType(type) {
    const normalized = String(type || '').trim().toLowerCase();
    return ({
        agent_task: 'task',
        payment_transaction: 'payment',
        technician_rating: 'review',
        sms: 'sms_conversation',
        email: 'email_message',
        yelp: 'yelp_conversation',
    })[normalized] || normalized;
}

function normalizeRecordRef(ref) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
    const type = normalizeRecordType(ref.type || ref.record_type);
    const id = ref.id ?? ref.record_id;
    if (!type || id === undefined || id === null || String(id).trim() === '') return null;
    return { type, id: String(id) };
}

function addReference(target, type, id) {
    if (id === undefined || id === null || String(id).trim() === '') return;
    const ref = normalizeRecordRef({ type, id });
    if (ref) target.set(`${ref.type}:${ref.id}`, ref);
}

function collectEventReferences(event) {
    const payload = payloadFor(event);
    const refs = new Map();
    addReference(refs, event.aggregate_type, event.aggregate_id);

    const declared = [];
    if (payload.record_ref !== undefined && payload.record_ref !== null) declared.push(payload.record_ref);
    if (payload.record_refs !== undefined && payload.record_refs !== null) {
        if (!Array.isArray(payload.record_refs)) return null;
        declared.push(...payload.record_refs);
    }
    for (const ref of declared) {
        const normalized = normalizeRecordRef(ref);
        if (!normalized) return null;
        refs.set(`${normalized.type}:${normalized.id}`, normalized);
    }

    for (const [key, type] of [
        ['job_id', 'job'],
        ['contact_id', 'contact'],
        ['lead_id', 'lead'],
        ['task_id', 'task'],
        ['estimate_id', 'estimate'],
        ['invoice_id', 'invoice'],
        ['payment_id', 'payment'],
        ['review_id', 'review'],
    ]) {
        addReference(refs, type, payload[key]);
    }
    return [...refs.values()];
}

async function loadRecord(companyId, ref, query) {
    switch (ref.type) {
    case 'company': {
        const { rows } = await query(
            `SELECT id FROM companies WHERE id = $1 AND id::text = $2 AND status = 'active'`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'job': {
        const { rows } = await query(
            `SELECT id, contact_id, assigned_provider_user_ids
             FROM jobs WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'contact': {
        const { rows } = await query(
            `SELECT id FROM contacts WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'lead': {
        const { rows } = await query(
            `SELECT id, uuid, contact_id
             FROM leads
             WHERE company_id = $1 AND (id::text = $2 OR uuid = $2)
             LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'task': {
        const { rows } = await query(
            `SELECT id, owner_user_id, author_user_id, job_id, lead_id,
                    estimate_id, invoice_id, contact_id, thread_id
             FROM tasks WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'estimate': {
        const { rows } = await query(
            `SELECT id, job_id, contact_id, lead_id, created_by
             FROM estimates WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'invoice': {
        const { rows } = await query(
            `SELECT id, job_id, contact_id, lead_id, estimate_id, created_by
             FROM invoices WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'payment': {
        const { rows } = await query(
            `SELECT id, job_id, contact_id, estimate_id, invoice_id, recorded_by
             FROM payment_transactions WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'review': {
        const { rows } = await query(
            `SELECT id, job_id
             FROM technician_ratings WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'timeline': {
        const { rows } = await query(
            `SELECT id, contact_id
             FROM timelines WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'sms_conversation': {
        const { rows } = await query(
            `SELECT sc.id,
                    ARRAY(
                        SELECT c.id
                        FROM contacts c
                        WHERE c.company_id = sc.company_id
                          AND regexp_replace(c.phone_e164, '\\D', '', 'g') =
                              regexp_replace(sc.customer_e164, '\\D', '', 'g')
                    ) AS contact_ids
             FROM sms_conversations sc
             WHERE sc.company_id = $1 AND sc.id::text = $2
             LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'sms_message': {
        const { rows } = await query(
            `SELECT sm.id,
                    ARRAY(
                        SELECT c.id
                        FROM sms_conversations sc
                        JOIN contacts c
                          ON c.company_id = sc.company_id
                         AND regexp_replace(c.phone_e164, '\\D', '', 'g') =
                             regexp_replace(sc.customer_e164, '\\D', '', 'g')
                        WHERE sc.id = sm.conversation_id
                          AND sc.company_id = sm.company_id
                    ) AS contact_ids
             FROM sms_messages sm
             WHERE sm.company_id = $1 AND sm.id::text = $2
             LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'call': {
        const { rows } = await query(
            `SELECT id, contact_id
             FROM calls
             WHERE company_id = $1 AND (id::text = $2 OR call_sid = $2)
             LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'email_message': {
        const { rows } = await query(
            `SELECT id, contact_id, timeline_id
             FROM email_messages WHERE company_id = $1 AND id::text = $2 LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'email_thread': {
        const { rows } = await query(
            `SELECT et.id,
                    ARRAY(
                        SELECT DISTINCT em.contact_id
                        FROM email_messages em
                        WHERE em.company_id = et.company_id
                          AND em.thread_id = et.id
                          AND em.contact_id IS NOT NULL
                    ) AS contact_ids
             FROM email_threads et
             WHERE et.company_id = $1 AND et.id::text = $2
             LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    case 'yelp_conversation': {
        const { rows } = await query(
            `SELECT id, lead_id
             FROM yelp_conversations
             WHERE company_id = $1 AND (id::text = $2 OR conversation_id = $2)
             LIMIT 1`,
            [companyId, ref.id]
        );
        return rows[0] || null;
    }
    default:
        return null;
    }
}

function rawParentRefs(type, row) {
    const refs = [];
    const add = (parentType, id) => {
        if (id !== undefined && id !== null) refs.push({ type: parentType, id: String(id) });
    };
    if (type === 'job') add('contact', row.contact_id);
    if (type === 'lead') add('contact', row.contact_id);
    if (type === 'task') {
        for (const parentType of ['job', 'lead', 'estimate', 'invoice', 'contact', 'timeline']) {
            add(parentType, row[`${parentType === 'timeline' ? 'thread' : parentType}_id`]);
        }
    }
    if (type === 'estimate') {
        add('job', row.job_id); add('contact', row.contact_id); add('lead', row.lead_id);
    }
    if (type === 'invoice') {
        add('job', row.job_id); add('contact', row.contact_id); add('lead', row.lead_id);
        add('estimate', row.estimate_id);
    }
    if (type === 'payment') {
        add('job', row.job_id); add('contact', row.contact_id);
        add('estimate', row.estimate_id); add('invoice', row.invoice_id);
    }
    if (type === 'review') add('job', row.job_id);
    if (['timeline', 'call', 'email_message'].includes(type)) add('contact', row.contact_id);
    if (type === 'yelp_conversation') add('lead', row.lead_id);
    for (const contactId of row.contact_ids || []) add('contact', contactId);
    return refs;
}

async function validateEventRecords(companyId, event, query) {
    if (!event.id || !/^\d+$/.test(String(event.id))) return null;
    if (!event.aggregate_type || event.aggregate_id === undefined || event.aggregate_id === null) return null;

    const { rows: eventRows } = await query(
        `SELECT event_data, actor_type, actor_id, created_at
         FROM domain_events
         WHERE company_id = $1
           AND id = $2
           AND event_type = $3
           AND aggregate_type = $4
           AND aggregate_id = $5
         LIMIT 1`,
        [companyId, event.id, event.event_type, event.aggregate_type, String(event.aggregate_id)]
    );
    if (eventRows.length === 0) return null;

    // The persisted event is authoritative. A caller cannot reuse a valid event
    // id/aggregate while substituting different record refs or pre-change users.
    const verifiedEvent = {
        ...event,
        payload: eventRows[0].event_data || {},
        event_data: eventRows[0].event_data || {},
        actor_type: eventRows[0].actor_type,
        actor_id: eventRows[0].actor_id,
        created_at: eventRows[0].created_at,
    };

    const references = collectEventReferences(verifiedEvent);
    if (!references || references.length === 0) return null;
    const records = new Map();
    const queue = [...references];
    while (queue.length > 0) {
        const ref = queue.shift();
        const key = `${ref.type}:${ref.id}`;
        if (records.has(key)) continue;
        const row = await loadRecord(companyId, ref, query);
        if (!row) return null;
        records.set(key, { ref, row });
        for (const parentRef of rawParentRefs(ref.type, row)) {
            const parentKey = `${parentRef.type}:${parentRef.id}`;
            if (!records.has(parentKey)) queue.push(parentRef);
        }
    }
    return { records, references, event: verifiedEvent };
}

function recordsOfType(context, type) {
    return [...context.records.values()].filter(record => record.ref.type === type);
}

function idsOfType(context, type) {
    return recordsOfType(context, type).map(record => String(record.row.id));
}

function sourcePredicateMatches(entry, event) {
    const payload = payloadFor(event);
    if (!entry.source_predicate) return true;
    if (entry.source_predicate === 'important_target_status') {
        return IMPORTANT_JOB_STATUSES.has(payload.to || payload.status || payload.target_status);
    }
    if (entry.source_predicate === 'exclude_review_and_converted') {
        return !['Review', 'Converted'].includes(payload.to || payload.status || payload.target_status);
    }
    return false;
}

function snapshotRecipientIds(event) {
    const payload = payloadFor(event);
    const requested = payload.previous_recipient_user_ids;
    if (requested === undefined) return new Set();
    if (!PRE_CHANGE_EVENTS.has(event.event_type) || !Array.isArray(requested)
        || requested.length > MAX_PREVIOUS_RECIPIENTS) return new Set();

    let actual = [];
    if (event.event_type === 'job.unassigned') {
        actual = payload.previous_assigned_provider_user_ids
            || payload.before?.assigned_provider_user_ids
            || [];
    } else if (event.event_type === 'lead.unassigned') {
        actual = payload.previous_assignee_user_ids
            || payload.before?.assignee_user_ids
            || [];
    } else if (event.event_type === 'task.reassigned') {
        actual = payload.previous_owner_user_ids
            || (payload.previous_owner_user_id ? [payload.previous_owner_user_id] : null)
            || (payload.before?.owner_user_id ? [payload.before.owner_user_id] : null)
            || [];
    }
    if (!Array.isArray(actual)) return new Set();
    const actualSet = new Set(actual.filter(Boolean).map(String));
    return new Set(requested.filter(Boolean).map(String).filter(userId => actualSet.has(userId)));
}

function isProvider(authz) {
    return authz.role_key === 'provider';
}

async function providerCanSeeAnyJob(companyId, userId, context, client) {
    const jobIds = idsOfType(context, 'job');
    for (const jobId of jobIds) {
        if (await tasksQueries.jobParentVisible(
            companyId,
            jobId,
            { assignedOnly: true, userId },
            client
        )) return true;
    }
    return false;
}

async function providerCanSeeAnyContact(companyId, userId, context, client) {
    const contactIds = idsOfType(context, 'contact');
    for (const contactId of contactIds) {
        if (await providerHasActiveJobForContact(companyId, userId, contactId, { client })) return true;
    }
    return false;
}

async function recordScopeAllows(companyId, entry, event, context, candidate, authz, client) {
    const provider = isProvider(authz);
    const previousRecipient = snapshotRecipientIds(event).has(String(candidate.user_id));
    const scope = entry.record_scope;

    if (scope === 'admin_only') return authz.permissions.includes('tenant.company.manage');
    if (scope.startsWith('office_only_lead')) return !provider && idsOfType(context, 'lead').length > 0;
    if (scope === 'office_only_job') return !provider && idsOfType(context, 'job').length > 0;

    if (scope.startsWith('job_assignment') || scope === 'rated_job_assignment') {
        if (!provider) return idsOfType(context, 'job').length > 0;
        if (scope === 'job_assignment_with_previous_recipient' && previousRecipient) return true;
        return providerCanSeeAnyJob(companyId, candidate.user_id, context, client);
    }

    if (scope === 'active_contact' || scope === 'active_contact_or_office_orphan'
        || scope === 'actor_and_active_contact') {
        if (!provider) return scope === 'active_contact_or_office_orphan'
            || idsOfType(context, 'contact').length > 0;
        if (scope === 'actor_and_active_contact' && String(event.actor_id || '') !== String(candidate.user_id)) {
            return false;
        }
        return providerCanSeeAnyContact(companyId, candidate.user_id, context, client);
    }

    if (scope === 'lead_office_or_job_assignment') {
        if (!provider) return idsOfType(context, 'lead').length > 0 || idsOfType(context, 'job').length > 0;
        return providerCanSeeAnyJob(companyId, candidate.user_id, context, client);
    }

    if (scope.startsWith('task_owner_author_or_')) {
        const taskRecords = recordsOfType(context, 'task');
        if (taskRecords.length === 0) return false;
        if (scope === 'task_owner_author_or_previous_recipient' && previousRecipient) return true;
        const taskScope = resolveTaskContentScope(authz.permissions, candidate.user_id);
        if (taskScope.canViewAll) return true;
        return taskRecords.some(({ row }) => (
            String(row.owner_user_id || '') === String(candidate.user_id)
            || String(row.author_user_id || '') === String(candidate.user_id)
        ));
    }

    if (scope === 'financial_parent' || scope === 'actor_and_financial_parent') {
        if (entry.required_permission !== 'notifications.financial.receive') return false;
        const hasFinancialRecord = ['estimate', 'invoice', 'payment']
            .some(type => recordsOfType(context, type).length > 0);
        if (!hasFinancialRecord) return false;
        if (!provider) return true;
        if (await providerCanSeeAnyJob(companyId, candidate.user_id, context, client)) return true;
        if (idsOfType(context, 'lead').length > 0) return false;
        return providerCanSeeAnyContact(companyId, candidate.user_id, context, client);
    }

    return false;
}

async function boundedProviderCandidateIds(companyId, entry, event, context, client) {
    const ids = new Set();
    const add = userId => {
        if (UUID_PATTERN.test(String(userId || ''))) ids.add(String(userId));
    };

    for (const { row } of recordsOfType(context, 'job')) {
        for (const userId of row.assigned_provider_user_ids || []) add(userId);
    }
    for (const { row } of recordsOfType(context, 'task')) {
        add(row.owner_user_id);
        add(row.author_user_id);
    }
    for (const userId of snapshotRecipientIds(event)) add(userId);

    const contactScoped = entry.record_scope.includes('contact')
        || entry.record_scope.includes('financial');
    if (contactScoped) {
        for (const contactId of idsOfType(context, 'contact')) {
            for (const userId of await listProvidersWithActiveJobForContact(
                companyId,
                contactId,
                { client }
            )) add(userId);
        }
    }
    return [...ids];
}

async function activeCandidates(companyId, entry, event, context, query, client) {
    const providerIds = await boundedProviderCandidateIds(companyId, entry, event, context, client);
    const { rows } = await query(
        `SELECT DISTINCT m.user_id
         FROM company_memberships m
         JOIN companies c
           ON c.id = m.company_id
          AND c.status = 'active'
         JOIN crm_users u
           ON u.id = m.user_id
          AND u.status = 'active'
          AND u.onboarding_status = 'active'
          AND COALESCE(u.kind, 'user') = 'user'
         WHERE m.company_id = $1
           AND m.status = 'active'
           AND (
                COALESCE(
                    m.role_key,
                    CASE WHEN m.role = 'company_admin' THEN 'tenant_admin' ELSE 'dispatcher' END
                ) <> 'provider'
                OR m.user_id = ANY($2::uuid[])
           )
         ORDER BY m.user_id`,
        [companyId, providerIds]
    );
    return rows.map(row => ({ user_id: String(row.user_id) }));
}

async function categoryPreferenceAllows(companyId, userId, categoryKey, query) {
    if (categoryKey === 'admin_system') return true;
    const { rows } = await query(
        `SELECT enabled
         FROM user_notification_preferences
         WHERE company_id = $1
           AND user_id = $2
           AND category = $3
         LIMIT 1`,
        [companyId, userId, categoryKey]
    );
    return rows[0]?.enabled !== false;
}

async function activeDestinations(companyId, userId, query) {
    const { rows: browserPush } = await query(
        `SELECT id, endpoint, p256dh, auth
         FROM push_subscriptions
         WHERE company_id = $1
           AND user_id = $2
           AND is_active = true
         ORDER BY id`,
        [companyId, userId]
    );
    const { rows: nativePush } = await query(
        `SELECT id, apns_token
         FROM device_tokens
         WHERE company_id = $1
           AND crm_user_id = $2
         ORDER BY id`,
        [companyId, userId]
    );
    return { browser_push: browserPush, native_push: nativePush };
}

function deliveryRecordRef(entry, context) {
    const preferredTypes = entry.record_scope.startsWith('task_')
        ? ['task']
        : entry.record_scope.includes('financial')
            ? ['payment', 'invoice', 'estimate', 'job', 'contact', 'lead']
            : entry.record_scope.includes('job') || entry.record_scope === 'rated_job_assignment'
                ? ['job']
                : entry.record_scope.includes('contact')
                    ? ['contact']
                    : entry.record_scope.includes('lead')
                        ? ['lead', 'job']
                        : [];
    for (const type of preferredTypes) {
        const record = recordsOfType(context, type)[0];
        if (record) return { type, id: String(record.row.id) };
    }
    return null;
}

async function claimDelivery(companyId, event, entry, candidate, channel, context, query) {
    const recordRef = deliveryRecordRef(entry, context);
    const { rows } = await query(
        `INSERT INTO notification_deliveries
            (company_id, domain_event_id, user_id, event_type, channel,
             record_type, record_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         ON CONFLICT (company_id, domain_event_id, user_id, channel) DO NOTHING
         RETURNING id`,
        [
            companyId,
            event.id,
            candidate.user_id,
            entry.event_type,
            channel,
            recordRef?.type || null,
            recordRef?.id || null,
        ]
    );
    return rows[0]?.id || null;
}

/**
 * Resolve eligible recipients and atomically claim their logical deliveries.
 * No caller-controlled role/audience/scope data is accepted.
 */
async function resolveNotificationRecipients(companyId, event, { client = null } = {}) {
    if (!companyId || !event?.company_id) {
        throw new NotificationRecipientResolutionError(
            'NOTIFICATION_COMPANY_REQUIRED',
            'Notification company context is required.'
        );
    }
    if (String(companyId) !== String(event.company_id)) {
        throw new NotificationRecipientResolutionError(
            'NOTIFICATION_COMPANY_MISMATCH',
            'Notification event company does not match the requested company.'
        );
    }

    const entry = getNotificationCatalogEntry(event.event_type);
    if (!entry || !entry.producer_available) return [];
    const query = queryFor(client);
    const context = await validateEventRecords(companyId, event, query);
    if (!context) return [];
    const verifiedEvent = context.event;
    if (!sourcePredicateMatches(entry, verifiedEvent)) return [];

    const candidates = await activeCandidates(
        companyId,
        entry,
        verifiedEvent,
        context,
        query,
        client
    );
    const scoped = [];
    for (const candidate of candidates) {
        let authz;
        try {
            authz = await authorizationService.resolveCompanyUserAuthz(
                companyId,
                candidate.user_id,
                { client }
            );
        } catch (error) {
            if (error?.name === 'CompanyUserAuthzError') continue;
            throw error;
        }
        if (String(authz.company?.id || '') !== String(companyId)) continue;
        if (!await categoryPreferenceAllows(
            companyId,
            candidate.user_id,
            entry.category_key,
            query
        )) continue;
        if (!authz.permissions.includes(entry.required_permission)) continue;
        if (!await recordScopeAllows(companyId, entry, verifiedEvent, context, candidate, authz, client)) continue;
        const destinations = await activeDestinations(companyId, candidate.user_id, query);
        if (destinations.browser_push.length === 0 && destinations.native_push.length === 0) continue;
        scoped.push({ candidate, authz, destinations });
    }

    if (scoped.length === 0) return [];
    const claimed = [];
    for (const { candidate, authz, destinations } of scoped) {
        try {
            const claimedDestinations = { browser_push: [], native_push: [] };
            const deliveryIds = {};
            for (const channel of ['browser_push', 'native_push']) {
                if (destinations[channel].length === 0) continue;
                const deliveryId = await claimDelivery(
                    companyId,
                    verifiedEvent,
                    entry,
                    candidate,
                    channel,
                    context,
                    query
                );
                if (!deliveryId) continue;
                deliveryIds[channel] = deliveryId;
                claimedDestinations[channel] = destinations[channel];
            }
            if (Object.keys(deliveryIds).length > 0) {
                claimed.push({
                    user_id: candidate.user_id,
                    role_key: authz.role_key,
                    destinations: claimedDestinations,
                    delivery_ids: deliveryIds,
                });
            }
        } catch (error) {
            // Membership can be revoked between live auth and the tenant-bound
            // delivery FK. That race is a deny, not a reason to widen/fallback.
            if (error?.code !== '23503') throw error;
        }
    }
    return claimed;
}

module.exports = {
    NotificationRecipientResolutionError,
    resolveNotificationRecipients,
};
