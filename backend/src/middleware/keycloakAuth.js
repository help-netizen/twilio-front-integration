/**
 * Keycloak OIDC Auth Middleware — PF007 Evolution
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const crypto = require('crypto');
const userService = require('../services/userService');
const auditService = require('../services/auditService');
const authorizationService = require('../services/authorizationService');

const KEYCLOAK_REALM_URL = process.env.KEYCLOAK_REALM_URL;
const FEATURE_AUTH = process.env.FEATURE_AUTH_ENABLED === 'true';

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

function authenticate(req, res, next) {
    req.traceId = crypto.randomUUID().split('-')[0];

    if (!FEATURE_AUTH) {
        req.user = {
            sub: 'dev-user',
            email: 'dev@localhost',
            name: 'Dev User',
            roles: ['company_admin'],
            company_id: '00000000-0000-0000-0000-000000000001',
            is_super_admin: false,
            _devMode: true,
        };
        req.authz = authorizationService.buildDevAuthzContext();
        req.companyFilter = { company_id: req.user.company_id };
        return next();
    }

    const authHeader = req.headers.authorization;
    const token = (authHeader && authHeader.startsWith('Bearer '))
        ? authHeader.slice(7)
        : req.query.token;

    if (!token) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token required', trace_id: req.traceId });
    }

    jwt.verify(token, getKey, { algorithms: ['RS256'], issuer: KEYCLOAK_REALM_URL }, async (err, decoded) => {
        if (err) return res.status(401).json({ code: 'AUTH_INVALID', message: 'Invalid or expired token', trace_id: req.traceId });

        const roles = extractRoles(decoded);
        const is_super_admin = roles.includes('super_admin');

        req.user = { sub: decoded.sub, email: decoded.email || decoded.preferred_username, name: decoded.name || decoded.preferred_username || 'Unknown', roles, is_super_admin, company_id: null };

        try {
            const crmUser = await userService.findOrCreateUser({ sub: decoded.sub, email: decoded.email, name: decoded.name, preferred_username: decoded.preferred_username, realm_roles: roles });
            req.user.crmUser = crmUser;
            req.user.company_id = crmUser?.company_id || null;

            try {
                req.authz = await authorizationService.resolveAuthzContext(crmUser);
            } catch (authzErr) {
                console.error('[Auth] Failed to resolve authz context:', authzErr.message);
                req.authz = { scope: null, platform_role: is_super_admin ? 'super_admin' : 'none', company: null, membership: null, permissions: [], scopes: {} };
            }
        } catch (profileErr) {
            console.error('[Auth] Failed to sync user profile:', profileErr.message);
            req.authz = { scope: null, platform_role: is_super_admin ? 'super_admin' : 'none', company: null, membership: null, permissions: [], scopes: {} };
        }

        next();
    });
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (req.user?._devMode) return next();

        const userRoles = req.user?.roles || [];
        let hasRole = allowedRoles.some(r => userRoles.includes(r));

        if (!hasRole && req.authz?.membership?.role_key) {
            const roleKey = req.authz.membership.role_key;
            const legacyMapping = { 'tenant_admin': 'company_admin', 'manager': 'company_admin', 'dispatcher': 'company_member', 'provider': 'company_member' };
            const mappedLegacy = legacyMapping[roleKey];
            if (mappedLegacy && allowedRoles.includes(mappedLegacy)) hasRole = true;
        }

        if (!hasRole) {
            console.warn(`[RBAC] Access denied for ${req.user?.email} — required: [${allowedRoles}], has: [${userRoles}]`);
            auditService.log({ actor_id: req.user?.crmUser?.id, actor_email: req.user?.email, actor_ip: req.ip, action: 'access_denied_403', target_type: 'route', target_id: `${req.method} ${req.originalUrl}`, company_id: req.user?.company_id, details: { required_roles: allowedRoles, user_roles: userRoles }, trace_id: req.traceId }).catch(() => { });
            return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Access denied', trace_id: req.traceId });
        }
        next();
    };
}

function requireCompanyAccess(req, res, next) {
    if (req.user?._devMode) {
        req.companyFilter = { company_id: req.user.company_id };
        return next();
    }

    if (req.authz?.scope === 'platform' || req.user?.is_super_admin) return res.status(403).json({ code: 'PLATFORM_SCOPE_ONLY', message: 'Platform admins cannot access tenant resources.', trace_id: req.traceId });
    if (!req.user?.company_id) return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED', message: 'No company association found', trace_id: req.traceId });

    req.companyFilter = { company_id: req.user.company_id };
    next();
}

module.exports = { authenticate, requireRole, requireCompanyAccess };
