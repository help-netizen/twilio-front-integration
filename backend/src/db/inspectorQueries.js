'use strict';

/**
 * INSPECTOR-AGENT-001 dedicated data layer.
 *
 * All tenant-owned operations require companyId explicitly. Every joined
 * tenant table repeats company equality; natural-key communication lookup is
 * paired with company_id. The one cross-company operation is the scheduler's
 * installation aggregate, which returns company claims from equality-scoped
 * Marketplace/company/settings joins and never reads business entities.
 */

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit } = require('./crmUtils');
const jobFinanceQueries = require('./jobFinanceQueries');
const {
    DEFAULT_INSPECTOR_INSTRUCTION,
    DEFAULT_IGNORED_JOB_STATUSES,
    DEFAULT_IGNORED_LEAD_STATUSES,
} = require('../services/inspectorDefaults');

const APP_KEY = 'inspector';
const DEFAULT_TIMEZONE = 'America/New_York';
const CLOSED_ESTIMATE_STATUSES = Object.freeze([
    'declined', 'void', 'voided', 'expired', 'converted', 'archived',
]);

function assertEntityType(entityType) {
    if (entityType !== 'job' && entityType !== 'lead') {
        const error = new Error('Inspector entityType must be job or lead');
        error.code = 'INVALID_ENTITY_TYPE';
        throw error;
    }
}

function virtualSettings(companyId) {
    return {
        company_id: companyId,
        enabled: true,
        ignored_job_statuses: [...DEFAULT_IGNORED_JOB_STATUSES],
        ignored_lead_statuses: [...DEFAULT_IGNORED_LEAD_STATUSES],
        instruction: DEFAULT_INSPECTOR_INSTRUCTION,
        updated_by: null,
        updated_at: null,
    };
}

async function getSettings(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT company_id, enabled, ignored_job_statuses, ignored_lead_statuses,
                instruction, updated_by, updated_at
         FROM inspector_settings
         WHERE company_id = $1`,
        [companyId]
    );
    return rows[0] || virtualSettings(companyId);
}

/**
 * Execution-time authority gate for an already-claimed company run.
 * A due-company snapshot is not authorization: disconnect/suspension/disable may
 * happen after selection, so the runner must obtain settings through this join.
 */
async function getRuntimeConfiguration(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT $1::UUID AS company_id,
                COALESCE(settings.enabled, true) AS enabled,
                settings.ignored_job_statuses,
                settings.ignored_lead_statuses,
                settings.instruction,
                settings.updated_by,
                settings.updated_at
         FROM companies company
         JOIN marketplace_installations installation
           ON installation.company_id = company.id
          AND installation.company_id = $1
          AND installation.status = 'connected'
         JOIN marketplace_apps app
           ON app.id = installation.app_id
          AND app.app_key = $2
          AND app.status = 'published'
         LEFT JOIN inspector_settings settings
           ON settings.company_id = company.id
          AND settings.company_id = $1
         WHERE company.id = $1
           AND company.status = 'active'
           AND COALESCE(settings.enabled, true) = true
         ORDER BY installation.id DESC
         LIMIT 1`,
        [companyId, APP_KEY]
    );
    if (!rows[0]) return null;
    const defaults = virtualSettings(companyId);
    return {
        ...defaults,
        ...rows[0],
        ignored_job_statuses: rows[0].ignored_job_statuses || defaults.ignored_job_statuses,
        ignored_lead_statuses: rows[0].ignored_lead_statuses || defaults.ignored_lead_statuses,
        instruction: rows[0].instruction || defaults.instruction,
    };
}

async function saveSettings(companyId, settings, updatedBy, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `INSERT INTO inspector_settings
            (company_id, enabled, ignored_job_statuses, ignored_lead_statuses,
             instruction, updated_by, updated_at)
         VALUES ($1, $2, $3::TEXT[], $4::TEXT[], $5, $6, NOW())
         ON CONFLICT (company_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            ignored_job_statuses = EXCLUDED.ignored_job_statuses,
            ignored_lead_statuses = EXCLUDED.ignored_lead_statuses,
            instruction = EXCLUDED.instruction,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
         RETURNING company_id, enabled, ignored_job_statuses, ignored_lead_statuses,
                   instruction, updated_by, updated_at`,
        [
            companyId,
            settings.enabled,
            settings.ignored_job_statuses,
            settings.ignored_lead_statuses,
            settings.instruction,
            updatedBy || null,
        ]
    );
    return rows[0];
}

async function getCompanyTimezone(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT COALESCE(NULLIF(timezone, ''), $2) AS timezone
         FROM companies
         WHERE id = $1`,
        [companyId, DEFAULT_TIMEZONE]
    );
    return rows[0]?.timezone || DEFAULT_TIMEZONE;
}

/** Scheduler authority aggregate: returns tenant ids only, never business data. */
async function listDueCompanies(now, limit = 20, client = null) {
    const query = queryFor(client, db);
    const safeLimit = clampLimit(limit, 20, 100);
    const { rows } = await query(
        `SELECT mi.company_id,
                COALESCE(NULLIF(c.timezone, ''), $2) AS timezone,
                ($1::TIMESTAMPTZ AT TIME ZONE COALESCE(NULLIF(c.timezone, ''), $2))::DATE
                    AS company_local_date
         FROM marketplace_installations mi
         JOIN marketplace_apps app
           ON app.id = mi.app_id
          AND app.app_key = $3
          AND app.status = 'published'
         JOIN companies c
           ON c.id = mi.company_id
          AND c.status = 'active'
         LEFT JOIN inspector_settings settings
           ON settings.company_id = mi.company_id
         WHERE mi.status = 'connected'
           AND COALESCE(settings.enabled, true) = true
           AND ($1::TIMESTAMPTZ AT TIME ZONE COALESCE(NULLIF(c.timezone, ''), $2))::TIME >= TIME '12:00'
           AND NOT EXISTS (
               SELECT 1
               FROM inspector_daily_runs run
               WHERE run.company_id = mi.company_id
                 AND run.company_local_date =
                     ($1::TIMESTAMPTZ AT TIME ZONE COALESCE(NULLIF(c.timezone, ''), $2))::DATE
                 AND (run.status <> 'running' OR run.lease_expires_at >= $1::TIMESTAMPTZ)
           )
         ORDER BY mi.company_id
         LIMIT $4`,
        [now, DEFAULT_TIMEZONE, APP_KEY, safeLimit]
    );
    return rows;
}

async function claimDailyRun(companyId, companyLocalDate, timezone, now, leaseExpiresAt, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `INSERT INTO inspector_daily_runs
            (company_id, company_local_date, timezone, status, lease_expires_at)
         VALUES ($1, $2::DATE, $3, 'running', $5::TIMESTAMPTZ)
         ON CONFLICT (company_id, company_local_date) DO UPDATE SET
            timezone = EXCLUDED.timezone,
            status = 'running',
            attempt_count = inspector_daily_runs.attempt_count + 1,
            lease_expires_at = EXCLUDED.lease_expires_at,
            finished_at = NULL,
            updated_at = $4::TIMESTAMPTZ
         WHERE inspector_daily_runs.status = 'running'
           AND inspector_daily_runs.lease_expires_at < $4::TIMESTAMPTZ
         RETURNING *`,
        [companyId, companyLocalDate, timezone, now, leaseExpiresAt]
    );
    return rows[0] || null;
}

async function refreshRunLease(companyId, runId, leaseExpiresAt, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rowCount } = await query(
        `UPDATE inspector_daily_runs
         SET lease_expires_at = $3::TIMESTAMPTZ, updated_at = NOW()
         WHERE company_id = $1 AND id = $2 AND status = 'running'`,
        [companyId, runId, leaseExpiresAt]
    );
    return rowCount > 0;
}

async function finishRun(companyId, runId, outcome, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `UPDATE inspector_daily_runs
         SET status = $3,
             candidate_count = $4,
             reviewed_count = $5,
             task_count = $6,
             no_action_count = $7,
             deduped_count = $8,
             warning_count = $9,
             warning_code = $10,
             warning_summary = $11,
             finished_at = NOW(),
             updated_at = NOW()
         WHERE company_id = $1 AND id = $2
         RETURNING *`,
        [
            companyId,
            runId,
            outcome.status,
            outcome.candidate_count || 0,
            outcome.reviewed_count || 0,
            outcome.task_count || 0,
            outcome.no_action_count || 0,
            outcome.deduped_count || 0,
            outcome.warning_count || 0,
            outcome.warning_code || null,
            outcome.warning_summary ? String(outcome.warning_summary).slice(0, 500) : null,
        ]
    );
    return rows[0] || null;
}

async function listCandidateJobs(
    companyId,
    boundary,
    ignoredStatuses,
    companyLocalDate,
    { afterId = 0, limit = 50 } = {},
    client = null
) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT j.id, j.company_id, j.contact_id, j.job_number, j.customer_name,
                j.blanc_status AS status, j.start_date, j.updated_at
         FROM jobs j
         WHERE j.company_id = $1
           AND j.id > $5
           AND j.start_date IS NOT NULL
           AND j.start_date < $2::TIMESTAMPTZ
           AND NOT (j.blanc_status = ANY($3::TEXT[]))
           AND NOT EXISTS (
               SELECT 1 FROM tasks task
               WHERE task.company_id = j.company_id
                 AND task.job_id = j.id
                 AND task.status = 'open'
                 AND task.agent_type = 'inspector'
           )
           AND NOT EXISTS (
               SELECT 1 FROM inspector_reviews review
               WHERE review.company_id = j.company_id
                 AND review.company_local_date = $4::DATE
                 AND review.entity_type = 'job'
                 AND review.entity_id = j.id
           )
         ORDER BY j.id
         LIMIT $6`,
        [companyId, boundary, ignoredStatuses, companyLocalDate, Number(afterId) || 0, clampLimit(limit, 50, 100)]
    );
    return rows;
}

async function listCandidateLeads(
    companyId,
    boundary,
    ignoredStatuses,
    companyLocalDate,
    { afterId = 0, limit = 50 } = {},
    client = null
) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT l.id, l.uuid, l.serial_id, l.company_id, l.contact_id,
                NULLIF(TRIM(CONCAT_WS(' ', l.first_name, l.last_name)), '') AS customer_name,
                l.status, l.updated_at
         FROM leads l
         WHERE l.company_id = $1
           AND l.id > $5
           AND l.updated_at < $2::TIMESTAMPTZ
           AND NOT (l.status = ANY($3::TEXT[]))
           AND NOT EXISTS (
               SELECT 1 FROM tasks task
               WHERE task.company_id = l.company_id
                 AND task.lead_id = l.id
                 AND task.status = 'open'
                 AND task.agent_type = 'inspector'
           )
           AND NOT EXISTS (
               SELECT 1 FROM inspector_reviews review
               WHERE review.company_id = l.company_id
                 AND review.company_local_date = $4::DATE
                 AND review.entity_type = 'lead'
                 AND review.entity_id = l.id
           )
         ORDER BY l.id
         LIMIT $6`,
        [companyId, boundary, ignoredStatuses, companyLocalDate, Number(afterId) || 0, clampLimit(limit, 50, 100)]
    );
    return rows;
}

async function reloadEligibleEntity(companyId, entityType, entityId, boundary, ignoredStatuses, client = null) {
    requireCompanyId(companyId);
    assertEntityType(entityType);
    const query = queryFor(client, db);
    const statusColumn = entityType === 'job' ? 'blanc_status' : 'status';
    const dateColumn = entityType === 'job' ? 'start_date' : 'updated_at';
    const table = entityType === 'job' ? 'jobs' : 'leads';
    const { rows } = await query(
        `SELECT id, company_id, contact_id, ${statusColumn} AS status, ${dateColumn} AS eligibility_date
         FROM ${table}
         WHERE company_id = $1
           AND id = $2
           AND ${dateColumn} IS NOT NULL
           AND ${dateColumn} < $3::TIMESTAMPTZ
           AND NOT (${statusColumn} = ANY($4::TEXT[]))`,
        [companyId, entityId, boundary, ignoredStatuses]
    );
    return rows[0] || null;
}

async function getEntityRecord(companyId, entityType, entityId, client = null) {
    requireCompanyId(companyId);
    assertEntityType(entityType);
    const query = queryFor(client, db);
    if (entityType === 'job') {
        const { rows } = await query(
            `SELECT j.id, j.company_id, j.contact_id, j.lead_id, j.job_number,
                    j.service_name, j.customer_name, j.customer_phone, j.customer_email,
                    j.address, j.blanc_status AS status, j.zb_status, j.zb_rescheduled,
                    j.zb_canceled, j.start_date, j.end_date, j.notes,
                    j.created_at, j.updated_at,
                    c.full_name AS contact_name, c.phone_e164 AS contact_phone,
                    c.email AS contact_email
             FROM jobs j
             LEFT JOIN contacts c
               ON c.id = j.contact_id
              AND c.company_id = j.company_id
             WHERE j.company_id = $1 AND j.id = $2`,
            [companyId, entityId]
        );
        return rows[0] || null;
    }
    const { rows } = await query(
        `SELECT l.id, l.uuid, l.serial_id, l.company_id, l.contact_id,
                l.first_name, l.last_name, l.company AS customer_company,
                l.phone, l.second_phone, l.email, l.address, l.city, l.state,
                l.postal_code, l.status, l.sub_status, l.job_type, l.job_source,
                l.lead_date_time, l.lead_end_date_time, l.lead_notes, l.comments,
                l.structured_notes AS notes, l.created_at, l.updated_at,
                c.full_name AS contact_name, c.phone_e164 AS contact_phone,
                c.email AS contact_email
         FROM leads l
         LEFT JOIN contacts c
           ON c.id = l.contact_id
          AND c.company_id = l.company_id
         WHERE l.company_id = $1 AND l.id = $2`,
        [companyId, entityId]
    );
    return rows[0] || null;
}

async function getLastStatusChange(companyId, entityType, identifiers, client = null) {
    requireCompanyId(companyId);
    assertEntityType(entityType);
    const query = queryFor(client, db);
    const ids = [...new Set((identifiers || []).filter(value => value !== null && value !== undefined)
        .map(value => String(value)))];
    if (ids.length === 0) return null;
    const { rows } = await query(
        `SELECT MAX(event.created_at) AS last_status_change_at
         FROM domain_events event
         WHERE event.company_id = $1
           AND event.aggregate_type = $2
           AND event.aggregate_id = ANY($3::TEXT[])
           AND event.event_type IN ('status_changed', 'job.status_changed', 'lead.status_changed',
                                    'canceled', 'converted', 'marked_lost', 'reactivated')`,
        [companyId, entityType, ids]
    );
    return rows[0]?.last_status_change_at || null;
}

async function getRecentCommunications(companyId, record, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const contactId = record.contact_id || null;
    const phones = [...new Set([
        record.contact_phone,
        record.customer_phone,
        record.phone,
        record.second_phone,
    ].map(value => String(value || '').trim()).filter(Boolean))];

    const callsPromise = contactId
        ? query(
            `SELECT call.id, call.direction, call.status,
                    COALESCE(call.started_at, call.created_at) AS occurred_at,
                    call.duration_sec,
                    transcript.text AS transcript_text
             FROM calls call
             LEFT JOIN LATERAL (
                 SELECT item.text
                 FROM transcripts item
                 WHERE item.company_id = call.company_id
                   AND item.call_sid = call.call_sid
                 ORDER BY item.updated_at DESC
                 LIMIT 1
             ) transcript ON true
             WHERE call.company_id = $1
               AND call.contact_id = $2
               AND call.parent_call_sid IS NULL
             ORDER BY COALESCE(call.started_at, call.created_at) DESC
             LIMIT 5`,
            [companyId, contactId]
        )
        : Promise.resolve({ rows: [] });

    const smsPromise = phones.length > 0
        ? query(
            `SELECT message.id, message.direction, message.body,
                    COALESCE(message.date_sent_remote, message.date_created_remote,
                             message.created_at) AS occurred_at
             FROM sms_conversations conversation
             JOIN sms_messages message
               ON message.conversation_id = conversation.id
              AND message.company_id = conversation.company_id
             WHERE conversation.company_id = $1
               AND conversation.customer_e164 = ANY($2::TEXT[])
             ORDER BY COALESCE(message.date_sent_remote, message.date_created_remote,
                               message.created_at) DESC
             LIMIT 8`,
            [companyId, phones]
        )
        : Promise.resolve({ rows: [] });

    const emailPromise = contactId
        ? query(
            `SELECT message.id, message.direction, message.from_name, message.from_email,
                    message.subject, COALESCE(message.body_text, message.snippet) AS body_text,
                    COALESCE(message.gmail_internal_at, message.created_at) AS occurred_at
             FROM email_messages message
             WHERE message.company_id = $1
               AND message.contact_id = $2
             ORDER BY COALESCE(message.gmail_internal_at, message.created_at) DESC
             LIMIT 5`,
            [companyId, contactId]
        )
        : Promise.resolve({ rows: [] });

    const [calls, sms, emails] = await Promise.all([callsPromise, smsPromise, emailPromise]);
    return { calls: calls.rows, sms: sms.rows, emails: emails.rows };
}

async function getFinanceSummary(companyId, entityType, entityId, client = null) {
    requireCompanyId(companyId);
    assertEntityType(entityType);
    const query = queryFor(client, db);
    const parentColumn = entityType === 'job' ? 'job_id' : 'lead_id';
    const estimatePromise = query(
        `WITH scoped AS (
            SELECT estimate.id, estimate.estimate_number, estimate.status, estimate.total,
                   estimate.created_at, estimate.updated_at
            FROM estimates estimate
            WHERE estimate.company_id = $1
              AND estimate.${parentColumn} = $2
              AND estimate.archived_at IS NULL
         )
         SELECT COALESCE(SUM(status_count), 0)::INTEGER AS count,
                COALESCE(jsonb_object_agg(status, status_count), '{}'::JSONB) AS statuses,
                (
                    SELECT to_jsonb(latest)
                    FROM (
                        SELECT id, estimate_number, status, total, created_at, updated_at
                        FROM scoped
                        WHERE status <> ALL($3::TEXT[])
                        ORDER BY updated_at DESC, id DESC
                        LIMIT 1
                    ) latest
                ) AS latest_actionable
         FROM (
            SELECT status, COUNT(*)::INTEGER AS status_count
            FROM scoped
            GROUP BY status
         ) counts`,
        [companyId, entityId, CLOSED_ESTIMATE_STATUSES]
    );
    const invoicePromise = query(
        `SELECT COUNT(*) FILTER (WHERE invoice.status NOT IN ('void','voided','refunded'))::INTEGER AS count,
                COALESCE(SUM(invoice.total) FILTER (
                    WHERE invoice.status NOT IN ('void','voided','refunded')
                ), 0) AS total_invoiced,
                COALESCE(SUM(invoice.amount_paid) FILTER (
                    WHERE invoice.status NOT IN ('void','voided','refunded')
                ), 0) AS invoice_paid,
                COALESCE(SUM(invoice.balance_due) FILTER (
                    WHERE invoice.status NOT IN ('void','voided','refunded')
                ), 0) AS invoice_due
         FROM invoices invoice
         WHERE invoice.company_id = $1
           AND invoice.${parentColumn} = $2`,
        [companyId, entityId]
    );
    const paymentPromise = entityType === 'job'
        ? jobFinanceQueries.listJobPaymentRollups(companyId, [entityId], client)
        : Promise.resolve([]);
    const [estimates, invoices, payments] = await Promise.all([
        estimatePromise,
        invoicePromise,
        paymentPromise,
    ]);
    const invoice = invoices.rows[0] || {};
    const payment = payments[0] || null;
    return {
        estimates: estimates.rows[0] || { count: 0, statuses: {}, latest_actionable: null },
        invoices: {
            count: Number(invoice.count || 0),
            total_invoiced: invoice.total_invoiced,
        },
        amount_paid: payment ? payment.total_paid : invoice.invoice_paid,
        balance_due: payment ? payment.total_due : invoice.invoice_due,
    };
}

function activeNotes(record) {
    const structured = Array.isArray(record.notes) ? record.notes : [];
    const notes = structured
        .filter(note => note && !note.deleted_at)
        .map(note => ({
            id: note.id || null,
            text: String(note.text || ''),
            author: note.author || note.created_by || null,
            created_at: note.created || note.created_at || null,
        }));
    if (record.lead_notes) {
        notes.push({ id: null, text: String(record.lead_notes), author: 'lead description', created_at: null });
    }
    if (record.comments) {
        notes.push({ id: null, text: String(record.comments), author: 'lead comments', created_at: null });
    }
    return notes;
}

function latestNoteAt(notes) {
    let latest = null;
    for (const note of notes) {
        const time = Date.parse(note.created_at);
        if (Number.isFinite(time) && (latest === null || time > latest)) latest = time;
    }
    return latest === null ? null : new Date(latest).toISOString();
}

async function getEntityContext(companyId, entityType, entityId, client = null) {
    requireCompanyId(companyId);
    assertEntityType(entityType);
    const record = await getEntityRecord(companyId, entityType, entityId, client);
    if (!record) return null;
    const identifiers = entityType === 'job'
        ? [record.id]
        : [record.id, record.serial_id, record.uuid];
    const notes = activeNotes(record);
    const [lastStatusChangeAt, communications, finance] = await Promise.all([
        getLastStatusChange(companyId, entityType, identifiers, client),
        getRecentCommunications(companyId, record, client),
        getFinanceSummary(companyId, entityType, entityId, client),
    ]);
    return {
        entity_type: entityType,
        entity: record,
        notes,
        last_note_at: latestNoteAt(notes),
        last_status_change_at: lastStatusChangeAt,
        entity_updated_at: record.updated_at || null,
        communications,
        finance,
    };
}

async function getOpenInspectorTask(companyId, entityType, entityId, client = null) {
    requireCompanyId(companyId);
    assertEntityType(entityType);
    const query = queryFor(client, db);
    const parentColumn = entityType === 'job' ? 'job_id' : 'lead_id';
    const { rows } = await query(
        `SELECT id, company_id, status, due_at, thread_id
         FROM tasks
         WHERE company_id = $1
           AND ${parentColumn} = $2
           AND status = 'open'
           AND agent_type = 'inspector'
         ORDER BY id
         LIMIT 1`,
        [companyId, entityId]
    );
    return rows[0] || null;
}

async function findExistingTimeline(companyId, contactId, client = null) {
    requireCompanyId(companyId);
    if (!contactId) return null;
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT timeline.id, timeline.contact_id
         FROM timelines timeline
         JOIN contacts contact
           ON contact.id = timeline.contact_id
          AND contact.company_id = timeline.company_id
         WHERE timeline.company_id = $1
           AND timeline.contact_id = $2
         ORDER BY timeline.updated_at DESC, timeline.id DESC
         LIMIT 1`,
        [companyId, contactId]
    );
    return rows[0] || null;
}

async function linkTaskToTimeline(companyId, taskId, timelineId, contactId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `UPDATE tasks task
         SET thread_id = timeline.id,
             contact_id = $4,
             subject_type = 'contact',
             subject_id = $4
         FROM timelines timeline
         WHERE task.company_id = $1
           AND task.id = $2
           AND task.thread_id IS NULL
           AND timeline.company_id = task.company_id
           AND timeline.id = $3
           AND timeline.contact_id = $4
         RETURNING task.id`,
        [companyId, taskId, timelineId, contactId]
    );
    return rows[0] || null;
}

async function getReview(companyId, companyLocalDate, entityType, entityId, client = null) {
    requireCompanyId(companyId);
    assertEntityType(entityType);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT * FROM inspector_reviews
         WHERE company_id = $1
           AND company_local_date = $2::DATE
           AND entity_type = $3
           AND entity_id = $4`,
        [companyId, companyLocalDate, entityType, entityId]
    );
    return rows[0] || null;
}

async function insertReview(companyId, review, client = null) {
    requireCompanyId(companyId);
    assertEntityType(review.entity_type);
    const query = queryFor(client, db);
    const { rows } = await query(
        `INSERT INTO inspector_reviews
            (company_id, company_local_date, entity_type, entity_id, verdict,
             provider, model, latency_ms, token_usage, explanation, task_id)
         VALUES ($1, $2::DATE, $3, $4, $5, $6, $7, $8, $9::JSONB, $10, $11)
         ON CONFLICT (company_id, company_local_date, entity_type, entity_id) DO NOTHING
         RETURNING *`,
        [
            companyId,
            review.company_local_date,
            review.entity_type,
            review.entity_id,
            review.verdict,
            review.provider || null,
            review.model || null,
            review.latency_ms ?? null,
            JSON.stringify(review.token_usage || {}),
            review.explanation ? String(review.explanation).slice(0, 1200) : null,
            review.task_id || null,
        ]
    );
    return rows[0] || getReview(
        companyId,
        review.company_local_date,
        review.entity_type,
        review.entity_id,
        client
    );
}

module.exports = {
    APP_KEY,
    CLOSED_ESTIMATE_STATUSES,
    DEFAULT_TIMEZONE,
    activeNotes,
    assertEntityType,
    claimDailyRun,
    findExistingTimeline,
    finishRun,
    getCompanyTimezone,
    getEntityContext,
    getEntityRecord,
    getFinanceSummary,
    getLastStatusChange,
    getOpenInspectorTask,
    getRecentCommunications,
    getReview,
    getRuntimeConfiguration,
    getSettings,
    insertReview,
    latestNoteAt,
    linkTaskToTimeline,
    listCandidateJobs,
    listCandidateLeads,
    listDueCompanies,
    refreshRunLease,
    reloadEligibleEntity,
    saveSettings,
    virtualSettings,
};
