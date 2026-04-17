/**
 * Email Workspace Routes (EMAIL-001)
 *
 * /api/email — tenant-scoped email workspace API
 *
 * Mounted with authenticate + requireCompanyAccess in server.js.
 * Individual endpoints enforce permission checks.
 */

const express = require('express');
const multer = require('multer');
const { requirePermission } = require('../middleware/authorization');
const emailQueries = require('../db/emailQueries');
const emailService = require('../services/emailService');
const emailMailboxService = require('../services/emailMailboxService');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ─── GET /api/email/mailbox ──────────────────────────────────────────────
// Non-secret mailbox state for the workspace
router.get('/mailbox', requirePermission('messages.view_internal'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const mailbox = await emailMailboxService.getMailboxStatus(companyId);
        res.json({ ok: true, data: { mailbox } });
    } catch (err) {
        console.error('[Email] GET /mailbox error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /api/email/threads ──────────────────────────────────────────────
// Server-driven thread list with view, search, cursor, limit
router.get('/threads', requirePermission('messages.view_internal'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { view = 'all', q, cursor, limit = '30' } = req.query;

        const result = await emailQueries.getThreads({
            company_id: companyId,
            view,
            q: q || null,
            cursor: cursor || null,
            limit: Math.min(parseInt(limit) || 30, 100),
        });

        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Email] GET /threads error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /api/email/threads/:threadId ────────────────────────────────────
// Full thread detail with messages + attachments
router.get('/threads/:threadId', requirePermission('messages.view_internal'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const threadId = req.params.threadId;

        const thread = await emailQueries.getThreadById(threadId, companyId);
        if (!thread) return res.status(404).json({ ok: false, error: 'Thread not found' });

        const messages = await emailQueries.getMessagesByThread(threadId, companyId);

        res.json({ ok: true, data: { thread, messages } });
    } catch (err) {
        console.error('[Email] GET /threads/:threadId error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /api/email/threads/:threadId/read ──────────────────────────────
// Mark thread as read (idempotent)
router.post('/threads/:threadId/read', requirePermission('messages.view_internal'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const thread = await emailQueries.markThreadRead(req.params.threadId, companyId);
        if (!thread) return res.status(404).json({ ok: false, error: 'Thread not found' });
        res.json({ ok: true, data: { thread } });
    } catch (err) {
        console.error('[Email] POST /threads/:threadId/read error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /api/email/threads/compose ─────────────────────────────────────
// Send a new email from the shared mailbox
router.post('/threads/compose', requirePermission('messages.send'), upload.array('files', 10), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { subject, body } = req.body;
        const to = req.body['to[]'] || req.body.to;
        const cc = req.body['cc[]'] || req.body.cc || [];

        const toList = Array.isArray(to) ? to : (to ? [to] : []);
        const ccList = Array.isArray(cc) ? cc : (cc ? [cc] : []);

        if (toList.length === 0) {
            return res.status(400).json({ ok: false, error: 'At least one recipient is required' });
        }
        if (!subject) {
            return res.status(400).json({ ok: false, error: 'Subject is required' });
        }
        if (!body && (!req.files || req.files.length === 0)) {
            return res.status(400).json({ ok: false, error: 'Body or attachment is required' });
        }

        const result = await emailService.sendEmail(companyId, {
            to: toList,
            cc: ccList,
            subject,
            body: body || '',
            files: req.files || [],
            userId: req.user?.sub,
            userEmail: req.user?.email,
        });

        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Email] POST /threads/compose error:', err.message);
        if (err.statusCode === 409) {
            return res.status(409).json({ ok: false, error: err.message });
        }
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── POST /api/email/threads/:threadId/reply ─────────────────────────────
// Reply in an existing Gmail thread
router.post('/threads/:threadId/reply', requirePermission('messages.send'), upload.array('files', 10), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const threadId = req.params.threadId;
        const { subject, body } = req.body;
        const to = req.body['to[]'] || req.body.to;
        const cc = req.body['cc[]'] || req.body.cc || [];

        const toList = Array.isArray(to) ? to : (to ? [to] : []);
        const ccList = Array.isArray(cc) ? cc : (cc ? [cc] : []);

        if (toList.length === 0) {
            return res.status(400).json({ ok: false, error: 'At least one recipient is required' });
        }
        if (!body && (!req.files || req.files.length === 0)) {
            return res.status(400).json({ ok: false, error: 'Body or attachment is required' });
        }

        const result = await emailService.replyToThread(companyId, threadId, {
            to: toList,
            cc: ccList,
            subject: subject || null,
            body: body || '',
            files: req.files || [],
            userId: req.user?.sub,
            userEmail: req.user?.email,
        });

        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Email] POST /threads/:threadId/reply error:', err.message);
        if (err.statusCode === 409) {
            return res.status(409).json({ ok: false, error: err.message });
        }
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── GET /api/email/attachments/:attachmentId/download ───────────────────
// Stream attachment through backend with tenant scoping
router.get('/attachments/:attachmentId/download', requirePermission('messages.view_internal'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const result = await emailService.getAttachmentStream(companyId, req.params.attachmentId);

        if (!result) return res.status(404).json({ ok: false, error: 'Attachment not found' });

        res.setHeader('Content-Type', result.contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${result.fileName || 'attachment'}"`);
        if (result.fileSize) res.setHeader('Content-Length', result.fileSize);
        res.send(result.buffer);
    } catch (err) {
        console.error('[Email] GET /attachments/:attachmentId/download error:', err.message);
        res.status(502).json({ ok: false, error: 'Failed to download attachment' });
    }
});

module.exports = router;
