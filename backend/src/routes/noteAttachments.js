/**
 * Note Attachments Routes
 *
 * GET /api/note-attachments/:id/url — presigned download URL for an attachment
 */

const express = require('express');
const router = express.Router();
const noteAttachmentsService = require('../services/noteAttachmentsService');

/**
 * GET /:id/url
 * Returns a fresh presigned URL for downloading an attachment.
 * Company isolation enforced via company_id filter.
 */
router.get('/:id/url', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const attachmentId = parseInt(req.params.id, 10);
        if (isNaN(attachmentId)) return res.status(400).json({ ok: false, error: 'Invalid attachment ID' });

        const url = await noteAttachmentsService.getPresignedUrlForAttachment(companyId, attachmentId);
        if (!url) return res.status(404).json({ ok: false, error: 'Attachment not found' });

        res.json({ ok: true, url });
    } catch (err) {
        console.error('[NoteAttachments] Error getting URL:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to get attachment URL' });
    }
});

/**
 * DELETE /:id
 * Delete an attachment (S3 object + DB record).
 */
router.delete('/:id', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const attachmentId = parseInt(req.params.id, 10);
        if (isNaN(attachmentId)) return res.status(400).json({ ok: false, error: 'Invalid attachment ID' });

        const deleted = await noteAttachmentsService.deleteAttachment(companyId, attachmentId);
        if (!deleted) return res.status(404).json({ ok: false, error: 'Attachment not found' });

        res.json({ ok: true });
    } catch (err) {
        console.error('[NoteAttachments] Error deleting:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to delete attachment' });
    }
});

module.exports = router;
