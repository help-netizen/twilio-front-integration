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
const { isContactBusy } = require('../services/callAvailability');
const { groupsForUser } = require('../services/groupRouting');
const agentPresence = require('../services/agentPresence');
const { buildSoftphoneIdentity, parseSoftphoneIdentity } = require('../services/softphoneIdentity');

function getCompanyId(req) {
    return req.companyFilter?.company_id;
}

function getCurrentUserId(req) {
    return req.user?.crmUser?.id || req.user?.sub || null;
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildMessageTwiml(message) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>${escapeXml(message)}</Say>
    <Hangup />
</Response>`;
}

async function validateOutboundCallerId({ callerId, from }) {
    const normalizedCallerId = toE164(callerId);
    if (!normalizedCallerId) {
        return { ok: false, status: 400, message: 'Invalid caller ID.' };
    }

    const identity = parseSoftphoneIdentity(from);
    if (!identity?.companyId || !identity?.userId) {
        return { ok: false, status: 403, message: 'Caller ID is not available for this softphone identity.' };
    }

    const db = require('../db/connection');
    const result = await db.query(
        `SELECT pns.phone_number
         FROM phone_number_settings pns
         JOIN user_groups ug
           ON ug.id = pns.group_id
          AND ug.company_id = pns.company_id::text
         JOIN user_group_members ugm
           ON ugm.group_id = ug.id
          AND ugm.user_id = $3
          AND COALESCE(ugm.is_active, true) = true
         JOIN company_memberships cm
           ON cm.user_id::text = ugm.user_id
          AND cm.company_id::text = ug.company_id
         JOIN company_user_profiles cup
           ON cup.membership_id = cm.id
          AND COALESCE(cup.phone_calls_allowed, false) = true
         WHERE pns.phone_number = $1
           AND pns.company_id::text = $2
           AND pns.routing_mode = 'client'
           AND pns.group_id IS NOT NULL
         LIMIT 1`,
        [normalizedCallerId, String(identity.companyId), String(identity.userId)]
    );
    if (result.rows.length === 0) {
        return { ok: false, status: 403, message: 'Caller ID is not assigned to this user group.' };
    }

    return { ok: true, callerId: normalizedCallerId, companyId: identity.companyId, userId: identity.userId };
}

async function getMyGroups(req) {
    const companyId = getCompanyId(req);
    const userId = getCurrentUserId(req);
    if (!companyId || !userId) return [];
    return groupsForUser(userId, companyId, { includeAllForDev: req.user?._devMode && !req.user?.crmUser?.id });
}

// ─── Authenticated router (token endpoint) ──────────────────────────────────
const tokenRouter = express.Router();

/**
 * GET /api/voice/token
 * Returns a short-lived Twilio Access Token for the authenticated user.
 * Only issues token if user has phone_calls_allowed = true.
 */
tokenRouter.get('/token', async (req, res) => {
    try {
        const userId = getCurrentUserId(req);
        const companyId = getCompanyId(req);
        if (!userId || !companyId) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        // Check phone_calls_allowed
        const db = require('../db/connection');
        let allowed = req.user?._devMode === true;
        if (!allowed) {
            const permResult = await db.query(
                `SELECT COALESCE(p.phone_calls_allowed, false) as allowed
                 FROM company_memberships m
                 LEFT JOIN company_user_profiles p ON p.membership_id = m.id
                 WHERE m.user_id = $1 AND m.company_id = $2`,
                [userId, companyId]
            );
            allowed = permResult.rows[0]?.allowed === true;
        }
        const myGroups = await getMyGroups(req);
        allowed = allowed && myGroups.length > 0;
        if (!allowed) {
            return res.json({ allowed: false });
        }

        const identity = buildSoftphoneIdentity(companyId, userId);
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
        const userId = getCurrentUserId(req);
        const companyId = getCompanyId(req);
        if (!userId) return res.json({ allowed: false });

        const db = require('../db/connection');
        let allowed = req.user?._devMode === true;
        if (!allowed) {
            const r = await db.query(
                `SELECT COALESCE(p.phone_calls_allowed, false) as allowed
                 FROM company_memberships m
                 LEFT JOIN company_user_profiles p ON p.membership_id = m.id
                 WHERE m.user_id = $1 AND m.company_id = $2`,
                [userId, companyId]
            );
            allowed = r.rows[0]?.allowed === true;
        }
        const myGroups = await getMyGroups(req);
        res.json({ allowed: allowed && myGroups.length > 0, groups_count: myGroups.length });
    } catch (err) {
        console.error('[Voice] Phone access check error:', err.message);
        res.json({ allowed: false });
    }
});

/**
 * POST /api/voice/presence
 * Softphone lifecycle heartbeat: available | on_call | offline.
 */
tokenRouter.post('/presence', async (req, res) => {
    try {
        const userId = getCurrentUserId(req);
        const companyId = getCompanyId(req);
        const status = req.body?.status;
        if (!userId || !companyId) return res.status(401).json({ ok: false, error: 'No user/company context' });
        const myGroups = await getMyGroups(req);
        if (myGroups.length === 0) return res.status(403).json({ ok: false, error: 'User is not assigned to any group' });

        const presence = await agentPresence.setAgentStatus(userId, companyId, status, { source: 'voice.presence' });
        res.json({ ok: true, data: presence });
    } catch (err) {
        console.error('[Voice] Presence update error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to update presence' });
    }
});

/**
 * GET /api/voice/check-busy?phone=+15085140320
 * Returns whether a phone number currently has an active call.
 * Used to prevent two users from calling the same number simultaneously.
 */
tokenRouter.get('/check-busy', async (req, res) => {
    try {
        const phone = req.query.phone;
        if (!phone) return res.json({ busy: false });

        const normalized = toE164(phone);
        const busy = await isContactBusy(normalized, 'check-busy');

        if (busy) {
            return res.json({
                busy: true,
                message: 'A team member is already on the line with this contact. Please try again later.',
            });
        }

        res.json({ busy: false });
    } catch (err) {
        console.error('[Voice] Check-busy error:', err.message);
        res.json({ busy: false }); // fail-open
    }
});

/**
 * GET /api/voice/blanc-numbers
 * F017: caller ID picker only shows numbers assigned to the user's groups.
 */
tokenRouter.get('/blanc-numbers', async (req, res) => {
    try {
        const db = require('../db/connection');
        const companyId = getCompanyId(req);
        const userId = getCurrentUserId(req);
        if (!companyId || !userId) return res.json({ ok: true, numbers: [] });

        const defaultCallerId = process.env.SOFTPHONE_CALLER_ID || '';
        const includeAllForDev = req.user?._devMode && !req.user?.crmUser?.id;
        const params = [companyId, defaultCallerId];
        const membershipJoin = includeAllForDev
            ? ''
            : 'JOIN user_group_members ugm ON ugm.group_id = ug.id AND ugm.user_id = $3 AND COALESCE(ugm.is_active, true) = true';
        if (!includeAllForDev) params.push(String(userId));

        const result = await db.query(
            `SELECT
                    pns.phone_number,
                    pns.friendly_name,
                    ug.id AS group_id,
                    ug.name AS group_name
             FROM phone_number_settings pns
             JOIN user_groups ug
               ON ug.id = pns.group_id
              AND ug.company_id = pns.company_id::text
             ${membershipJoin}
             WHERE pns.company_id = $1
               AND pns.routing_mode = 'client'
             ORDER BY (pns.phone_number = $2) DESC, pns.phone_number`,
            params
        );
        res.json({ ok: true, numbers: result.rows });
    } catch (err) {
        console.error('[Voice] Failed to fetch blanc numbers:', err.message);
        res.json({ ok: true, numbers: [] });
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
    const requestedCallerId = req.body.CallerId || process.env.SOFTPHONE_CALLER_ID || process.env.TWILIO_PHONE_NUMBER;
    const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://abc-metrics.fly.dev';
    const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;
    const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;
    const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;

    console.log('[Voice TwiML] Outbound request:', {
        to,
        callerId: requestedCallerId,
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
        res.type('text/xml').send(buildMessageTwiml('Invalid phone number.'));
        return;
    }

    let callerId;
    let validatedCompanyId = null;
    try {
        const validation = await validateOutboundCallerId({ callerId: requestedCallerId, from: req.body.From });
        if (!validation.ok) {
            res.status(validation.status || 403);
            res.type('text/xml').send(buildMessageTwiml(validation.message || 'Caller ID is not allowed.'));
            return;
        }
        callerId = validation.callerId;
        validatedCompanyId = validation.companyId;
    } catch (err) {
        console.error('[Voice TwiML] Caller ID validation error:', err.message);
        res.status(500);
        res.type('text/xml').send(buildMessageTwiml('Caller ID validation failed.'));
        return;
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial callerId="${escapeXml(callerId)}"
          timeout="25"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
        <Number statusCallback="${statusCallbackUrl}"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">${escapeXml(normalized)}</Number>
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
            const timeline = await queries.findOrCreateTimeline(normalized, validatedCompanyId);
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
                companyId: validatedCompanyId,
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

module.exports = { tokenRouter, twimlRouter };
