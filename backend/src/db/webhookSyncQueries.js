/**
 * Webhook & Sync Query Module
 * Extracted from queries.js — RF006
 *
 * Covers: webhook_inbox operations, sync_state operations, sync health
 */
const db = require('./connection');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// =============================================================================
// Webhook inbox
// =============================================================================

async function insertInboxEvent(data) {
    const {
        eventKey, source, eventType, eventTime,
        callSid, recordingSid, transcriptionSid,
        payload, headers
    } = data;

    const result = await db.query(
        `INSERT INTO webhook_inbox (
            event_key, source, event_type, event_time,
            call_sid, recording_sid, transcription_sid,
            payload, headers, company_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (event_key) DO NOTHING
        RETURNING *`,
        [
            eventKey, source, eventType, eventTime,
            callSid, recordingSid, transcriptionSid,
            JSON.stringify(payload), JSON.stringify(headers || {}),
            data.companyId || DEFAULT_COMPANY_ID
        ]
    );
    return result.rows[0];
}

async function claimInboxEvents(batchSize = 10) {
    const result = await db.query(
        `UPDATE webhook_inbox
         SET status = 'processing', attempts = attempts + 1
         WHERE id IN (
             SELECT id FROM webhook_inbox
             WHERE status = 'received'
             ORDER BY received_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [batchSize]
    );
    return result.rows;
}

async function markInboxProcessed(id) {
    await db.query(
        `UPDATE webhook_inbox SET status = 'processed', processed_at = now() WHERE id = $1`,
        [id]
    );
}

async function markInboxFailed(id, errorText) {
    const result = await db.query(
        `UPDATE webhook_inbox
         SET status = CASE WHEN attempts >= 10 THEN 'dead' ELSE 'received' END,
             error_text = $2
         WHERE id = $1
         RETURNING *`,
        [id, errorText]
    );
    return result.rows[0];
}

// =============================================================================
// Sync state
// =============================================================================

async function getSyncState(jobName) {
    const result = await db.query(
        'SELECT * FROM sync_state WHERE job_name = $1',
        [jobName]
    );
    return result.rows[0];
}

async function upsertSyncState(jobName, cursor, error = null) {
    const result = await db.query(
        `INSERT INTO sync_state (job_name, cursor, last_success_at)
         VALUES ($1, $2, CASE WHEN $3::text IS NULL THEN now() ELSE NULL END)
         ON CONFLICT (job_name) DO UPDATE SET
             cursor = EXCLUDED.cursor,
             last_success_at = CASE WHEN $3::text IS NULL THEN now() ELSE sync_state.last_success_at END,
             last_error_at = CASE WHEN $3::text IS NOT NULL THEN now() ELSE sync_state.last_error_at END,
             last_error = $3
         RETURNING *`,
        [jobName, JSON.stringify(cursor), error]
    );
    return result.rows[0];
}

async function getSyncHealth() {
    const result = await db.query(
        `SELECT * FROM sync_state ORDER BY job_name`
    );
    const inbox = await db.query(
        `SELECT status, COUNT(*) as count
         FROM webhook_inbox
         GROUP BY status`
    );
    return {
        jobs: result.rows,
        inbox: inbox.rows.reduce((acc, r) => { acc[r.status] = parseInt(r.count); return acc; }, {}),
    };
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    insertInboxEvent,
    claimInboxEvents,
    markInboxProcessed,
    markInboxFailed,
    getSyncState,
    upsertSyncState,
    getSyncHealth,
};
