/**
 * Note Attachments Service
 *
 * Handles file uploads for notes on jobs, leads, and contacts.
 * Files are stored in S3 (Tigris), metadata in note_attachments table.
 */

const db = require('../db/connection');
const storageService = require('./storageService');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES_PER_NOTE = 5;
const ALLOWED_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * Upload files and create attachment records.
 *
 * @param {string} companyId
 * @param {'job'|'lead'|'contact'} entityType
 * @param {number} entityId
 * @param {number|null} noteIndex
 * @param {Array<{buffer: Buffer, mimetype: string, originalname: string, size: number}>} files
 * @param {string|null} userId
 * @param {{noteId?: string|null, existingCount?: number}} [opts]
 *   noteId — stable note id stamped onto note_attachments.note_id (NOTES-001).
 *   existingCount — attachments already on the note; counted toward MAX so the
 *   per-note cap covers surviving + newly added files (used by edit).
 * @returns {Promise<Array<{id: number, fileName: string, contentType: string, fileSize: number}>>}
 */
async function createAttachments(companyId, entityType, entityId, noteIndex, files, userId, opts = {}) {
    if (!files || files.length === 0) return [];
    const noteId = opts.noteId || null;
    const existingCount = opts.existingCount || 0;
    if (existingCount + files.length > MAX_FILES_PER_NOTE) {
        throw Object.assign(new Error(`Maximum ${MAX_FILES_PER_NOTE} files per note`), { status: 400 });
    }

    const results = [];

    for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
            throw Object.assign(
                new Error(`File "${file.originalname}" exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`),
                { status: 400 }
            );
        }
        if (!ALLOWED_TYPES.has(file.mimetype)) {
            throw Object.assign(
                new Error(`File type "${file.mimetype}" is not allowed`),
                { status: 400 }
            );
        }

        const storageKey = storageService.generateStorageKey(companyId, entityType, entityId, file.originalname);
        await storageService.uploadFile(file.buffer, file.mimetype, storageKey);

        const row = await db.query(
            `INSERT INTO note_attachments (company_id, entity_type, entity_id, note_index, note_id, file_name, content_type, file_size, storage_key, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, file_name, content_type, file_size`,
            [companyId, entityType, entityId, noteIndex, noteId, file.originalname, file.mimetype, file.size, storageKey, userId]
        );

        results.push(row.rows[0]);
    }

    return results;
}

/**
 * Get all attachments for an entity, with presigned URLs.
 */
async function getAttachmentsForEntity(companyId, entityType, entityId) {
    const result = await db.query(
        `SELECT id, note_index, note_id, file_name, content_type, file_size, storage_key, created_at
         FROM note_attachments
         WHERE company_id = $1 AND entity_type = $2 AND entity_id = $3
           AND note_index IS NOT NULL
         ORDER BY created_at`,
        [companyId, entityType, entityId]
    );

    const attachments = [];
    for (const row of result.rows) {
        let url;
        try {
            url = await storageService.getPresignedUrl(row.storage_key);
        } catch {
            url = null;
        }
        attachments.push({
            id: row.id,
            noteIndex: row.note_index,
            noteId: row.note_id,
            fileName: row.file_name,
            contentType: row.content_type,
            fileSize: row.file_size,
            url,
            createdAt: row.created_at,
        });
    }
    return attachments;
}

/**
 * Get a single presigned URL for an attachment (with company_id check).
 */
async function getPresignedUrlForAttachment(companyId, attachmentId) {
    const result = await db.query(
        `SELECT storage_key FROM note_attachments WHERE id = $1 AND company_id = $2`,
        [attachmentId, companyId]
    );
    if (result.rows.length === 0) return null;
    return storageService.getPresignedUrl(result.rows[0].storage_key);
}

/**
 * Delete an attachment (DB record + S3 object).
 */
async function deleteAttachment(companyId, attachmentId) {
    const result = await db.query(
        `DELETE FROM note_attachments WHERE id = $1 AND company_id = $2 RETURNING storage_key`,
        [attachmentId, companyId]
    );
    if (result.rows.length === 0) return false;
    try {
        await storageService.deleteFile(result.rows[0].storage_key);
    } catch (err) {
        console.warn('[NoteAttachments] Failed to delete S3 object:', err.message);
    }
    return true;
}

const ENTITY_TABLES = { job: 'jobs', lead: 'leads', contact: 'contacts' };

function validateFile(file) {
    if (file.size > MAX_FILE_SIZE) {
        throw Object.assign(new Error(`File "${file.originalname}" exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`), { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.mimetype)) {
        throw Object.assign(new Error(`File type "${file.mimetype}" is not allowed`), { status: 400 });
    }
}

/** Confirm an entity (job/lead/contact) belongs to the company (NOTE-ATTACH-UPLOAD-001 isolation). */
async function entityExistsInCompany(companyId, entityType, entityId) {
    const table = ENTITY_TABLES[entityType];
    if (!table) return false;
    const { rows } = await db.query(
        `SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [entityId, companyId]
    );
    return rows.length > 0;
}

/**
 * Resolve the public lead UUID used by lead notes to the legacy serial_id used
 * by note_attachments. Numeric ids remain supported for older callers.
 */
async function resolveEntityIdInCompany(companyId, entityType, entityId) {
    const rawEntityId = String(entityId ?? '').trim();
    if (!rawEntityId) return null;

    if (entityType === 'lead') {
        let { rows } = await db.query(
            `SELECT id, serial_id FROM leads WHERE uuid = $1 AND company_id = $2 LIMIT 1`,
            [rawEntityId, companyId]
        );
        if (rows.length === 0 && /^\d+$/.test(rawEntityId)) {
            ({ rows } = await db.query(
                `SELECT id, serial_id FROM leads WHERE id = $1 AND company_id = $2 LIMIT 1`,
                [Number(rawEntityId), companyId]
            ));
        }
        if (rows.length === 0) return null;
        return rows[0].serial_id ?? rows[0].id;
    }

    if (!/^\d+$/.test(rawEntityId)) return null;
    const numericId = Number(rawEntityId);
    if (!Number.isSafeInteger(numericId)) return null;
    return await entityExistsInCompany(companyId, entityType, numericId) ? numericId : null;
}

/**
 * Stage attachments BEFORE a note exists: upload to S3 + insert rows with
 * note_index = NULL (the "staged" marker — excluded from display, cleaned by cron
 * if abandoned). Returned ids are later passed to associateStagedAttachments.
 */
async function stageAttachments(companyId, entityType, entityId, files, userId) {
    if (!files || files.length === 0) return [];
    const results = [];
    for (const file of files) {
        validateFile(file);
        const storageKey = storageService.generateStorageKey(companyId, entityType, entityId, file.originalname);
        await storageService.uploadFile(file.buffer, file.mimetype, storageKey);
        const row = await db.query(
            `INSERT INTO note_attachments (company_id, entity_type, entity_id, note_index, note_id, file_name, content_type, file_size, storage_key, uploaded_by)
             VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7, $8)
             RETURNING id, file_name, content_type, file_size`,
            [companyId, entityType, entityId, file.originalname, file.mimetype, file.size, storageKey, userId]
        );
        results.push(row.rows[0]);
    }
    return results;
}

/**
 * Attach previously-staged uploads to a note: stamp note_id + note_index on rows
 * that are still staged (note_index IS NULL) and owned by this company+entity.
 * Foreign / already-committed / unknown ids are silently ignored.
 */
async function associateStagedAttachments(companyId, entityType, entityId, attachmentIds, noteId, noteIndex, opts = {}) {
    const ids = (attachmentIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return [];
    const existingCount = opts.existingCount || 0;
    if (existingCount + ids.length > MAX_FILES_PER_NOTE) {
        throw Object.assign(new Error(`Maximum ${MAX_FILES_PER_NOTE} files per note`), { status: 400 });
    }
    const { rows } = await db.query(
        `UPDATE note_attachments
            SET note_id = $1, note_index = $2
          WHERE id = ANY($3::bigint[])
            AND company_id = $4 AND entity_type = $5 AND entity_id = $6
            AND note_index IS NULL
        RETURNING id, file_name, content_type, file_size`,
        [noteId, noteIndex, ids, companyId, entityType, entityId]
    );
    return rows;
}

/**
 * Cron: delete staged attachments (note_index IS NULL) abandoned for > olderThanHours.
 * Removes the S3 object (best-effort) then the row. Returns the count deleted.
 */
async function deleteStaleStagedAttachments(olderThanHours = 24) {
    const { rows } = await db.query(
        `DELETE FROM note_attachments
          WHERE note_index IS NULL
            AND created_at < now() - ($1 || ' hours')::interval
        RETURNING storage_key`,
        [String(olderThanHours)]
    );
    for (const r of rows) {
        try { await storageService.deleteFile(r.storage_key); }
        catch (err) { console.warn('[NoteAttachments] stale S3 delete failed:', err.message); }
    }
    return rows.length;
}

module.exports = {
    MAX_FILE_SIZE,
    MAX_FILES_PER_NOTE,
    createAttachments,
    getAttachmentsForEntity,
    getPresignedUrlForAttachment,
    deleteAttachment,
    entityExistsInCompany,
    resolveEntityIdInCompany,
    stageAttachments,
    associateStagedAttachments,
    deleteStaleStagedAttachments,
};
