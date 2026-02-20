/**
 * Pulse API routes
 * Timeline endpoint: returns calls + SMS for a contact.
 * Mounted at /api/pulse
 */
const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const queries = require('../db/queries');
const convQueries = require('../db/conversationsQueries');

// =============================================================================
// GET /api/pulse/timeline/:contactId — combined calls + SMS for a contact
// Also supports /api/pulse/timeline-by-id/:timelineId for timeline-first routing
// =============================================================================

// Timeline by timelineId
router.get('/timeline-by-id/:timelineId', async (req, res) => {
    try {
        const timelineId = parseInt(req.params.timelineId);
        if (isNaN(timelineId)) {
            return res.status(400).json({ error: 'Invalid timelineId' });
        }

        // Get timeline info
        const tlResult = await db.query('SELECT * FROM timelines WHERE id = $1', [timelineId]);
        const timeline = tlResult.rows[0];
        if (!timeline) {
            return res.status(404).json({ error: 'Timeline not found' });
        }

        // Get contact if linked
        let contact = null;
        if (timeline.contact_id) {
            const contactResult = await db.query('SELECT * FROM contacts WHERE id = $1', [timeline.contact_id]);
            contact = contactResult.rows[0] || null;
        }

        return await buildTimeline(req, res, contact, timeline);
    } catch (error) {
        console.error('[Pulse] GET /timeline-by-id/:timelineId error:', error);
        res.status(500).json({ error: 'Failed to fetch timeline' });
    }
});

// Legacy: timeline by contactId
router.get('/timeline/:contactId', async (req, res) => {
    try {
        const contactId = parseInt(req.params.contactId);
        if (isNaN(contactId)) {
            return res.status(400).json({ error: 'Invalid contactId' });
        }

        // Get contact info
        const contactResult = await db.query('SELECT * FROM contacts WHERE id = $1', [contactId]);
        const contact = contactResult.rows[0] || null;

        // Find timeline linked to this contact
        let timeline = null;
        if (contact) {
            const tlResult = await db.query('SELECT * FROM timelines WHERE contact_id = $1 LIMIT 1', [contactId]);
            timeline = tlResult.rows[0] || null;
        }

        return await buildTimeline(req, res, contact, timeline);
    } catch (error) {
        console.error('[Pulse] GET /timeline/:contactId error:', error);
        res.status(500).json({ error: 'Failed to fetch timeline' });
    }
});

// Shared timeline builder
async function buildTimeline(req, res, contact, timeline) {
    // Get calls by timeline_id with recordings + transcripts
    let callRows = [];
    if (timeline?.id) {
        const callResult = await db.query(
            `SELECT c.*, to_json(co) as contact,
                COALESCE(r.recording_sid, cr.recording_sid) as recording_sid,
                COALESCE(r.status, cr.status) as recording_status,
                COALESCE(r.duration_sec, cr.duration_sec) as recording_duration_sec,
                COALESCE(t.status, ct.status) as transcript_status,
                COALESCE(t.text, ct.text) as transcript_text,
                COALESCE(t.raw_payload, ct.raw_payload) as transcript_raw_payload
             FROM calls c
             LEFT JOIN contacts co ON c.contact_id = co.id
             -- Direct recording on this call
             LEFT JOIN LATERAL (
                 SELECT recording_sid, status, duration_sec
                 FROM recordings
                 WHERE recordings.call_sid = c.call_sid
                 ORDER BY completed_at DESC NULLS LAST, updated_at DESC
                 LIMIT 1
             ) r ON true
             -- Fallback: recording on child legs (for parent inbound calls)
             LEFT JOIN LATERAL (
                 SELECT rec.recording_sid, rec.status, rec.duration_sec
                 FROM calls child
                 JOIN recordings rec ON rec.call_sid = child.call_sid
                 WHERE child.parent_call_sid = c.call_sid
                 ORDER BY rec.completed_at DESC NULLS LAST, rec.updated_at DESC
                 LIMIT 1
             ) cr ON r.recording_sid IS NULL
             -- Direct transcript on this call
             LEFT JOIN LATERAL (
                 SELECT status, text, raw_payload
                 FROM transcripts
                 WHERE transcripts.call_sid = c.call_sid
                 ORDER BY updated_at DESC
                 LIMIT 1
             ) t ON true
             -- Fallback: transcript on child legs
             LEFT JOIN LATERAL (
                 SELECT tr.status, tr.text, tr.raw_payload
                 FROM calls child
                 JOIN transcripts tr ON tr.call_sid = child.call_sid
                 WHERE child.parent_call_sid = c.call_sid
                 ORDER BY tr.updated_at DESC
                 LIMIT 1
             ) ct ON t.status IS NULL
             WHERE c.timeline_id = $1
               AND c.parent_call_sid IS NULL
             ORDER BY c.started_at DESC NULLS LAST`,
            [timeline.id]
        );
        callRows = callResult.rows;
    }

    // Phone: contact phone (primary) or orphan timeline phone
    const rawPhone = contact?.phone_e164 || timeline?.phone_e164;
    const normalizedPhone = rawPhone ? '+' + rawPhone.replace(/\D/g, '') : null;

    // Collect unique phone numbers from call rows
    const callPhones = new Set();
    for (const row of callRows) {
        if (row.from_number) callPhones.add(row.from_number);
        if (row.to_number) callPhones.add(row.to_number);
    }

    const calls = callRows.map(formatCall);

    // Get SMS conversations matching phones
    let messages = [];
    let conversations = [];

    const phonesToSearch = new Set();
    if (normalizedPhone) phonesToSearch.add(normalizedPhone);
    // Include secondary phone
    const secondaryPhone = contact?.secondary_phone;
    if (secondaryPhone) {
        const normalizedSecondary = '+' + secondaryPhone.replace(/\D/g, '');
        phonesToSearch.add(normalizedSecondary);
    }
    for (const p of callPhones) phonesToSearch.add(p);

    if (phonesToSearch.size > 0) {
        const phoneArray = [...phonesToSearch];
        const phoneDigits = phoneArray.map(p => p.replace(/\D/g, ''));
        const convResult = await db.query(
            `SELECT * FROM sms_conversations
             WHERE regexp_replace(customer_e164, '\\D', '', 'g') = ANY($1)
             ORDER BY last_message_at DESC NULLS LAST`,
            [phoneDigits]
        );
        conversations = convResult.rows;

        for (const conv of conversations) {
            const msgs = await convQueries.getMessages(conv.id, { limit: 200 });
            messages.push(...msgs.map(m => ({
                ...m,
                conversation_id: conv.id,
                from_number: m.direction === 'inbound' ? conv.customer_e164 : conv.proxy_e164,
                to_number: m.direction === 'inbound' ? conv.proxy_e164 : conv.customer_e164,
                media: typeof m.media === 'string' ? JSON.parse(m.media) : m.media,
            })));
        }
    }

    res.json({
        calls, messages, conversations,
        timeline_id: timeline?.id || null,
        contact: contact || null,
    });
}

// =============================================================================
// Format a call row (mirrors calls.js format)
// =============================================================================
function formatCall(row) {
    const contact = row.contact
        ? (typeof row.contact === 'string' ? JSON.parse(row.contact) : row.contact)
        : null;

    return {
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
        answered_by: row.answered_by,
        price: row.price,
        price_unit: row.price_unit,
        created_at: row.created_at,
        updated_at: row.updated_at,
        contact: contact ? {
            id: contact.id,
            phone_e164: contact.phone_e164,
            full_name: contact.full_name,
            email: contact.email,
        } : null,
        call_count: row.call_count ? parseInt(row.call_count) : undefined,
        recording: row.recording_sid ? {
            recording_sid: row.recording_sid,
            status: row.recording_status,
            playback_url: row.recording_sid ? `/api/calls/${row.call_sid}/recording.mp3` : null,
            duration_sec: row.recording_duration_sec,
        } : undefined,
        transcript: row.transcript_status ? {
            status: row.transcript_status,
            text: row.transcript_text,
            gemini_summary: (() => {
                const rp = row.transcript_raw_payload;
                if (!rp) return null;
                const p = typeof rp === 'string' ? JSON.parse(rp) : rp;
                return p.gemini_summary || null;
            })(),
        } : undefined,
    };
}

// =============================================================================
// GET /api/pulse/unread-count — number of contacts with unread events
// =============================================================================
router.get('/unread-count', async (req, res) => {
    try {
        // Count contacts that have unread in EITHER sms_conversations OR contacts
        const result = await db.query(`
            SELECT COUNT(DISTINCT phone) as count FROM (
                SELECT customer_e164 as phone FROM sms_conversations WHERE has_unread = true
                UNION
                SELECT phone_e164 as phone FROM contacts WHERE has_unread = true
            ) unread_phones
        `);
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.json({ count: 0 });
    }
});

module.exports = router;
