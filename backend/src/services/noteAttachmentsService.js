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
 * @returns {Promise<Array<{id: number, fileName: string, contentType: string, fileSize: number}>>}
 */
async function createAttachments(companyId, entityType, entityId, noteIndex, files, userId) {
    if (!files || files.length === 0) return [];
    if (files.length > MAX_FILES_PER_NOTE) {
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
            `INSERT INTO note_attachments (company_id, entity_type, entity_id, note_index, file_name, content_type, file_size, storage_key, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, file_name, content_type, file_size`,
            [companyId, entityType, entityId, noteIndex, file.originalname, file.mimetype, file.size, storageKey, userId]
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
        `SELECT id, note_index, file_name, content_type, file_size, storage_key, created_at
         FROM note_attachments
         WHERE company_id = $1 AND entity_type = $2 AND entity_id = $3
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

module.exports = {
    MAX_FILE_SIZE,
    MAX_FILES_PER_NOTE,
    createAttachments,
    getAttachmentsForEntity,
    getPresignedUrlForAttachment,
    deleteAttachment,
};
