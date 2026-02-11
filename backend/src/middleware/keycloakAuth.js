/**
 * Keycloak OIDC Auth Middleware
 * 
 * Verifies Bearer JWT tokens issued by Keycloak using JWKS (RS256).
 * Provides:
 *   - authenticate: verify token, attach req.user with company context
 *   - requireRole(...roles): check user has at least one specified role
 *   - requireCompanyAccess: ensure req scoped to user's company
 * 
 * Roles: super_admin, company_admin, company_member
 * 
 * ENV:
 *   KEYCLOAK_REALM_URL  — e.g. http://localhost:8080/realms/crm-prod
 *   FEATURE_AUTH_ENABLED — set to "true" to enable (default: disabled)
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const crypto = require('crypto');
const userService = require('../services/userService');
const auditService = require('../services/auditService');

const KEYCLOAK_REALM_URL = process.env.KEYCLOAK_REALM_URL;
const FEATURE_AUTH = process.env.FEATURE_AUTH_ENABLED === 'true';

// ── JWKS Client ─────────────────────────────────────────────────────────────

let jwksRsa = null;
function getJwksClient() {
    if (jwksRsa) return jwksRsa;
    if (!KEYCLOAK_REALM_URL) return null;
    jwksRsa = jwksClient({
        jwksUri: `${KEYCLOAK_REALM_URL}/protocol/openid-connect/certs`,
        cache: true,
        cacheMaxAge: 600000,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
    });
    return jwksRsa;
}

function getKey(header, callback) {
    const client = getJwksClient();
    if (!client) return callback(new Error('JWKS client not initialized'));
    client.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
    });
}

// ── Role helpers ────────────────────────────────────────────────────────────

/**
 * Extract realm roles from Keycloak JWT.
 */
function extractRoles(decoded) {
    const roles = new Set();
    if (decoded.realm_access?.roles) {
        decoded.realm_access.roles.forEach(r => roles.add(r));
    }
    if (Array.isArray(decoded.realm_roles)) {
        decoded.realm_roles.forEach(r => roles.add(r));
    }
    return Array.from(roles);
}

// ── Middleware: authenticate ────────────────────────────────────────────────

/**
 * Verify Bearer JWT, attach req.user with:
 *   { sub, email, name, roles, company_id, is_super_admin, crmUser, traceId }
 * 
 * Dev mode: sets a stub user with company_id pointing to default company.
 */
function authenticate(req, res, next) {
    // Generate trace_id for every request (§10)
    req.traceId = crypto.randomUUID().split('-')[0];

    // Dev mode bypass
    if (!FEATURE_AUTH) {
        req.user = {
            sub: 'dev-user',
            email: 'dev@localhost',
            name: 'Dev User',
            roles: ['company_admin'],
            company_id: null,
            is_super_admin: false,
            _devMode: true,
        };
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            code: 'AUTH_REQUIRED',
            message: 'Bearer token required',
            trace_id: req.traceId,
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
                code: 'AUTH_INVALID',
                message: 'Invalid or expired token',
                trace_id: req.traceId,
            });
        }

        const roles = extractRoles(decoded);
        const is_super_admin = roles.includes('super_admin');

        req.user = {
            sub: decoded.sub,
            email: decoded.email || decoded.preferred_username,
            name: decoded.name || decoded.preferred_username || 'Unknown',
            roles,
            is_super_admin,
            company_id: null,
        };

        // Resolve company_id from CRM DB (single source of truth)
        try {
            const crmUser = await userService.findOrCreateUser({
                sub: decoded.sub,
                email: decoded.email,
                name: decoded.name,
                preferred_username: decoded.preferred_username,
                realm_roles: roles,
            });
            req.user.crmUser = crmUser;
            req.user.company_id = crmUser?.company_id || null;
        } catch (profileErr) {
            console.error('[Auth] Failed to sync user profile:', profileErr.message);
        }

        next();
    });
}

// ── Middleware: requireRole ─────────────────────────────────────────────────

/**
 * Check req.user has at least one of the specified roles.
 * super_admin always passes.
 * 
 * Usage: router.get('/admin', authenticate, requireRole('company_admin'), handler)
 */
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (req.user?._devMode) return next();
        if (req.user?.is_super_admin) return next();

        const userRoles = req.user?.roles || [];
        const hasRole = allowedRoles.some(r => userRoles.includes(r));

        if (!hasRole) {
            console.warn(`[RBAC] Access denied for ${req.user?.email} — required: [${allowedRoles}], has: [${userRoles}]`);

            // Audit: access_denied_403
            auditService.log({
                actor_id: req.user?.crmUser?.id,
                actor_email: req.user?.email,
                actor_ip: req.ip,
                action: 'access_denied_403',
                target_type: 'route',
                target_id: `${req.method} ${req.originalUrl}`,
                company_id: req.user?.company_id,
                details: { required_roles: allowedRoles, user_roles: userRoles },
                trace_id: req.traceId,
            }).catch(() => { });

            return res.status(403).json({
                code: 'ACCESS_DENIED',
                message: 'Access denied',
                trace_id: req.traceId,
            });
        }
        next();
    };
}

// ── Middleware: requireCompanyAccess ─────────────────────────────────────────

/**
 * Ensure the authenticated user has a company_id resolved.
 * super_admin bypasses (global context — §5).
 * 
 * Attaches req.companyFilter for use in DB queries:
 *   - For super_admin: {} (no filter)
 *   - For others: { company_id: '<uuid>' }
 */
function requireCompanyAccess(req, res, next) {
    if (req.user?._devMode) {
        req.companyFilter = { company_id: req.user.company_id };
        return next();
    }

    // super_admin can access all companies
    if (req.user?.is_super_admin) {
        req.companyFilter = {};
        return next();
    }

    if (!req.user?.company_id) {
        console.warn(`[RBAC] No company_id for user ${req.user?.email}`);
        return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'No company association found',
            trace_id: req.traceId,
        });
    }

    req.companyFilter = { company_id: req.user.company_id };
    next();
}

module.exports = { authenticate, requireRole, requireCompanyAccess };
