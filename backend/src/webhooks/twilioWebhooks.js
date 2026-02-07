const twilio = require('twilio');
const db = require('../db/connection');

// Import TwiML generator for voice-inbound response
const twimlRouter = require('../routes/twiml');

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
        // 1. Validate X-Twilio-Signature (skip in development for testing)
        if (process.env.NODE_ENV !== 'development' && !validateTwilioSignature(req)) {
            console.warn(`[${traceId}] Invalid Twilio signature`);
            return res.status(403).json({ error: 'Invalid signature' });
        }

        if (process.env.NODE_ENV === 'development') {
            console.log(`[${traceId}] ⚠️  DEV MODE: Skipping signature validation`);
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

/**
 * Handle Twilio Voice URL webhook (new incoming/outgoing call)
 * POST /webhooks/twilio/voice-inbound
 * 
 * This is called when a NEW call arrives, BEFORE Tw iML is returned.
 * Handles BOTH directions:
 * - INBOUND: PSTN → Twilio → SIP (Bria)
 * - OUTBOUND: SIP (Bria) → Twilio → PSTN
 */
async function handleVoiceInbound(req, res) {
    const traceId = generateTraceId();
    const startTime = Date.now();

    console.log(`[${traceId}] Voice inbound webhook - NEW CALL`, {
        callSid: req.body.CallSid,
        from: req.body.From,
        to: req.body.To,
        callStatus: req.body.CallStatus,
        direction: req.body.Direction
    });

    try {
        // 1. Validate signature (skip in dev)
        if (process.env.NODE_ENV !== 'development' && !validateTwilioSignature(req)) {
            console.warn(`[${traceId}] Invalid Twilio signature`);
            return res.status(403).send('<Response><Reject/></Response>');
        }

        // 2. Extract payload
        const { CallSid, From, To, CallStatus, Direction } = req.body;

        if (!CallSid) {
            console.error(`[${traceId}] Missing CallSid`);
            return res.status(400).send('<Response><Reject/></Response>');
        }

        // 3. Store initial call notification in inbox
        const dedupeKey = `call-inbound:${CallSid}:${Date.now()}`;
        await db.query(`
            INSERT INTO twilio_webhook_inbox 
                (source, event_type, call_sid, dedupe_key, payload)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (dedupe_key) DO NOTHING
        `, ['twilio_voice', 'call-inbound', CallSid, dedupeKey, req.body]);

        // 4. Determine call direction and generate appropriate TwiML
        const ngrokUrl = process.env.NGROK_URL || 'https://hyperrational-nonregressively-julissa.ngrok-free.dev';
        const statusCallbackUrl = `${ngrokUrl}/webhooks/twilio/voice-status`;
        const dialActionUrl = `${ngrokUrl}/webhooks/twilio/dial-action`;

        let twiml;

        // Check if this is an OUTBOUND call (from SIP to phone number)
        const isOutbound = From && From.startsWith('sip:');

        if (isOutbound) {
            // OUTBOUND: SIP → PSTN
            // Extract phone number from SIP URI
            // To arrives as: sip:5085140320@abchomes.sip.us1.twilio.com:5061;user=phone
            // Need to extract just the number part and add +1
            let dialNumber = To;
            if (To && To.startsWith('sip:')) {
                const match = To.match(/^sip:(\+?\d+)@/);
                if (match) {
                    dialNumber = match[1].startsWith('+') ? match[1] : `+1${match[1]}`;
                }
            }

            console.log(`[${traceId}] Outbound call: SIP → ${dialNumber} (raw To: ${To})`);

            twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="30"
          callerId="+16175006181"
          action="${dialActionUrl}"
          method="POST">
        <Number statusCallback="${statusCallbackUrl}"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">${dialNumber}</Number>
    </Dial>
</Response>`;
        } else {
            // INBOUND: PSTN → SIP
            // Dial to SIP endpoint (dispatcher)
            console.log(`[${traceId}] Inbound call detected: ${From} → SIP`);

            const sipUser = process.env.SIP_USER || 'dispatcher';
            const sipDomain = process.env.SIP_DOMAIN || 'abchomes.sip.us1.twilio.com';
            const sipEndpoint = `sip:${sipUser}@${sipDomain}`;

            twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="30"
          action="${dialActionUrl}"
          method="POST">
        <Sip statusCallback="${statusCallbackUrl}"
             statusCallbackEvent="initiated ringing answered completed"
             statusCallbackMethod="POST">${sipEndpoint}</Sip>
    </Dial>
</Response>`;
        }

        console.log(`[${traceId}] Returning TwiML for ${isOutbound ? 'outbound' : 'inbound'} call`);

        res.type('text/xml');
        res.send(twiml);

    } catch (error) {
        console.error(`[${traceId}] Error handling voice inbound:`, error);
        res.status(500).send('<Response><Reject/></Response>');
    }
}

/**
 * Handle Dial action callback (final Dial result)
 * POST /webhooks/twilio/dial-action
 * 
 * This is called AFTER <Dial> completes with final DialCallStatus
 */
async function handleDialAction(req, res) {
    const traceId = generateTraceId();
    const startTime = Date.now();

    console.log(`[${traceId}] Dial action webhook - DIAL COMPLETE`, {
        callSid: req.body.CallSid,
        dialCallStatus: req.body.DialCallStatus,
        dialCallDuration: req.body.DialCallDuration
    });

    try {
        // 1. Validate signature (skip in dev)
        if (process.env.NODE_ENV !== 'development' && !validateTwilioSignature(req)) {
            console.warn(`[${traceId}] Invalid Twilio signature`);
            return res.status(403).send('<Response></Response>');
        }

        // 2. Extract payload
        const { CallSid, DialCallStatus, DialCallDuration } = req.body;

        if (!CallSid) {
            console.error(`[${traceId}] Missing CallSid`);
            return res.status(400).send('<Response></Response>');
        }

        // 3. Store dial action result in inbox
        const dedupeKey = `dial-action:${CallSid}:${Date.now()}`;
        await db.query(`
            INSERT INTO twilio_webhook_inbox 
                (source, event_type, call_sid, dedupe_key, payload)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (dedupe_key) DO NOTHING
        `, ['twilio_voice', 'dial-action', CallSid, dedupeKey, req.body]);

        console.log(`[${traceId}] Dial action stored`, {
            dialCallStatus: DialCallStatus,
            duration: DialCallDuration
        });

        // 4. Return empty TwiML (call already ended)
        res.type('text/xml');
        res.send('<Response></Response>');

    } catch (error) {
        console.error(`[${traceId}] Error handling dial action:`, error);
        res.status(500).send('<Response></Response>');
    }
}

module.exports = {
    handleVoiceStatus,
    handleRecordingStatus,
    handleVoiceInbound,
    handleDialAction,
    validateTwilioSignature
};
