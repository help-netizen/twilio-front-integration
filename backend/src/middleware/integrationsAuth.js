/**
 * Integrations Auth Middleware
 * 
 * Secure authentication for external lead generators using
 * X-BLANC-API-KEY and X-BLANC-API-SECRET headers.
 * 
 * Middleware chain: rejectLegacyAuth → validateHeaders → authenticateIntegration
 * 
 * SEC-003: secret stored as hash(secret + server_pepper)
 * SEC-004: constant-time comparison via crypto.timingSafeEqual
 * SEC-005: no secrets in logs
 */

const crypto = require('crypto');
const db = require('../db/connection');

const PEPPER = process.env.BLANC_SERVER_PEPPER;

// =============================================================================
// Hash helper
// =============================================================================

/**
 * Compute hash(secret + pepper) using SHA-256.
 * @param {string} secret
 * @returns {string} hex-encoded hash
 */
function hashSecret(secret) {
    if (!PEPPER) {
        throw new Error('BLANC_SERVER_PEPPER is not set');
    }
    return crypto
        .createHash('sha256')
        .update(secret + PEPPER)
        .digest('hex');
}

/**
 * Constant-time comparison of two hex strings (SEC-004).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// =============================================================================
// Middleware: reject legacy auth formats
// =============================================================================

/**
 * Reject requests that use legacy Workiz-style auth:
 * - api_key in query string
 * - auth_secret in request body
 */
function rejectLegacyAuth(req, res, next) {
    if (req.query.api_key) {
        return res.status(401).json({
            success: false,
            code: 'AUTH_LEGACY_REJECTED',
            message: 'api_key in query string is not accepted. Use X-BLANC-API-KEY header.',
            request_id: req.requestId,
        });
    }
    if (req.body && req.body.auth_secret) {
        return res.status(401).json({
            success: false,
            code: 'AUTH_LEGACY_REJECTED',
            message: 'auth_secret in body is not accepted. Use X-BLANC-API-SECRET header.',
            request_id: req.requestId,
        });
    }
    next();
}

// =============================================================================
// Middleware: validate required headers present
// =============================================================================

/**
 * Check that both X-BLANC-API-KEY and X-BLANC-API-SECRET headers are present.
 */
function validateHeaders(req, res, next) {
    const apiKey = req.headers['x-blanc-api-key'];
    const apiSecret = req.headers['x-blanc-api-secret'];

    if (!apiKey || !apiSecret) {
        return res.status(401).json({
            success: false,
            code: 'AUTH_HEADERS_REQUIRED',
            message: 'X-BLANC-API-KEY and X-BLANC-API-SECRET headers are required.',
            request_id: req.requestId,
        });
    }

    // Attach for downstream use (key only — never log the secret)
    req.blancApiKey = apiKey;
    req.blancApiSecret = apiSecret;
    next();
}

// =============================================================================
// Middleware: authenticate integration
// =============================================================================

/**
 * Look up integration by key_id, verify secret, check expiry/revocation.
 * Updates last_used_at on success.
 */
async function authenticateIntegration(req, res, next) {
    try {
        const apiKey = req.blancApiKey;
        const apiSecret = req.blancApiSecret;

        // Look up integration by key_id
        const result = await db.query(
            'SELECT id, key_id, secret_hash, scopes, expires_at, revoked_at FROM api_integrations WHERE key_id = $1',
            [apiKey]
        );

        if (result.rows.length === 0) {
            // Mask key in logs
            const masked = apiKey.length > 4 ? apiKey.slice(0, 4) + '****' : '****';
            console.warn(`[Auth] Invalid key_id: ${masked}`);
            return res.status(401).json({
                success: false,
                code: 'AUTH_KEY_INVALID',
                message: 'Invalid API key.',
                request_id: req.requestId,
            });
        }

        const integration = result.rows[0];

        // Check revoked
        if (integration.revoked_at) {
            return res.status(401).json({
                success: false,
                code: 'AUTH_CREDENTIALS_INACTIVE',
                message: 'This integration has been revoked.',
                request_id: req.requestId,
            });
        }

        // Check expired
        if (integration.expires_at && new Date(integration.expires_at) < new Date()) {
            return res.status(401).json({
                success: false,
                code: 'AUTH_CREDENTIALS_INACTIVE',
                message: 'This integration has expired.',
                request_id: req.requestId,
            });
        }

        // Verify secret (constant-time)
        const incomingHash = hashSecret(apiSecret);
        if (!safeCompare(incomingHash, integration.secret_hash)) {
            return res.status(401).json({
                success: false,
                code: 'AUTH_SECRET_INVALID',
                message: 'Invalid API secret.',
                request_id: req.requestId,
            });
        }

        // Auth passed — attach integration info to request
        req.integrationKeyId = integration.key_id;
        req.integrationId = integration.id;
        req.integrationScopes = integration.scopes;

        // Update last_used_at in background (don't block response)
        db.query(
            'UPDATE api_integrations SET last_used_at = now() WHERE id = $1',
            [integration.id]
        ).catch(err => console.error('[Auth] Failed to update last_used_at:', err.message));

        // Clean up secret from request
        delete req.blancApiSecret;

        next();
    } catch (err) {
        console.error('[Auth] Unexpected error:', err.message);
        return res.status(500).json({
            success: false,
            code: 'AUTH_INTERNAL_ERROR',
            message: 'Authentication service error.',
            request_id: req.requestId,
        });
    }
}

module.exports = {
    hashSecret,
    safeCompare,
    rejectLegacyAuth,
    validateHeaders,
    authenticateIntegration,
};
