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
            // ── Determine routing mode for this phone number ──────────────
            // Check phone_number_settings table for per-number config,
            // fall back to SOFTPHONE_DEFAULT_IDENTITY env var.
            let routingMode = 'sip';
            let clientIdentity = null;
            const dbConn = require('../db/connection');

            try {
                const routeResult = await dbConn.query(
                    `SELECT routing_mode, client_identity FROM phone_number_settings WHERE phone_number = $1`,
                    [To]
                );
                if (routeResult.rows.length > 0) {
                    routingMode = routeResult.rows[0].routing_mode;
                    clientIdentity = routeResult.rows[0].client_identity;
                }
            } catch (routeErr) {
                console.warn(`[${traceId}] Failed to query phone_number_settings, using env fallback:`, routeErr.message);
            }

            // Env var fallback (global override)
            if (routingMode === 'sip' && process.env.SOFTPHONE_DEFAULT_IDENTITY) {
                routingMode = 'client';
                clientIdentity = process.env.SOFTPHONE_DEFAULT_IDENTITY;
            }

            if (routingMode === 'client') {
                // ── WebRTC SoftPhone routing ──────────────────────────────────
                // Query all users with phone_calls_allowed = true
                let allowedIdentities = [];
                try {
                    const allowedResult = await dbConn.query(
                        `SELECT 'user_' || m.user_id AS identity
                         FROM company_memberships m
                         JOIN company_user_profiles p ON p.membership_id = m.id
                         WHERE p.phone_calls_allowed = true`
                    );
                    allowedIdentities = allowedResult.rows.map(r => r.identity);
                } catch (permErr) {
                    console.warn(`[${traceId}] Failed to query allowed users, falling back to clientIdentity:`, permErr.message);
                    if (clientIdentity) allowedIdentities = [clientIdentity];
                }

                // Fallback: if no DB result but env var set, use it
                if (allowedIdentities.length === 0 && clientIdentity) {
                    allowedIdentities = [clientIdentity];
                }

                if (allowedIdentities.length === 0) {
                    // No allowed users → voicemail
                    console.log(`[${traceId}] No allowed Client users → voicemail`);
                    const vmLanguage = process.env.VM_LANGUAGE || 'en-US';
                    const vmGreeting = process.env.VM_GREETING || 'Hello! Our team is currently assisting other customers. Please leave your name and phone number, and we will call you back as soon as possible.';
                    const vmMaxLen = Number(process.env.VM_MAXLEN || 180);
                    const vmSilenceTimeout = Number(process.env.VM_SILENCE_TIMEOUT || 5);
                    const vmFinishOnKey = process.env.VM_FINISH_ON_KEY || '#';

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

                    // Mark as voicemail_recording
                    try {
                        await dbConn.query(
                            `UPDATE calls SET status = 'voicemail_recording', is_final = false WHERE call_sid = $1`,
                            [CallSid]
                        );
                        const realtimeService = require('../services/realtimeService');
                        const freshCall = await queries.getCallByCallSid(CallSid);
                        if (freshCall) {
                            realtimeService.publishCallUpdate({ eventType: 'call.updated', ...freshCall });
                        }
                    } catch (vmErr) {
                        console.warn(`[${traceId}] Failed to set voicemail_recording:`, vmErr.message);
                    }
                } else {
                    // ── Check if all Client users are busy ──────────────────
                    // If ALL are on active calls, hold the caller with a
                    // redirect loop instead of timing out after 25s.
                    let allBusy = false;
                    let busyIdentities = new Set();
                    try {
                        const busyResult = await dbConn.query(
                            `SELECT DISTINCT
                                CASE WHEN to_number LIKE 'client:%' THEN to_number
                                     WHEN from_number LIKE 'client:%' THEN from_number
                                END AS client_number,
                                call_sid
                             FROM calls
                             WHERE status IN ('ringing', 'in-progress')
                               AND is_final = false
                               AND (to_number LIKE 'client:%' OR from_number LIKE 'client:%')
                               AND (
                                   (status = 'ringing' AND started_at > NOW() - INTERVAL '90 seconds')
                                   OR
                                   (status = 'in-progress' AND started_at > NOW() - INTERVAL '4 hours')
                               )`
                        );
                        busyIdentities = new Set(
                            busyResult.rows
                                .map(r => (r.client_number || '').replace('client:', ''))
                                .filter(Boolean)
                        );
                        allBusy = allowedIdentities.length > 0 &&
                            allowedIdentities.every(id => busyIdentities.has(id));

                        // Twilio API fallback: if all operators appear busy, verify via Twilio REST API
                        if (allBusy) {
                            console.log(`[${traceId}] All clients busy per DB — verifying via Twilio API`);
                            try {
                                const twilio = require('twilio');
                                const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
                                const busySids = busyResult.rows.map(r => r.call_sid).filter(Boolean);
                                const resolvedSids = new Set();

                                for (const sid of busySids) {
                                    try {
                                        const details = await twilioClient.calls(sid).fetch();
                                        const apiStatus = (details.status || '').toLowerCase();
                                        if (['completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(apiStatus)) {
                                            // Call is actually finished — update DB and remove from busy set
                                            resolvedSids.add(sid);
                                            await dbConn.query(
                                                `UPDATE calls SET status = $2, is_final = true, ended_at = COALESCE($3, ended_at)
                                                 WHERE call_sid = $1 AND is_final = false`,
                                                [sid, apiStatus, details.endTime ? new Date(details.endTime) : null]
                                            );
                                            console.log(`[${traceId}] Twilio API: ${sid} actually ${apiStatus} — fixed`);
                                        }
                                    } catch (fetchErr) {
                                        console.warn(`[${traceId}] Twilio API fetch failed for ${sid}:`, fetchErr.message);
                                    }
                                }

                                if (resolvedSids.size > 0) {
                                    // Recalculate busy identities excluding resolved calls
                                    const stillBusyRows = busyResult.rows.filter(r => !resolvedSids.has(r.call_sid));
                                    busyIdentities = new Set(
                                        stillBusyRows
                                            .map(r => (r.client_number || '').replace('client:', ''))
                                            .filter(Boolean)
                                    );
                                    allBusy = allowedIdentities.length > 0 &&
                                        allowedIdentities.every(id => busyIdentities.has(id));
                                    console.log(`[${traceId}] After Twilio API check: allBusy=${allBusy}, resolved=${resolvedSids.size}`);
                                }
                            } catch (twilioErr) {
                                console.warn(`[${traceId}] Twilio API fallback failed, using DB data:`, twilioErr.message);
                            }
                        }
                    } catch (busyErr) {
                        console.warn(`[${traceId}] Failed to check busy clients:`, busyErr.message);
                    }

                    // Parse retry counter from query string (redirect loop)
                    const holdRetry = parseInt(req.query.holdRetry || '0', 10);
                    const maxHoldRetries = 48; // 48 × 5s = 4 minutes max hold

                    if (allBusy && holdRetry < maxHoldRetries) {
                        // All operators busy → hold loop
                        const holdMsg = holdRetry === 0
                            ? 'All representatives are currently assisting other customers. Please stay on the line.'
                            : '';
                        const holdLanguage = process.env.VM_LANGUAGE || 'en-US';
                        const redirectUrl = `${baseUrl}/webhooks/twilio/voice-inbound?holdRetry=${holdRetry + 1}`;

                        console.log(`[${traceId}] All clients busy — hold loop (retry ${holdRetry}/${maxHoldRetries})`);

                        // Notify frontend via SSE on first retry so user sees the waiting call immediately
                        if (holdRetry === 0) {
                            try {
                                const realtimeService = require('../services/realtimeService');
                                realtimeService.broadcast('call.holding', {
                                    call_sid: CallSid,
                                    from_number: From,
                                    to_number: To,
                                    holdRetry: 0,
                                });
                            } catch (sseErr) {
                                console.warn(`[${traceId}] SSE broadcast failed:`, sseErr.message);
                            }
                        }

                        const sayXml = holdMsg ? `\n    <Say language="${holdLanguage}">${holdMsg}</Say>` : '';
                        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>${sayXml}
    <Pause length="5"/>
    <Redirect method="POST">${redirectUrl}</Redirect>
</Response>`;
                    } else if (allBusy && holdRetry >= maxHoldRetries) {
                        // Max hold time exceeded → voicemail
                        console.log(`[${traceId}] Max hold time exceeded → voicemail`);
                        const vmLanguage = process.env.VM_LANGUAGE || 'en-US';
                        const vmGreeting = process.env.VM_GREETING || 'Hello! Our team is currently assisting other customers. Please leave your name and phone number, and we will call you back as soon as possible.';
                        const vmMaxLen = Number(process.env.VM_MAXLEN || 180);
                        const vmSilenceTimeout = Number(process.env.VM_SILENCE_TIMEOUT || 5);
                        const vmFinishOnKey = process.env.VM_FINISH_ON_KEY || '#';

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
                    } else {
                        // At least one user is free → dial only free users (exclude busy)
                        const freeIdentities = allowedIdentities.filter(id => !busyIdentities.has(id));
                        console.log(`[${traceId}] Inbound: ${From} → Client([${freeIdentities.join(',')}]) (busy: [${[...busyIdentities].join(',')}])`);

                        const clientEndpoints = freeIdentities.map(id =>
                            `        <Client statusCallback="${statusCallbackUrl}"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">${id}</Client>`
                        ).join('\n');

                        const inboundTimeout = Number(process.env.DIAL_TIMEOUT || 25);
                        const inboundStreamXml = realtimeEnabled ? `
    <Start>
        <Stream name="realtime-transcript" url="${mediaStreamUrl}" track="both_tracks">
            <Parameter name="callSid" value="${CallSid}" />
            <Parameter name="direction" value="inbound" />
        </Stream>
    </Start>` : '';

                        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>${inboundStreamXml}
    <Dial timeout="${inboundTimeout}"
          answerOnBridge="true"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
${clientEndpoints}
    </Dial>
</Response>`;
                    }
                }
            } else {
                // ── SIP / Bria routing (original) ─────────────────────────────
                console.log(`[${traceId}] Inbound: ${From} → SIP`);
                const sipDomain = process.env.SIP_DOMAIN || 'abchomes.sip.us1.twilio.com';
                // Support multiple SIP users (ring all simultaneously)
                const allSipUsers = (process.env.SIP_USERS || process.env.SIP_USER || 'dispatcher').split(',').map(u => u.trim());

                // ── Exclude busy operators ──────────────────────────────────────
                // Query child SIP legs that are currently active (not yet final)
                let availableUsers = allSipUsers;
                try {
                    const db = require('../db/connection');
                    const busyResult = await db.query(
                        `SELECT DISTINCT to_number, call_sid FROM calls
                         WHERE status IN ('ringing', 'in-progress', 'voicemail_recording')
                           AND is_final = false
                           AND to_number LIKE 'sip:%'
                           AND (
                               (status = 'ringing' AND started_at > NOW() - INTERVAL '90 seconds')
                               OR
                               (status IN ('in-progress', 'voicemail_recording') AND started_at > NOW() - INTERVAL '4 hours')
                           )`
                    );
                    const busySipUsers = new Set();
                    for (const row of busyResult.rows) {
                        // Extract username from "sip:dana@domain" or "sip:dana@domain:port"
                        const match = row.to_number.match(/^sip:([^@]+)@/);
                        if (match) busySipUsers.add(match[1]);
                    }
                    if (busySipUsers.size > 0) {
                        availableUsers = allSipUsers.filter(u => !busySipUsers.has(u));
                        console.log(`[${traceId}] Busy operators: [${[...busySipUsers].join(',')}], available: [${availableUsers.join(',')}]`);
                    }

                    // Twilio API fallback: if all operators appear busy, verify via Twilio REST API
                    if (availableUsers.length === 0) {
                        console.log(`[${traceId}] All SIP operators busy per DB — verifying via Twilio API`);
                        try {
                            const twilio = require('twilio');
                            const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
                            const busySids = busyResult.rows.map(r => r.call_sid).filter(Boolean);
                            let anyResolved = false;

                            for (const sid of busySids) {
                                try {
                                    const details = await twilioClient.calls(sid).fetch();
                                    const apiStatus = (details.status || '').toLowerCase();
                                    if (['completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(apiStatus)) {
                                        anyResolved = true;
                                        await db.query(
                                            `UPDATE calls SET status = $2, is_final = true, ended_at = COALESCE($3, ended_at)
                                             WHERE call_sid = $1 AND is_final = false`,
                                            [sid, apiStatus, details.endTime ? new Date(details.endTime) : null]
                                        );
                                        console.log(`[${traceId}] Twilio API: ${sid} actually ${apiStatus} — fixed`);
                                    }
                                } catch (fetchErr) {
                                    console.warn(`[${traceId}] Twilio API fetch failed for ${sid}:`, fetchErr.message);
                                }
                            }

                            if (anyResolved) {
                                // Re-query available users after fixing stale records
                                const freshResult = await db.query(
                                    `SELECT DISTINCT to_number FROM calls
                                     WHERE status IN ('ringing', 'in-progress', 'voicemail_recording')
                                       AND is_final = false
                                       AND to_number LIKE 'sip:%'
                                       AND started_at > NOW() - INTERVAL '4 hours'`
                                );
                                const freshBusy = new Set();
                                for (const row of freshResult.rows) {
                                    const match = row.to_number.match(/^sip:([^@]+)@/);
                                    if (match) freshBusy.add(match[1]);
                                }
                                availableUsers = allSipUsers.filter(u => !freshBusy.has(u));
                                console.log(`[${traceId}] After Twilio API check: available=[${availableUsers.join(',')}]`);
                            }
                        } catch (twilioErr) {
                            console.warn(`[${traceId}] Twilio API fallback failed, using DB data:`, twilioErr.message);
                        }
                    }
                } catch (busyErr) {
                    console.warn(`[${traceId}] Failed to check busy operators, ringing all:`, busyErr.message);
                }

                // If all operators are busy → go straight to voicemail
                if (availableUsers.length === 0) {
                    console.log(`[${traceId}] All operators busy → voicemail`);
                    const vmLanguage = process.env.VM_LANGUAGE || 'en-US';
                    const vmGreeting = process.env.VM_GREETING || 'Hello! Our team is currently assisting other customers. Please leave your name and phone number, and we will call you back as soon as possible.';
                    const vmMaxLen = Number(process.env.VM_MAXLEN || 180);
                    const vmSilenceTimeout = Number(process.env.VM_SILENCE_TIMEOUT || 5);
                    const vmFinishOnKey = process.env.VM_FINISH_ON_KEY || '#';

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

                    // Mark as voicemail_recording
                    try {
                        const db = require('../db/connection');
                        await db.query(
                            `UPDATE calls SET status = 'voicemail_recording', is_final = false WHERE call_sid = $1`,
                            [CallSid]
                        );
                        const realtimeService = require('../services/realtimeService');
                        const freshCall = await queries.getCallByCallSid(CallSid);
                        if (freshCall) {
                            realtimeService.publishCallUpdate({ eventType: 'call.updated', ...freshCall });
                        }
                    } catch (vmErr) {
                        console.warn(`[${traceId}] Failed to set voicemail_recording:`, vmErr.message);
                    }
                } else {
                    const sipEndpoints = availableUsers.map(user =>
                        `        <Sip statusCallback="${statusCallbackUrl}"
             statusCallbackEvent="initiated ringing answered completed"
             statusCallbackMethod="POST">sip:${user}@${sipDomain}</Sip>`
                    ).join('\n');

                    const inboundTimeout = Number(process.env.DIAL_TIMEOUT || 25);
                    const inboundStreamXml = realtimeEnabled ? `
    <Start>
        <Stream name="realtime-transcript" url="${mediaStreamUrl}" track="both_tracks">
            <Parameter name="callSid" value="${CallSid}" />
            <Parameter name="direction" value="inbound" />
        </Stream>
    </Start>` : '';

                    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>${inboundStreamXml}
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

        // Finalize all child legs for this parent call to prevent stale busy state
        try {
            const db = require('../db/connection');
            const finalizeStatus = dialStatus === 'completed' || dialStatus === 'answered' ? 'completed' : 'no-answer';
            const result = await db.query(
                `UPDATE calls SET status = CASE WHEN status = 'in-progress' THEN 'completed' ELSE $2 END,
                        is_final = true,
                        ended_at = COALESCE(ended_at, NOW())
                 WHERE parent_call_sid = $1
                   AND is_final = false`,
                [CallSid, finalizeStatus]
            );
            if (result.rowCount > 0) {
                console.log(`[${traceId}] Finalized ${result.rowCount} child leg(s) for parent ${CallSid}`);
            }
        } catch (childErr) {
            console.warn(`[${traceId}] Failed to finalize child legs:`, childErr.message);
        }

        const toVoicemail = dialStatus !== 'completed' && dialStatus !== 'answered';

        let twiml;
        if (toVoicemail) {
            const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://abc-metrics.fly.dev';
            const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;
            const vmLanguage = process.env.VM_LANGUAGE || 'en-US';
            const vmGreeting = process.env.VM_GREETING || 'Hello! Our team is currently assisting other customers. Please leave your name and phone number, and we will call you back as soon as possible.';
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
