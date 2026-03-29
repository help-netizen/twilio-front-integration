/**
 * Portal Queries Module
 * PF005 Client Portal MVP — Sprint 6
 *
 * Database queries for portal_access_tokens, portal_sessions, portal_events.
 */
const db = require('./connection');
const crypto = require('crypto');

// =============================================================================
// Helper
// =============================================================================

function hashToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// =============================================================================
// Access Tokens
// =============================================================================

/**
 * Generate a random 48-byte hex token, hash it, store in portal_access_tokens.
 * Returns { rawToken, tokenRecord }.
 */
async function createAccessToken(companyId, contactId, {
    scope = 'full',
    documentType = null,
    documentId = null,
    expiresInHours = 24,
    createdBy = null,
} = {}) {
    const rawToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = hashToken(rawToken);

    const { rows } = await db.query(
        `INSERT INTO portal_access_tokens
            (company_id, contact_id, token_hash, scope, document_type, document_id, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' hours')::interval, $8)
         RETURNING *`,
        [companyId, contactId, tokenHash, scope, documentType, documentId, String(expiresInHours), createdBy]
    );

    return { rawToken, tokenRecord: rows[0] };
}

/**
 * Hash the raw token and look up a valid (non-expired, non-revoked) record.
 */
async function findValidToken(rawToken) {
    const tokenHash = hashToken(rawToken);
    const { rows } = await db.query(
        `SELECT * FROM portal_access_tokens
         WHERE token_hash = $1 AND expires_at > NOW() AND revoked_at IS NULL`,
        [tokenHash]
    );
    return rows[0] || null;
}

/**
 * Revoke a single token by ID.
 */
async function revokeToken(tokenId) {
    const { rows } = await db.query(
        `UPDATE portal_access_tokens SET revoked_at = NOW() WHERE id = $1 RETURNING *`,
        [tokenId]
    );
    return rows[0] || null;
}

/**
 * Revoke all active tokens for a contact.
 */
async function revokeAllContactTokens(contactId) {
    const { rowCount } = await db.query(
        `UPDATE portal_access_tokens SET revoked_at = NOW()
         WHERE contact_id = $1 AND revoked_at IS NULL`,
        [contactId]
    );
    return rowCount;
}

// =============================================================================
// Sessions
// =============================================================================

/**
 * Create a new portal session.
 */
async function createSession(tokenId, contactId, ipAddress, userAgent) {
    const { rows } = await db.query(
        `INSERT INTO portal_sessions (token_id, contact_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tokenId, contactId, ipAddress, userAgent]
    );
    return rows[0];
}

/**
 * Get an active session with its token details.
 * Only returns if session is not ended and token is valid.
 */
async function getSessionById(sessionId) {
    const { rows } = await db.query(
        `SELECT s.*,
                t.company_id,
                t.scope,
                t.document_type,
                t.document_id,
                t.expires_at AS token_expires_at
         FROM portal_sessions s
         JOIN portal_access_tokens t ON s.token_id = t.id
         WHERE s.id = $1
           AND s.ended_at IS NULL
           AND t.revoked_at IS NULL
           AND t.expires_at > NOW()`,
        [sessionId]
    );
    return rows[0] || null;
}

/**
 * Touch session last_active_at.
 */
async function touchSession(sessionId) {
    await db.query(
        `UPDATE portal_sessions SET last_active_at = NOW() WHERE id = $1`,
        [sessionId]
    );
}

/**
 * End a session.
 */
async function endSession(sessionId) {
    const { rows } = await db.query(
        `UPDATE portal_sessions SET ended_at = NOW() WHERE id = $1 RETURNING *`,
        [sessionId]
    );
    return rows[0] || null;
}

// =============================================================================
// Events
// =============================================================================

/**
 * Log a portal event.
 */
async function logEvent(sessionId, contactId, eventType, documentType = null, documentId = null, metadata = null) {
    const { rows } = await db.query(
        `INSERT INTO portal_events (session_id, contact_id, event_type, document_type, document_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [sessionId, contactId, eventType, documentType, documentId, metadata ? JSON.stringify(metadata) : null]
    );
    return rows[0];
}

// =============================================================================
// Contact Documents
// =============================================================================

/**
 * Get documents accessible to a contact based on token scope.
 * If scope is 'full': returns all estimates + invoices for this contact.
 * If scope is scoped to a specific document_type/document_id: returns only that.
 */
async function getContactDocuments(companyId, contactId, scope, documentType = null, documentId = null) {
    if (scope !== 'full' && documentType && documentId) {
        // Scoped to a single document
        if (documentType === 'estimate') {
            const { rows } = await db.query(
                `SELECT 'estimate' AS type, id, estimate_number AS number, status, total, created_at
                 FROM estimates
                 WHERE id = $1 AND company_id = $2 AND contact_id = $3`,
                [documentId, companyId, contactId]
            );
            return rows;
        }
        if (documentType === 'invoice') {
            const { rows } = await db.query(
                `SELECT 'invoice' AS type, id, invoice_number AS number, status, total, created_at
                 FROM invoices
                 WHERE id = $1 AND company_id = $2 AND contact_id = $3`,
                [documentId, companyId, contactId]
            );
            return rows;
        }
        return [];
    }

    // Full scope: union estimates + invoices for this contact
    const { rows } = await db.query(
        `SELECT 'estimate' AS type, id, estimate_number AS number, status, total, created_at
         FROM estimates
         WHERE company_id = $1 AND contact_id = $2
         UNION ALL
         SELECT 'invoice' AS type, id, invoice_number AS number, status, total, created_at
         FROM invoices
         WHERE company_id = $1 AND contact_id = $2
         ORDER BY created_at DESC`,
        [companyId, contactId]
    );
    return rows;
}

// =============================================================================
// Contact
// =============================================================================

/**
 * Get a contact by ID (limited fields for portal).
 */
async function getContactById(contactId) {
    const { rows } = await db.query(
        `SELECT id, company_id, full_name AS name, email, phone_e164 AS phone
         FROM contacts WHERE id = $1`,
        [contactId]
    );
    return rows[0] || null;
}

/**
 * Update contact basic info (for portal profile update).
 */
async function updateContactProfile(contactId, { name, email, phone }) {
    const sets = [];
    const params = [contactId];
    let idx = 1;

    if (name !== undefined) {
        idx++;
        sets.push(`full_name = $${idx}`);
        params.push(name);
    }
    if (email !== undefined) {
        idx++;
        sets.push(`email = $${idx}`);
        params.push(email);
    }
    if (phone !== undefined) {
        idx++;
        sets.push(`phone_e164 = $${idx}`);
        params.push(phone);
    }

    if (sets.length === 0) return getContactById(contactId);

    sets.push('updated_at = NOW()');

    const { rows } = await db.query(
        `UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 RETURNING
         id, company_id, full_name AS name, email, phone_e164 AS phone`,
        params
    );
    return rows[0] || null;
}

// =============================================================================
// Payment History
// =============================================================================

/**
 * Get payment history for a contact.
 */
async function getContactPaymentHistory(companyId, contactId) {
    const { rows } = await db.query(
        `SELECT * FROM payment_transactions
         WHERE company_id = $1 AND contact_id = $2
         ORDER BY created_at DESC`,
        [companyId, contactId]
    );
    return rows;
}

// =============================================================================
// Bookings (Jobs)
// =============================================================================

/**
 * Get jobs for a contact.
 */
async function getContactBookings(companyId, contactId) {
    const { rows } = await db.query(
        `SELECT id, title, status, scheduled_at
         FROM jobs
         WHERE company_id = $1 AND contact_id = $2
         ORDER BY scheduled_at DESC NULLS LAST`,
        [companyId, contactId]
    );
    return rows;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    createAccessToken,
    findValidToken,
    revokeToken,
    revokeAllContactTokens,
    createSession,
    getSessionById,
    touchSession,
    endSession,
    logEvent,
    getContactDocuments,
    getContactById,
    updateContactProfile,
    getContactPaymentHistory,
    getContactBookings,
};
