/**
 * Email Settings Routes (EMAIL-001)
 *
 * /api/settings/email — mailbox lifecycle management
 *
 * All endpoints require tenant.integrations.manage permission
 * (enforced at mount in server.js).
 */

const express = require('express');
const emailMailboxService = require('../services/emailMailboxService');
const emailSyncService = require('../services/emailSyncService');
const providerRegistry = require('../services/mail/providerRegistry');

const router = express.Router();

// ─── GET /api/settings/email ─────────────────────────────────────────────
// Returns current mailbox status for the active company
router.get('/', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) return res.status(400).json({ ok: false, error: 'No company context' });

        const mailbox = await emailMailboxService.getMailboxStatus(companyId);
        res.json({ ok: true, data: { mailbox } });
    } catch (err) {
        console.error('[EmailSettings] GET / error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /api/settings/email/google/start ───────────────────────────────
// Returns Google OAuth URL for browser redirect
router.post('/google/start', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) return res.status(400).json({ ok: false, error: 'No company context' });

        const userId = req.user?.sub || req.user?.email;
        const authUrl = emailMailboxService.buildAuthUrl(companyId, userId);
        res.json({ ok: true, data: { auth_url: authUrl } });
    } catch (err) {
        console.error('[EmailSettings] POST /google/start error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /api/settings/email/disconnect ─────────────────────────────────
// Marks mailbox as disconnected without deleting synced history
router.post('/disconnect', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) return res.status(400).json({ ok: false, error: 'No company context' });

        const userId = req.user?.sub || req.user?.email;

        // EMAIL-TIMELINE-001 (TASK-ET-6) — tear down the Gmail push watch BEFORE disconnecting,
        // while the mailbox still holds a valid token. disconnectMailbox nulls the tokens, after
        // which stopWatch's users.stop could not authenticate and the watch would keep pushing
        // until it self-expires (≤7 days). Best-effort + safe-fail; a teardown failure must not
        // change the disconnect response.
        try {
            await providerRegistry.get(companyId).stopWatch(companyId);
        } catch (watchErr) {
            console.warn(`[EmailSettings] stopWatch (non-fatal) for company ${companyId}:`, watchErr.message);
        }

        const mailbox = await emailMailboxService.disconnectMailbox(companyId, userId);
        if (!mailbox) return res.status(404).json({ ok: false, error: 'No mailbox found' });

        res.json({ ok: true, data: { mailbox: { status: mailbox.status } } });
    } catch (err) {
        console.error('[EmailSettings] POST /disconnect error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /api/settings/email/sync ───────────────────────────────────────
// Triggers an immediate sync for the connected mailbox
router.post('/sync', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) return res.status(400).json({ ok: false, error: 'No company context' });

        const mailbox = await emailMailboxService.getMailboxStatus(companyId);
        if (!mailbox) return res.status(404).json({ ok: false, error: 'No mailbox found' });
        if (mailbox.status === 'disconnected') {
            return res.status(409).json({ ok: false, error: 'Mailbox is disconnected' });
        }

        // Trigger sync in background (don't await)
        emailSyncService.syncMailbox(companyId).catch(err => {
            console.error('[EmailSettings] Background sync error:', err.message);
        });

        res.json({ ok: true, data: { message: 'Sync started', mailbox } });
    } catch (err) {
        console.error('[EmailSettings] POST /sync error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
