const twilio = require('twilio');
const queries = require('../db/queries');

/**
 * Validate Twilio webhook signature
 */
function validateTwilioSignature(req) {
    const signature = req.headers['x-twilio-signature'];
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!signature || !authToken) {
        console.error('Missing signature or auth token');
        return false;
    }

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
 * Generate event_key for deduplication.
 * Uses I-Twilio-Idempotency-Token if available, else builds a canonical key.
 */
function generateEventKey(source, payload, req) {
    const idempotencyToken = req.headers['i-twilio-idempotency-token'];
    if (idempotencyToken) return idempotencyToken;

    const { CallSid, CallStatus, RecordingSid, RecordingStatus, TranscriptionSid, TranscriptionStatus, Timestamp } = payload;

    switch (source) {
        case 'voice':
            return `voice:${CallSid}:${CallStatus}:${Timestamp || Date.now()}`;
        case 'dial':
            return `dial:${CallSid}:${payload.DialCallStatus}:${Date.now()}`;
        case 'recording':
            return `recording:${RecordingSid}:${RecordingStatus}:${Timestamp || Date.now()}`;
        case 'transcription':
            return `transcription:${TranscriptionSid}:${TranscriptionStatus}:${Date.now()}`;
        default:
            return `${source}:${CallSid}:${Date.now()}`;
    }
}

function generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generic webhook handler that pushes to webhook_inbox
 */
async function ingestToInbox({ source, eventType, payload, req, traceId }) {
    const eventKey = generateEventKey(source, payload, req);
    const eventTime = payload.Timestamp && !isNaN(parseInt(payload.Timestamp))
        ? new Date(parseInt(payload.Timestamp) * 1000)
        : new Date();

    const result = await queries.insertInboxEvent({
        eventKey,
        source,
        eventType,
        eventTime,
        callSid: payload.CallSid || null,
        recordingSid: payload.RecordingSid || null,
        transcriptionSid: payload.TranscriptionSid || null,
        payload,
        headers: {
            'x-twilio-signature': req.headers['x-twilio-signature'],
            'i-twilio-idempotency-token': req.headers['i-twilio-idempotency-token'],
        },
    });

    if (result) {
        console.log(`[${traceId}] Event stored in inbox`, { id: result.id, eventKey });
    } else {
        console.log(`[${traceId}] Duplicate event ignored`, { eventKey });
    }

    return result;
}

// =============================================================================
// POST /webhooks/twilio/voice-status
// =============================================================================
async function handleVoiceStatus(req, res) {
    const traceId = generateTraceId();
    console.log(`[${traceId}] Voice status webhook`, { callSid: req.body.CallSid, status: req.body.CallStatus });

    try {
        if (process.env.NODE_ENV !== 'development' && !validateTwilioSignature(req)) {
            return res.status(403).json({ error: 'Invalid signature' });
        }

        const { CallSid, CallStatus } = req.body;
        if (!CallSid || !CallStatus) {
            return res.status(400).json({ error: 'Missing CallSid or CallStatus' });
        }

        await ingestToInbox({
            source: 'voice',
            eventType: 'call.status_changed',
            payload: req.body,
            req,
            traceId
        });

        res.status(204).send();
    } catch (error) {
        console.error(`[${traceId}] Error:`, error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// =============================================================================
// POST /webhooks/twilio/recording-status
// =============================================================================
async function handleRecordingStatus(req, res) {
    const traceId = generateTraceId();
    console.log(`[${traceId}] Recording status webhook`, { recordingSid: req.body.RecordingSid, status: req.body.RecordingStatus });

    try {
        if (process.env.NODE_ENV !== 'development' && !validateTwilioSignature(req)) {
            return res.status(403).json({ error: 'Invalid signature' });
        }

        const { RecordingSid, CallSid } = req.body;
        if (!RecordingSid || !CallSid) {
            return res.status(400).json({ error: 'Missing RecordingSid or CallSid' });
        }

        await ingestToInbox({
            source: 'recording',
            eventType: 'recording.updated',
            payload: req.body,
            req,
            traceId
        });

        res.status(204).send();
    } catch (error) {
        console.error(`[${traceId}] Error:`, error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// =============================================================================
// POST /webhooks/twilio/transcription-status  (NEW)
// =============================================================================
async function handleTranscriptionStatus(req, res) {
    const traceId = generateTraceId();
    console.log(`[${traceId}] Transcription status webhook`, {
        transcriptionSid: req.body.TranscriptionSid,
        status: req.body.TranscriptionStatus
    });

    try {
        if (process.env.NODE_ENV !== 'development' && !validateTwilioSignature(req)) {
            return res.status(403).json({ error: 'Invalid signature' });
        }

        const { TranscriptionSid, TranscriptionStatus } = req.body;
        if (!TranscriptionSid || !TranscriptionStatus) {
            return res.status(400).json({ error: 'Missing TranscriptionSid or TranscriptionStatus' });
        }

        await ingestToInbox({
            source: 'transcription',
            eventType: 'transcript.updated',
            payload: req.body,
            req,
            traceId
        });

        res.status(204).send();
    } catch (error) {
        console.error(`[${traceId}] Error:`, error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// =============================================================================
// POST /webhooks/twilio/voice-inbound (TwiML response)
// =============================================================================
async function handleVoiceInbound(req, res) {
    const traceId = generateTraceId();
    console.log(`[${traceId}] Voice inbound - NEW CALL`, {
        callSid: req.body.CallSid, from: req.body.From, to: req.body.To
    });

    try {
        if (process.env.NODE_ENV !== 'development' && !validateTwilioSignature(req)) {
            return res.status(403).send('<Response><Reject/></Response>');
        }

        const { CallSid, From, To } = req.body;
        if (!CallSid) {
            return res.status(400).send('<Response><Reject/></Response>');
        }

        // Store initial call in inbox
        await ingestToInbox({
            source: 'voice',
            eventType: 'call.inbound',
            payload: req.body,
            req,
            traceId
        });

        // Determine direction and return TwiML
        const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://abc-metrics.fly.dev';
        const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;
        const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;
        const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;

        const isOutbound = From && From.startsWith('sip:');
        let twiml;

        if (isOutbound) {
            let dialNumber = To;
            if (To && To.startsWith('sip:')) {
                const match = To.match(/^sip:(\+?\d+)@/);
                if (match) {
                    dialNumber = match[1].startsWith('+') ? match[1] : `+1${match[1]}`;
                }
            }
            console.log(`[${traceId}] Outbound: SIP → ${dialNumber}`);

            const outboundCallerId = process.env.OUTBOUND_CALLER_ID || '+16175006181';
            const outboundTimeout = Number(process.env.DIAL_TIMEOUT || 25);
            twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="${outboundTimeout}"
          answerOnBridge="true"
          callerId="${outboundCallerId}"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
        <Number statusCallback="${statusCallbackUrl}"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">${dialNumber}</Number>
    </Dial>
</Response>`;
        } else {
            console.log(`[${traceId}] Inbound: ${From} → SIP`);
            const sipDomain = process.env.SIP_DOMAIN || 'abchomes.sip.us1.twilio.com';
            // Support multiple SIP users (ring all simultaneously)
            const sipUsers = (process.env.SIP_USERS || process.env.SIP_USER || 'dispatcher').split(',').map(u => u.trim());
            const sipEndpoints = sipUsers.map(user =>
                `        <Sip statusCallback="${statusCallbackUrl}"
             statusCallbackEvent="initiated ringing answered completed"
             statusCallbackMethod="POST">sip:${user}@${sipDomain}</Sip>`
            ).join('\n');

            const inboundTimeout = Number(process.env.DIAL_TIMEOUT || 25);
            twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="${inboundTimeout}"
          answerOnBridge="true"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
${sipEndpoints}
    </Dial>
</Response>`;
        }

        res.type('text/xml');
        res.send(twiml);
    } catch (error) {
        console.error(`[${traceId}] Error:`, error);
        res.status(500).send('<Response><Reject/></Response>');
    }
}

// =============================================================================
// POST /webhooks/twilio/voice-dial-action
// Voicemail logic: if no one answered, play greeting + record voicemail
// =============================================================================
async function handleDialAction(req, res) {
    const traceId = generateTraceId();
    const dialStatus = String(req.body.DialCallStatus || '').toLowerCase();
    console.log(`[${traceId}] Dial action`, {
        callSid: req.body.CallSid, dialStatus, from: req.body.From
    });

    try {
        if (process.env.NODE_ENV !== 'development' && !validateTwilioSignature(req)) {
            return res.status(403).send('<Response></Response>');
        }

        const { CallSid } = req.body;
        if (!CallSid) {
            return res.status(400).send('<Response></Response>');
        }

        await ingestToInbox({
            source: 'dial',
            eventType: 'dial.action',
            payload: req.body,
            req,
            traceId
        });

        const toVoicemail = ['no-answer', 'busy'].includes(dialStatus);

        let twiml;
        if (toVoicemail) {
            const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://abc-metrics.fly.dev';
            const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;
            const vmLanguage = process.env.VM_LANGUAGE || 'en-US';
            const vmGreeting = process.env.VM_GREETING || 'All managers are currently busy. We will call you back. Please leave a voice message after the beep.';
            const vmMaxLen = Number(process.env.VM_MAXLEN || 180);
            const vmSilenceTimeout = Number(process.env.VM_SILENCE_TIMEOUT || 5);
            const vmFinishOnKey = process.env.VM_FINISH_ON_KEY || '#';

            console.log(`[${traceId}] No answer (${dialStatus}) → voicemail`);

            twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say language="${vmLanguage}">${vmGreeting}</Say>
    <Record maxLength="${vmMaxLen}"
            timeout="${vmSilenceTimeout}"
            finishOnKey="${vmFinishOnKey}"
            playBeep="true"
            transcribe="false"
            recordingStatusCallback="${recordingStatusUrl}"
            recordingStatusCallbackMethod="POST" />
    <Hangup />
</Response>`;

            // Set call status to voicemail_recording so UI shows "Leaving voicemail"
            try {
                const db = require('../db/connection');
                await db.query(
                    `UPDATE calls SET status = 'voicemail_recording', is_final = false WHERE call_sid = $1`,
                    [CallSid]
                );
                // Broadcast SSE so frontend updates immediately
                const realtimeService = require('../services/realtimeService');
                const freshCall = await queries.getCallByCallSid(CallSid);
                if (freshCall) {
                    realtimeService.publishCallUpdate({ eventType: 'call.updated', ...freshCall });
                }
                console.log(`[${traceId}] Status → voicemail_recording`);
            } catch (vmErr) {
                console.warn(`[${traceId}] Failed to set voicemail_recording:`, vmErr.message);
            }
        } else {
            console.log(`[${traceId}] Call completed (${dialStatus}) → hangup`);
            twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup />
</Response>`;
        }

        res.type('text/xml');
        res.send(twiml);
    } catch (error) {
        console.error(`[${traceId}] Error:`, error);
        res.status(500).send('<Response><Hangup /></Response>');
    }
}

// =============================================================================
// POST /webhooks/twilio/voice-fallback
// Emergency fallback when voice-inbound fails (500/timeout)
// =============================================================================
async function handleVoiceFallback(req, res) {
    const traceId = generateTraceId();
    console.error(`[${traceId}] ⚠️ VOICE FALLBACK triggered`, {
        callSid: req.body.CallSid,
        from: req.body.From,
        to: req.body.To,
        errorCode: req.body.ErrorCode,
        errorUrl: req.body.ErrorUrl
    });

    try {
        // Store fallback event in inbox for monitoring
        await ingestToInbox({
            source: 'voice',
            eventType: 'call.fallback',
            payload: req.body,
            req,
            traceId
        });
    } catch (e) {
        console.error(`[${traceId}] Fallback inbox error:`, e.message);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say language="en-US">We are experiencing technical difficulties. Please try again later.</Say>
    <Say language="ru-RU">В данный момент наблюдаются технические проблемы. Пожалуйста, перезвоните позже.</Say>
    <Hangup />
</Response>`;

    res.type('text/xml');
    res.send(twiml);
}

module.exports = {
    handleVoiceStatus,
    handleRecordingStatus,
    handleTranscriptionStatus,
    handleVoiceInbound,
    handleDialAction,
    handleVoiceFallback,
    validateTwilioSignature
};
