const db = require('./connection');
const { toE164 } = require('../utils/phoneUtils');

// Default company ID for single-tenant mode (Boston Masters)
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// =============================================================================
// Contact operations
// =============================================================================

async function findContactByPhone(phoneE164) {
    // Use digits-only comparison to handle format mismatches
    // (e.g. "+15085140320" should match "+1 (508) 514-0320")
    const digits = phoneE164.replace(/\D/g, '');
    const result = await db.query(
        `SELECT * FROM contacts WHERE regexp_replace(phone_e164, '\\D', '', 'g') = $1 LIMIT 1`,
        [digits]
    );
    return result.rows[0];
}

async function createContact(phoneE164, fullName = null, companyId = null) {
    const normalized = toE164(phoneE164) || phoneE164;
    const result = await db.query(
        `INSERT INTO contacts (phone_e164, full_name, company_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [normalized, fullName || normalized, companyId || DEFAULT_COMPANY_ID]
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
        price, priceUnit, lastEventTime, rawLastPayload,
        timelineId
    } = data;

    const result = await db.query(
        `INSERT INTO calls (
            call_sid, parent_call_sid, contact_id, direction,
            from_number, to_number, status, is_final,
            started_at, answered_at, ended_at, duration_sec,
            price, price_unit, last_event_time, raw_last_payload,
            company_id, timeline_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (call_sid) DO UPDATE SET
            parent_call_sid   = COALESCE(EXCLUDED.parent_call_sid, calls.parent_call_sid),
            contact_id        = COALESCE(EXCLUDED.contact_id, calls.contact_id),
            timeline_id       = COALESCE(EXCLUDED.timeline_id, calls.timeline_id),
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
          AND (NOT calls.is_final OR EXCLUDED.is_final)
        RETURNING *`,
        [
            callSid, parentCallSid, contactId, direction,
            fromNumber, toNumber, status, isFinal,
            startedAt, answeredAt, endedAt, durationSec,
            price, priceUnit, lastEventTime,
            JSON.stringify(rawLastPayload || {}),
            data.companyId || DEFAULT_COMPANY_ID,
            timelineId || null
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
 * Filters out inbound child legs (parent_call_sid IS NULL) so only root calls appear.
 */
async function getCallsByContact({ limit = 20, offset = 0, companyId = null, search = null } = {}) {
    const companyFilter = companyId ? `AND c.company_id = $3` : '';
    const companyFilter2 = companyId ? `AND c2.company_id = $3` : '';
    const companyFilter3 = companyId ? `AND c3.company_id = $3` : '';
    const params = [limit, offset];
    if (companyId) params.push(companyId);

    // Search filter: match phone digits, contact name, call_sid, lead name
    let searchFilter = '';
    if (search) {
        const searchTerm = search.trim();
        const digits = searchTerm.replace(/\D/g, '');
        const conditions = [];

        // Text-based: contact name, call_sid
        const textIdx = params.length + 1;
        params.push('%' + searchTerm + '%');
        conditions.push('co.full_name ILIKE $' + textIdx);
        conditions.push('c.call_sid ILIKE $' + textIdx);
        // Lead name via contact phone
        conditions.push(
            "EXISTS (SELECT 1 FROM leads l WHERE regexp_replace(l.phone, E'\\\\D', '', 'g') = regexp_replace(co.phone_e164, E'\\\\D', '', 'g') AND (l.first_name ILIKE $" + textIdx + " OR l.last_name ILIKE $" + textIdx + " OR CONCAT(l.first_name, ' ', l.last_name) ILIKE $" + textIdx + "))"
        );

        // Digit-based phone search
        if (digits.length > 0) {
            const digitIdx = params.length + 1;
            params.push('%' + digits + '%');
            conditions.push("regexp_replace(co.phone_e164, E'\\\\D', '', 'g') LIKE $" + digitIdx);
            conditions.push("regexp_replace(c.from_number, E'\\\\D', '', 'g') LIKE $" + digitIdx);
            conditions.push("regexp_replace(c.to_number, E'\\\\D', '', 'g') LIKE $" + digitIdx);
        }

        searchFilter = 'AND (' + conditions.join(' OR ') + ')';
    }

    const result = await db.query(
        `SELECT * FROM (
            SELECT DISTINCT ON (c.contact_id)
                c.*,
                to_json(co) as contact,
                (SELECT COUNT(*) FROM calls c2
                 WHERE c2.contact_id = c.contact_id
                   AND c2.parent_call_sid IS NULL
                   ${companyFilter2}) as call_count
             FROM calls c
             LEFT JOIN contacts co ON c.contact_id = co.id
             WHERE c.contact_id IS NOT NULL
               AND c.parent_call_sid IS NULL
               ${companyFilter}
               ${searchFilter}
               AND EXISTS (
                   SELECT 1 FROM calls c3
                   WHERE c3.contact_id = c.contact_id
                     AND c3.parent_call_sid IS NULL
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
           AND parent_call_sid IS NULL
           ${companyFilter}
           AND EXISTS (
               SELECT 1 FROM calls c2
               WHERE c2.contact_id = calls.contact_id
                 AND c2.parent_call_sid IS NULL
                 AND c2.status NOT IN ('failed', 'canceled')
                 ${companyFilter2}
           )`,
        params
    );
    return parseInt(result.rows[0].count, 10);
}

/**
 * Get calls for a specific contact (with recording + transcript data).
 * Filters out inbound child legs. For parent calls, also searches child legs
 * for recordings and transcripts (since media is often on the winner child).
 */
async function getCallsByContactId(contactId) {
    const result = await db.query(
        `SELECT c.*, to_json(co) as contact,
            COALESCE(r.recording_sid, cr.recording_sid) as recording_sid,
            COALESCE(r.status, cr.status) as recording_status,
            COALESCE(r.duration_sec, cr.duration_sec) as recording_duration_sec,
            COALESCE(t.status, ct.status) as transcript_status,
            COALESCE(t.text, ct.text) as transcript_text,
            COALESCE(t.raw_payload, ct.raw_payload) as transcript_raw_payload
         FROM calls c
         LEFT JOIN contacts co ON c.contact_id = co.id
         -- Direct recording on this call
         LEFT JOIN LATERAL (
             SELECT recording_sid, status, duration_sec
             FROM recordings
             WHERE recordings.call_sid = c.call_sid
             ORDER BY completed_at DESC NULLS LAST, updated_at DESC
             LIMIT 1
         ) r ON true
         -- Fallback: recording on child legs (for parent inbound calls)
         LEFT JOIN LATERAL (
             SELECT rec.recording_sid, rec.status, rec.duration_sec
             FROM calls child
             JOIN recordings rec ON rec.call_sid = child.call_sid
             WHERE child.parent_call_sid = c.call_sid
             ORDER BY rec.completed_at DESC NULLS LAST, rec.updated_at DESC
             LIMIT 1
         ) cr ON r.recording_sid IS NULL
         -- Direct transcript on this call
         LEFT JOIN LATERAL (
             SELECT status, text, raw_payload
             FROM transcripts
             WHERE transcripts.call_sid = c.call_sid
             ORDER BY updated_at DESC
             LIMIT 1
         ) t ON true
         -- Fallback: transcript on child legs
         LEFT JOIN LATERAL (
             SELECT tr.status, tr.text, tr.raw_payload
             FROM calls child
             JOIN transcripts tr ON tr.call_sid = child.call_sid
             WHERE child.parent_call_sid = c.call_sid
             ORDER BY tr.updated_at DESC
             LIMIT 1
         ) ct ON t.status IS NULL
         WHERE c.contact_id = $1
           AND c.parent_call_sid IS NULL
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
    let [recordings, transcripts] = await Promise.all([
        getRecordingsByCallSid(callSid),
        getTranscriptsByCallSid(callSid),
    ]);

    // Fallback: if no media on this call, check child legs
    if (recordings.length === 0 || transcripts.length === 0) {
        const childResult = await db.query(
            `SELECT call_sid FROM calls WHERE parent_call_sid = $1`,
            [callSid]
        );
        for (const child of childResult.rows) {
            if (recordings.length === 0) {
                const childRecs = await getRecordingsByCallSid(child.call_sid);
                if (childRecs.length > 0) recordings = childRecs;
            }
            if (transcripts.length === 0) {
                const childTrans = await getTranscriptsByCallSid(child.call_sid);
                if (childTrans.length > 0) transcripts = childTrans;
            }
            if (recordings.length > 0 && transcripts.length > 0) break;
        }
    }

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
// Contact unread state
// =============================================================================

async function markContactUnread(contactId, eventTime = new Date()) {
    console.log(`[UNREAD-TRACE] markContactUnread called for contact ${contactId}`, new Error().stack?.split('\n').slice(1, 4).join(' <- '));
    const result = await db.query(
        `UPDATE contacts SET
            has_unread = true,
            last_incoming_event_at = GREATEST(last_incoming_event_at, $2),
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [contactId, eventTime]
    );
    console.log(`[UNREAD-TRACE] markContactUnread result: has_unread=${result.rows[0]?.has_unread}`);
    return result.rows[0] || null;
}

async function markContactRead(contactId) {
    console.log(`[UNREAD-TRACE] markContactRead called for contact ${contactId}`, new Error().stack?.split('\n').slice(1, 4).join(' <- '));
    const result = await db.query(
        `UPDATE contacts SET
            has_unread = false,
            last_read_at = now(),
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [contactId]
    );
    console.log(`[UNREAD-TRACE] markContactRead result: has_unread=${result.rows[0]?.has_unread}`);
    return result.rows[0] || null;
}

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
// Timeline operations
// =============================================================================

/**
 * Find or create a timeline for a phone number.
 * Contact-first resolution:
 *   1. Find the most recently updated contact whose primary or secondary phone matches
 *   2. If found → find/create a timeline by contact_id (one per contact)
 *   3. If not found → find/create an orphan timeline by phone_e164
 */
async function findOrCreateTimeline(phoneE164, companyId = null) {
    const digits = phoneE164.replace(/\D/g, '');

    // 1. Find the most recently updated contact for this phone
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
        // 2. Contact found — find/create timeline by contact_id
        let tl = await db.query(
            `SELECT * FROM timelines WHERE contact_id = $1 LIMIT 1`,
            [contact.id]
        );
        if (tl.rows[0]) return { ...tl.rows[0], contact_id: contact.id };

        // Create contact timeline (phone_e164 = NULL)
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

    // 3. No contact — find/create orphan timeline by phone_e164
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

/**
 * Find a contact by phone — checks both phone_e164 and secondary_phone.
 * Does NOT create a contact if not found.
 */
async function findContactByPhoneOrSecondary(phoneE164) {
    const digits = phoneE164.replace(/\D/g, '');
    // Check primary phone first
    let result = await db.query(
        `SELECT * FROM contacts WHERE regexp_replace(phone_e164, '\\D', '', 'g') = $1 LIMIT 1`,
        [digits]
    );
    if (result.rows[0]) return result.rows[0];

    // Check secondary phone
    result = await db.query(
        `SELECT * FROM contacts WHERE regexp_replace(secondary_phone, '\\D', '', 'g') = $1 LIMIT 1`,
        [digits]
    );
    return result.rows[0] || null;
}

/**
 * Get timelines with latest call + SMS enrichment.
 * Starts FROM timelines so SMS-only threads (no calls) are included.
 * 3-tier sort: action_required > unread > rest, then by most recent interaction.
 */
async function getCallsByTimeline({ limit = 20, offset = 0, companyId = null, search = null } = {}) {
    const companyFilter = companyId ? `AND tl.company_id = $3` : '';
    const params = [limit, offset];
    if (companyId) params.push(companyId);

    // Search filter
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
             -- Call fields (may be NULL for SMS-only timelines)
             latest_call.*,
             to_json(co) as contact,
             tl.id as tl_id,
             tl.id as timeline_id,
             tl.has_unread as tl_has_unread,
             COALESCE(tl.phone_e164, co.phone_e164) as tl_phone,
             tl.sms_last_at,
             -- Action Required fields
             tl.is_action_required,
             tl.action_required_reason,
             tl.action_required_set_at,
             tl.action_required_set_by,
             tl.snoozed_until,
             tl.owner_user_id,
             -- Open task summary
             open_task.id as open_task_id,
             open_task.title as open_task_title,
             open_task.due_at as open_task_due_at,
             open_task.priority as open_task_priority,
             -- SMS enrichment
             sms.last_message_at as sms_last_message_at,
             sms.last_message_direction as sms_last_message_direction,
             sms.last_message_preview as sms_last_message_preview,
             sms.has_unread as sms_has_unread,
             sms.sms_conversation_id
         FROM timelines tl
         LEFT JOIN contacts co ON tl.contact_id = co.id
         -- Latest parent call per timeline
         LEFT JOIN LATERAL (
             SELECT c2.*
             FROM calls c2
             WHERE c2.timeline_id = tl.id
               AND c2.parent_call_sid IS NULL
             ORDER BY c2.started_at DESC NULLS LAST
             LIMIT 1
         ) latest_call ON true
         -- Open task (at most 1 per thread due to unique partial index)
         LEFT JOIN tasks open_task ON open_task.thread_id = tl.id AND open_task.status = 'open'
         -- SMS enrichment
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
           -- Tier 1: Action Required (non-snoozed) at top
           CASE WHEN tl.is_action_required = true
                 AND (tl.snoozed_until IS NULL OR tl.snoozed_until <= now())
                THEN 0
           -- Tier 2: Unread threads next
                WHEN tl.has_unread = true OR sms.has_unread = true
                THEN 1
           -- Tier 3: Everything else
                ELSE 2
           END ASC,
           -- Within each tier: most recent interaction first
           GREATEST(latest_call.started_at, sms.last_message_at) DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        params
    );
    return result.rows;
}

/**
 * Get total timelines with calls count
 */
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

/**
 * Set action_required on a timeline thread.
 */
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

/**
 * Mark thread as handled: clear action_required + close open task.
 */
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

    // Close any open task for this thread
    await db.query(
        `UPDATE tasks SET status = 'done', completed_at = now()
         WHERE thread_id = $1 AND status = 'open'`,
        [timelineId]
    );

    return tl.rows[0] || null;
}

/**
 * Snooze a thread until a specific time.
 */
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

/**
 * Unsnooze expired threads (called by scheduler).
 * Returns list of unsnoozed timeline IDs.
 */
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

/**
 * Assign owner to a thread + its open task.
 */
async function assignThread(timelineId, ownerUserId) {
    const tl = await db.query(
        `UPDATE timelines SET
            owner_user_id = $2,
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [timelineId, ownerUserId]
    );

    // Also assign open task if exists
    await db.query(
        `UPDATE tasks SET owner_user_id = $2
         WHERE thread_id = $1 AND status = 'open'`,
        [timelineId, ownerUserId]
    );

    return tl.rows[0] || null;
}

/**
 * Create a task linked to a thread.
 */
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

/**
 * Get the open task for a thread (at most 1).
 */
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
    findContactByPhone,
    createContact,
    findOrCreateContact,
    markContactUnread,
    markContactRead,
    markTimelineUnread,
    markTimelineRead,

    // Timelines
    findOrCreateTimeline,
    findContactByPhoneOrSecondary,
    getCallsByTimeline,
    getTimelinesWithCallsCount,

    // Action Required + Tasks
    setActionRequired,
    markThreadHandled,
    snoozeThread,
    unsnoozeExpiredThreads,
    assignThread,
    createTask,
    getOpenTaskByThread,

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
