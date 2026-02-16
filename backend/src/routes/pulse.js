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
// =============================================================================
router.get('/timeline/:contactId', async (req, res) => {
    try {
        const contactId = parseInt(req.params.contactId);
        if (isNaN(contactId)) {
            return res.status(400).json({ error: 'Invalid contactId' });
        }

        // 1) Get contact to find phone
        const callRows = await queries.getCallsByContactId(contactId);
        if (!callRows.length) {
            return res.json({ calls: [], messages: [], conversations: [] });
        }

        const contact = callRows[0].contact ? (typeof callRows[0].contact === 'string' ? JSON.parse(callRows[0].contact) : callRows[0].contact) : null;
        const phoneE164 = contact?.phone_e164;

        // 2) Format calls (reuse same format as calls route)
        const calls = callRows.map(formatCall);

        // 3) Get SMS conversations matching the contact's phone
        let messages = [];
        let conversations = [];
        if (phoneE164) {
            const convResult = await db.query(
                `SELECT * FROM sms_conversations WHERE customer_e164 = $1 ORDER BY last_message_at DESC NULLS LAST`,
                [phoneE164]
            );
            conversations = convResult.rows;

            // Fetch messages from all matching conversations
            for (const conv of conversations) {
                const msgs = await convQueries.getMessages(conv.id, { limit: 200 });
                messages.push(...msgs.map(m => ({
                    ...m,
                    conversation_id: conv.id,
                    media: typeof m.media === 'string' ? JSON.parse(m.media) : m.media,
                })));
            }
        }

        res.json({ calls, messages, conversations });
    } catch (error) {
        console.error('[Pulse] GET /timeline/:contactId error:', error);
        res.status(500).json({ error: 'Failed to fetch timeline' });
    }
});

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
        } : undefined,
    };
}

module.exports = router;
