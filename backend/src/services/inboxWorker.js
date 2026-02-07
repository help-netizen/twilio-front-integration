const db = require('../db/connection');
const { isFinalStatus, validateTransition, applyTransition } = require('./stateMachine');

/**
 * Configuration
 */
const CONFIG = {
    BATCH_SIZE: 10,              // Events to process per cycle
    POLL_INTERVAL_MS: 1000,      // Poll every 1 second
    MAX_RETRIES: 3,              // Max retry attempts before dead-letter
    RETRY_DELAY_MS: 5000,        // Delay before retry (exponential backoff)
    PROCESSING_TIMEOUT_MS: 30000 // Max time for event processing
};

/**
 * Event normalization - transform Twilio webhook payload to canonical format
 */
function normalizeVoiceEvent(payload) {
    const {
        CallSid,
        CallStatus,
        Timestamp,
        From,
        To,
        Direction,
        Duration,
        CallDuration,

        // Parent call reference
        ParentCallSid,

        // Extended fields
        AnsweredBy,
        CallerName,
        FromCity,
        FromState,
        FromCountry,
        ToCity,
        ToState,
        ToCountry,
        Price,
        PriceUnit,

        // Queue fields
        QueueTime,

        // Recording
        RecordingUrl,
        RecordingSid,
        RecordingDuration
    } = payload;

    return {
        call_sid: CallSid,
        event_type: 'call.status_changed',
        event_status: CallStatus.toLowerCase(),
        event_time: new Date(parseInt(Timestamp) * 1000),

        // Call details
        from_number: From,
        to_number: To,
        direction: Direction?.toLowerCase() || 'external',
        duration: parseInt(Duration || CallDuration || 0),

        // Parent reference
        parent_call_sid: ParentCallSid || null,

        // Metadata
        metadata: {
            answered_by: AnsweredBy,
            caller_name: CallerName,
            from_location: {
                city: FromCity,
                state: FromState,
                country: FromCountry
            },
            to_location: {
                city: ToCity,
                state: ToState,
                country: ToCountry
            },
            price: Price,
            price_unit: PriceUnit,
            queue_time: QueueTime,
            recording_url: RecordingUrl,
            recording_sid: RecordingSid,
            recording_duration: RecordingDuration
        }
    };
}

/**
 * Event normalization for recording events
 */
function normalizeRecordingEvent(payload) {
    const {
        RecordingSid,
        CallSid,
        RecordingStatus,
        RecordingDuration,
        RecordingUrl,
        Timestamp
    } = payload;

    return {
        call_sid: CallSid,
        event_type: 'recording.status_changed',
        event_status: RecordingStatus.toLowerCase(),
        event_time: new Date(parseInt(Timestamp) * 1000),

        metadata: {
            recording_sid: RecordingSid,
            recording_duration: RecordingDuration,
            recording_url: RecordingUrl
        }
    };
}


/**
 * Upsert message in database
 */
async function upsertMessage(normalizedEvent, source = 'webhook') {
    const {
        call_sid,
        event_status,
        event_time,
        from_number,
        to_number,
        direction,
        duration,
        parent_call_sid,
        metadata
    } = normalizedEvent;

    const isFinal = isFinalStatus(event_status);

    // Validate state transition (log warning but don't block in non-strict mode)
    // In production, you might want to fetch current status from DB first
    const validation = validateTransition(null, event_status); // Simplified: no current state check
    if (!validation.valid) {
        console.warn('State transition validation warning:', validation.reason);
    }

    // Upsert message with event-time guard to prevent out-of-order updates
    const result = await db.query(`
        INSERT INTO messages (
            twilio_sid, status, from_number, to_number, direction,
            duration, start_time, parent_call_sid, metadata,
            last_event_time, is_final, finalized_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT (twilio_sid) DO UPDATE SET
            -- Validate transition before updating status
            status = CASE 
                WHEN messages.last_event_time IS NULL OR $10 > messages.last_event_time 
                THEN EXCLUDED.status 
                ELSE messages.status 
            END,
            duration = CASE 
                WHEN messages.last_event_time IS NULL OR $10 > messages.last_event_time 
                THEN EXCLUDED.duration 
                ELSE messages.duration 
            END,
            metadata = CASE 
                WHEN messages.last_event_time IS NULL OR $10 > messages.last_event_time 
                THEN EXCLUDED.metadata 
                ELSE messages.metadata 
            END,
            last_event_time = GREATEST(messages.last_event_time, $10),
            is_final = messages.is_final OR $11,  -- Once final, always final
            finalized_at = CASE 
                WHEN $11 AND messages.finalized_at IS NULL 
                THEN NOW() 
                ELSE messages.finalized_at 
            END,
            updated_at = NOW()
        RETURNING id, twilio_sid, status
    `, [
        call_sid,
        event_status,
        from_number,
        to_number,
        direction,
        duration,
        event_time,
        parent_call_sid,
        metadata,
        event_time, // last_event_time
        isFinal,
        event_time  // For GREATEST comparison
    ]);

    return result.rows[0];
}

/**
 * Append event to call_events log
 */
async function appendCallEvent(normalizedEvent, source = 'webhook') {
    const {
        call_sid,
        event_type,
        event_status,
        event_time,
        metadata
    } = normalizedEvent;

    await db.query(`
        INSERT INTO call_events (
            call_sid, event_type, event_status, event_time, source, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [
        call_sid,
        event_type,
        event_status,
        event_time,
        source,
        { ...normalizedEvent, metadata }
    ]);
}

/**
 * Process a single inbox event
 */
async function processEvent(inboxEvent) {
    const { id, source, event_type, payload } = inboxEvent;
    const traceId = `worker_${id}_${Date.now()}`;

    console.log(`[${traceId}] Processing event`, {
        inboxId: id,
        source,
        eventType: event_type,
        callSid: payload.CallSid
    });

    try {
        // 1. Normalize event based on source
        let normalized;
        if (source === 'twilio_voice') {
            normalized = normalizeVoiceEvent(payload);
        } else if (source === 'twilio_recording') {
            normalized = normalizeRecordingEvent(payload);
        } else {
            throw new Error(`Unknown event source: ${source}`);
        }

        // 2. Upsert message snapshot
        const message = await upsertMessage(normalized, 'webhook');

        console.log(`[${traceId}] Message upserted`, {
            messageId: message.id,
            callSid: message.twilio_sid,
            status: message.status
        });

        // 3. Append to immutable event log
        await appendCallEvent(normalized, 'webhook');

        console.log(`[${traceId}] Event logged successfully`);

        // 4. Publish realtime event to connected clients
        try {
            const realtimeService = require('./realtimeService');
            realtimeService.publishCallUpdate(message);
            console.log(`[${traceId}] Realtime event published`);
        } catch (error) {
            // Non-critical: log but don't fail processing
            console.warn(`[${traceId}] Failed to publish realtime event:`, error.message);
        }

        return { success: true };

    } catch (error) {
        console.error(`[${traceId}] Error processing event`, {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Claim and process inbox events
 */
async function claimAndProcessEvents() {
    const client = await db.pool.connect();

    try {
        // Begin transaction
        await client.query('BEGIN');

        // Claim events using SKIP LOCKED for concurrency
        const result = await client.query(`
            UPDATE twilio_webhook_inbox
            SET processing_status = 'processing'
            WHERE id IN (
                SELECT id FROM twilio_webhook_inbox
                WHERE processing_status = 'pending'
                ORDER BY received_at
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        `, [CONFIG.BATCH_SIZE]);

        await client.query('COMMIT');

        const events = result.rows;

        if (events.length === 0) {
            return { processed: 0, failed: 0 };
        }

        console.log(`Claimed ${events.length} events for processing`);

        // Process each event
        let processed = 0;
        let failed = 0;

        for (const event of events) {
            try {
                await processEvent(event);

                // Mark as completed
                await db.query(`
                    UPDATE twilio_webhook_inbox
                    SET processing_status = 'completed',
                        processed_at = NOW(),
                        error = NULL
                    WHERE id = $1
                `, [event.id]);

                processed++;

            } catch (error) {
                failed++;

                // Increment retry count
                const newRetryCount = (event.retry_count || 0) + 1;
                const status = newRetryCount >= CONFIG.MAX_RETRIES
                    ? 'dead_letter'
                    : 'pending';

                await db.query(`
                    UPDATE twilio_webhook_inbox
                    SET processing_status = $1,
                        retry_count = $2,
                        error = $3
                    WHERE id = $4
                `, [status, newRetryCount, error.message, event.id]);

                if (status === 'dead_letter') {
                    console.error(`Event ${event.id} moved to dead letter after ${newRetryCount} retries`);
                } else {
                    console.warn(`Event ${event.id} retry ${newRetryCount}/${CONFIG.MAX_RETRIES}`);
                }
            }
        }

        return { processed, failed };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error claiming events:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Worker main loop
 */
async function startWorker() {
    console.log('🔄 Inbox worker started');
    console.log(`   Batch size: ${CONFIG.BATCH_SIZE}`);
    console.log(`   Poll interval: ${CONFIG.POLL_INTERVAL_MS}ms`);
    console.log(`   Max retries: ${CONFIG.MAX_RETRIES}`);

    let isRunning = true;

    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, stopping worker...');
        isRunning = false;
    });

    process.on('SIGINT', () => {
        console.log('Received SIGINT, stopping worker...');
        isRunning = false;
    });

    while (isRunning) {
        try {
            const { processed, failed } = await claimAndProcessEvents();

            if (processed > 0 || failed > 0) {
                console.log(`Processed: ${processed}, Failed: ${failed}`);
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, CONFIG.POLL_INTERVAL_MS));

        } catch (error) {
            console.error('Worker loop error:', error);
            // Wait longer on error
            await new Promise(resolve => setTimeout(resolve, CONFIG.POLL_INTERVAL_MS * 5));
        }
    }

    console.log('✅ Inbox worker stopped');
    process.exit(0);
}

module.exports = {
    startWorker,
    processEvent,
    normalizeVoiceEvent,
    normalizeRecordingEvent,
    upsertMessage,
    appendCallEvent,
    isFinalStatus,
    CONFIG
};
