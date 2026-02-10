/**
 * Keycloak OIDC Auth Middleware
 * 
 * Verifies Bearer JWT tokens issued by Keycloak using JWKS (RS256).
 * Provides:
 *   - authenticate: verify token, attach req.user
 *   - requireRole(...roles): check user has at least one of the specified roles
 * 
 * ENV:
 *   KEYCLOAK_REALM_URL  — e.g. http://localhost:8080/realms/crm-prod
 *   FEATURE_AUTH        — set to "true" to enable (default: disabled)
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const userService = require('../services/userService');

const KEYCLOAK_REALM_URL = process.env.KEYCLOAK_REALM_URL;
const FEATURE_AUTH = process.env.FEATURE_AUTH_ENABLED === 'true';

// JWKS client — caches signing keys from Keycloak
let jwksRsa = null;
function getJwksClient() {
    if (jwksRsa) return jwksRsa;
    if (!KEYCLOAK_REALM_URL) return null;
    jwksRsa = jwksClient({
        jwksUri: `${KEYCLOAK_REALM_URL}/protocol/openid-connect/certs`,
        cache: true,
        cacheMaxAge: 600000, // 10 min
        rateLimit: true,
        jwksRequestsPerMinute: 10,
    });
    return jwksRsa;
}

/**
 * JWKS key retrieval callback for jwt.verify
 */
function getKey(header, callback) {
    const client = getJwksClient();
    if (!client) return callback(new Error('JWKS client not initialized'));
    client.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
    });
}

/**
 * Extract realm roles from Keycloak JWT.
 * Keycloak puts them in realm_access.roles and optionally in realm_roles mapper.
 */
function extractRoles(decoded) {
    const roles = new Set();
    // Standard Keycloak claim
    if (decoded.realm_access?.roles) {
        decoded.realm_access.roles.forEach(r => roles.add(r));
    }
    // Custom mapper (realm_roles)
    if (Array.isArray(decoded.realm_roles)) {
        decoded.realm_roles.forEach(r => roles.add(r));
    }
    return Array.from(roles);
}

/**
 * Middleware: authenticate
 * 
 * Verifies Bearer JWT, attaches req.user with:
 *   { sub, email, name, roles, crmUser }
 * 
 * If FEATURE_AUTH is off, sets req.user to a dev-mode stub.
 */
function authenticate(req, res, next) {
    // Feature flag — skip auth if disabled
    if (!FEATURE_AUTH) {
        req.user = {
            sub: 'dev-user',
            email: 'dev@localhost',
            name: 'Dev User',
            roles: ['owner_admin'],
            _devMode: true,
        };
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            ok: false,
            error: { code: 'AUTH_REQUIRED', message: 'Bearer token required' },
        });
    }

    const token = authHeader.slice(7);

    jwt.verify(token, getKey, {
        algorithms: ['RS256'],
        issuer: KEYCLOAK_REALM_URL,
    }, async (err, decoded) => {
        if (err) {
            console.warn('[Auth] JWT verification failed:', err.message);
            return res.status(401).json({
                ok: false,
                error: { code: 'AUTH_INVALID', message: 'Invalid or expired token' },
            });
        }

        const roles = extractRoles(decoded);

        req.user = {
            sub: decoded.sub,
            email: decoded.email || decoded.preferred_username,
            name: decoded.name || decoded.preferred_username || 'Unknown',
            roles,
        };

        // Upsert shadow profile (fire-and-forget for speed, but await to have crmUser)
        try {
            req.user.crmUser = await userService.findOrCreateUser({
                sub: decoded.sub,
                email: decoded.email,
                name: decoded.name,
                preferred_username: decoded.preferred_username,
                realm_roles: roles,
            });
        } catch (profileErr) {
            console.error('[Auth] Failed to sync user profile:', profileErr.message);
            // Non-fatal — continue without crmUser
        }

        next();
    });
}

/**
 * Middleware factory: requireRole
 * 
 * Returns middleware that checks req.user.roles includes at least one
 * of the specified roles. Returns 403 if not.
 * 
 * Usage: router.get('/admin', authenticate, requireRole('owner_admin'), handler)
 * 
 * @param  {...string} allowedRoles
 */
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        // Dev mode bypasses role checks
        if (req.user?._devMode) return next();

        const userRoles = req.user?.roles || [];
        const hasRole = allowedRoles.some(r => userRoles.includes(r));

        if (!hasRole) {
            console.warn(`[RBAC] Access denied for ${req.user?.email} — required: [${allowedRoles}], has: [${userRoles}]`);
            return res.status(403).json({
                ok: false,
                error: {
                    code: 'FORBIDDEN',
                    message: 'Insufficient permissions',
                    required_roles: allowedRoles,
                },
            });
        }
        next();
    };
}

module.exports = { authenticate, requireRole };
