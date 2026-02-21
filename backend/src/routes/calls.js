const express = require('express');
const router = express.Router();
const queries = require('../db/queries');
const fetch = require('node-fetch');
const { generateCallSummary } = require('../services/callSummaryService');

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
        } = req.query;

        const companyId = req.companyFilter?.company_id;
        const result = await queries.getCalls({
            cursor: cursor ? parseInt(cursor) : undefined,
            limit: Math.min(parseInt(limit) || 50, 200),
            status: status || undefined,
            hasRecording: has_recording === 'true' ? true : undefined,
            hasTranscript: has_transcript === 'true' ? true : undefined,
            contactId: contact_id ? parseInt(contact_id) : undefined,
            companyId,
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
// GET /api/calls/by-contact — grouped by timeline (conversations replacement)
// =============================================================================
router.get('/by-contact', async (req, res) => {
    try {
        const { limit = 50, offset = 0, search } = req.query;
        const companyId = req.companyFilter?.company_id;
        const calls = await queries.getCallsByTimeline({
            limit: parseInt(limit),
            offset: parseInt(offset),
            companyId,
            search: search || null,
        });
        const total = await queries.getTimelinesWithCallsCount(companyId);

        // Format calls — SMS data already included from SQL
        let conversations = calls.map(c => {
            const formatted = formatCall(c);
            const tlPhone = c.tl_phone || null;
            const callTime = new Date(c.started_at || c.created_at);
            const smsTime = c.sms_last_message_at ? new Date(c.sms_last_message_at) : null;

            // Helper: pick the first non-SIP phone from candidates
            const pickPhone = (...candidates) => {
                for (const p of candidates) {
                    if (p && !p.startsWith('sip:')) return p;
                }
                return candidates.find(Boolean) || '';
            };

            let last_interaction_at, last_interaction_type, last_interaction_phone;
            if (smsTime && smsTime > callTime) {
                last_interaction_at = c.sms_last_message_at;
                last_interaction_type = c.sms_last_message_direction === 'inbound' ? 'sms_inbound' : 'sms_outbound';
                last_interaction_phone = pickPhone(tlPhone, c.contact?.phone_e164, c.from_number, c.to_number);
            } else {
                last_interaction_at = c.started_at || c.created_at;
                last_interaction_type = 'call';
                const isInbound = (c.direction || '').includes('inbound');
                const candidatePhone = isInbound ? c.from_number : c.to_number;
                last_interaction_phone = pickPhone(candidatePhone, tlPhone, c.contact?.phone_e164, c.from_number, c.to_number);
            }

            return {
                ...formatted,
                timeline_id: c.tl_id || c.timeline_id || null,
                tl_phone: tlPhone,
                has_unread: c.sms_has_unread || false,
                sms_conversation_id: c.sms_conversation_id || null,
                last_interaction_at,
                last_interaction_type,
                last_interaction_phone,
            };
        });

        // Add SMS-only timelines (those with SMS but NO calls)
        try {
            const existingDigits = new Set();
            for (const c of conversations) {
                const tlPhone = c.tl_phone;
                if (tlPhone) existingDigits.add(tlPhone.replace(/\D/g, ''));
                const raw = c.contact?.phone_e164;
                if (raw) existingDigits.add(raw.replace(/\D/g, ''));
                const sec = c.contact?.secondary_phone;
                if (sec) existingDigits.add(sec.replace(/\D/g, ''));
                if (c.from_number) existingDigits.add(c.from_number.replace(/\D/g, ''));
                if (c.to_number) existingDigits.add(c.to_number.replace(/\D/g, ''));
            }

            const dbConn = require('../db/connection');
            const smsOnlyResult = await dbConn.query(
                `SELECT sc.*, sc.customer_digits
                 FROM sms_conversations sc
                 ORDER BY sc.last_message_at DESC NULLS LAST
                 LIMIT 200`
            );

            // Filter to SMS-only (not already covered by call timelines)
            // Pre-compute contact name matches for search
            let searchContactDigits = null;
            if (search) {
                const searchTerm = search.trim();
                if (searchTerm.length > 0 && /[a-zA-Z]/.test(searchTerm)) {
                    const contactMatchResult = await dbConn.query(
                        `SELECT phone_e164, secondary_phone FROM contacts
                         WHERE full_name ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1`,
                        ['%' + searchTerm + '%']
                    );
                    searchContactDigits = new Set();
                    for (const co of contactMatchResult.rows) {
                        if (co.phone_e164) searchContactDigits.add(co.phone_e164.replace(/\D/g, ''));
                        if (co.secondary_phone) searchContactDigits.add(co.secondary_phone.replace(/\D/g, ''));
                    }
                }
            }
            const smsOnlyRows = [];
            for (const smsRow of smsOnlyResult.rows) {
                const digits = smsRow.customer_digits;
                if (!digits || existingDigits.has(digits)) continue;
                existingDigits.add(digits);

                if (search) {
                    const searchTerm = search.trim().toLowerCase();
                    const searchDigits = searchTerm.replace(/\D/g, '');
                    let matches = false;
                    if (searchDigits.length > 0 && digits.includes(searchDigits)) matches = true;
                    if (smsRow.friendly_name && smsRow.friendly_name.toLowerCase().includes(searchTerm)) matches = true;
                    if (smsRow.customer_e164 && smsRow.customer_e164.toLowerCase().includes(searchTerm)) matches = true;
                    // Also check if a contact with matching name owns this phone
                    if (!matches && searchContactDigits && searchContactDigits.has(digits)) matches = true;
                    if (!matches) continue;
                }
                smsOnlyRows.push(smsRow);
            }

            if (smsOnlyRows.length > 0) {
                // Batch: find contacts by phone digits (2 queries instead of N*2)
                const smsDigitsList = smsOnlyRows.map(s => s.customer_digits);
                const [contactsResult, timelinesResult] = await Promise.all([
                    dbConn.query(
                        `SELECT * FROM contacts
                         WHERE regexp_replace(phone_e164, '[^0-9]', '', 'g') = ANY($1)
                            OR regexp_replace(secondary_phone, '[^0-9]', '', 'g') = ANY($1)`,
                        [smsDigitsList]
                    ),
                    dbConn.query(
                        `SELECT t.*, regexp_replace(COALESCE(t.phone_e164, c.phone_e164), '[^0-9]', '', 'g') as tl_digits
                         FROM timelines t
                         LEFT JOIN contacts c ON t.contact_id = c.id
                         WHERE regexp_replace(COALESCE(t.phone_e164, c.phone_e164), '[^0-9]', '', 'g') = ANY($1)`,
                        [smsDigitsList]
                    ),
                ]);

                // Build lookup maps
                const contactByDigits = {};
                for (const co of contactsResult.rows) {
                    const d1 = co.phone_e164 ? co.phone_e164.replace(/\D/g, '') : null;
                    const d2 = co.secondary_phone ? co.secondary_phone.replace(/\D/g, '') : null;
                    if (d1) contactByDigits[d1] = co;
                    if (d2 && !contactByDigits[d2]) contactByDigits[d2] = co;
                }
                const timelineByDigits = {};
                for (const tl of timelinesResult.rows) {
                    if (tl.tl_digits) timelineByDigits[tl.tl_digits] = tl;
                }

                for (const smsRow of smsOnlyRows) {
                    const contact = contactByDigits[smsRow.customer_digits] || null;
                    const timeline = timelineByDigits[smsRow.customer_digits] || null;

                    conversations.push({
                        id: null,
                        call_sid: null,
                        direction: smsRow.last_message_direction === 'inbound' ? 'inbound' : 'outbound',
                        from_number: smsRow.customer_e164,
                        to_number: smsRow.proxy_e164 || '',
                        status: 'completed',
                        is_final: true,
                        started_at: smsRow.last_message_at,
                        ended_at: null,
                        duration_sec: null,
                        created_at: smsRow.created_at,
                        updated_at: smsRow.updated_at,
                        contact: contact ? {
                            id: contact.id,
                            phone_e164: contact.phone_e164,
                            full_name: contact.full_name,
                            email: contact.email,
                            secondary_phone: contact.secondary_phone,
                            secondary_phone_name: contact.secondary_phone_name,
                            company_name: contact.company_name,
                            created_at: contact.created_at,
                            updated_at: contact.updated_at,
                        } : null,
                        timeline_id: timeline?.id || null,
                        tl_phone: smsRow.customer_e164,
                        has_unread: smsRow.has_unread || false,
                        sms_conversation_id: smsRow.id || null,
                        last_interaction_at: smsRow.last_message_at,
                        last_interaction_type: smsRow.last_message_direction === 'inbound' ? 'sms_inbound' : 'sms_outbound',
                        last_interaction_phone: smsRow.customer_e164,
                    });
                }
            }
        } catch (smsOnlyErr) {
            console.warn('[by-contact] SMS-only timelines failed:', smsOnlyErr.message);
        }

        // Enrich with has_unread from contacts table (SMS unread already from SQL)
        try {
            const dbConn = require('../db/connection');
            const contactIds = conversations.map(c => c.contact?.id).filter(Boolean);
            if (contactIds.length > 0) {
                const contactResult = await dbConn.query(
                    `SELECT id, has_unread FROM contacts WHERE id = ANY($1)`,
                    [contactIds]
                );
                const contactUnreadMap = {};
                for (const row of contactResult.rows) {
                    contactUnreadMap[row.id] = row.has_unread;
                }
                for (const conv of conversations) {
                    const cid = conv.contact?.id;
                    if (cid && contactUnreadMap[cid]) {
                        conv.has_unread = true;
                    }
                }
            }
        } catch (e) {
            console.warn('[by-contact] Unread enrichment failed:', e.message);
        }

        // Dedup by timeline phone digits
        {
            const seen = new Map();
            const deduped = [];
            for (const conv of conversations) {
                const raw = conv.tl_phone || conv.contact?.phone_e164 || conv.from_number || '';
                const digits = raw.replace(/\D/g, '');
                if (!digits) { deduped.push(conv); continue; }
                if (!seen.has(digits)) {
                    seen.set(digits, deduped.length);
                    deduped.push(conv);
                }
                // Keep whichever was first (already sorted by recency)
            }
            conversations = deduped;
        }

        // Final sort: unread first, then by last interaction (most recent first)
        conversations.sort((a, b) => {
            if (a.has_unread !== b.has_unread) return a.has_unread ? -1 : 1;
            const ta = new Date(a.last_interaction_at || 0);
            const tb = new Date(b.last_interaction_at || 0);
            return tb - ta;
        });

        res.json({
            conversations,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset),
        });
    } catch (error) {
        console.error('Error fetching calls by contact:', error);
        res.status(500).json({ error: 'Failed to fetch calls by contact' });
    }
});

// =============================================================================
// POST /api/calls/contact/:contactId/mark-read — team-wide mark read
// =============================================================================
router.post('/contact/:contactId/mark-read', async (req, res) => {
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
router.delete('/:callSid/transcript', async (req, res) => {
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
router.post('/:callSid/transcribe', async (req, res) => {
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
router.post('/:callSid/summarize', async (req, res) => {
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

        if (summaryResult.error) {
            return res.status(502).json({ error: `Summary generation failed: ${summaryResult.error}` });
        }

        // 3. Update raw_payload in existing transcript
        let existingPayload = {};
        try {
            existingPayload = typeof transcript.raw_payload === 'string'
                ? JSON.parse(transcript.raw_payload)
                : (transcript.raw_payload || {});
        } catch { existingPayload = {}; }

        existingPayload.gemini_summary = summaryResult.summary;
        existingPayload.gemini_entities = summaryResult.entities;
        existingPayload.gemini_generated_at = new Date().toISOString();

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

        console.log(`✅ Gemini summary (re-)generated for ${callSid}: ${summaryResult.summary?.length} chars, ${summaryResult.entities.length} entities`);
        res.json({
            status: 'completed',
            gemini_summary: summaryResult.summary,
            gemini_entities: summaryResult.entities,
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

    return call;
}

module.exports = router;
