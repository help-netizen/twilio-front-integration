/**
 * Storage Service — S3-compatible object storage.
 *
 * STORAGE-VULTR-001 (2026-08): migrated off the decommissioned Tigris (Fly) bucket to
 * self-hosted MinIO on the Vultr box, fronted by Caddy at https://storage.albusto.com.
 * Provides file upload, presigned URL generation, and deletion. Config via env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, BUCKET_NAME
 * MinIO uses PATH-STYLE addressing (endpoint/bucket/key), so forcePathStyle is required —
 * both for the SDK's own requests and for the presigned URLs it hands the browser.
 */

const {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
} = require('@aws-sdk/client-s3');
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
        forcePathStyle: true, // MinIO (self-hosted) addresses buckets by path, not vhost
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
 * Download a stored object into memory.
 *
 * Note attachments are capped at 10 MB before upload, so buffering one image is
 * bounded and lets the vision worker send the original bytes to Gemini.
 *
 * @param {string} storageKey - S3 object key
 * @returns {Promise<Buffer>}
 */
async function downloadFile(storageKey) {
    const client = getClient();
    const response = await client.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: storageKey,
    }));
    const body = response.Body;
    if (!body) throw new Error('Stored attachment has no body');
    if (Buffer.isBuffer(body)) return body;
    if (typeof body.transformToByteArray === 'function') {
        return Buffer.from(await body.transformToByteArray());
    }

    const chunks = [];
    for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
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
 * Check whether an object exists without downloading it.
 *
 * @param {string} storageKey - S3 object key
 * @returns {Promise<boolean>}
 */
async function fileExists(storageKey) {
    const client = getClient();
    try {
        await client.send(new HeadObjectCommand({
            Bucket: BUCKET,
            Key: storageKey,
        }));
        return true;
    } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
            return false;
        }
        throw err;
    }
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
    downloadFile,
    getPresignedUrl,
    fileExists,
    deleteFile,
};
