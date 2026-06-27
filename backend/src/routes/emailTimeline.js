/**
 * emailTimeline.js — outbound email from the contact timeline (EMAIL-TIMELINE-001,
 * TASK-ET-8). One route: POST /contacts/:contactId/send → reply-in-thread or
 * initiate, stamped onto the timeline. Mirrors the error→httpStatus mapping idiom
 * of slotEngineSettings.js (the service throws `err.httpStatus`/`err.code`; the
 * route maps it to a `{ ok:false, error:{ code, message } }` envelope).
 *
 * Mounted: app.use('/api/email/timeline', authenticate, requireCompanyAccess, router)
 */
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const emailTimelineService = require('../services/email/emailTimelineService');
const providerRegistry = require('../services/mail/providerRegistry');

function companyId(req) { return req.companyFilter?.company_id; }

// GET /mailbox-status — lightweight connection probe for the composer (FIX #2).
// Gated by messages.send (a sender, not a reader, needs this). Returns only
// { connected, email_address } — never tokens. A status read must never 500 the
// composer, so any failure degrades to { connected:false }.
router.get('/mailbox-status', requirePermission('messages.send'), async (req, res) => {
    try {
        const status = await providerRegistry.get(companyId(req)).getConnectionStatus(companyId(req));
        res.json({
            ok: true,
            data: {
                connected: !!(status && status.connected),
                email_address: (status && status.email_address) || null,
            },
        });
    } catch (err) {
        console.error('[EmailTimeline] mailbox-status error:', err.message);
        res.json({ ok: true, data: { connected: false } });
    }
});

// POST /contacts/:contactId/send — send (reply or initiate) to one of the contact's
// emails. Body: { body, toEmail } (no subject — auto for a new thread). 200 → the
// created outbound timeline item; coded errors → 409/404/422 (else 500).
router.post('/contacts/:contactId/send', requirePermission('messages.send'), async (req, res) => {
    try {
        const { body, toEmail } = req.body || {};
        const item = await emailTimelineService.sendForContact(
            companyId(req),
            req.params.contactId,
            { body, toEmail, userId: req.user?.sub, userEmail: req.user?.email }
        );
        res.json({ ok: true, data: item });
    } catch (err) {
        if (err && err.httpStatus) {
            return res.status(err.httpStatus).json({
                ok: false,
                error: { code: err.code || 'INVALID', message: err.message },
            });
        }
        console.error('[EmailTimeline] send error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
