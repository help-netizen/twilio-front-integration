/**
 * Integrations Service
 * 
 * CRUD operations for api_integrations table.
 * Handles credential generation, hashing, and management.
 */

const crypto = require('crypto');
const db = require('../db/connection');
const { hashSecret } = require('../middleware/integrationsAuth');

// =============================================================================
// Key / Secret generation
// =============================================================================

const KEY_PREFIX = 'blanc_';
const KEY_LENGTH = 24;   // total: blanc_ + 24 random chars
const SECRET_LENGTH = 48;

/**
 * Generate a random API key: blanc_<24 random hex chars>
 */
function generateKeyId() {
    return KEY_PREFIX + crypto.randomBytes(KEY_LENGTH / 2).toString('hex');
}

/**
 * Generate a random API secret: 48 random hex chars
 */
function generateSecret() {
    return crypto.randomBytes(SECRET_LENGTH / 2).toString('hex');
}

// =============================================================================
// Create Integration
// =============================================================================

/**
 * Create a new integration. Returns the plaintext secret ONCE.
 * @param {string} clientName
 * @param {string[]} scopes
 * @param {string|null} expiresAt  ISO date or null
 * @returns {{ key_id, secret, client_name, scopes, created_at, expires_at }}
 */
async function createIntegration(clientName, scopes = ['leads:create'], expiresAt = null) {
    const keyId = generateKeyId();
    const secret = generateSecret();
    const secretHash = hashSecret(secret);

    const result = await db.query(
        `INSERT INTO api_integrations (client_name, key_id, secret_hash, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, client_name, key_id, scopes, created_at, expires_at`,
        [clientName, keyId, secretHash, JSON.stringify(scopes), expiresAt]
    );

    const row = result.rows[0];

    return {
        id: row.id,
        client_name: row.client_name,
        key_id: row.key_id,
        secret, // plaintext — shown ONCE
        scopes: row.scopes,
        created_at: row.created_at,
        expires_at: row.expires_at,
    };
}

// =============================================================================
// List Integrations (no secret_hash exposed)
// =============================================================================

async function listIntegrations() {
    const result = await db.query(
        `SELECT id, client_name, key_id, scopes, created_at, expires_at, revoked_at, last_used_at, updated_at
         FROM api_integrations
         ORDER BY created_at DESC`
    );
    return result.rows;
}

// =============================================================================
// Revoke Integration
// =============================================================================

/**
 * Revoke an integration by setting revoked_at.
 * @param {string} keyId
 */
async function revokeIntegration(keyId) {
    const result = await db.query(
        `UPDATE api_integrations SET revoked_at = now() WHERE key_id = $1 AND revoked_at IS NULL
         RETURNING id, key_id, revoked_at`,
        [keyId]
    );

    if (result.rows.length === 0) {
        const err = new Error('Integration not found or already revoked');
        err.status = 404;
        throw err;
    }

    return result.rows[0];
}

// =============================================================================
// Get Integration by key_id (for auth middleware)
// =============================================================================

async function getIntegrationByKeyId(keyId) {
    const result = await db.query(
        `SELECT id, client_name, key_id, secret_hash, scopes, created_at, expires_at, revoked_at, last_used_at
         FROM api_integrations WHERE key_id = $1`,
        [keyId]
    );
    return result.rows[0] || null;
}

module.exports = {
    createIntegration,
    listIntegrations,
    revokeIntegration,
    getIntegrationByKeyId,
};
