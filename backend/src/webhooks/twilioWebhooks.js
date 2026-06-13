const twilio = require('twilio');
const queries = require('../db/queries');
const groupRouting = require('../services/groupRouting');
const callFlowRuntime = require('../services/callFlowRuntime');

/**
 * Validate Twilio webhook signature
 */
async function validateTwilioSignature(req) {
    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
        console.error('Missing Twilio signature');
        return false;
    }

    // ALB-107: webhooks may come from a tenant SUBACCOUNT — each is signed
    // with its own auth token, resolved by the AccountSid in the payload.
    let authToken = process.env.TWILIO_AUTH_TOKEN;
    const accountSid = req.body?.AccountSid;
    if (accountSid && accountSid !== process.env.TWILIO_ACCOUNT_SID) {
        try {
            const telephonyTenantService = require('../services/telephonyTenantService');
            const subToken = await telephonyTenantService.getAuthTokenForAccountSid(accountSid);
            if (subToken) authToken = subToken;
        } catch (err) {
            console.error('Subaccount token lookup failed:', err.message);
        }
    }
    if (!authToken) return false;

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

function buildHangupTwiml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup />
</Response>`;
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
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
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
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
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
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
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
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
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
        const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://api.albusto.com';
        const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;
        const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;
        const voicemailCompleteUrl = `${baseUrl}/webhooks/twilio/voicemail-complete`;

        const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;

        // Realtime transcription: build <Start><Stream> block if enabled
        const realtimeEnabled = process.env.FEATURE_REALTIME_TRANSCRIPTION === 'true';
        const mediaStreamUrl = baseUrl.replace(/^http/, 'ws') + '/ws/twilio-media';

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
            const outboundStreamXml = realtimeEnabled ? `
    <Start>
        <Stream name="realtime-transcript" url="${mediaStreamUrl}" track="both_tracks">
            <Parameter name="callSid" value="${CallSid}" />
            <Parameter name="direction" value="outbound" />
        </Stream>
    </Start>` : '';

            twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>${outboundStreamXml}
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
            const resolvedGroup = await groupRouting.resolveGroupForNumber(To);
            if (resolvedGroup) {
                console.log(`[${traceId}] F017 inbound: ${From} → group ${resolvedGroup.group.name} (${resolvedGroup.group.id})`);
                twiml = await callFlowRuntime.startExecution({
                    callSid: CallSid,
                    fromNumber: From,
                    toNumber: To,
                    group: resolvedGroup.group,
                    flow: resolvedGroup.flow,
                    baseUrl,
                    traceId,
                });
            } else {
                console.log(`[${traceId}] F017 inbound: ${To} has no assigned group → voicemail`);
                twiml = callFlowRuntime.buildVoicemailTwiml({ baseUrl });
            }
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
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
            return res.status(403).send('<Response></Response>');
        }

        const { CallSid } = req.body;
        if (!CallSid) {
            return res.status(400).send('<Response></Response>');
        }

        // Defensive no-loop guard for already-issued TwiML that had <Record>
        // without an action URL. Twilio posts Record completion back to the
        // current URL; without this branch we would generate another voicemail
        // prompt and create repeated 5-second recordings for the same call.
        const isRecordActionCallback = !req.body.DialCallStatus &&
            (req.body.RecordingSid || req.body.RecordingUrl || req.body.RecordingDuration);
        if (isRecordActionCallback) {
            console.log(`[${traceId}] Voicemail Record action callback on dial-action → hangup`, {
                callSid: CallSid,
                recordingSid: req.body.RecordingSid,
            });
            res.type('text/xml');
            return res.send(buildHangupTwiml());
        }

        // Enqueue dial event for async processing by inboxWorker (single-writer architecture).
        // All DB writes (child finalization, parent status, SSE) are handled by processDialEvent
        // in inboxWorker to eliminate race conditions with voice-status event processing.
        // Non-blocking: DB failure must not prevent TwiML response (causes Twilio 31005 error).
        try {
            await ingestToInbox({
                source: 'dial',
                eventType: 'dial.action',
                payload: req.body,
                req,
                traceId
            });
        } catch (ingestErr) {
            console.error(`[${traceId}] Inbox ingestion failed (non-blocking):`, ingestErr.message);
        }

        const execution = await callFlowRuntime.getExecution(CallSid);
        if (execution && execution.status === 'active') {
            // vapi_agent nodes mark their Dial action with ?vapiNode=1 so the
            // real DialCallStatus maps to a vapi.* event (completed → end call,
            // failure/timeout → follow the node's fallback edge).
            const flowEvent = req.query.flowEvent
                || (req.query.vapiNode ? callFlowRuntime.vapiEventFromDialStatus(dialStatus) : callFlowRuntime.eventFromDialStatus(dialStatus));
            const flowTwiml = await callFlowRuntime.advance(CallSid, flowEvent, traceId);
            if (flowTwiml) {
                res.type('text/xml');
                return res.send(flowTwiml);
            }
        }

        // Decide TwiML response based on DialCallStatus (no DB reads needed)
        // For outbound calls (operator → PSTN) skip voicemail — it's only for inbound callers.
        const isOutbound = (req.body.Direction === 'outbound-api') ||
                           (req.body.From || '').startsWith('client:');
        const toVoicemail = !isOutbound && dialStatus !== 'completed' && dialStatus !== 'answered';

        let twiml;
        if (toVoicemail) {
            const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://api.albusto.com';
            const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;
            const voicemailCompleteUrl = `${baseUrl}/webhooks/twilio/voicemail-complete`;
            const vmLanguage = process.env.VM_LANGUAGE || 'en-US';
            const vmGreeting = process.env.VM_GREETING || 'Hello! Our team is currently assisting other customers. Please leave your name and phone number, and we will call you back as soon as possible.';
            const vmMaxLen = Number(process.env.VM_MAXLEN || 180);
            const vmSilenceTimeout = Number(process.env.VM_SILENCE_TIMEOUT || 5);
            const vmFinishOnKey = process.env.VM_FINISH_ON_KEY || '#';

            console.log(`[${traceId}] No answer (${dialStatus}) → voicemail TwiML`);

            twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say language="${vmLanguage}">${vmGreeting}</Say>
    <Record maxLength="${vmMaxLen}"
            action="${voicemailCompleteUrl}"
            method="POST"
            timeout="${vmSilenceTimeout}"
            finishOnKey="${vmFinishOnKey}"
            playBeep="true"
            transcribe="false"
            recordingStatusCallback="${recordingStatusUrl}"
            recordingStatusCallbackMethod="POST" />
    <Hangup />
</Response>`;
        } else {
            console.log(`[${traceId}] Call completed (${dialStatus}) → hangup TwiML`);
            twiml = buildHangupTwiml();
        }

        res.type('text/xml');
        res.send(twiml);
    } catch (error) {
        console.error(`[${traceId}] Error:`, error);
        // Never return 500 from TwiML webhooks — Twilio plays "application error" to the caller
        res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>');
    }
}

// =============================================================================
// POST /webhooks/twilio/voicemail-complete
// <Record action> target — recordingStatusCallback handles persistence.
// =============================================================================
async function handleVoicemailComplete(req, res) {
    const traceId = generateTraceId();
    console.log(`[${traceId}] Voicemail complete`, {
        callSid: req.body.CallSid,
        recordingSid: req.body.RecordingSid,
    });

    try {
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
            return res.status(403).send('<Response></Response>');
        }

        const callSid = req.body.CallSid;
        const flowEvent = req.query.flowEvent || 'voicemail.recorded';
        const flowTwiml = callSid
            ? await callFlowRuntime.advance(callSid, flowEvent, traceId)
            : null;

        res.type('text/xml');
        res.send(flowTwiml || buildHangupTwiml());
    } catch (error) {
        console.error(`[${traceId}] Error:`, error);
        res.type('text/xml').send(buildHangupTwiml());
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
    handleVoicemailComplete,
    handleVoiceFallback,
    validateTwilioSignature
};
