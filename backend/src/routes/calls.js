const express = require('express');
const router = express.Router();
const queries = require('../db/queries');
const fetch = require('node-fetch');

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
// GET /api/calls/by-contact — grouped by contact (conversations replacement)
// =============================================================================
router.get('/by-contact', async (req, res) => {
    try {
        const { limit = 20, offset = 0 } = req.query;
        const companyId = req.companyFilter?.company_id;
        const calls = await queries.getCallsByContact({
            limit: parseInt(limit),
            offset: parseInt(offset),
            companyId,
        });
        const total = await queries.getContactsWithCallsCount(companyId);

        res.json({
            conversations: calls.map(c => ({
                ...formatCall(c),
                call_count: parseInt(c.call_count || 0),
            })),
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
        const transcript = media.transcripts?.[0];

        res.json({
            callSid,
            recording: recording ? {
                recordingSid: recording.recording_sid,
                status: recording.status,
                playbackUrl: recording.status === 'completed' ? `/api/calls/${callSid}/recording.mp3` : null,
                durationSec: recording.duration_sec,
                channels: recording.channels,
            } : null,
            transcript: transcript ? {
                status: transcript.status,
                text: transcript.text,
                confidence: transcript.confidence,
                languageCode: transcript.language_code,
                updatedAt: transcript.updated_at,
            } : null,
        });
    } catch (error) {
        console.error('Error fetching call media:', error);
        res.status(500).json({ error: 'Failed to fetch call media' });
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
