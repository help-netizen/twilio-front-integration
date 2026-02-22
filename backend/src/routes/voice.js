/**
 * Voice API Routes — SoftPhone (Twilio Voice JS SDK)
 *
 * Provides:
 *   GET  /api/voice/token           — Mint Access Token (Keycloak-authed)
 *   POST /api/voice/twiml/outbound  — TwiML for SDK-initiated outbound calls (Twilio-called)
 *   POST /api/voice/twiml/inbound   — TwiML for inbound calls → route to <Client> (Twilio-called)
 */

const express = require('express');
const { generateToken } = require('../services/voiceService');
const { toE164 } = require('../utils/phoneUtils');

// ─── Authenticated router (token endpoint) ──────────────────────────────────
const tokenRouter = express.Router();

/**
 * GET /api/voice/token
 * Returns a short-lived Twilio Access Token for the authenticated user.
 * Only issues token if user has phone_calls_allowed = true.
 */
tokenRouter.get('/token', async (req, res) => {
    try {
        const userId = req.user?.crmUser?.id;
        const companyId = req.user?.company_id;
        if (!userId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        // Check phone_calls_allowed
        const db = require('../db/connection');
        const permResult = await db.query(
            `SELECT COALESCE(phone_calls_allowed, false) as allowed
             FROM company_memberships WHERE user_id = $1 AND company_id = $2`,
            [userId, companyId]
        );
        const allowed = permResult.rows[0]?.allowed === true;
        if (!allowed) {
            return res.json({ allowed: false });
        }

        const identity = `user_${userId}`;
        const result = generateToken(identity);

        res.json({ ...result, allowed: true });
    } catch (err) {
        console.error('[Voice] Token generation error:', err.message);
        res.status(500).json({ error: 'Failed to generate voice token' });
    }
});

/**
 * GET /api/voice/phone-access
 * Lightweight check: is phone calling enabled for this user?
 */
tokenRouter.get('/phone-access', async (req, res) => {
    try {
        const userId = req.user?.crmUser?.id;
        const companyId = req.user?.company_id;
        if (!userId) return res.json({ allowed: false });

        const db = require('../db/connection');
        const r = await db.query(
            `SELECT COALESCE(phone_calls_allowed, false) as allowed
             FROM company_memberships WHERE user_id = $1 AND company_id = $2`,
            [userId, companyId]
        );
        res.json({ allowed: r.rows[0]?.allowed === true });
    } catch (err) {
        console.error('[Voice] Phone access check error:', err.message);
        res.json({ allowed: false });
    }
});

// ─── TwiML router (Twilio-called, no auth) ──────────────────────────────────
const twimlRouter = express.Router();

/**
 * POST /api/voice/twiml/outbound
 * Called by Twilio when the browser SDK initiates an outbound call via Device.connect().
 * Returns TwiML that dials the PSTN number.
 */
twimlRouter.post('/twiml/outbound', async (req, res) => {
    const to = req.body.To;
    // Allow client to specify caller ID (from Blanc phone settings); fall back to env var
    const callerId = req.body.CallerId || process.env.SOFTPHONE_CALLER_ID || process.env.TWILIO_PHONE_NUMBER;
    const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://abc-metrics.fly.dev';
    const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;
    const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;
    const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;

    console.log('[Voice TwiML] Outbound request:', {
        to,
        callerId,
        from: req.body.From,
        callSid: req.body.CallSid,
    });

    if (!to) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>No destination number provided.</Say>
</Response>`;
        res.type('text/xml').send(twiml);
        return;
    }

    // Normalize and validate
    const normalized = toE164(to);
    if (!normalized) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Invalid phone number.</Say>
</Response>`;
        res.type('text/xml').send(twiml);
        return;
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial callerId="${callerId}"
          timeout="25"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
        <Number statusCallback="${statusCallbackUrl}"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">${normalized}</Number>
    </Dial>
</Response>`;

    console.log('[Voice TwiML] Outbound TwiML generated for:', normalized);
    res.type('text/xml').send(twiml);

    // Create parent call record immediately so it appears in timeline right away
    const callSid = req.body.CallSid;
    if (callSid) {
        try {
            const db = require('../db/connection');
            const queries = require('../db/queries');
            const realtimeService = require('../services/realtimeService');

            // Resolve timeline for the dialed number
            const timeline = await queries.findOrCreateTimeline(normalized, null);
            const timelineId = timeline.id;
            const contactId = timeline.contact_id || null;

            const call = await queries.upsertCall({
                callSid,
                parentCallSid: null,
                contactId,
                timelineId,
                direction: 'outbound',
                fromNumber: callerId,
                toNumber: normalized,
                status: 'initiated',
                isFinal: false,
                startedAt: new Date(),
                answeredAt: null,
                endedAt: null,
                durationSec: null,
                price: null,
                priceUnit: null,
                lastEventTime: new Date(),
                rawLastPayload: req.body,
            });

            if (call) {
                realtimeService.publishCallUpdate({ eventType: 'call.updated', ...call });
                console.log('[Voice TwiML] Initial call record created:', callSid);
            }
        } catch (err) {
            console.warn('[Voice TwiML] Failed to create initial call record (non-blocking):', err.message);
        }
    }
});

/**
 * POST /api/voice/twiml/inbound
 * Called by Twilio when an inbound call arrives at the Twilio phone number.
 * Routes to <Client> identity for WebRTC delivery.
 *
 * IMPORTANT: This also ingests the initial call event into webhook_inbox
 * so the parent call (with correct From=caller) is stored. Without this,
 * only child <Client> status callbacks would be processed, and those
 * have From=company_number instead of the caller's number.
 */
twimlRouter.post('/twiml/inbound', async (req, res) => {
    const defaultIdentity = process.env.SOFTPHONE_DEFAULT_IDENTITY || 'user_1';
    const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://abc-metrics.fly.dev';
    const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;
    const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;
    const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;

    console.log('[Voice TwiML] Inbound request:', {
        from: req.body.From,
        to: req.body.To || req.body.Called,
        callSid: req.body.CallSid,
        targetIdentity: defaultIdentity,
    });

    // ── Ingest parent call into webhook_inbox (same as handleVoiceInbound) ──
    // This ensures the call record has the correct From (caller) number.
    try {
        const queries = require('../db/queries');
        const { CallSid } = req.body;
        if (CallSid) {
            const eventKey = `voice:${CallSid}:inbound-softphone:${Date.now()}`;
            await queries.insertInboxEvent({
                eventKey,
                source: 'voice',
                eventType: 'call.inbound',
                eventTime: new Date(),
                callSid: CallSid,
                recordingSid: null,
                transcriptionSid: null,
                payload: req.body,
                headers: {
                    'x-twilio-signature': req.headers['x-twilio-signature'],
                    'i-twilio-idempotency-token': req.headers['i-twilio-idempotency-token'],
                },
            });
            console.log('[Voice TwiML] Inbound call ingested into webhook_inbox:', CallSid);
        }
    } catch (ingestErr) {
        // Non-blocking — still return TwiML even if ingestion fails
        console.error('[Voice TwiML] Ingestion error (non-blocking):', ingestErr.message);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="25"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
        <Client statusCallback="${statusCallbackUrl}"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">${defaultIdentity}</Client>
    </Dial>
</Response>`;

    console.log('[Voice TwiML] Inbound TwiML generated, routing to:', defaultIdentity);
    res.type('text/xml').send(twiml);
});

/**
 * GET /api/voice/blanc-numbers
 * Returns phone numbers configured as Blanc (routing_mode='client') for caller ID picker.
 */
twimlRouter.get('/blanc-numbers', async (req, res) => {
    try {
        const db = require('../db/connection');
        const result = await db.query(
            `SELECT phone_number, friendly_name FROM phone_number_settings WHERE routing_mode = 'client' ORDER BY phone_number`
        );
        res.json({ ok: true, numbers: result.rows });
    } catch (err) {
        console.error('[Voice] Failed to fetch blanc numbers:', err.message);
        // Fallback: return empty list so UI still works
        res.json({ ok: true, numbers: [] });
    }
});

module.exports = { tokenRouter, twimlRouter };
