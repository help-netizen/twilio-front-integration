const queries = require('../db/queries');
const db = require('../db/connection');
const { isFinalStatus } = require('./stateMachine');
const CallProcessor = require('./callProcessor');
const { extractPhoneFromSIP } = require('./callProcessor');
const { reconcileStaleCalls } = require('./reconcileStale');

/**
 * Configuration
 */
const CONFIG = {
    BATCH_SIZE: 10,
    POLL_INTERVAL_MS: 1000,
    MAX_RETRIES: 10,
    STALE_CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
};

// =============================================================================
// Event normalizers — transform Twilio payload → canonical form
// =============================================================================

function normalizeVoiceEvent(payload) {
    const {
        CallSid, CallStatus, Timestamp, From, To, Direction,
        Duration, CallDuration, ParentCallSid,
        AnsweredBy, CallerName, Price, PriceUnit,
        FromCity, FromState, FromCountry,
        ToCity, ToState, ToCountry,
        RecordingUrl, RecordingSid, RecordingDuration,
        QueueTime,
    } = payload;

    const eventTime = Timestamp && !isNaN(parseInt(Timestamp))
        ? new Date(parseInt(Timestamp) * 1000)
        : new Date();

    // Direction detection via CallProcessor
    const direction = CallProcessor.detectDirection({ from: From, to: To });

    return {
        callSid: CallSid,
        eventType: 'call.status_changed',
        eventStatus: (CallStatus || '').toLowerCase(),
        eventTime,
        fromNumber: From,
        toNumber: To,
        direction,
        durationSec: parseInt(Duration || CallDuration || 0),
        parentCallSid: ParentCallSid || null,
        price: Price ? parseFloat(Price) : null,
        priceUnit: PriceUnit || null,
        metadata: {
            answered_by: AnsweredBy,
            caller_name: CallerName,
            queue_time: QueueTime,
            from_location: { city: FromCity, state: FromState, country: FromCountry },
            to_location: { city: ToCity, state: ToState, country: ToCountry },
            recording_url: RecordingUrl,
            recording_sid: RecordingSid,
            recording_duration: RecordingDuration,
        },
    };
}

function normalizeRecordingEvent(payload) {
    const {
        RecordingSid, CallSid, RecordingStatus,
        RecordingDuration, RecordingUrl, RecordingChannels,
        RecordingTrack, RecordingSource,
        Timestamp,
    } = payload;

    return {
        recordingSid: RecordingSid,
        callSid: CallSid,
        status: (RecordingStatus || '').toLowerCase(),
        recordingUrl: RecordingUrl,
        durationSec: RecordingDuration ? parseInt(RecordingDuration) : null,
        channels: RecordingChannels ? parseInt(RecordingChannels) : null,
        track: RecordingTrack || null,
        source: RecordingSource || null,
        eventTime: Timestamp && !isNaN(parseInt(Timestamp))
            ? new Date(parseInt(Timestamp) * 1000)
            : new Date(),
    };
}

function normalizeTranscriptionEvent(payload) {
    const {
        TranscriptionSid, TranscriptionStatus, TranscriptionText,
        RecordingSid, CallSid,
        LanguageCode, Confidence,
    } = payload;

    return {
        transcriptionSid: TranscriptionSid,
        callSid: CallSid,
        recordingSid: RecordingSid,
        status: (TranscriptionStatus || '').toLowerCase(),
        text: TranscriptionText || null,
        languageCode: LanguageCode || null,
        confidence: Confidence ? parseFloat(Confidence) : null,
        eventTime: new Date(),
    };
}

// =============================================================================
// Process a single inbox event
// =============================================================================

async function processEvent(inboxEvent) {
    const { id, source, event_type, payload } = inboxEvent;
    const traceId = `worker_${id}`;

    console.log(`[${traceId}] Processing`, { source, event_type, callSid: payload.CallSid });

    try {
        if (source === 'voice' || source === 'dial') {
            await processVoiceEvent(payload, event_type, traceId);
        } else if (source === 'recording') {
            await processRecordingEvent(payload, traceId);
        } else if (source === 'transcription') {
            await processTranscriptionEvent(payload, traceId);
        } else {
            throw new Error(`Unknown source: ${source}`);
        }

        return { success: true };
    } catch (error) {
        console.error(`[${traceId}] Error:`, error.message);
        throw error;
    }
}

// =============================================================================
// Voice event → upsert call + resolve contact
// =============================================================================

async function processVoiceEvent(payload, eventType, traceId) {
    const normalized = normalizeVoiceEvent(payload);

    // Resolve external party via CallProcessor
    const callData = {
        from: normalized.fromNumber,
        to: normalized.toNumber,
        direction: normalized.direction,
        status: normalized.eventStatus,
        duration: normalized.durationSec,
        parentCallSid: normalized.parentCallSid,
    };
    const processed = CallProcessor.processCall(callData);
    const externalParty = processed.externalParty;

    // Resolve contact
    let contactId = null;
    if (externalParty?.formatted && processed.direction !== 'internal') {
        const contact = await queries.findOrCreateContact(
            externalParty.formatted,
            externalParty.formatted
        );
        contactId = contact.id;
    }

    const isFinal = isFinalStatus(normalized.eventStatus);

    // Guard: don't let non-final events overwrite a final status
    // (e.g. dial.action sends "in-progress" after call is already "completed")
    let skipUpsert = false;
    if (!normalized.parentCallSid) {
        try {
            const existing = await queries.getCallByCallSid(normalized.callSid);
            if (existing) {
                const existingIsFinal = isFinalStatus(existing.status) ||
                    ['voicemail_recording', 'voicemail_left'].includes(existing.status);
                if (existingIsFinal && !isFinal) {
                    console.log(`[${traceId}] Skipping upsert — call is final (${existing.status}), ignoring non-final ${normalized.eventStatus}`);
                    skipUpsert = true;
                }
                if (['voicemail_recording', 'voicemail_left'].includes(existing.status)) {
                    console.log(`[${traceId}] Skipping upsert — call is in ${existing.status} status`);
                    skipUpsert = true;
                }
            }
        } catch (e) { /* proceed with upsert if check fails */ }
    }

    // Guard: for inbound parent calls, Twilio sends "in-progress" when TwiML starts
    // (Dial begins ringing agents), not when someone answers. Keep as "ringing"
    // until a child leg actually reaches "in-progress".
    let effectiveStatus = normalized.eventStatus;
    if (!normalized.parentCallSid && normalized.eventStatus === 'in-progress' && !skipUpsert) {
        try {
            const childCheck = await db.query(
                `SELECT 1 FROM calls WHERE parent_call_sid = $1 AND status = 'in-progress' LIMIT 1`,
                [normalized.callSid]
            );
            if (childCheck.rows.length === 0) {
                effectiveStatus = 'ringing';
                console.log(`[${traceId}] Parent in-progress but no child answered → keeping as ringing`);
            }
        } catch (e) { /* use original status if check fails */ }
    }

    const effectiveIsFinal = isFinalStatus(effectiveStatus);

    // Upsert call snapshot
    let call;
    if (!skipUpsert) {
        call = await queries.upsertCall({
            callSid: normalized.callSid,
            parentCallSid: normalized.parentCallSid,
            contactId,
            direction: processed.direction,   // Use CallProcessor's direction
            fromNumber: extractPhoneFromSIP(normalized.fromNumber),
            toNumber: extractPhoneFromSIP(normalized.toNumber),
            status: effectiveStatus,
            isFinal: effectiveIsFinal,
            startedAt: normalized.eventTime,
            answeredAt: effectiveStatus === 'in-progress' ? normalized.eventTime : null,
            endedAt: effectiveIsFinal ? normalized.eventTime : null,
            durationSec: normalized.durationSec || null,
            price: normalized.price,
            priceUnit: normalized.priceUnit,
            lastEventTime: normalized.eventTime,
            rawLastPayload: payload,
        });
    }

    if (call) {
        console.log(`[${traceId}] Call upserted`, { callSid: call.call_sid, status: call.status });
    } else {
        console.log(`[${traceId}] Call not updated (out-of-order event)`, { callSid: normalized.callSid });
    }

    // Append immutable event
    await queries.appendCallEvent(
        normalized.callSid,
        eventType || 'call.status_changed',
        normalized.eventTime,
        { ...normalized, raw: payload }
    );

    // Enrich from Twilio API on final status (skip if voicemail — we manage those statuses ourselves)
    let enrichedCall = call;
    if (isFinal && !skipUpsert) {
        await enrichFromTwilioApi(normalized.callSid, call, traceId);
        // Re-read from DB to get enriched data for SSE broadcast
        try {
            const freshCall = await queries.getCallByCallSid(normalized.callSid);
            if (freshCall) enrichedCall = freshCall;
        } catch (e) { /* use original call if re-read fails */ }
    }

    // Publish realtime event (after enrichment so frontend gets correct duration)
    if (!skipUpsert) {
        publishRealtimeEvent('call.updated', enrichedCall || { call_sid: normalized.callSid, status: normalized.eventStatus }, traceId);
    }

    // When a child leg goes in-progress (someone answered), update parent to in-progress
    if (normalized.parentCallSid && normalized.eventStatus === 'in-progress') {
        try {
            const parentCall = await queries.getCallByCallSid(normalized.parentCallSid);
            if (parentCall && parentCall.status === 'ringing') {
                await db.query(
                    `UPDATE calls SET status = 'in-progress', answered_at = $2 WHERE call_sid = $1`,
                    [normalized.parentCallSid, normalized.eventTime]
                );
                const freshParent = await queries.getCallByCallSid(normalized.parentCallSid);
                if (freshParent) {
                    publishRealtimeEvent('call.updated', freshParent, traceId);
                }
                console.log(`[${traceId}] Child answered → parent ${normalized.parentCallSid} → in-progress`);
            }
        } catch (e) {
            console.warn(`[${traceId}] Failed to update parent to in-progress:`, e.message);
        }
    }

    // Reconcile parent call if this is a child leg that reached final status
    if (normalized.parentCallSid && isFinal) {
        await reconcileParentCall(normalized.parentCallSid, traceId);
    }

    // Also reconcile if THIS is the parent call reaching final status
    // For inbound: Twilio marks parent as 'completed' even when no agent answered
    // For outbound: parent call needs child leg data for accurate status/duration
    if (!normalized.parentCallSid && isFinal) {
        await reconcileParentCall(normalized.callSid, traceId);
    }
}

// =============================================================================
// Reconcile parent call from child legs
// When child legs complete, update the parent with the winner's metadata
// =============================================================================

async function reconcileParentCall(parentCallSid, traceId) {
    try {
        // Guard: don't overwrite voicemail statuses
        const parentCheck = await db.query(
            `SELECT status FROM calls WHERE call_sid = $1`, [parentCallSid]
        );
        const parentCurrentStatus = parentCheck.rows[0]?.status;
        if (['voicemail_recording', 'voicemail_left'].includes(parentCurrentStatus)) {
            console.log(`[${traceId}] Skipping reconciliation — parent is ${parentCurrentStatus}`);
            return;
        }

        // Get all child legs for this parent
        const childResult = await db.query(
            `SELECT call_sid, status, duration_sec, started_at, ended_at, is_final, contact_id
             FROM calls WHERE parent_call_sid = $1
             ORDER BY duration_sec DESC NULLS LAST`,
            [parentCallSid]
        );
        const children = childResult.rows;

        if (children.length === 0) return;

        // Check if all children are final
        const allFinal = children.every(c => c.is_final);

        // Determine winner: completed child with longest duration
        const winner = children.find(c =>
            c.status === 'completed' && c.duration_sec && c.duration_sec > 0
        );

        // Get contact_id from winner or first child that has one
        // (for outbound SIP calls where parent may not have contact_id)
        const childContactId = winner?.contact_id || children.find(c => c.contact_id)?.contact_id || null;

        // Determine parent status from children
        let parentStatus;
        let parentIsFinal = false;
        let parentDuration = null;
        let parentAnsweredAt = null;
        let parentEndedAt = null;

        if (winner) {
            parentStatus = 'completed';
            parentIsFinal = true;
            parentDuration = winner.duration_sec;
            parentAnsweredAt = winner.started_at;
            parentEndedAt = winner.ended_at;
        } else if (allFinal) {
            // No winner — determine status from children
            // Priority: busy > no-answer > failed
            // (failed only if ALL children failed; any no-answer means the call rang but wasn't picked up)
            const statuses = children.map(c => c.status);
            if (statuses.includes('busy')) {
                parentStatus = 'busy';
            } else if (statuses.includes('no-answer')) {
                parentStatus = 'no-answer';
            } else {
                parentStatus = 'failed';
            }
            parentIsFinal = true;
            parentEndedAt = children.reduce((latest, c) =>
                c.ended_at && (!latest || new Date(c.ended_at) > new Date(latest)) ? c.ended_at : latest
                , null);
        } else {
            // Some children still active — parent stays in-progress
            parentStatus = 'in-progress';
        }

        // Update parent call with reconciled data + propagate contact_id from child
        await db.query(
            `UPDATE calls SET
                status = $2,
                is_final = $3,
                duration_sec = COALESCE($4, duration_sec),
                answered_at = COALESCE($5, answered_at),
                ended_at = COALESCE($6, ended_at),
                contact_id = COALESCE(calls.contact_id, $7)
             WHERE call_sid = $1`,
            [parentCallSid, parentStatus, parentIsFinal, parentDuration, parentAnsweredAt, parentEndedAt, childContactId]
        );

        console.log(`[${traceId}] Reconciled parent ${parentCallSid}: status=${parentStatus}, winner=${winner?.call_sid || 'none'}`);

        // Publish update for parent so frontend refreshes
        const parentCall = await queries.getCallByCallSid(parentCallSid);
        if (parentCall) {
            publishRealtimeEvent('call.updated', parentCall, traceId);
        }
    } catch (error) {
        console.error(`[${traceId}] Failed to reconcile parent ${parentCallSid}:`, error.message);
    }
}

// =============================================================================
// Recording event → upsert recording
// =============================================================================

async function processRecordingEvent(payload, traceId) {
    const normalized = normalizeRecordingEvent(payload);

    const recording = await queries.upsertRecording({
        recordingSid: normalized.recordingSid,
        callSid: normalized.callSid,
        status: normalized.status,
        recordingUrl: normalized.recordingUrl,
        durationSec: normalized.durationSec,
        channels: normalized.channels,
        track: normalized.track,
        source: normalized.source,
        startedAt: normalized.status === 'in-progress' ? normalized.eventTime : null,
        completedAt: normalized.status === 'completed' ? normalized.eventTime : null,
        rawPayload: payload,
    });

    console.log(`[${traceId}] Recording upserted`, {
        recordingSid: recording.recording_sid,
        status: recording.status
    });

    // Append immutable event
    await queries.appendCallEvent(
        normalized.callSid,
        'recording.updated',
        normalized.eventTime,
        { ...normalized, raw: payload }
    );

    // Publish realtime event
    if (normalized.status === 'completed') {
        publishRealtimeEvent('recording.ready', recording, traceId);

        // Transition voicemail_recording → voicemail_left
        try {
            const call = await queries.getCallByCallSid(normalized.callSid);
            if (call && call.status === 'voicemail_recording') {
                await db.query(
                    `UPDATE calls SET status = 'voicemail_left', is_final = true,
                     duration_sec = COALESCE($2, duration_sec),
                     ended_at = COALESCE($3, ended_at)
                     WHERE call_sid = $1`,
                    [normalized.callSid, normalized.durationSec, normalized.eventTime]
                );
                const updatedCall = await queries.getCallByCallSid(normalized.callSid);
                if (updatedCall) {
                    publishRealtimeEvent('call.updated', updatedCall, traceId);
                }
                console.log(`[${traceId}] Status → voicemail_left for ${normalized.callSid}`);
            }
        } catch (err) {
            console.warn(`[${traceId}] Failed to set voicemail_left:`, err.message);
        }

        // Enqueue post-call transcription
        try {
            await queries.upsertTranscript({
                transcriptionSid: null,
                callSid: normalized.callSid,
                recordingSid: normalized.recordingSid,
                mode: 'post-call',
                status: 'processing',
                languageCode: null,
                confidence: null,
                text: null,
                isFinal: false,
                rawPayload: { enqueued_by: 'recording-status-handler' },
            });

            await db.query(
                `INSERT INTO transcription_jobs(call_sid, recording_sid, status)
                 VALUES ($1, $2, 'queued')
                 ON CONFLICT DO NOTHING`,
                [normalized.callSid, normalized.recordingSid]
            );

            publishRealtimeEvent('transcript.processing', {
                callSid: normalized.callSid,
                recordingSid: normalized.recordingSid,
                status: 'processing',
            }, traceId);

            console.log(`[${traceId}] Transcription job enqueued for ${normalized.callSid}`);
        } catch (err) {
            console.error(`[${traceId}] Failed to enqueue transcription:`, err.message);
        }
    }
}

// =============================================================================
// Transcription event → upsert transcript
// =============================================================================

async function processTranscriptionEvent(payload, traceId) {
    const normalized = normalizeTranscriptionEvent(payload);

    const transcript = await queries.upsertTranscript({
        transcriptionSid: normalized.transcriptionSid,
        callSid: normalized.callSid,
        recordingSid: normalized.recordingSid,
        mode: 'post-call',
        status: normalized.status,
        languageCode: normalized.languageCode,
        confidence: normalized.confidence,
        text: normalized.text,
        isFinal: true,
        rawPayload: payload,
    });

    console.log(`[${traceId}] Transcript upserted`, {
        transcriptionSid: transcript.transcription_sid,
        status: transcript.status
    });

    // Append immutable event
    await queries.appendCallEvent(
        normalized.callSid,
        'transcript.updated',
        normalized.eventTime,
        { ...normalized, raw: payload }
    );

    // Publish realtime event
    if (normalized.status === 'completed') {
        publishRealtimeEvent('transcript.ready', transcript, traceId);
    }
}

// =============================================================================
// Twilio API enrichment on final call status
// =============================================================================

async function enrichFromTwilioApi(callSid, existingCall, traceId) {
    try {
        const twilio = require('twilio');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const details = await client.calls(callSid).fetch();
        const db = require('../db/connection');

        // Direct UPDATE bypassing the timestamp guard in upsertCall
        // The enrichment should always overwrite with authoritative Twilio API data
        await db.query(
            `UPDATE calls SET
                parent_call_sid = COALESCE($2, parent_call_sid),
                direction       = COALESCE(direction, $3),
                status          = COALESCE($4, status),
                is_final        = COALESCE($5, is_final),
                started_at      = COALESCE($6, started_at),
                answered_at     = COALESCE($7, answered_at),
                ended_at        = COALESCE($8, ended_at),
                duration_sec    = COALESCE($9, duration_sec),
                price           = COALESCE($10, price),
                price_unit      = COALESCE($11, price_unit)
             WHERE call_sid = $1`,
            [
                callSid,
                details.parentCallSid || null,
                existingCall?.direction || details.direction,
                details.status || null,
                isFinalStatus(details.status) || false,
                details.startTime ? new Date(details.startTime) : null,
                details.startTime ? new Date(details.startTime) : null,
                details.endTime ? new Date(details.endTime) : null,
                parseInt(details.duration) || null,
                details.price ? parseFloat(details.price) : null,
                details.priceUnit || 'USD',
            ]
        );

        console.log(`[${traceId}] Enriched from Twilio API`, {
            price: details.price,
            duration: details.duration,
            endTime: details.endTime
        });
    } catch (error) {
        console.warn(`[${traceId}] Failed to enrich from Twilio API:`, error.message);
    }
}

// =============================================================================
// Realtime SSE publishing
// =============================================================================

function publishRealtimeEvent(eventType, data, traceId) {
    try {
        const realtimeService = require('./realtimeService');
        realtimeService.publishCallUpdate({ eventType, ...data });
        console.log(`[${traceId}] SSE event: ${eventType}`);
    } catch (error) {
        console.warn(`[${traceId}] SSE publish failed:`, error.message);
    }
}

// =============================================================================
// Worker: claim → process → mark
// =============================================================================

async function claimAndProcessEvents() {
    const events = await queries.claimInboxEvents(CONFIG.BATCH_SIZE);

    if (events.length === 0) return { processed: 0, failed: 0 };

    console.log(`Claimed ${events.length} events`);

    let processed = 0;
    let failed = 0;

    for (const event of events) {
        try {
            await processEvent(event);
            await queries.markInboxProcessed(event.id);
            processed++;
        } catch (error) {
            await queries.markInboxFailed(event.id, error.message);
            failed++;
        }
    }

    return { processed, failed };
}

// =============================================================================
// Worker main loop
// =============================================================================

async function startWorker() {
    console.log('🔄 Inbox worker started (v4 + stale reconciliation)');
    console.log(`   Batch: ${CONFIG.BATCH_SIZE} | Poll: ${CONFIG.POLL_INTERVAL_MS}ms | Retries: ${CONFIG.MAX_RETRIES}`);
    console.log(`   Stale check: every ${CONFIG.STALE_CHECK_INTERVAL_MS / 1000}s`);

    let isRunning = true;
    let lastStaleCheck = 0;
    process.on('SIGTERM', () => { isRunning = false; });
    process.on('SIGINT', () => { isRunning = false; });

    while (isRunning) {
        try {
            const { processed, failed } = await claimAndProcessEvents();
            if (processed > 0 || failed > 0) {
                console.log(`Processed: ${processed}, Failed: ${failed}`);
            }

            // Periodic stale call reconciliation
            const now = Date.now();
            if (now - lastStaleCheck >= CONFIG.STALE_CHECK_INTERVAL_MS) {
                lastStaleCheck = now;
                try {
                    await reconcileStaleCalls();
                } catch (err) {
                    console.error('Stale reconciliation error:', err.message);
                }
            }

            await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
        } catch (error) {
            console.error('Worker loop error:', error);
            await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 5));
        }
    }

    console.log('✅ Worker stopped');
    process.exit(0);
}

module.exports = {
    startWorker,
    processEvent,
    normalizeVoiceEvent,
    normalizeRecordingEvent,
    normalizeTranscriptionEvent,
    reconcileParentCall,
    isFinalStatus,
    CONFIG,
};
