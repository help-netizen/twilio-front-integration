const db = require('./connection');

// Default company ID for single-tenant mode (Boston Masters)
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// =============================================================================
// Contact operations
// =============================================================================

async function findContactByPhone(phoneE164) {
    const result = await db.query(
        'SELECT * FROM contacts WHERE phone_e164 = $1',
        [phoneE164]
    );
    return result.rows[0];
}

async function createContact(phoneE164, fullName = null, companyId = null) {
    const result = await db.query(
        `INSERT INTO contacts (phone_e164, full_name, company_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (phone_e164) WHERE phone_e164 IS NOT NULL
         DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, contacts.full_name)
         RETURNING *`,
        [phoneE164, fullName || phoneE164, companyId || DEFAULT_COMPANY_ID]
    );
    return result.rows[0];
}

async function findOrCreateContact(phoneE164, fullName = null) {
    let contact = await findContactByPhone(phoneE164);
    if (!contact) {
        contact = await createContact(phoneE164, fullName);
    }
    return contact;
}

// =============================================================================
// Call operations (snapshot model)
// =============================================================================

/**
 * Upsert a call record — INSERT or UPDATE the snapshot.
 * Guards against out-of-order events via last_event_time.
 */
async function upsertCall(data) {
    const {
        callSid, parentCallSid, contactId, direction,
        fromNumber, toNumber, status, isFinal,
        startedAt, answeredAt, endedAt, durationSec,
        price, priceUnit, lastEventTime, rawLastPayload
    } = data;

    const result = await db.query(
        `INSERT INTO calls (
            call_sid, parent_call_sid, contact_id, direction,
            from_number, to_number, status, is_final,
            started_at, answered_at, ended_at, duration_sec,
            price, price_unit, last_event_time, raw_last_payload,
            company_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (call_sid) DO UPDATE SET
            parent_call_sid   = COALESCE(EXCLUDED.parent_call_sid, calls.parent_call_sid),
            contact_id        = COALESCE(EXCLUDED.contact_id, calls.contact_id),
            direction         = EXCLUDED.direction,
            from_number       = EXCLUDED.from_number,
            to_number         = EXCLUDED.to_number,
            status            = EXCLUDED.status,
            is_final          = EXCLUDED.is_final,
            started_at        = COALESCE(EXCLUDED.started_at, calls.started_at),
            answered_at       = COALESCE(EXCLUDED.answered_at, calls.answered_at),
            ended_at          = COALESCE(EXCLUDED.ended_at, calls.ended_at),
            duration_sec      = COALESCE(EXCLUDED.duration_sec, calls.duration_sec),
            price             = COALESCE(EXCLUDED.price, calls.price),
            price_unit        = COALESCE(EXCLUDED.price_unit, calls.price_unit),
            last_event_time   = EXCLUDED.last_event_time,
            raw_last_payload  = EXCLUDED.raw_last_payload
        WHERE EXCLUDED.last_event_time >= COALESCE(calls.last_event_time, '1970-01-01'::timestamptz)
        RETURNING *`,
        [
            callSid, parentCallSid, contactId, direction,
            fromNumber, toNumber, status, isFinal,
            startedAt, answeredAt, endedAt, durationSec,
            price, priceUnit, lastEventTime,
            JSON.stringify(rawLastPayload || {}),
            data.companyId || DEFAULT_COMPANY_ID
        ]
    );
    return result.rows[0];
}

/**
 * Get a single call by CallSid
 */
async function getCallByCallSid(callSid, companyId = null) {
    const conditions = ['c.call_sid = $1'];
    const params = [callSid];
    if (companyId) {
        conditions.push(`c.company_id = $2`);
        params.push(companyId);
    }
    const result = await db.query(
        `SELECT c.*, to_json(co) as contact
         FROM calls c
         LEFT JOIN contacts co ON c.contact_id = co.id
         WHERE ${conditions.join(' AND ')}`,
        params
    );
    return result.rows[0];
}

/**
 * Get calls with cursor-based pagination and optional filters.
 * Cursor is the last seen `id`.
 */
async function getCalls({ cursor, limit = 50, status, hasRecording, hasTranscript, contactId, companyId } = {}) {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (companyId) {
        conditions.push(`c.company_id = $${paramIdx++}`);
        params.push(companyId);
    }
    if (cursor) {
        conditions.push(`c.id < $${paramIdx++}`);
        params.push(cursor);
    }
    if (status) {
        conditions.push(`c.status = $${paramIdx++}`);
        params.push(status);
    }
    if (contactId) {
        conditions.push(`c.contact_id = $${paramIdx++}`);
        params.push(contactId);
    }
    if (hasRecording === true) {
        conditions.push(`EXISTS (SELECT 1 FROM recordings r WHERE r.call_sid = c.call_sid AND r.status = 'completed')`);
    }
    if (hasTranscript === true) {
        conditions.push(`EXISTS (SELECT 1 FROM transcripts t WHERE t.call_sid = c.call_sid AND t.status = 'completed')`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit);

    const result = await db.query(
        `SELECT c.*, to_json(co) as contact
         FROM calls c
         LEFT JOIN contacts co ON c.contact_id = co.id
         ${whereClause}
         ORDER BY c.id DESC
         LIMIT $${paramIdx}`,
        params
    );

    const rows = result.rows;
    const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;

    return { calls: rows, nextCursor };
}

/**
 * Get calls grouped by contact (replaces old "conversations" listing).
 * Returns latest call per contact with call count.
 */
async function getCallsByContact({ limit = 20, offset = 0, companyId = null } = {}) {
    const companyFilter = companyId ? `AND c.company_id = $3` : '';
    const companyFilter2 = companyId ? `AND c2.company_id = $3` : '';
    const companyFilter3 = companyId ? `AND c3.company_id = $3` : '';
    const params = [limit, offset];
    if (companyId) params.push(companyId);

    const result = await db.query(
        `SELECT * FROM (
            SELECT DISTINCT ON (c.contact_id)
                c.*,
                to_json(co) as contact,
                (SELECT COUNT(*) FROM calls c2 WHERE c2.contact_id = c.contact_id ${companyFilter2}) as call_count
             FROM calls c
             LEFT JOIN contacts co ON c.contact_id = co.id
             WHERE c.contact_id IS NOT NULL
               ${companyFilter}
               AND EXISTS (
                   SELECT 1 FROM calls c3
                   WHERE c3.contact_id = c.contact_id
                     AND c3.status NOT IN ('failed', 'canceled')
                     ${companyFilter3}
               )
             ORDER BY c.contact_id, c.started_at DESC NULLS LAST
         ) sub
         ORDER BY sub.started_at DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        params
    );
    return result.rows;
}

/**
 * Get total contacts with calls count
 */
async function getContactsWithCallsCount(companyId = null) {
    const companyFilter = companyId ? `AND calls.company_id = $1` : '';
    const companyFilter2 = companyId ? `AND c2.company_id = $1` : '';
    const params = companyId ? [companyId] : [];
    const result = await db.query(
        `SELECT COUNT(DISTINCT contact_id) FROM calls
         WHERE contact_id IS NOT NULL
           ${companyFilter}
           AND EXISTS (
               SELECT 1 FROM calls c2
               WHERE c2.contact_id = calls.contact_id
                 AND c2.status NOT IN ('failed', 'canceled')
                 ${companyFilter2}
           )`,
        params
    );
    return parseInt(result.rows[0].count, 10);
}

/**
 * Get calls for a specific contact (with recording + transcript data)
 */
async function getCallsByContactId(contactId) {
    const result = await db.query(
        `SELECT c.*, to_json(co) as contact,
            r.recording_sid, r.status as recording_status, r.duration_sec as recording_duration_sec,
            t.status as transcript_status, t.text as transcript_text
         FROM calls c
         LEFT JOIN contacts co ON c.contact_id = co.id
         LEFT JOIN LATERAL (
             SELECT recording_sid, status, duration_sec
             FROM recordings
             WHERE recordings.call_sid = c.call_sid
             ORDER BY completed_at DESC NULLS LAST, updated_at DESC
             LIMIT 1
         ) r ON true
         LEFT JOIN LATERAL (
             SELECT status, text
             FROM transcripts
             WHERE transcripts.call_sid = c.call_sid
             ORDER BY updated_at DESC
             LIMIT 1
         ) t ON true
         WHERE c.contact_id = $1
         ORDER BY c.started_at DESC NULLS LAST`,
        [contactId]
    );
    return result.rows;
}

/**
 * Get active (non-final) calls
 */
async function getActiveCalls(companyId = null) {
    const companyFilter = companyId ? `AND c.company_id = $1` : '';
    const params = companyId ? [companyId] : [];
    const result = await db.query(
        `SELECT c.*, to_json(co) as contact
         FROM calls c
         LEFT JOIN contacts co ON c.contact_id = co.id
         WHERE c.is_final = false ${companyFilter}
         ORDER BY c.started_at DESC NULLS LAST`,
        params
    );
    return result.rows;
}

/**
 * Get non-final calls (for reconcile)
 */
async function getNonFinalCalls(windowHours = 6) {
    const result = await db.query(
        `SELECT * FROM calls
         WHERE is_final = false
           AND created_at >= now() - interval '1 hour' * $1
         ORDER BY created_at ASC`,
        [windowHours]
    );
    return result.rows;
}

// =============================================================================
// Recording operations
// =============================================================================

async function upsertRecording(data) {
    const {
        recordingSid, callSid, status, recordingUrl,
        durationSec, channels, track, source,
        startedAt, completedAt, rawPayload
    } = data;

    const result = await db.query(
        `INSERT INTO recordings (
            recording_sid, call_sid, status, recording_url,
            duration_sec, channels, track, source,
            started_at, completed_at, raw_payload, company_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (recording_sid) DO UPDATE SET
            status        = EXCLUDED.status,
            recording_url = COALESCE(EXCLUDED.recording_url, recordings.recording_url),
            duration_sec  = COALESCE(EXCLUDED.duration_sec, recordings.duration_sec),
            channels      = COALESCE(EXCLUDED.channels, recordings.channels),
            track         = COALESCE(EXCLUDED.track, recordings.track),
            source        = COALESCE(EXCLUDED.source, recordings.source),
            started_at    = COALESCE(EXCLUDED.started_at, recordings.started_at),
            completed_at  = COALESCE(EXCLUDED.completed_at, recordings.completed_at),
            raw_payload   = EXCLUDED.raw_payload
        RETURNING *`,
        [
            recordingSid, callSid, status, recordingUrl,
            durationSec, channels || null, track || null, source || null,
            startedAt, completedAt,
            JSON.stringify(rawPayload || {}),
            data.companyId || DEFAULT_COMPANY_ID
        ]
    );
    return result.rows[0];
}

async function getRecordingsByCallSid(callSid) {
    const result = await db.query(
        `SELECT * FROM recordings WHERE call_sid = $1 ORDER BY started_at DESC`,
        [callSid]
    );
    return result.rows;
}

// =============================================================================
// Transcript operations
// =============================================================================

async function upsertTranscript(data) {
    const {
        transcriptionSid, callSid, recordingSid, mode,
        status, languageCode, confidence, text,
        isFinal, sequenceNo, rawPayload
    } = data;

    const result = await db.query(
        `INSERT INTO transcripts (
            transcription_sid, call_sid, recording_sid, mode,
            status, language_code, confidence, text,
            is_final, sequence_no, raw_payload, company_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (transcription_sid) DO UPDATE SET
            status        = EXCLUDED.status,
            text          = COALESCE(EXCLUDED.text, transcripts.text),
            confidence    = COALESCE(EXCLUDED.confidence, transcripts.confidence),
            is_final      = EXCLUDED.is_final,
            raw_payload   = EXCLUDED.raw_payload
        RETURNING *`,
        [
            transcriptionSid, callSid, recordingSid, mode || 'post-call',
            status, languageCode, confidence, text,
            isFinal !== undefined ? isFinal : true,
            sequenceNo,
            JSON.stringify(rawPayload || {}),
            data.companyId || DEFAULT_COMPANY_ID
        ]
    );
    return result.rows[0];
}

async function getTranscriptsByCallSid(callSid) {
    const result = await db.query(
        `SELECT * FROM transcripts WHERE call_sid = $1 ORDER BY sequence_no ASC NULLS LAST, created_at ASC`,
        [callSid]
    );
    return result.rows;
}

// =============================================================================
// Call events (immutable log)
// =============================================================================

async function appendCallEvent(callSid, eventType, eventTime, payload, companyId = null) {
    const result = await db.query(
        `INSERT INTO call_events (call_sid, event_type, event_time, payload, company_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [callSid, eventType, eventTime, JSON.stringify(payload), companyId || DEFAULT_COMPANY_ID]
    );
    return result.rows[0];
}

async function getCallEvents(callSid) {
    const result = await db.query(
        `SELECT * FROM call_events WHERE call_sid = $1 ORDER BY event_time DESC`,
        [callSid]
    );
    return result.rows;
}

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
    return result.rows[0]; // null if duplicate
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

// =============================================================================
// Media aggregation (recordings + transcripts for a call)
// =============================================================================

async function getCallMedia(callSid) {
    const [recordings, transcripts] = await Promise.all([
        getRecordingsByCallSid(callSid),
        getTranscriptsByCallSid(callSid),
    ]);
    return { recordings, transcripts };
}

// =============================================================================
// Health check for sync
// =============================================================================

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
    // Contacts
    findContactByPhone,
    createContact,
    findOrCreateContact,

    // Calls
    upsertCall,
    getCallByCallSid,
    getCalls,
    getCallsByContact,
    getContactsWithCallsCount,
    getCallsByContactId,
    getActiveCalls,
    getNonFinalCalls,

    // Recordings
    upsertRecording,
    getRecordingsByCallSid,

    // Transcripts
    upsertTranscript,
    getTranscriptsByCallSid,

    // Call events
    appendCallEvent,
    getCallEvents,

    // Webhook inbox
    insertInboxEvent,
    claimInboxEvents,
    markInboxProcessed,
    markInboxFailed,

    // Sync state
    getSyncState,
    upsertSyncState,

    // Aggregation
    getCallMedia,
    getSyncHealth,
};
