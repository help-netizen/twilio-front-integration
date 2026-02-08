const queries = require('../db/queries');
const db = require('../db/connection');
const { isFinalStatus } = require('./stateMachine');
const CallProcessor = require('./callProcessor');

/**
 * Configuration
 */
const CONFIG = {
    BATCH_SIZE: 10,
    POLL_INTERVAL_MS: 1000,
    MAX_RETRIES: 10,
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

    // Upsert call snapshot
    const call = await queries.upsertCall({
        callSid: normalized.callSid,
        parentCallSid: normalized.parentCallSid,
        contactId,
        direction: processed.direction,   // Use CallProcessor's direction
        fromNumber: normalized.fromNumber,
        toNumber: normalized.toNumber,
        status: normalized.eventStatus,
        isFinal,
        startedAt: normalized.eventTime,
        answeredAt: normalized.eventStatus === 'in-progress' ? normalized.eventTime : null,
        endedAt: isFinal ? normalized.eventTime : null,
        durationSec: normalized.durationSec || null,
        price: normalized.price,
        priceUnit: normalized.priceUnit,
        lastEventTime: normalized.eventTime,
        rawLastPayload: payload,
    });

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

    // Enrich from Twilio API on final status
    if (isFinal) {
        await enrichFromTwilioApi(normalized.callSid, call, traceId);
    }

    // Publish realtime event
    publishRealtimeEvent('call.updated', call || { call_sid: normalized.callSid, status: normalized.eventStatus }, traceId);
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

        // Variant B: enqueue post-call transcription
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

        // Update call with enriched data
        await queries.upsertCall({
            callSid,
            parentCallSid: details.parentCallSid || null,
            contactId: existingCall?.contact_id || null,
            direction: existingCall?.direction || details.direction,
            fromNumber: details.from,
            toNumber: details.to,
            status: existingCall?.status || details.status,
            isFinal: true,
            startedAt: details.startTime ? new Date(details.startTime) : null,
            answeredAt: details.startTime ? new Date(details.startTime) : null,
            endedAt: details.endTime ? new Date(details.endTime) : null,
            durationSec: parseInt(details.duration) || null,
            price: details.price ? parseFloat(details.price) : null,
            priceUnit: details.priceUnit || 'USD',
            lastEventTime: details.dateUpdated ? new Date(details.dateUpdated) : new Date(),
            rawLastPayload: existingCall?.raw_last_payload || {},
        });

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
    console.log('🔄 Inbox worker started (v3)');
    console.log(`   Batch: ${CONFIG.BATCH_SIZE} | Poll: ${CONFIG.POLL_INTERVAL_MS}ms | Retries: ${CONFIG.MAX_RETRIES}`);

    let isRunning = true;
    process.on('SIGTERM', () => { isRunning = false; });
    process.on('SIGINT', () => { isRunning = false; });

    while (isRunning) {
        try {
            const { processed, failed } = await claimAndProcessEvents();
            if (processed > 0 || failed > 0) {
                console.log(`Processed: ${processed}, Failed: ${failed}`);
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
    isFinalStatus,
    CONFIG,
};
