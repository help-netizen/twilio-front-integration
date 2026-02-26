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
// =============================================================================
// GET /api/pulse/timeline-by-phone — find timeline ID by phone number
// =============================================================================
router.get('/timeline-by-phone', async (req, res) => {
    try {
        const phone = req.query.phone;
        if (!phone) return res.json({ timelineId: null, contactName: null });

        const digits = phone.replace(/\D/g, '');
        if (!digits) return res.json({ timelineId: null, contactName: null });

        // Find timeline + contact name by phone
        const result = await db.query(
            `SELECT t.id, c.full_name FROM timelines t
             LEFT JOIN contacts c ON t.contact_id = c.id
             WHERE regexp_replace(COALESCE(t.phone_e164, c.phone_e164), '\\D', '', 'g') = $1
                OR regexp_replace(c.secondary_phone, '\\D', '', 'g') = $1
             LIMIT 1`,
            [digits]
        );
        const row = result.rows[0];
        res.json({
            timelineId: row?.id || null,
            contactName: row?.full_name || null,
        });
    } catch (error) {
        console.error('[Pulse] timeline-by-phone error:', error);
        res.json({ timelineId: null, contactName: null });
    }
});

// =============================================================================
// POST /api/pulse/ensure-timeline — find or create a timeline for a phone number
// Optionally link it to a contact (for new leads from API with no history).
// Body: { phone: string, contactId?: number }
// Returns: { timelineId, contactId, created }
// =============================================================================
router.post('/ensure-timeline', async (req, res) => {
    try {
        const { phone, contactId } = req.body;
        if (!phone) {
            return res.status(400).json({ error: 'phone is required' });
        }

        const companyId = req.user?.company_id || null;

        // If contactId is provided, resolve timeline for this specific contact
        if (contactId) {
            const existing = await db.query(
                'SELECT id FROM timelines WHERE contact_id = $1 LIMIT 1',
                [contactId]
            );
            if (existing.rows[0]) {
                return res.json({
                    timelineId: existing.rows[0].id,
                    contactId,
                    created: false,
                });
            }

            // No timeline for this contact — create one linked to the contact
            const newTl = await db.query(
                `INSERT INTO timelines (contact_id, company_id)
                 VALUES ($1, $2)
                 ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL
                 DO UPDATE SET updated_at = now()
                 RETURNING *`,
                [contactId, companyId]
            );
            console.log(`[Pulse] ensure-timeline: created timeline ${newTl.rows[0].id} for contact ${contactId}`);
            return res.json({
                timelineId: newTl.rows[0].id,
                contactId,
                created: true,
            });
        }

        // No contactId — resolve by phone number (orphan or contact-linked)
        const timeline = await queries.findOrCreateTimeline(phone, companyId);

        res.json({
            timelineId: timeline.id,
            contactId: timeline.contact_id || null,
            created: false,
        });
    } catch (error) {
        console.error('[Pulse] POST /ensure-timeline error:', error);
        res.status(500).json({ error: 'Failed to ensure timeline' });
    }
});

// =============================================================================
// POST /api/pulse/threads/:id/mark-handled — clear Action Required + close task
// =============================================================================
router.post('/threads/:id/mark-handled', async (req, res) => {
    try {
        const timelineId = parseInt(req.params.id);
        if (isNaN(timelineId)) return res.status(400).json({ error: 'Invalid timeline id' });

        const tl = await queries.markThreadHandled(timelineId);
        if (!tl) return res.status(404).json({ error: 'Timeline not found' });

        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('thread.handled', { timelineId });

        res.json({ timeline: tl });
    } catch (error) {
        console.error('[Pulse] mark-handled error:', error);
        res.status(500).json({ error: 'Failed to mark handled' });
    }
});

// =============================================================================
// POST /api/pulse/threads/:id/snooze — snooze until given time
// =============================================================================
router.post('/threads/:id/snooze', async (req, res) => {
    try {
        const timelineId = parseInt(req.params.id);
        if (isNaN(timelineId)) return res.status(400).json({ error: 'Invalid timeline id' });

        const { snoozed_until } = req.body;
        if (!snoozed_until) return res.status(400).json({ error: 'snoozed_until is required' });

        const tl = await queries.snoozeThread(timelineId, snoozed_until);
        if (!tl) return res.status(404).json({ error: 'Timeline not found' });

        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('thread.snoozed', { timelineId, snoozed_until });

        res.json({ timeline: tl });
    } catch (error) {
        console.error('[Pulse] snooze error:', error);
        res.status(500).json({ error: 'Failed to snooze thread' });
    }
});

// =============================================================================
// POST /api/pulse/threads/:id/assign — assign owner
// =============================================================================
router.post('/threads/:id/assign', async (req, res) => {
    try {
        const timelineId = parseInt(req.params.id);
        if (isNaN(timelineId)) return res.status(400).json({ error: 'Invalid timeline id' });

        const { owner_user_id } = req.body;
        if (!owner_user_id) return res.status(400).json({ error: 'owner_user_id is required' });

        const tl = await queries.assignThread(timelineId, owner_user_id);
        if (!tl) return res.status(404).json({ error: 'Timeline not found' });

        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('thread.assigned', { timelineId, owner_user_id });

        res.json({ timeline: tl });
    } catch (error) {
        console.error('[Pulse] assign error:', error);
        res.status(500).json({ error: 'Failed to assign thread' });
    }
});

// =============================================================================
// POST /api/pulse/threads/:id/tasks — create task + set Action Required
// =============================================================================
router.post('/threads/:id/tasks', async (req, res) => {
    try {
        const timelineId = parseInt(req.params.id);
        if (isNaN(timelineId)) return res.status(400).json({ error: 'Invalid timeline id' });

        const { title, description, priority, due_at } = req.body;
        if (!title) return res.status(400).json({ error: 'title is required' });

        // Get timeline to resolve company_id and subject
        const tlResult = await db.query('SELECT * FROM timelines WHERE id = $1', [timelineId]);
        const tl = tlResult.rows[0];
        if (!tl) return res.status(404).json({ error: 'Timeline not found' });

        const task = await queries.createTask({
            companyId: tl.company_id,
            threadId: timelineId,
            subjectType: 'contact',
            subjectId: tl.contact_id,
            title,
            description,
            priority,
            dueAt: due_at,
            ownerUserId: tl.owner_user_id,
            createdBy: 'user',
        });

        // Set action_required if not already set
        if (!tl.is_action_required) {
            await queries.setActionRequired(timelineId, 'manual', 'user');
        }

        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('thread.action_required', { timelineId, reason: 'manual', task });

        res.json({ task });
    } catch (error) {
        console.error('[Pulse] create task error:', error);
        res.status(500).json({ error: 'Failed to create task' });
    }
});

module.exports = router;
