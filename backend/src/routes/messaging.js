/**
 * Messaging API routes
 * REST API for frontend SMS Conversations UI.
 * Mounted at /api/messaging
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const convQueries = require('../db/conversationsQueries');
const conversationsService = require('../services/conversationsService');

// Multer: memory storage, 10 MB max
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/messaging — list conversations
router.get('/', async (req, res) => {
    try {
        const { limit = 30, cursor, state } = req.query;
        const conversations = await convQueries.getConversations({
            limit: parseInt(limit),
            cursor,
            state,
            company_id: req.companyId,
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
router.get('/:id', async (req, res) => {
    try {
        const conv = await convQueries.getConversationById(req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ conversation: conv });
    } catch (err) {
        console.error('[Messaging] GET /:id error:', err);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// GET /api/messaging/:id/messages — messages in a conversation
router.get('/:id/messages', async (req, res) => {
    try {
        const { limit = 50, cursor } = req.query;
        const messages = await convQueries.getMessages(req.params.id, {
            limit: parseInt(limit),
            cursor,
        });
        res.json({ messages, hasMore: messages.length === parseInt(limit) });
    } catch (err) {
        console.error('[Messaging] GET /:id/messages error:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// POST /api/messaging/:id/messages — send a message (supports file attachment)
router.post('/:id/messages', upload.single('file'), async (req, res) => {
    try {
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
        const message = await conversationsService.sendMessage(req.params.id, { body: body || null, mediaSid, fileInfo });
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
router.post('/:id/mark-read', async (req, res) => {
    try {
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

// POST /api/messaging/start — start new conversation
router.post('/start', async (req, res) => {
    try {
        const { customerE164, proxyE164, initialMessage } = req.body;
        if (!customerE164 || !proxyE164) {
            return res.status(400).json({ error: 'customerE164 and proxyE164 required' });
        }
        const conversation = await conversationsService.getOrCreateConversation(
            customerE164, proxyE164, req.companyId
        );
        let message = null;
        if (initialMessage) {
            message = await conversationsService.sendMessage(conversation.id, { body: initialMessage });
        }
        res.json({ conversation, message });
    } catch (err) {
        console.error('[Messaging] POST /start error:', err);
        res.status(500).json({ error: err.message || 'Failed to start conversation' });
    }
});

module.exports = router;
