/**
 * Note Attachments Routes
 *
 * GET /api/note-attachments/:id/url — presigned download URL for an attachment
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const noteAttachmentsService = require('../services/noteAttachmentsService');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: noteAttachmentsService.MAX_FILE_SIZE, files: noteAttachmentsService.MAX_FILES_PER_NOTE },
});

const VALID_ENTITY_TYPES = new Set(['job', 'lead', 'contact']);

/**
 * POST /upload — NOTE-ATTACH-UPLOAD-001: stage attachment(s) BEFORE the note is saved.
 * Body (multipart): attachments[] + entity_type (job|lead|contact) + entity_id.
 * Uploads to S3 and returns ids the note-create/edit then associates. Company-isolated.
 */
router.post('/upload', upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const entityType = req.body.entity_type;
        const entityId = parseInt(req.body.entity_id, 10);
        const files = req.files || [];

        if (!VALID_ENTITY_TYPES.has(entityType)) {
            return res.status(400).json({ ok: false, error: 'Invalid entity_type' });
        }
        if (!Number.isInteger(entityId)) {
            return res.status(400).json({ ok: false, error: 'Invalid entity_id' });
        }
        if (files.length === 0) {
            return res.status(400).json({ ok: false, error: 'No files provided' });
        }
        const exists = await noteAttachmentsService.entityExistsInCompany(companyId, entityType, entityId);
        if (!exists) {
            return res.status(404).json({ ok: false, error: 'Entity not found' });
        }

        const userId = req.user?.crmUser?.id || req.user?.sub || null;
        const attachments = await noteAttachmentsService.stageAttachments(companyId, entityType, entityId, files, userId);
        res.json({ ok: true, data: { attachments } });
    } catch (err) {
        console.error('[NoteAttachments] Upload (stage) error:', err.message);
        res.status(err.status || 500).json({ ok: false, error: err.message || 'Upload failed' });
    }
});

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
