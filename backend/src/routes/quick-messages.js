/**
 * Quick Messages API routes
 * CRUD + reorder for reusable SMS templates.
 * Mounted at /api/quick-messages
 */
const express = require('express');
const router = express.Router();
const qmQueries = require('../db/quickMessagesQueries');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

/** Resolve company_id: from user profile, companyFilter, or default */
function getCompanyId(req) {
    return req.user?.company_id
        || req.companyFilter?.company_id
        || DEFAULT_COMPANY_ID;
}

// GET /api/quick-messages — list all quick messages (ordered)
router.get('/', async (req, res) => {
    try {
        const messages = await qmQueries.getQuickMessages(getCompanyId(req));
        res.json({ messages });
    } catch (err) {
        console.error('[QuickMessages] GET / error:', err);
        res.status(500).json({ error: 'Failed to load quick messages' });
    }
});

// POST /api/quick-messages — create a new quick message
router.post('/', async (req, res) => {
    try {
        const { title, content } = req.body;
        if (!title || !content) {
            return res.status(400).json({ error: 'title and content are required' });
        }
        const message = await qmQueries.createQuickMessage(getCompanyId(req), title, content);
        res.status(201).json({ message });
    } catch (err) {
        console.error('[QuickMessages] POST / error:', err);
        res.status(500).json({ error: 'Failed to create quick message' });
    }
});

// PUT /api/quick-messages/reorder — update sort order
// Must be before /:id to avoid matching "reorder" as an id
router.put('/reorder', async (req, res) => {
    try {
        const { orderedIds } = req.body;
        if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
            return res.status(400).json({ error: 'orderedIds array is required' });
        }
        const messages = await qmQueries.reorderQuickMessages(getCompanyId(req), orderedIds);
        res.json({ messages });
    } catch (err) {
        console.error('[QuickMessages] PUT /reorder error:', err);
        res.status(500).json({ error: 'Failed to reorder quick messages' });
    }
});

// PUT /api/quick-messages/:id — update a quick message
router.put('/:id', async (req, res) => {
    try {
        const { title, content } = req.body;
        const message = await qmQueries.updateQuickMessage(req.params.id, getCompanyId(req), { title, content });
        if (!message) return res.status(404).json({ error: 'Quick message not found' });
        res.json({ message });
    } catch (err) {
        console.error('[QuickMessages] PUT /:id error:', err);
        res.status(500).json({ error: 'Failed to update quick message' });
    }
});

// DELETE /api/quick-messages/:id — delete a quick message
router.delete('/:id', async (req, res) => {
    try {
        const deleted = await qmQueries.deleteQuickMessage(req.params.id, getCompanyId(req));
        if (!deleted) return res.status(404).json({ error: 'Quick message not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[QuickMessages] DELETE /:id error:', err);
        res.status(500).json({ error: 'Failed to delete quick message' });
    }
});

module.exports = router;
