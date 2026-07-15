const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');

// PF007-HARDENING-002: calls surface requires call-history visibility
// (reports.calls.view) or pulse access; telephony actions need phone perms.
const callsRead = requirePermission('reports.calls.view', 'pulse.view');
router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return callsRead(req, res, next);
    return next(); // writes guarded per-route below
});
const queries = require('../db/queries');
const emailQueries = require('../db/emailQueries');
const db = require('../db/connection');
const fetch = require('node-fetch');
const { generateCallSummary } = require('../services/callSummaryService');
const { getTwilioClient } = require('../services/twilioClient');
const operationsDashboard = require('../services/operationsDashboard');
const agentPresence = require('../services/agentPresence');
const { buildSoftphoneIdentity } = require('../services/softphoneIdentity');

// =============================================================================
// GET /api/calls — list calls with cursor pagination
// =============================================================================
router.get('/', async (req, res) => {
    try {
        const {
            cursor,
            limit = 50,
            status,
            has_recording,
            has_transcript,
            contact_id,
            date_from,
            date_to,
            root_only,
            group_id,
        } = req.query;

        const isoDate = /^\d{4}-\d{2}-\d{2}$/;
        const dateFrom = typeof date_from === 'string' && isoDate.test(date_from) ? date_from : undefined;
        const dateTo = typeof date_to === 'string' && isoDate.test(date_to) ? date_to : undefined;

        const companyId = req.companyFilter?.company_id;
        const result = await queries.getCalls({
            cursor: cursor ? parseInt(cursor) : undefined,
            limit: Math.min(parseInt(limit) || 50, 200),
            status: status || undefined,
            hasRecording: has_recording === 'true' ? true : undefined,
            hasTranscript: has_transcript === 'true' ? true : undefined,
            contactId: contact_id ? parseInt(contact_id) : undefined,
            companyId,
            dateFrom,
            dateTo,
            rootOnly: root_only === 'true' ? true : undefined,
            groupId: group_id || undefined,
            providerScope: getProviderScope(req),
        });

        res.json({
            calls: result.calls.map(formatCall),
            next_cursor: result.nextCursor,
            count: result.calls.length,
        });
    } catch (error) {
        console.error('Error fetching calls:', error);
        res.status(500).json({ error: 'Failed to fetch calls' });
    }
});

// =============================================================================
// GET /api/calls/active — active (non-final) calls
// =============================================================================
router.get('/active', async (req, res) => {
    try {
        const calls = await queries.getActiveCalls(req.companyFilter?.company_id);
        res.json({
            active_calls: calls.map(formatCall),
            count: calls.length,
        });
    } catch (error) {
        console.error('Error fetching active calls:', error);
        res.status(500).json({ error: 'Failed to fetch active calls' });
    }
});

// =============================================================================
// GET /api/calls/operations-dashboard — F017 group-aware operations dashboard
// =============================================================================
router.get('/operations-dashboard', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const data = await operationsDashboard.getOperationsDashboard(companyId);
        res.json({ ok: true, data });
    } catch (error) {
        console.error('Error fetching operations dashboard:', error);
        res.status(500).json({ ok: false, error: 'Failed to fetch operations dashboard' });
    }
});

// =============================================================================
// GET /api/calls/by-contact — grouped by timeline (conversations replacement)
// =============================================================================
router.get('/by-contact', async (req, res) => {
    try {
        // LIST-PAGINATION-001: tenant scope is mandatory. A read with no company
        // context must never fall through to an unscoped (cross-tenant) query.
        const companyId = req.companyFilter?.company_id;
        if (!companyId) {
            return res.status(401).json({ error: 'No company context' });
        }

        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const search = req.query.search || null;

        // MAIL-MUTE-001: resolve this company's `from:`-derived muted sender set
        // (literal emails/domains) from the ~60s-cached Mail Secretary settings, so
        // an excluded vendor's EMAIL signal drops out of the Pulse list. This is the
        // ONLY caller that passes non-empty muted sets; every other
        // getUnifiedTimelinePage caller defaults to [] (byte-identical behavior).
        // getMutedSenderSet is already fail-open (returns an empty set on error /
        // inactive Mail Secretary); the extra try/catch here keeps the Pulse list
        // fail-open at the ROUTE boundary too — a mute-resolution failure must never
        // 500 or drop rows (FR-10 / S9), it just degrades to today's behavior.
        let mutedEmails = [];
        let mutedDomains = [];
        try {
            ({ emails: mutedEmails, domains: mutedDomains } =
                await require('../services/mailAgentService').getMutedSenderSet(companyId));
        } catch (muteErr) {
            console.warn('[by-contact] muted-sender resolution failed (non-blocking):', muteErr.message);
        }

        // ONE unified, SQL-ordered, offset/limit page across calls + SMS + email.
        // Ordering, unread rollup, dedup (one row per timeline) and `total` all
        // come from SQL — the route no longer over-fetches or re-sorts in JS.
        const rows = await queries.getUnifiedTimelinePage({ limit, offset, companyId, search, mutedEmails, mutedDomains });

        // total = COUNT(*) OVER() on the unified set (0 rows ⇒ empty page ⇒ 0).
        const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

        // Pick the first non-SIP phone from candidates.
        const pickPhone = (...candidates) => {
            for (const p of candidates) {
                if (p && !p.startsWith('sip:')) return p;
            }
            return candidates.find(Boolean) || '';
        };

        // Map rows in DB order — NO re-sort, NO dedup (both are done in SQL now).
        const conversations = rows.map(c => {
            const formatted = formatCall(c);
            const tlPhone = c.tl_phone || null;

            const callTime = c.started_at ? new Date(c.started_at).getTime() : null;
            const smsTime = c.sms_last_message_at ? new Date(c.sms_last_message_at).getTime() : null;
            const emailTime = c.email_last_message_at ? new Date(c.email_last_message_at).getTime() : null;

            // Determine which channel produced the most recent interaction. On an
            // exact tie the preference is call > sms > email (matches `>` below,
            // which only switches when a later channel is strictly greater).
            let last_interaction_at = c.started_at || null;
            let last_interaction_type = callTime != null ? 'call' : null;
            let last_interaction_phone = '';

            if (callTime != null) {
                const isInbound = (c.direction || '').includes('inbound');
                const candidatePhone = isInbound ? c.from_number : c.to_number;
                last_interaction_phone = pickPhone(candidatePhone, tlPhone, c.contact?.phone_e164, c.from_number, c.to_number);
            }
            if (smsTime != null && (callTime == null || smsTime > callTime)) {
                last_interaction_at = c.sms_last_message_at;
                last_interaction_type = c.sms_last_message_direction === 'inbound' ? 'sms_inbound' : 'sms_outbound';
                last_interaction_phone = pickPhone(tlPhone, c.contact?.phone_e164, c.from_number, c.to_number);
            }
            const bestSoFar = Math.max(callTime ?? -Infinity, smsTime ?? -Infinity);
            if (emailTime != null && emailTime > bestSoFar) {
                last_interaction_at = c.email_last_message_at;
                last_interaction_type = c.email_last_message_direction === 'inbound' ? 'email_inbound' : 'email_outbound';
                // Email carries no phone; keep the timeline/contact phone if any.
                last_interaction_phone = pickPhone(tlPhone, c.contact?.phone_e164);
            }

            return {
                ...formatted,
                timeline_id: c.tl_id || c.timeline_id || null,
                // YELP-TIMELINE-DEDUP-001: a contactless conv-id timeline has no contact,
                // so formatCall (call-fields only) leaves the row with no name. The unified
                // query denormalizes tl.display_name / tl.external_source for exactly this
                // case; carry them through so PulseContactItem can label the row ("Jenna")
                // + badge its Yelp origin instead of rendering a blank title.
                display_name: c.display_name || null,
                external_source: c.external_source || null,
                tl_phone: tlPhone,
                tl_has_unread: c.tl_has_unread || false,
                has_unread: !!c.any_unread,
                sms_has_unread: c.sms_has_unread || false,
                sms_conversation_id: c.sms_conversation_id || null,
                email_thread_id: c.email_thread_id || null,
                last_interaction_at,
                last_interaction_type,
                last_interaction_phone,
                // Action Required fields
                is_action_required: c.is_action_required || false,
                action_required_reason: c.action_required_reason || null,
                action_required_set_at: c.action_required_set_at || null,
                snoozed_until: c.snoozed_until || null,
                owner_user_id: c.owner_user_id || null,
                // AR-TASK-UNIFY-001: "Action Required" is derived from open tasks.
                has_open_task: !!c.open_task_id,
                open_task_count: Number(c.open_task_count) || 0,
                open_task: c.open_task_id ? {
                    id: c.open_task_id,
                    title: c.open_task_title,
                    description: c.open_task_description || null,
                    due_at: c.open_task_due_at,
                    priority: c.open_task_priority,
                    // MAIL-AGENT-001: agent tasks carry the triage comment for the AR bar.
                    kind: c.open_task_kind || 'user',
                    agent_output: c.open_task_agent_output || null,
                    // OUTBOUND-PARTS-CALL-BTN-001: typed action buttons for the AR bar.
                    actions: c.open_task_actions || null,
                    // SLOTPICK-001 (SP-03): the task's parent (job) id/type so the Pulse AR
                    // robot-call button can getJob(jobId) for coords — mirrors TaskCard's
                    // parent_type/parent_id. Additive.
                    parent_id: c.open_task_parent_id ?? null,
                    parent_type: c.open_task_parent_type || null,
                } : null,
            };
        });

        // Enrich: batch-resolve leads for all phone numbers (1 query instead of N).
        let leads_map = {};
        try {
            const leadsService = require('../services/leadsService');
            const phones = conversations.map(c =>
                c.tl_phone || c.contact?.phone_e164 || c.from_number || c.to_number || ''
            ).filter(Boolean);
            if (phones.length > 0) {
                leads_map = await leadsService.getLeadsByPhones(phones, companyId);
            }
        } catch (leadsErr) {
            console.warn('[by-contact] Leads enrichment failed (non-blocking):', leadsErr.message);
        }

        res.json({
            conversations,
            leads_map,
            total,
            limit,
            offset,
        });
    } catch (error) {
        console.error('Error fetching calls by contact:', error);
        res.status(500).json({ error: 'Failed to fetch calls by contact' });
    }
});

// =============================================================================
// POST /api/calls/contact/:contactId/mark-read — team-wide mark read
// =============================================================================
router.post('/contact/:contactId/mark-read', requirePermission('pulse.view', 'reports.calls.view'), async (req, res) => {
    try {
        const { contactId } = req.params;
        console.log(`[MARK-READ-DEBUG] POST /contact/${contactId}/mark-read called`, {
            referer: req.headers.referer || req.headers.referrer,
            origin: req.headers.origin,
            userAgent: (req.headers['user-agent'] || '').substring(0, 80),
        });
        const contact = await queries.markContactRead(parseInt(contactId));
        if (!contact) {
            return res.status(404).json({ error: 'Contact not found' });
        }
        // SSE broadcast so all users see the read state
        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('contact.read', { contactId: parseInt(contactId) });
        res.json({ contact });
    } catch (error) {
        console.error('Error marking contact read:', error);
        res.status(500).json({ error: 'Failed to mark contact read' });
    }
});

// =============================================================================
// POST /api/calls/contact/:contactId/mark-unread — team-wide mark unread
// =============================================================================
router.post('/contact/:contactId/mark-unread', requirePermission('pulse.view', 'reports.calls.view'), async (req, res) => {
    try {
        const { contactId } = req.params;
        const contact = await queries.markContactUnread(parseInt(contactId));
        if (!contact) {
            return res.status(404).json({ error: 'Contact not found' });
        }
        // SSE broadcast so all users see the unread state
        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('contact.unread', { contactId: parseInt(contactId) });
        res.json({ contact });
    } catch (error) {
        console.error('Error marking contact unread:', error);
        res.status(500).json({ error: 'Failed to mark contact unread' });
    }
});

// =============================================================================
// POST /api/calls/timeline/:timelineId/mark-read — mark timeline as read
// =============================================================================
router.post('/timeline/:timelineId/mark-read', requirePermission('pulse.view', 'reports.calls.view'), async (req, res) => {
    try {
        const { timelineId } = req.params;
        const companyId = req.companyFilter?.company_id;
        const tl = await queries.markTimelineRead(parseInt(timelineId));
        if (!tl) return res.status(404).json({ error: 'Timeline not found' });
        // Also mark contact read if linked
        if (tl.contact_id) {
            await queries.markContactRead(tl.contact_id).catch(() => { });
        }
        // Also mark linked SMS conversations as read
        try {
            const dbConn = require('../db/connection');
            const digits = new Set();
            if (tl.phone_e164) digits.add(tl.phone_e164.replace(/\D/g, ''));
            if (tl.contact_id) {
                const cResult = await dbConn.query(
                    'SELECT phone_e164, secondary_phone FROM contacts WHERE id = $1',
                    [tl.contact_id]
                );
                const co = cResult.rows[0];
                if (co?.phone_e164) digits.add(co.phone_e164.replace(/\D/g, ''));
                if (co?.secondary_phone) digits.add(co.secondary_phone.replace(/\D/g, ''));
            }
            if (digits.size > 0) {
                await dbConn.query(
                    `UPDATE sms_conversations SET has_unread = false, last_read_at = now(), updated_at = now()
                     WHERE has_unread = true AND customer_digits = ANY($1)`,
                    [[...digits]]
                );
            }
        } catch (smsErr) {
            console.warn('[mark-read] SMS conversation mark-read failed:', smsErr.message);
        }
        // PULSE-READ-EMAIL-001: clear the same inbound- and outbound-linked email
        // threads that contribute email_threads.unread_count to the Pulse list.
        if (tl.contact_id) {
            await emailQueries.markContactEmailThreadsRead(tl.contact_id, companyId)
                .catch((emailErr) => {
                    console.warn('[mark-read] email thread mark-read failed:', emailErr.message);
                });
        }
        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('timeline.read', { timelineId: parseInt(timelineId) });
        res.json({ timeline: tl });
    } catch (error) {
        console.error('Error marking timeline read:', error);
        res.status(500).json({ error: 'Failed to mark timeline read' });
    }
});

// =============================================================================
// POST /api/calls/timeline/:timelineId/mark-unread — mark timeline as unread
// =============================================================================
router.post('/timeline/:timelineId/mark-unread', requirePermission('pulse.view', 'reports.calls.view'), async (req, res) => {
    try {
        const { timelineId } = req.params;
        const tl = await queries.markTimelineUnread(parseInt(timelineId));
        if (!tl) return res.status(404).json({ error: 'Timeline not found' });
        // Also mark contact unread if linked
        if (tl.contact_id) {
            await queries.markContactUnread(tl.contact_id).catch(() => { });
        }
        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('timeline.unread', { timelineId: parseInt(timelineId) });
        res.json({ timeline: tl });
    } catch (error) {
        console.error('Error marking timeline unread:', error);
        res.status(500).json({ error: 'Failed to mark timeline unread' });
    }
});

// =============================================================================
// GET /api/calls/contact/:contactId — all calls for a contact
// =============================================================================
router.get('/contact/:contactId', async (req, res) => {
    try {
        const calls = await queries.getCallsByContactId(parseInt(req.params.contactId));
        res.json({ calls: calls.map(formatCall), count: calls.length });
    } catch (error) {
        console.error('Error fetching contact calls:', error);
        res.status(500).json({ error: 'Failed to fetch contact calls' });
    }
});

// =============================================================================
// POST /api/calls/:callSid/transfer — F017 cold transfer to another group agent
// =============================================================================
router.post('/:callSid/transfer', requirePermission('phone_calls.use'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { callSid } = req.params;
        const { target_user_id } = req.body || {};
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });
        if (!target_user_id) return res.status(400).json({ ok: false, error: 'target_user_id is required' });

        const execution = await db.query(
            `SELECT cfe.call_sid, cfe.group_id, ug.name AS group_name
             FROM call_flow_executions cfe
             JOIN user_groups ug
               ON ug.id = cfe.group_id
              AND ug.company_id = cfe.company_id::text
             WHERE cfe.call_sid = $1
               AND cfe.company_id = $2
             ORDER BY cfe.created_at DESC
             LIMIT 1`,
            [callSid, companyId]
        );
        const row = execution.rows[0];
        if (!row) return res.status(404).json({ ok: false, error: 'Active group call not found' });

        const member = await db.query(
            `SELECT
                 ugm.user_id,
                 COALESCE(cu.full_name, cu.email, ugm.user_id) AS name,
                 COALESCE(cup.phone_calls_allowed, false) AS phone_calls_allowed
             FROM user_group_members ugm
             JOIN user_groups ug
               ON ug.id = ugm.group_id
              AND ug.company_id = $3
             LEFT JOIN crm_users cu ON cu.id::text = ugm.user_id
             LEFT JOIN company_memberships cm
               ON cm.user_id::text = ugm.user_id
              AND cm.company_id::text = ug.company_id
             LEFT JOIN company_user_profiles cup ON cup.membership_id = cm.id
             WHERE ugm.group_id = $1
               AND ugm.user_id = $2
               AND COALESCE(ugm.is_active, true) = true
             LIMIT 1`,
            [row.group_id, String(target_user_id), companyId]
        );
        if (member.rows.length === 0) {
            return res.status(403).json({ ok: false, error: 'Target agent is not a member of this call group' });
        }
        if (member.rows[0].phone_calls_allowed !== true) {
            return res.status(403).json({ ok: false, error: 'Target agent is not enabled for phone calls' });
        }
        if ((await agentPresence.getAgentStatus(String(target_user_id), companyId)) !== 'available') {
            return res.status(409).json({ ok: false, error: 'Target agent is not available for transfer' });
        }

        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
            return res.status(503).json({ ok: false, error: 'Twilio REST credentials are not configured' });
        }

        const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://api.albusto.com';
        const targetIdentity = buildSoftphoneIdentity(companyId, target_user_id);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial answerOnBridge="true"
          action="${baseUrl}/webhooks/twilio/voice-dial-action?flowEvent=call.handoff"
          method="POST">
        <Client>${escapeXml(targetIdentity)}</Client>
    </Dial>
</Response>`;

        const client = getTwilioClient();
        try {
            await client.calls(callSid).update({ twiml });
        } catch (twilioError) {
            console.warn('Twilio transfer update failed:', {
                status: twilioError.status,
                code: twilioError.code,
                message: twilioError.message,
            });
            const statusCode = twilioError.status === 404 || twilioError.code === 20404 ? 404 : 502;
            return res.status(statusCode).json({
                ok: false,
                error: 'Twilio could not update the active call',
                twilio_status: twilioError.status || null,
                twilio_code: twilioError.code || null,
            });
        }

        res.json({
            ok: true,
            data: {
                call_sid: callSid,
                group_id: row.group_id,
                target_user_id: String(target_user_id),
                target_identity: targetIdentity,
                target_name: member.rows[0].name,
            },
        });
    } catch (error) {
        console.error('Error transferring call:', error);
        res.status(500).json({ ok: false, error: 'Failed to transfer call' });
    }
});

// =============================================================================
// GET /api/calls/:callSid — single call detail
// =============================================================================
router.get('/:callSid', async (req, res) => {
    try {
        const call = await queries.getCallByCallSid(req.params.callSid, req.companyFilter?.company_id);
        if (!call) {
            return res.status(404).json({ error: 'Call not found' });
        }
        res.json({ call: formatCall(call) });
    } catch (error) {
        console.error('Error fetching call:', error);
        res.status(500).json({ error: 'Failed to fetch call' });
    }
});

// =============================================================================
// GET /api/calls/:callSid/recording.mp3 — proxy audio from Twilio
// =============================================================================
router.get('/:callSid/recording.mp3', async (req, res) => {
    try {
        const media = await queries.getCallMedia(req.params.callSid);
        const recording = media.recordings?.[0];

        if (!recording || recording.status !== 'completed') {
            return res.status(404).json({ error: 'Recording not available' });
        }

        // OUTBOUND-CALL-TIMELINE-001 (S8): non-Twilio recordings (e.g. VAPI robot
        // calls) are persisted as a self-authorizing CDN URL under a synthetic sid
        // (`vapi_<id>`, written by vapiCallTimelineService finalize), never a Twilio
        // `RE…` recording sid — there is no Twilio SID to fetch. Stream straight from
        // recording_url. Same `recording` row getCallMedia already loaded and the same
        // route auth/company gate apply to both branches — only the fetch source
        // differs, keyed purely off the sid shape (the tenant check is not weakened).
        if (!/^RE/i.test(recording.recording_sid || '')) {
            if (!recording.recording_url) {
                return res.status(404).json({ error: 'Recording not available' });
            }

            let upstreamRes;
            try {
                // No auth header — VAPI recording URLs are self-authorizing (unlike
                // the Twilio REST branch below, which needs Basic account auth).
                upstreamRes = await fetch(recording.recording_url, { redirect: 'follow' });
            } catch (fetchErr) {
                console.error(`Recording URL fetch failed: ${fetchErr.message}`);
                return res.status(502).json({ error: 'Failed to fetch recording' });
            }

            if (!upstreamRes.ok) {
                console.error(`Recording URL fetch failed: ${upstreamRes.status}`);
                return res.status(502).json({ error: 'Failed to fetch recording' });
            }

            // Content-Type from upstream (VAPI serves wav; fallback audio/wav).
            // Accept-Ranges/Content-Length passthrough mirror the Twilio branch.
            res.set('Content-Type', upstreamRes.headers.get('content-type') || 'audio/wav');
            res.set('Accept-Ranges', 'bytes');
            if (upstreamRes.headers.get('content-length')) {
                res.set('Content-Length', upstreamRes.headers.get('content-length'));
            }

            return upstreamRes.body.pipe(res);
        }

        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;

        if (!accountSid || !authToken) {
            return res.status(500).json({ error: 'Twilio credentials not configured' });
        }

        // Twilio REST API for recording media
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recording.recording_sid}.mp3`;
        const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

        const twilioRes = await fetch(twilioUrl, {
            headers: { 'Authorization': authHeader },
            redirect: 'follow',
        });

        if (!twilioRes.ok) {
            console.error(`Twilio recording fetch failed: ${twilioRes.status}`);
            return res.status(502).json({ error: 'Failed to fetch recording from Twilio' });
        }

        res.set('Content-Type', 'audio/mpeg');
        res.set('Accept-Ranges', 'bytes');
        if (twilioRes.headers.get('content-length')) {
            res.set('Content-Length', twilioRes.headers.get('content-length'));
        }

        twilioRes.body.pipe(res);
    } catch (error) {
        console.error('Error proxying recording:', error);
        res.status(500).json({ error: 'Failed to proxy recording' });
    }
});

// =============================================================================
// GET /api/calls/:callSid/media — recordings + transcripts (structured)
// =============================================================================
router.get('/:callSid/media', async (req, res) => {
    try {
        const callSid = req.params.callSid;
        const media = await queries.getCallMedia(callSid);
        const recording = media.recordings?.[0];
        // Prefer the completed transcript over processing/enqueued ones
        const transcript = media.transcripts?.find(t => t.status === 'completed') || media.transcripts?.[0];

        res.json({
            callSid,
            recording: recording ? {
                recordingSid: recording.recording_sid,
                status: recording.status,
                playbackUrl: recording.status === 'completed' ? `/api/calls/${callSid}/recording.mp3` : null,
                durationSec: recording.duration_sec,
                channels: recording.channels,
            } : null,
            transcript: transcript ? (() => {
                let payload = {};
                try {
                    payload = typeof transcript.raw_payload === 'string'
                        ? JSON.parse(transcript.raw_payload)
                        : (transcript.raw_payload || {});
                } catch { payload = {}; }
                return {
                    status: transcript.status,
                    text: transcript.text,
                    confidence: transcript.confidence,
                    languageCode: transcript.language_code,
                    updatedAt: transcript.updated_at,
                    entities: payload.entities || [],
                    sentimentScore: payload.sentimentScore ?? null,
                    gemini_summary: payload.gemini_summary || null,
                    gemini_entities: payload.gemini_entities || [],
                    gemini_generated_at: payload.gemini_generated_at || null,
                    gemini_error: payload.gemini_error || null,
                    gemini_error_at: payload.gemini_error_at || null,
                    gemini_used_fallback_model: payload.gemini_used_fallback_model || null,
                    gemini_primary_error: payload.gemini_primary_error || null,
                };
            })() : null,
        });
    } catch (error) {
        console.error('Error fetching call media:', error);
        res.status(500).json({ error: 'Failed to fetch call media' });
    }
});

// =============================================================================
// DELETE /api/calls/:callSid/transcript — remove all transcripts (for reset)
// =============================================================================
router.delete('/:callSid/transcript', requirePermission('reports.calls.view'), async (req, res) => {
    try {
        const callSid = req.params.callSid;
        const db = require('../db/connection');
        const result = await db.query(
            `DELETE FROM transcripts WHERE call_sid = $1`,
            [callSid]
        );

        console.log(`🗑️ Deleted ${result.rowCount} transcript(s) for ${callSid}`);
        res.json({ deleted: result.rowCount });
    } catch (error) {
        console.error(`Error deleting transcripts for ${req.params.callSid}:`, error);
        res.status(500).json({ error: 'Failed to delete transcripts' });
    }
});

// =============================================================================
// POST /api/calls/:callSid/transcribe — generate transcription via AssemblyAI
// =============================================================================
router.post('/:callSid/transcribe', requirePermission('reports.calls.view', 'pulse.view'), async (req, res) => {
    const callSid = req.params.callSid;
    try {
        // Get recording for this call
        const media = await queries.getCallMedia(callSid);
        const recording = media.recordings?.[0];
        if (!recording || recording.status !== 'completed') {
            return res.status(404).json({ error: 'No completed recording found for this call' });
        }

        const { transcribeCall } = require('../services/transcriptionService');
        const result = await transcribeCall(callSid, recording.recording_sid, `manual-${callSid}`);
        res.json(result);
    } catch (error) {
        console.error(`Error transcribing call ${callSid}:`, error);
        res.status(500).json({ error: error.message || 'Failed to generate transcription' });
    }
});

// =============================================================================
// POST /api/calls/:callSid/summarize — (re-)generate Gemini summary
// =============================================================================
router.post('/:callSid/summarize', requirePermission('reports.calls.view', 'pulse.view'), async (req, res) => {
    const callSid = req.params.callSid;
    try {
        // 1. Load existing transcript
        const media = await queries.getCallMedia(callSid);
        const transcript = media.transcripts?.[0];
        if (!transcript || transcript.status !== 'completed' || !transcript.text) {
            return res.status(404).json({ error: 'No completed transcript found for this call' });
        }

        // 2. Call Gemini
        const summaryResult = await generateCallSummary(transcript.text, {
            callerPhone: req.body?.callerPhone || null,
            callTime: req.body?.callTime || null,
        });

        // Load existing payload (needed for both success and failure paths)
        let existingPayload = {};
        try {
            existingPayload = typeof transcript.raw_payload === 'string'
                ? JSON.parse(transcript.raw_payload)
                : (transcript.raw_payload || {});
        } catch { existingPayload = {}; }

        if (summaryResult.error) {
            // Persist error to raw_payload for diagnostics, then return 502
            existingPayload.gemini_error = {
                code: summaryResult.error_code || 'unknown',
                detail: summaryResult.error_detail || summaryResult.error || null,
                attempts: summaryResult.attempts ?? null,
                message: summaryResult.error || null,
                fallback_attempted: summaryResult.fallback_attempted || false,
                fallback_model: summaryResult.fallback_model || null,
                fallback_error_code: summaryResult.fallback_error_code || null,
            };
            existingPayload.gemini_error_at = new Date().toISOString();

            try {
                await queries.upsertTranscript({
                    transcriptionSid: transcript.transcription_sid,
                    callSid,
                    recordingSid: transcript.recording_sid,
                    mode: transcript.mode || 'post-call',
                    status: transcript.status,
                    languageCode: transcript.language_code,
                    confidence: transcript.confidence,
                    text: transcript.text,
                    isFinal: true,
                    rawPayload: existingPayload,
                });
            } catch (persistErr) {
                console.error(`Failed to persist gemini_error for ${callSid}:`, persistErr.message);
            }

            return res.status(502).json({
                error: `Summary generation failed: ${summaryResult.error}`,
                error_code: summaryResult.error_code,
                error_detail: summaryResult.error_detail,
                attempts: summaryResult.attempts,
            });
        }

        // 3. Update raw_payload in existing transcript (success path — reset error fields)
        existingPayload.gemini_summary = summaryResult.summary;
        existingPayload.gemini_entities = summaryResult.entities;
        existingPayload.gemini_generated_at = new Date().toISOString();
        existingPayload.gemini_error = null;
        existingPayload.gemini_error_at = null;
        existingPayload.gemini_used_fallback_model = summaryResult.used_fallback_model || null;
        existingPayload.gemini_primary_error = summaryResult.primary_error || null;

        await queries.upsertTranscript({
            transcriptionSid: transcript.transcription_sid,
            callSid,
            recordingSid: transcript.recording_sid,
            mode: transcript.mode || 'post-call',
            status: transcript.status,
            languageCode: transcript.language_code,
            confidence: transcript.confidence,
            text: transcript.text,
            isFinal: true,
            rawPayload: existingPayload,
        });

        console.log(`✅ Gemini summary (re-)generated for ${callSid}: ${summaryResult.summary?.length} chars, ${summaryResult.entities.length} entities${summaryResult.used_fallback_model ? ` (via fallback ${summaryResult.used_fallback_model})` : ''}`);
        res.json({
            status: 'completed',
            gemini_summary: summaryResult.summary,
            gemini_entities: summaryResult.entities,
            used_fallback_model: summaryResult.used_fallback_model || null,
            primary_error: summaryResult.primary_error || null,
        });
    } catch (error) {
        console.error(`Error generating summary for ${callSid}:`, error);
        res.status(500).json({ error: 'Failed to generate summary' });
    }
});

// =============================================================================
// GET /api/calls/:callSid/events — event history
// =============================================================================
router.get('/:callSid/events', async (req, res) => {
    try {
        const events = await queries.getCallEvents(req.params.callSid);
        res.json({ events, count: events.length });
    } catch (error) {
        console.error('Error fetching call events:', error);
        res.status(500).json({ error: 'Failed to fetch call events' });
    }
});

// =============================================================================
// GET /api/health/sync — sync health dashboard
// =============================================================================
router.get('/health/sync', async (req, res) => {
    try {
        const health = await queries.getSyncHealth();
        res.json(health);
    } catch (error) {
        console.error('Error fetching sync health:', error);
        res.status(500).json({ error: 'Failed to fetch sync health' });
    }
});

// =============================================================================
// Format call for API response
// =============================================================================
function formatCall(row) {
    const call = {
        id: row.id,
        call_sid: row.call_sid,
        parent_call_sid: row.parent_call_sid,
        direction: row.direction,
        from_number: row.from_number,
        to_number: row.to_number,
        status: row.status,
        is_final: row.is_final,
        started_at: row.started_at,
        answered_at: row.answered_at,
        ended_at: row.ended_at,
        duration_sec: row.duration_sec,
        answered_by: row.answered_by || null,
        price: row.price,
        price_unit: row.price_unit,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };

    // Include recording data if joined
    if (row.recording_sid) {
        call.recording = {
            recording_sid: row.recording_sid,
            status: row.recording_status,
            playback_url: row.recording_status === 'completed' ? `/api/calls/${row.call_sid}/recording.mp3` : null,
            duration_sec: row.recording_duration_sec,
        };
    }

    // Include transcript data if joined
    if (row.transcript_status) {
        call.transcript = {
            status: row.transcript_status,
            text: row.transcript_text,
        };
    }

    // Include contact if joined
    if (row.contact) {
        call.contact = typeof row.contact === 'string' ? JSON.parse(row.contact) : row.contact;
    }

    // Include call_count if present (from by-contact query)
    if (row.call_count !== undefined) {
        call.call_count = parseInt(row.call_count);
    }

    if (row.routing_group_id) {
        call.routing_group = {
            id: row.routing_group_id,
            name: row.routing_group_name || row.routing_group_id,
        };
    }

    if (row.flow_context_json || row.flow_current_node_id || row.flow_execution_status) {
        const context = safeParseJSON(row.flow_context_json);
        call.flow_path = operationsDashboard.flowPathFromContext(
            context,
            row.flow_current_node_id,
            row.flow_execution_status || row.status
        );
        call.flow_execution_status = row.flow_execution_status || null;
        call.flow_current_node_id = row.flow_current_node_id || null;
    }

    return call;
}

function safeParseJSON(value) {
    try {
        if (!value) return {};
        return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return {};
    }
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

module.exports = router;
