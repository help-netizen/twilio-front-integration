const twilio = require('twilio');
const db = require('../db/connection');

/**
 * Validate Twilio webhook signature
 * @param {Object} req - Express request object
 * @returns {boolean} - True if signature is valid
 */
function validateTwilioSignature(req) {
    const signature = req.headers['x-twilio-signature'];
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!signature || !authToken) {
        console.error('Missing signature or auth token');
        return false;
    }

    // Construct full URL
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const url = `${protocol}://${host}${req.originalUrl}`;

    try {
        return twilio.validateRequest(authToken, signature, url, req.body);
    } catch (error) {
        console.error('Signature validation error:', error);
        return false;
    }
}

/**
 * Generate dedupe key for webhook event
 * @param {Object} payload - Twilio webhook payload
 * @returns {string} - Unique dedupe key
 */
function generateDedupeKey(payload) {
    const { CallSid, CallStatus, Timestamp } = payload;
    return `call:${CallSid}:${CallStatus}:${Timestamp}`;
}

/**
 * Generate unique trace ID for request tracking
 * @returns {string} - Trace ID
 */
function generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Handle Twilio voice status webhook
 * POST /webhooks/twilio/voice-status
 */
async function handleVoiceStatus(req, res) {
    const traceId = generateTraceId();
    const startTime = Date.now();

    console.log(`[${traceId}] Voice status webhook received`, {
        callSid: req.body.CallSid,
        status: req.body.CallStatus
    });

    try {
        // 1. Validate X-Twilio-Signature
        if (!validateTwilioSignature(req)) {
            console.warn(`[${traceId}] Invalid Twilio signature`);
            return res.status(403).json({ error: 'Invalid signature' });
        }

        // 2. Extract payload
        const payload = req.body;
        const { CallSid, CallStatus, Timestamp } = payload;

        if (!CallSid || !CallStatus) {
            console.error(`[${traceId}] Missing required fields`, { payload });
            return res.status(400).json({ error: 'Missing CallSid or CallStatus' });
        }

        // 3. Generate dedupe key
        const dedupeKey = generateDedupeKey(payload);

        // 4. Insert into inbox (idempotent - ON CONFLICT DO NOTHING)
        const result = await db.query(`
            INSERT INTO twilio_webhook_inbox 
                (source, event_type, call_sid, dedupe_key, payload)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (dedupe_key) DO NOTHING
            RETURNING id
        `, ['twilio_voice', 'call-status', CallSid, dedupeKey, payload]);

        const elapsed = Date.now() - startTime;

        if (result.rows.length > 0) {
            console.log(`[${traceId}] Event stored in inbox`, {
                inboxId: result.rows[0].id,
                callSid: CallSid,
                status: CallStatus,
                elapsed: `${elapsed}ms`
            });
        } else {
            console.log(`[${traceId}] Duplicate event ignored`, {
                callSid: CallSid,
                status: CallStatus,
                dedupeKey,
                elapsed: `${elapsed}ms`
            });
        }

        // 5. Return 200 quickly
        res.status(200).send('OK');

    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.error(`[${traceId}] Error processing voice status webhook`, {
            error: error.message,
            stack: error.stack,
            elapsed: `${elapsed}ms`
        });
        res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * Handle Twilio recording status webhook
 * POST /webhooks/twilio/recording-status
 */
async function handleRecordingStatus(req, res) {
    const traceId = generateTraceId();
    const startTime = Date.now();

    console.log(`[${traceId}] Recording status webhook received`, {
        recordingSid: req.body.RecordingSid,
        status: req.body.RecordingStatus
    });

    try {
        // 1. Validate X-Twilio-Signature
        if (!validateTwilioSignature(req)) {
            console.warn(`[${traceId}] Invalid Twilio signature`);
            return res.status(403).json({ error: 'Invalid signature' });
        }

        // 2. Extract payload
        const payload = req.body;
        const { RecordingSid, CallSid, RecordingStatus, Timestamp } = payload;

        if (!RecordingSid || !CallSid) {
            console.error(`[${traceId}] Missing required fields`, { payload });
            return res.status(400).json({ error: 'Missing RecordingSid or CallSid' });
        }

        // 3. Generate dedupe key
        const dedupeKey = `recording:${RecordingSid}:${RecordingStatus}:${Timestamp}`;

        // 4. Insert into inbox (idempotent)
        const result = await db.query(`
            INSERT INTO twilio_webhook_inbox 
                (source, event_type, call_sid, recording_sid, dedupe_key, payload)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (dedupe_key) DO NOTHING
            RETURNING id
        `, ['twilio_recording', 'recording-status', CallSid, RecordingSid, dedupeKey, payload]);

        const elapsed = Date.now() - startTime;

        if (result.rows.length > 0) {
            console.log(`[${traceId}] Recording event stored in inbox`, {
                inboxId: result.rows[0].id,
                recordingSid: RecordingSid,
                callSid: CallSid,
                status: RecordingStatus,
                elapsed: `${elapsed}ms`
            });
        } else {
            console.log(`[${traceId}] Duplicate recording event ignored`, {
                recordingSid: RecordingSid,
                dedupeKey,
                elapsed: `${elapsed}ms`
            });
        }

        // 5. Return 200 quickly
        res.status(200).send('OK');

    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.error(`[${traceId}] Error processing recording status webhook`, {
            error: error.message,
            stack: error.stack,
            elapsed: `${elapsed}ms`
        });
        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = {
    handleVoiceStatus,
    handleRecordingStatus,
    validateTwilioSignature
};
