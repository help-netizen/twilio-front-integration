const twilio = require('twilio');
const crypto = require('crypto');
const queries = require('../db/queries');
const groupRouting = require('../services/groupRouting');
const callFlowRuntime = require('../services/callFlowRuntime');
const walletService = require('../services/walletService');
const telephonyTenantService = require('../services/telephonyTenantService');
const callBlacklistService = require('../services/callBlacklistService');
const callMaskingService = require('../services/callMaskingService');
const { mintStreamToken } = require('../services/mediaStreamTokenService');

function recordTenantResolutionFailure(surface, reason) {
    console.warn('[TwilioSecurity]', {
        event: 'twilio.tenant_unresolved',
        surface,
        reason,
        metric: 'twilio_tenant_unresolved_total',
        increment: 1,
    });
}

function tenantUnresolvedError(reason) {
    const err = new Error('Twilio tenant could not be resolved');
    err.code = 'TWILIO_TENANT_UNRESOLVED';
    err.reason = reason;
    return err;
}

async function resolveWebhookCompanyId(payload, surface = 'webhook') {
    const accountSid = payload?.AccountSid;
    if (!accountSid) {
        recordTenantResolutionFailure(surface, 'missing_account_sid');
        throw tenantUnresolvedError('missing_account_sid');
    }

    let companyId;
    try {
        companyId = await telephonyTenantService.resolveCompanyByAccountSid(accountSid);
    } catch {
        recordTenantResolutionFailure(surface, 'resolution_error');
        throw tenantUnresolvedError('resolution_error');
    }
    if (!companyId) {
        recordTenantResolutionFailure(surface, 'unbound_account_sid');
        throw tenantUnresolvedError('unbound_account_sid');
    }
    return companyId;
}

/**
 * Record a wallet-blocked inbound call as a missed call so it shows in the
 * caller's timeline. Final (is_final) so async inbox events can't downgrade it.
 */
async function recordMissedInbound({ callSid, from, to, companyId, payload }) {
    const realtimeService = require('../services/realtimeService');
    const now = new Date();
    const timeline = await queries.findOrCreateTimeline(from, companyId);
    const call = await queries.upsertCall({
        callSid,
        parentCallSid: null,
        contactId: timeline.contact_id || null,
        timelineId: timeline.id,
        direction: 'inbound',
        fromNumber: from,
        toNumber: to,
        status: 'no-answer',
        isFinal: true,
        startedAt: now,
        answeredAt: null,
        endedAt: now,
        durationSec: 0,
        price: 0,
        priceUnit: null,
        lastEventTime: now,
        rawLastPayload: payload,
        companyId,
    });
    if (call) realtimeService.publishCallUpdate({ eventType: 'call.updated', ...call });
}

/**
 * Persist a blacklist rejection directly, bypassing the inbound inbox worker.
 * That worker intentionally creates unread/Action Required/task work for normal
 * inbound calls, none of which applies to a rejected caller.
 */
async function recordBlockedInbound({ callSid, from, to, companyId, payload }) {
    const realtimeService = require('../services/realtimeService');
    const now = new Date();
    const timeline = await queries.findOrCreateTimeline(from, companyId);
    const call = await queries.upsertCall({
        callSid,
        parentCallSid: null,
        contactId: timeline.contact_id || null,
        timelineId: timeline.id,
        direction: 'inbound',
        fromNumber: from,
        toNumber: to,
        status: 'blocked',
        isFinal: true,
        startedAt: now,
        answeredAt: null,
        endedAt: now,
        durationSec: 0,
        price: 0,
        priceUnit: null,
        lastEventTime: now,
        rawLastPayload: payload,
        companyId,
    });
    if (!call) throw new Error('Blocked call snapshot was not persisted');
    try {
        realtimeService.publishCallUpdate({ eventType: 'call.updated', ...call });
    } catch (err) {
        console.warn('[CallBlacklist] Realtime publish failed (non-blocking):', err.message);
    }
    return call;
}

/**
 * Validate Twilio webhook signature
 */
async function validateTwilioSignature(req, options = {}) {
    const signature = req.headers?.['x-twilio-signature'];
    if (!signature) {
        console.error('Missing Twilio signature');
        return false;
    }

    const accountSid = options.accountSid || req.body?.AccountSid;
    try {
        await resolveWebhookCompanyId({ AccountSid: accountSid }, 'signature_validation');
    } catch {
        return false;
    }

    let authToken;
    try {
        authToken = await telephonyTenantService.getAuthTokenForAccountSid(accountSid);
    } catch {
        return false;
    }
    if (!authToken) return false;

    let url = options.url;
    if (!url) {
        const protocol = req.headers?.['x-forwarded-proto']
            || req.protocol
            || (req.socket?.encrypted ? 'https' : 'http');
        const host = req.headers?.['x-forwarded-host']
            || (typeof req.get === 'function' ? req.get('host') : req.headers?.host);
        const originalUrl = req.originalUrl || req.url;
        if (!protocol || !host || !originalUrl) return false;
        url = `${protocol}://${host}${originalUrl}`;
    }
    const params = Object.prototype.hasOwnProperty.call(options, 'params')
        ? options.params
        : req.body;

    try {
        return twilio.validateRequest(authToken, signature, url, params);
    } catch (error) {
        console.error('Signature validation error:', error);
        return false;
    }
}

/**
 * Generate event_key for deduplication.
 * Uses I-Twilio-Idempotency-Token if available, else builds a canonical key.
 */
function generateEventKey(source, eventType, payload, req) {
    const idempotencyToken = req.headers?.['i-twilio-idempotency-token'];
    const stableFields = idempotencyToken
        ? { accountSid: payload.AccountSid || '', eventType, idempotencyToken }
        : {
            accountSid: payload.AccountSid || '',
            eventType,
            callSid: payload.CallSid || '',
            parentCallSid: payload.ParentCallSid || '',
            recordingSid: payload.RecordingSid || '',
            transcriptionSid: payload.TranscriptionSid || '',
            callStatus: payload.CallStatus || '',
            dialCallStatus: payload.DialCallStatus || '',
            recordingStatus: payload.RecordingStatus || '',
            transcriptionStatus: payload.TranscriptionStatus || '',
            sequence: payload.SequenceNumber || payload.Sequence || '',
            timestamp: payload.Timestamp || '',
        };
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify(stableFields))
        .digest('hex');
    return `twilio:${source}:${idempotencyToken ? 'idem' : 'event'}:${digest}`;
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

function buildBlacklistRejectTwiml() {
    return '<Response><Reject reason="busy"/></Response>';
}

function webhookBaseUrl() {
    return process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://api.albusto.com';
}

function mediaStreamUrl() {
    return webhookBaseUrl().replace(/^http/, 'ws') + '/ws/twilio-media';
}

function buildMaskingGatherTwiml(baseUrl, attempt = 1, invalid = false) {
    const actionUrl = `${baseUrl}/webhooks/twilio/voice-mask-code?attempt=${attempt}`;
    const invalidXml = invalid
        ? '\n        <Say language="en-US">That customer code was not recognized.</Say>'
        : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="dtmf"
            numDigits="${callMaskingService.CODE_DIGITS}"
            timeout="10"
            actionOnEmptyResult="true"
            action="${actionUrl}"
            method="POST">${invalidXml}
        <Say language="en-US">Enter the six digit customer code.</Say>
    </Gather>
    <Hangup />
</Response>`;
}

function buildMaskingDialTwiml({ baseUrl, maskingNumber, customerPhone }) {
    const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;
    const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;
    const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-mask-dial-action`;
    const consentUrl = `${baseUrl}/webhooks/twilio/voice-mask-consent`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial answerOnBridge="true"
          callerId="${maskingNumber}"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST"
          recordingStatusCallbackEvent="completed">
        <Number url="${consentUrl}"
                method="POST"
                statusCallback="${statusCallbackUrl}"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">${customerPhone}</Number>
    </Dial>
</Response>`;
}

/**
 * Generic webhook handler that pushes to webhook_inbox
 */
async function ingestToInbox({ source, eventType, payload, req, traceId }) {
    const companyId = await resolveWebhookCompanyId(payload, `inbox.${source}`);
    const eventKey = generateEventKey(source, eventType, payload, req);
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
        companyId,
        payload,
        headers: {
            'x-twilio-signature': req.headers?.['x-twilio-signature'],
            'i-twilio-idempotency-token': req.headers?.['i-twilio-idempotency-token'],
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
    console.log(`[${traceId}] Voice status webhook received`);

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
        if (error.code === 'TWILIO_TENANT_UNRESOLVED') {
            return res.status(403).json({ error: 'Twilio tenant unresolved' });
        }
        res.status(500).json({ error: 'Internal server error' });
    }
}

// =============================================================================
// POST /webhooks/twilio/recording-status
// =============================================================================
async function handleRecordingStatus(req, res) {
    const traceId = generateTraceId();
    console.log(`[${traceId}] Recording status webhook received`);

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
        if (error.code === 'TWILIO_TENANT_UNRESOLVED') {
            return res.status(403).json({ error: 'Twilio tenant unresolved' });
        }
        res.status(500).json({ error: 'Internal server error' });
    }
}

// =============================================================================
// POST /webhooks/twilio/transcription-status  (NEW)
// =============================================================================
async function handleTranscriptionStatus(req, res) {
    const traceId = generateTraceId();
    console.log(`[${traceId}] Transcription status webhook received`);

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
        if (error.code === 'TWILIO_TENANT_UNRESOLVED') {
            return res.status(403).json({ error: 'Twilio tenant unresolved' });
        }
        res.status(500).json({ error: 'Internal server error' });
    }
}

// =============================================================================
// POST /webhooks/twilio/voice-inbound (TwiML response)
// =============================================================================
async function handleVoiceInbound(req, res) {
    const traceId = generateTraceId();
    console.log(`[${traceId}] Voice inbound webhook received`);

    try {
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
            return res.status(403).send('<Response><Reject/></Response>');
        }

        const { CallSid, From, To } = req.body;
        if (!CallSid) {
            return res.status(400).send('<Response><Reject/></Response>');
        }

        // Determine direction and return TwiML
        const baseUrl = webhookBaseUrl();
        const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;
        const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;
        const voicemailCompleteUrl = `${baseUrl}/webhooks/twilio/voicemail-complete`;

        const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;

        // Realtime transcription: build <Start><Stream> block if enabled
        const realtimeEnabled = process.env.FEATURE_REALTIME_TRANSCRIPTION === 'true';
        const streamUrl = mediaStreamUrl();

        const isOutbound = From && From.startsWith('sip:');
        let twiml;

        if (isOutbound) {
            const outboundCompanyId = realtimeEnabled
                ? await resolveWebhookCompanyId(req.body)
                : null;
            await ingestToInbox({
                source: 'voice',
                eventType: 'call.inbound',
                payload: req.body,
                req,
                traceId
            });

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
            let streamToken = null;
            if (realtimeEnabled && outboundCompanyId) {
                try {
                    streamToken = mintStreamToken({
                        companyId: outboundCompanyId,
                        callSid: CallSid,
                        accountSid: req.body.AccountSid,
                        direction: 'outbound',
                    });
                } catch {
                    console.warn('[MediaStreamSecurity]', {
                        event: 'twilio.media_stream.disabled',
                        reason: 'token_mint_failed',
                        metric: 'twilio_media_stream_token_mint_failed_total',
                        increment: 1,
                    });
                }
            }
            const outboundStreamXml = streamToken ? `
    <Start>
        <Stream name="realtime-transcript" url="${streamUrl}" track="both_tracks">
            <Parameter name="direction" value="outbound" />
            <Parameter name="streamToken" value="${streamToken}" />
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
            // TWILIO-TENANT-FIX-001: AccountSid is the only tenant binding.
            // Master maps explicitly to ABC Homes; connected subaccounts map
            // through company_telephony; missing/unknown bindings fail closed.
            const companyId = await resolveWebhookCompanyId(req.body, 'voice_inbound');

            // CALL-BLACKLIST-001: this is the pre-routing hook. Both lookup and
            // persistence are fail-open so blacklist availability can never be
            // a dependency of the normal inbound route.
            let isBlacklisted = false;
            try {
                isBlacklisted = await callBlacklistService.isBlocked(companyId, From);
            } catch (err) {
                console.warn(`[${traceId}] Blacklist lookup failed; continuing inbound route:`, err.message);
            }

            if (isBlacklisted) {
                try {
                    await recordBlockedInbound({
                        callSid: CallSid,
                        from: From,
                        to: To,
                        companyId,
                        payload: req.body,
                    });
                    console.log(`[${traceId}] Inbound caller is blacklisted; rejecting ${From} → ${To}`);
                    res.type('text/xml');
                    return res.send(buildBlacklistRejectTwiml());
                } catch (err) {
                    console.warn(`[${traceId}] Blocked-call persistence failed; continuing inbound route:`, err.message);
                }
            }

            // CALL-MASKING-001: only an enabled company masking number called
            // from exactly one active member whose role holds `call_masking.use`
            // (matched by profile phone) enters the code gather. Customers and
            // unknown callers continue through the existing IVR/group route below.
            const maskingContext = await callMaskingService.getInboundMaskingContext(
                companyId,
                To,
                From
            ).catch((err) => {
                console.warn(`[${traceId}] Call masking lookup failed; using normal inbound route:`, err.message);
                return null;
            });
            if (maskingContext) {
                if (await walletService.isServiceBlocked(companyId).catch(() => false)) {
                    res.type('text/xml');
                    return res.send('<Response><Reject reason="busy"/></Response>');
                }
                res.type('text/xml');
                return res.send(buildMaskingGatherTwiml(baseUrl));
            }

            // Normal inbound processing starts only after the blacklist hook.
            // Successfully blocked calls bypass this event because its worker
            // creates unread/Action Required/task work by design.
            await ingestToInbox({
                source: 'voice',
                eventType: 'call.inbound',
                payload: req.body,
                req,
                traceId
            });

            // Wallet gate (−$5 grace floor): block inbound calls when the
            // company can't pay. Reject BEFORE answering so Twilio never starts
            // the per-minute meter — the caller gets a busy signal and we log a
            // missed call in the timeline. (Mirrors the outbound/SMS gate.)
            // C4 (ONBTEL-001): uses the company resolved above — guaranteed
            // non-null here, so the gate can no longer be skipped via a null
            // lookup. isServiceBlocked stays fail-open on error so a transient
            // wallet failure never drops legitimate routing.
            if (await walletService.isServiceBlocked(companyId).catch(() => false)) {
                console.log(`[${traceId}] Inbound blocked — wallet at grace floor; rejecting ${From} → ${To}`);
                await recordMissedInbound({ callSid: CallSid, from: From, to: To, companyId, payload: req.body })
                    .catch(e => console.warn(`[${traceId}] missed-call log failed (non-blocking):`, e.message));
                res.type('text/xml');
                return res.send('<Response><Reject reason="busy"/></Response>');
            }

            const resolvedGroup = await groupRouting.resolveGroupForNumber(To, companyId);
            if (resolvedGroup) {
                console.log(`[${traceId}] F017 inbound: ${From} → group ${resolvedGroup.group.name} (${resolvedGroup.group.id})`);
                twiml = await callFlowRuntime.startExecution({
                    callSid: CallSid,
                    companyId,
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
        if (error.code === 'TWILIO_TENANT_UNRESOLVED') {
            res.type('text/xml');
            return res.send('<Response><Reject/></Response>');
        }
        console.error(`[${traceId}] Error:`, error);
        res.status(500).send('<Response><Reject/></Response>');
    }
}

// =============================================================================
// POST /webhooks/twilio/voice-mask-code
// <Gather> target shared by manual IVR entry and direct post-dial DTMF.
// =============================================================================
async function handleMaskingCode(req, res) {
    const traceId = generateTraceId();
    try {
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
            return res.status(403).send('<Response><Reject/></Response>');
        }

        const { CallSid, From, To, Digits } = req.body || {};
        if (!CallSid || !From || !To) {
            return res.status(400).send(buildHangupTwiml());
        }

        const companyId = await resolveWebhookCompanyId(req.body);
        const resolved = companyId
            ? await callMaskingService.resolveCustomerForProviderCode(companyId, {
                maskingNumber: To,
                providerPhone: From,
                code: Digits,
            })
            : null;

        if (!resolved) {
            const attempt = Number(req.query?.attempt || 1);
            res.type('text/xml');
            return res.send(
                attempt < 2
                    ? buildMaskingGatherTwiml(webhookBaseUrl(), 2, true)
                    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say language="en-US">We could not complete this masked call.</Say>
    <Hangup />
</Response>`
            );
        }

        // Persist the privacy-safe mapping before any Dial child/status event
        // can reach the inbox worker. The session stores contact_id, never the
        // customer's phone alongside the keyed code.
        await callMaskingService.createSession(companyId, CallSid, resolved);
        const privacySafePayload = { ...req.body };
        delete privacySafePayload.Digits;
        await ingestToInbox({
            source: 'voice',
            eventType: 'call.inbound',
            payload: privacySafePayload,
            req,
            traceId,
        });

        res.type('text/xml');
        res.send(buildMaskingDialTwiml({
            baseUrl: webhookBaseUrl(),
            maskingNumber: resolved.masking_number,
            customerPhone: resolved.customer_phone,
        }));
    } catch (error) {
        console.error(`[${traceId}] Masked call code handler failed:`, error.message);
        res.type('text/xml').send(buildHangupTwiml());
    }
}

// =============================================================================
// POST /webhooks/twilio/voice-mask-consent
// Called-party screening TwiML, executed after answer and before connection.
// =============================================================================
async function handleMaskingConsent(req, res) {
    if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
        return res.status(403).send('<Response><Reject/></Response>');
    }
    res.type('text/xml');
    // CALL-MASK-SILENT-001: the customer answers a plain call from the company
    // number — no announcement. Kept as an endpoint so calls already bridged
    // through an older TwiML during a deploy still get a valid (empty) document.
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response />`);
}

// =============================================================================
// POST /webhooks/twilio/voice-mask-dial-action
// Finalize the normal call timeline without falling into inbound voicemail.
// =============================================================================
async function handleMaskingDialAction(req, res) {
    const traceId = generateTraceId();
    try {
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
            return res.status(403).send('<Response></Response>');
        }
        if (!req.body?.CallSid) {
            return res.status(400).send('<Response></Response>');
        }
        await ingestToInbox({
            source: 'dial',
            eventType: 'dial.action',
            payload: { ...req.body, MaskedCall: '1' },
            req,
            traceId,
        });
        const reached = ['completed', 'answered'].includes(
            String(req.body.DialCallStatus || '').toLowerCase()
        );
        res.type('text/xml');
        res.send(reached
            ? buildHangupTwiml()
            : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say language="en-US">The customer could not be reached.</Say>
    <Hangup />
</Response>`);
    } catch (error) {
        console.error(`[${traceId}] Masked call dial action failed:`, error.message);
        res.type('text/xml').send(buildHangupTwiml());
    }
}

// =============================================================================
// POST /webhooks/twilio/voice-dial-action
// Voicemail logic: if no one answered, play greeting + record voicemail
// =============================================================================
async function handleDialAction(req, res) {
    const traceId = generateTraceId();
    const dialStatus = String(req.body.DialCallStatus || '').toLowerCase();
    console.log(`[${traceId}] Dial action webhook received`, { dialStatus });

    try {
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
            return res.status(403).send('<Response></Response>');
        }

        const { CallSid } = req.body;
        if (!CallSid) {
            return res.status(400).send('<Response></Response>');
        }
        let companyId;
        try {
            companyId = await resolveWebhookCompanyId(req.body, 'voice_dial_action');
        } catch (error) {
            if (error.code === 'TWILIO_TENANT_UNRESOLVED') {
                return res.status(403).type('text/xml').send(buildHangupTwiml());
            }
            throw error;
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
            if (ingestErr.code === 'TWILIO_TENANT_UNRESOLVED') {
                return res.status(403).type('text/xml').send(buildHangupTwiml());
            }
            console.error(`[${traceId}] Inbox ingestion failed (non-blocking):`, ingestErr.message);
        }

        // SARA-BACKUP-HARDEN-001: any flow-engine failure here must NOT bubble
        // to the outer catch (a 500 makes Twilio drop the live caller) — log it
        // and fall through to the legacy voicemail branch below, which answers.
        try {
            const execution = await callFlowRuntime.getExecution(CallSid, companyId);
            if (execution && execution.status === 'active') {
                // vapi_agent nodes mark their Dial action with ?vapiNode=1 so the
                // real DialCallStatus maps to a vapi.* event (completed → end call,
                // failure/timeout → follow the node's fallback edge).
                const flowEvent = req.query.flowEvent
                    || (req.query.vapiNode ? callFlowRuntime.vapiEventFromDialStatus(dialStatus) : callFlowRuntime.eventFromDialStatus(dialStatus));
                const flowTwiml = await callFlowRuntime.advance(CallSid, flowEvent, traceId, companyId);
                if (flowTwiml) {
                    res.type('text/xml');
                    return res.send(flowTwiml);
                }
            }
        } catch (flowErr) {
            console.error(`[${traceId}] Call-flow advance crashed — falling back to voicemail route:`, flowErr.stack || flowErr.message);
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
    console.log(`[${traceId}] Voicemail complete webhook received`);

    try {
        if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
            return res.status(403).send('<Response></Response>');
        }

        const callSid = req.body.CallSid;
        if (!callSid) {
            return res.status(400).type('text/xml').send(buildHangupTwiml());
        }
        let companyId;
        try {
            companyId = await resolveWebhookCompanyId(req.body, 'voicemail_complete');
        } catch (error) {
            if (error.code === 'TWILIO_TENANT_UNRESOLVED') {
                return res.status(403).type('text/xml').send(buildHangupTwiml());
            }
            throw error;
        }
        const flowEvent = req.query.flowEvent || 'voicemail.recorded';
        const flowTwiml = await callFlowRuntime.advance(callSid, flowEvent, traceId, companyId);

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
    if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
        return res.status(403).json({ error: 'Invalid signature' });
    }
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
        if (e.code === 'TWILIO_TENANT_UNRESOLVED') {
            return res.status(403).type('text/xml').send('<Response><Reject/></Response>');
        }
        console.error(`[${traceId}] Fallback inbox error:`, e.message);
    }
    console.error(`[${traceId}] VOICE FALLBACK triggered`, {
        errorCode: req.body.ErrorCode || null,
    });

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
    handleMaskingCode,
    handleMaskingConsent,
    handleMaskingDialAction,
    validateTwilioSignature,
    resolveWebhookCompanyId,
    ingestToInbox,
    generateEventKey,
    mediaStreamUrl,
    buildBlacklistRejectTwiml,
    buildMaskingGatherTwiml,
    buildMaskingDialTwiml,
};
