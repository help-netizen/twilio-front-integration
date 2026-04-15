/**
 * Storage Service — S3-compatible object storage (Tigris on Fly.io)
 *
 * Provides file upload, presigned URL generation, and deletion.
 * Uses environment variables set by `fly storage create`:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, BUCKET_NAME
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const BUCKET = process.env.BUCKET_NAME || 'blanc-attachments';
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

let _client = null;

function getClient() {
    if (_client) return _client;
    _client = new S3Client({
        region: 'auto',
        endpoint: process.env.AWS_ENDPOINT_URL_S3,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        },
    });
    return _client;
}

/**
 * Generate a unique storage key for a note attachment.
 * Format: {companyId}/notes/{entityType}/{entityId}/{uuid}-{filename}
 */
function generateStorageKey(companyId, entityType, entityId, originalFilename) {
    const uuid = crypto.randomUUID();
    const ext = path.extname(originalFilename);
    const safeName = path.basename(originalFilename, ext)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .substring(0, 50);
    return `${companyId}/notes/${entityType}/${entityId}/${uuid}-${safeName}${ext}`;
}

/**
 * Upload a file buffer to S3.
 *
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type
 * @param {string} storageKey - S3 object key
 * @returns {Promise<void>}
 */
async function uploadFile(buffer, contentType, storageKey) {
    const client = getClient();
    await client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: storageKey,
        Body: buffer,
        ContentType: contentType,
    }));
}

/**
 * Generate a presigned GET URL for a file.
 *
 * @param {string} storageKey - S3 object key
 * @param {number} [expiresIn] - TTL in seconds (default: 1 hour)
 * @returns {Promise<string>} Presigned URL
 */
async function getPresignedUrl(storageKey, expiresIn = PRESIGNED_URL_EXPIRY) {
    const client = getClient();
    return getSignedUrl(client, new GetObjectCommand({
        Bucket: BUCKET,
        Key: storageKey,
    }), { expiresIn });
}

/**
 * Delete a file from S3.
 *
 * @param {string} storageKey - S3 object key
 * @returns {Promise<void>}
 */
async function deleteFile(storageKey) {
    const client = getClient();
    await client.send(new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: storageKey,
    }));
}

module.exports = {
    generateStorageKey,
    uploadFile,
    getPresignedUrl,
    deleteFile,
};
