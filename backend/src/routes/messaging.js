/**
 * Messaging API routes
 * REST API for frontend SMS Conversations UI.
 * Mounted at /api/messaging
 */
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope, PULSE_INACTIVE_JOB_STATUSES } = require('../middleware/providerScope');
const db = require('../db/connection');
const { getMaskViewer, redactPulsePayload } = require('../services/pulseMaskingService');

// Tenant + provider visibility for a conversation by id → null contract = 404
async function loadVisibleConversation(req) {
    const companyId = req.companyFilter?.company_id;
    const conv = await convQueries.getConversationById(req.params.id, companyId);
    if (!conv) return null;
    const scope = getProviderScope(req);
    if (scope.assignedOnly) {
        const ok = await convQueries.isConversationVisibleToProvider(conv.id, companyId, scope.userId);
        if (!ok) return null;
    }
    return conv;
}

// PF007-HARDENING-002: client SMS threads need message visibility; sending
// needs messages.send.
const msgRead = requirePermission('messages.view_client', 'messages.view_internal', 'pulse.view');
const multer = require('multer');
const convQueries = require('../db/conversationsQueries');
const conversationsService = require('../services/conversationsService');

async function resolveMaskedStartTarget(req, contactId, targetRef) {
    if (!(await getMaskViewer(req))) return null;
    if (!Number.isInteger(Number(contactId))) return null;

    const slot = targetRef === 'contact:primary'
        ? 'primary'
        : targetRef === 'contact:secondary' ? 'secondary' : null;
    if (!slot) return null;

    const companyId = req.companyFilter?.company_id;
    if (!companyId) return null;
    const scope = getProviderScope(req);
    const params = [Number(contactId), companyId];
    let providerFilter = '';
    if (scope.assignedOnly) {
        if (!scope.userId) {
            providerFilter = 'AND FALSE';
        } else {
            params.push(JSON.stringify([String(scope.userId)]), PULSE_INACTIVE_JOB_STATUSES);
            providerFilter = `AND EXISTS (
                SELECT 1
                FROM jobs visible_job
                WHERE visible_job.company_id = c.company_id
                  AND visible_job.contact_id = c.id
                  AND visible_job.assigned_provider_user_ids @> $3::jsonb
                  AND (visible_job.blanc_status IS NULL OR visible_job.blanc_status <> ALL($4::text[]))
            )`;
        }
    }

    const { rows } = await db.query(
        `SELECT c.phone_e164, c.secondary_phone
         FROM contacts c
         WHERE c.id = $1
           AND c.company_id = $2
           ${providerFilter}`,
        params
    );
    const customerE164 = slot === 'primary' ? rows[0]?.phone_e164 : rows[0]?.secondary_phone;
    if (!customerE164) return null;

    const proxy = await db.query(
        `SELECT proxy_e164
         FROM sms_conversations
         WHERE company_id = $1
           AND proxy_e164 IS NOT NULL
         ORDER BY
           (regexp_replace(customer_e164, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')) DESC,
           last_message_at DESC NULLS LAST
         LIMIT 1`,
        [companyId, customerE164]
    );
    if (!proxy.rows[0]?.proxy_e164) return null;
    return { customerE164, proxyE164: proxy.rows[0].proxy_e164 };
}

// Multer: memory storage, 10 MB max
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/messaging — list conversations
router.get('/', msgRead, async (req, res) => {
    try {
        const { limit = 30, cursor, state } = req.query;
        const conversations = await convQueries.getConversations({
            limit: parseInt(limit),
            cursor,
            state,
            company_id: req.companyFilter?.company_id,
        });
        const nextCursor = conversations.length === parseInt(limit)
            ? conversations[conversations.length - 1].last_message_at
            : null;
        res.json({ conversations, nextCursor });
    } catch (err) {
        console.error('[Messaging] GET / error:', err);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

// GET /api/messaging/:id — single conversation
router.get('/:id', msgRead, async (req, res) => {
    try {
        const conv = await loadVisibleConversation(req);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ conversation: conv });
    } catch (err) {
        console.error('[Messaging] GET /:id error:', err);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// GET /api/messaging/:id/messages — messages in a conversation
router.get('/:id/messages', msgRead, async (req, res) => {
    try {
        const conv = await loadVisibleConversation(req);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        const { limit = 50, cursor } = req.query;
        const messages = await convQueries.getMessages(req.params.id, {
            limit: parseInt(limit),
            cursor,
            companyId: req.companyFilter?.company_id,
        });
        res.json({ messages, hasMore: messages.length === parseInt(limit) });
    } catch (err) {
        console.error('[Messaging] GET /:id/messages error:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// POST /api/messaging/:id/messages — send a message (supports file attachment)
router.post('/:id/messages', requirePermission('messages.send'), upload.single('file'), async (req, res) => {
    try {
        const conv = await loadVisibleConversation(req);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        const body = req.body.body || '';
        const file = req.file;
        if (!body && !file) {
            return res.status(400).json({ error: 'body or file required' });
        }

        let mediaSid = null;
        if (file) {
            mediaSid = await conversationsService.uploadMediaToMCS(
                file.buffer, file.mimetype, file.originalname
            );
        }

        const fileInfo = file ? { filename: file.originalname, contentType: file.mimetype, size: file.size } : null;

        // Twilio Conversations drops body from SMS when mediaSid is set,
        // so send media and text as separate messages.
        let message;
        if (mediaSid && body) {
            // 1) media-only message
            message = await conversationsService.sendMessage(req.params.id, { body: null, mediaSid, fileInfo });
            // 2) text-only message
            message = await conversationsService.sendMessage(req.params.id, { body });
        } else {
            message = await conversationsService.sendMessage(req.params.id, { body: body || null, mediaSid, fileInfo });
        }

        res.json({ message });
    } catch (err) {
        console.error('[Messaging] POST /:id/messages error:', err);
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large (max 10 MB)' });
        }
        res.status(500).json({ error: err.message || 'Failed to send message' });
    }
});

// POST /api/messaging/:id/mark-read — mark conversation as read
router.post('/:id/mark-read', msgRead, async (req, res) => {
    try {
        const owned = await loadVisibleConversation(req);
        if (!owned) return res.status(404).json({ error: 'Conversation not found' });
        const conv = await convQueries.markConversationRead(req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        // SSE push updated conversation
        const realtimeService = require('../services/realtimeService');
        realtimeService.publishConversationUpdate(conv);
        res.json({ conversation: conv });
    } catch (err) {
        console.error('[Messaging] POST /:id/mark-read error:', err);
        res.status(500).json({ error: 'Failed to mark read' });
    }
});

// POST /api/messaging/:id/mark-unread — mark conversation as unread
router.post('/:id/mark-unread', msgRead, async (req, res) => {
    try {
        const owned = await loadVisibleConversation(req);
        if (!owned) return res.status(404).json({ error: 'Conversation not found' });
        const conv = await convQueries.markConversationUnread(req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        const realtimeService = require('../services/realtimeService');
        realtimeService.publishConversationUpdate(conv);
        res.json({ conversation: conv });
    } catch (err) {
        console.error('[Messaging] POST /:id/mark-unread error:', err);
        res.status(500).json({ error: 'Failed to mark unread' });
    }
});

// POST /api/messaging/start — start new conversation
router.post('/start', requirePermission('messages.send'), async (req, res) => {
    try {
        let { customerE164, proxyE164 } = req.body;
        const { initialMessage, contactId, targetRef } = req.body;
        const maskViewer = await getMaskViewer(req);
        if (maskViewer && (targetRef == null || contactId == null)) {
            return res.status(400).json({ error: 'Opaque message target required' });
        }
        if (targetRef != null || contactId != null) {
            const resolved = await resolveMaskedStartTarget(req, contactId, targetRef);
            if (!resolved) {
                return res.status(404).json({ error: 'Message target not found' });
            }
            ({ customerE164, proxyE164 } = resolved);
        }
        if (!customerE164 || !proxyE164) {
            return res.status(400).json({ error: 'customerE164 and proxyE164 required' });
        }
        const conversation = await conversationsService.getOrCreateConversation(
            customerE164, proxyE164, req.companyFilter?.company_id
        );
        let message = null;
        if (initialMessage) {
            message = await conversationsService.sendMessage(conversation.id, { body: initialMessage });
        }
        res.json(redactPulsePayload({ conversation, message }, maskViewer));
    } catch (err) {
        console.error('[Messaging] POST /start error:', err);
        res.status(500).json({ error: err.message || 'Failed to start conversation' });
    }
});

module.exports = router;
