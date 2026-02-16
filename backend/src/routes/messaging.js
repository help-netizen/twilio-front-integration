/**
 * Messaging API routes
 * REST API for frontend SMS Conversations UI.
 * Mounted at /api/messaging
 */
const express = require('express');
const router = express.Router();
const convQueries = require('../db/conversationsQueries');
const conversationsService = require('../services/conversationsService');

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

// POST /api/messaging/:id/messages — send a message
router.post('/:id/messages', async (req, res) => {
    try {
        const { body, mediaUrl, author } = req.body;
        if (!body && !mediaUrl) {
            return res.status(400).json({ error: 'body or mediaUrl required' });
        }
        const message = await conversationsService.sendMessage(req.params.id, { body, author, mediaUrl });
        res.json({ message });
    } catch (err) {
        console.error('[Messaging] POST /:id/messages error:', err);
        res.status(500).json({ error: err.message || 'Failed to send message' });
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

// GET /api/messaging/media/:mediaId/temporary-url — redirect to actual media
router.get('/media/:mediaId/temporary-url', async (req, res) => {
    try {
        const result = await conversationsService.getMediaTemporaryUrl(req.params.mediaId);
        if (!result.url) {
            return res.status(404).json({ error: 'Media URL not available' });
        }
        // Redirect to the actual Twilio-hosted media URL
        res.redirect(result.url);
    } catch (err) {
        console.error('[Messaging] GET /media/:id/temporary-url error:', err);
        res.status(500).json({ error: err.message || 'Failed to get media URL' });
    }
});

module.exports = router;
