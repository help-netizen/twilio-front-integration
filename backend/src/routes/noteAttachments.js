/**
 * Note Attachments Routes
 *
 * GET /api/note-attachments/:id/url — presigned download URL for an attachment
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const noteAttachmentsService = require('../services/noteAttachmentsService');
const db = require('../db/connection');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: noteAttachmentsService.MAX_FILE_SIZE, files: noteAttachmentsService.MAX_FILES_PER_NOTE },
});

const VALID_ENTITY_TYPES = new Set(['job', 'lead', 'contact']);
const ENTITY_PERMISSIONS = {
    job: {
        view: ['jobs.view'],
        edit: ['jobs.edit', 'jobs.done_pending_approval'],
    },
    lead: {
        view: ['leads.view'],
        edit: ['leads.edit'],
    },
    contact: {
        view: ['contacts.view'],
        edit: ['contacts.edit'],
    },
};

function requireBodyEntityPermission(access) {
    return (req, res, next) => {
        const permissions = ENTITY_PERMISSIONS[req.body?.entity_type]?.[access];
        if (!permissions) return next(); // Handler returns the existing validation error.
        return requirePermission(...permissions)(req, res, next);
    };
}

async function canAccessJob(req, companyId, jobId) {
    const scope = getProviderScope(req);
    if (!scope.assignedOnly) return true;
    if (!scope.userId) return false;
    const result = await db.query(
        `SELECT 1
         FROM jobs
         WHERE id = $1 AND company_id = $2
           AND assigned_provider_user_ids @> $3::jsonb
         LIMIT 1`,
        [jobId, companyId, JSON.stringify([scope.userId])]
    );
    return result.rows.length > 0;
}

async function loadAttachmentEntity(req, res, next) {
    try {
        const attachmentId = parseInt(req.params.id, 10);
        if (isNaN(attachmentId)) {
            return res.status(400).json({ ok: false, error: 'Invalid attachment ID' });
        }

        const companyId = req.companyFilter?.company_id;
        const result = await db.query(
            `SELECT entity_type, entity_id, note_index, uploaded_by
             FROM note_attachments
             WHERE id = $1 AND company_id = $2`,
            [attachmentId, companyId]
        );
        const entityType = result.rows[0]?.entity_type;
        if (!VALID_ENTITY_TYPES.has(entityType)) {
            return res.status(404).json({ ok: false, error: 'Attachment not found' });
        }
        if (entityType === 'job' && !await canAccessJob(req, companyId, result.rows[0].entity_id)) {
            return res.status(404).json({ ok: false, error: 'Attachment not found' });
        }

        req.attachmentId = attachmentId;
        req.attachmentEntityType = entityType;
        req.attachmentNoteIndex = result.rows[0].note_index;
        req.attachmentUploadedBy = result.rows[0].uploaded_by;
        next();
    } catch (err) {
        next(err);
    }
}

function requireLoadedEntityPermission(access) {
    return (req, res, next) => {
        if (req.user?._devMode) return next();
        if (access === 'edit' && req.attachmentEntityType === 'job') {
            const permissions = req.authz?.permissions || [];
            if (permissions.includes('jobs.edit')) return next();
            const ownsStagedUpload = permissions.includes('jobs.done_pending_approval')
                && req.attachmentNoteIndex == null
                && req.attachmentUploadedBy != null
                && String(req.attachmentUploadedBy) === String(req.user?.crmUser?.id);
            if (ownsStagedUpload) return next();
            return requirePermission('jobs.edit')(req, res, next);
        }
        const permissions = ENTITY_PERMISSIONS[req.attachmentEntityType]?.[access] || [];
        return requirePermission(...permissions)(req, res, next);
    };
}

/**
 * POST /upload — NOTE-ATTACH-UPLOAD-001: stage attachment(s) BEFORE the note is saved.
 * Body (multipart): attachments[] + entity_type (job|lead|contact) + entity_id.
 * Uploads to S3 and returns ids the note-create/edit then associates. Company-isolated.
 */
router.post('/upload', upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE),
    requirePermission('jobs.edit', 'jobs.done_pending_approval', 'leads.edit', 'contacts.edit'),
    requireBodyEntityPermission('edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const entityType = req.body.entity_type;
        const requestedEntityId = req.body.entity_id;
        const files = req.files || [];

        if (!VALID_ENTITY_TYPES.has(entityType)) {
            return res.status(400).json({ ok: false, error: 'Invalid entity_type' });
        }
        if (typeof requestedEntityId !== 'string' || requestedEntityId.trim() === '') {
            return res.status(400).json({ ok: false, error: 'Invalid entity_id' });
        }
        if (entityType !== 'lead' && !/^\d+$/.test(requestedEntityId.trim())) {
            return res.status(400).json({ ok: false, error: 'Invalid entity_id' });
        }
        if (files.length === 0) {
            return res.status(400).json({ ok: false, error: 'No files provided' });
        }
        const entityId = await noteAttachmentsService.resolveEntityIdInCompany(companyId, entityType, requestedEntityId);
        if (entityId == null) {
            return res.status(404).json({ ok: false, error: 'Entity not found' });
        }
        if (entityType === 'job' && !await canAccessJob(req, companyId, entityId)) {
            return res.status(404).json({ ok: false, error: 'Entity not found' });
        }

        const userId = req.user?.crmUser?.id || null;
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
router.get('/:id/url', loadAttachmentEntity,
    requirePermission('jobs.view', 'leads.view', 'contacts.view'),
    requireLoadedEntityPermission('view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const attachmentId = req.attachmentId;

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
router.delete('/:id', loadAttachmentEntity,
    requirePermission('jobs.edit', 'jobs.done_pending_approval', 'leads.edit', 'contacts.edit'),
    requireLoadedEntityPermission('edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const attachmentId = req.attachmentId;

        const deleted = await noteAttachmentsService.deleteAttachment(companyId, attachmentId);
        if (!deleted) return res.status(404).json({ ok: false, error: 'Attachment not found' });

        res.json({ ok: true });
    } catch (err) {
        console.error('[NoteAttachments] Error deleting:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to delete attachment' });
    }
});

module.exports = router;
