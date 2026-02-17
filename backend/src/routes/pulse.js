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

        // 1) Get contact info directly from contacts table
        const contactResult = await db.query(
            'SELECT * FROM contacts WHERE id = $1', [contactId]
        );
        const contact = contactResult.rows[0] || null;

        // 2) Get calls for this contact
        const callRows = await queries.getCallsByContactId(contactId);

        const rawPhone = contact?.phone_e164;
        // Normalize to E.164: strip everything except digits and leading +
        const normalizedPhone = rawPhone ? '+' + rawPhone.replace(/\D/g, '') : null;

        // Also collect unique phone numbers from call rows (from/to)
        const callPhones = new Set();
        for (const row of callRows) {
            if (row.from_number) callPhones.add(row.from_number);
            if (row.to_number) callPhones.add(row.to_number);
        }

        // Format calls (reuse same format as calls route)
        const calls = callRows.map(formatCall);

        // 3) Get SMS conversations matching the contact's phone
        let messages = [];
        let conversations = [];

        // Build a set of phones to search (normalized contact phone + call phones)
        const phonesToSearch = new Set();
        if (normalizedPhone) phonesToSearch.add(normalizedPhone);
        for (const p of callPhones) phonesToSearch.add(p);

        if (phonesToSearch.size > 0) {
            const phoneArray = [...phonesToSearch];
            // Use digits-only comparison to handle format mismatches
            const phoneDigits = phoneArray.map(p => p.replace(/\D/g, ''));
            const convResult = await db.query(
                `SELECT * FROM sms_conversations
                 WHERE regexp_replace(customer_e164, '\\D', '', 'g') = ANY($1)
                 ORDER BY last_message_at DESC NULLS LAST`,
                [phoneDigits]
            );
            conversations = convResult.rows;

            // Fetch messages from all matching conversations
            for (const conv of conversations) {
                const msgs = await convQueries.getMessages(conv.id, { limit: 200 });
                messages.push(...msgs.map(m => ({
                    ...m,
                    conversation_id: conv.id,
                    // Derive from/to phone using conversation phones + direction
                    from_number: m.direction === 'inbound' ? conv.customer_e164 : conv.proxy_e164,
                    to_number: m.direction === 'inbound' ? conv.proxy_e164 : conv.customer_e164,
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

// =============================================================================
// GET /api/pulse/unread-count — number of contacts with unread events
// =============================================================================
router.get('/unread-count', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT COUNT(*) as count FROM sms_conversations WHERE has_unread = true'
        );
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.json({ count: 0 });
    }
});

module.exports = router;
