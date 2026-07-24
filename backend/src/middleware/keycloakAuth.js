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
const FEATURE_SMS_2FA = () => process.env.FEATURE_SMS_2FA === 'true';

// Paths reachable while the device is not yet trusted (OTP flow itself, health)
const TWO_FA_EXEMPT = [/^\/api\/auth\//, /^\/health/, /^\/api\/public\//, /^\/api\/onboarding/];

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
}

function readNativeDeviceCredential(req) {
    const value = req.headers['x-albusto-device'];
    if (typeof value !== 'string') return null;
    const credential = value.trim();
    return credential && credential.length <= 256 ? credential : null;
}

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
        // ONBOARD-FIX-001 (SEC): the dev bypass hands every request the seed
        // company (…0001) as company_admin. That is a total cross-tenant leak if
        // it ever runs in production, so fail CLOSED there — never serve tenant
        // data without real auth. Dev bypass stays available only outside prod.
        if (process.env.NODE_ENV === 'production') {
            console.error('[Auth] FATAL: FEATURE_AUTH_ENABLED is not "true" in production — refusing the dev auth bypass');
            return res.status(500).json({ code: 'AUTH_MISCONFIGURED', message: 'Authentication is misconfigured', trace_id: req.traceId });
        }
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

        // Connector access tokens are deliberately bound to /mcp/chatgpt. Their
        // human subject authorizes the AI identity but must never be resolved as
        // that human on the ordinary CRM API surface.
        const connectorClientId = String(process.env.CHATGPT_MCP_CLIENT_ID || '').trim();
        const isConnectorToken = [decoded.azp, decoded.client_id]
            .some((tokenClientId) => tokenClientId === connectorClientId);
        if (connectorClientId && isConnectorToken) {
            return res.status(401).json({
                code: 'AUTH_INVALID',
                message: 'Invalid or expired token',
                trace_id: req.traceId,
            });
        }

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

        // SMS 2FA (ALB-101, FEATURE_SMS_2FA): users with a verified phone must
        // present either the existing trusted-device cookie or the native app's
        // Keychain-backed device credential. The two transports resolve through
        // the same hashed trusted_devices lookup; web cookie behavior is unchanged.
        try {
            const crmUser = req.user?.crmUser;
            if (FEATURE_SMS_2FA() && crmUser?.phone_verified_at
                && !TWO_FA_EXEMPT.some(rx => rx.test(req.originalUrl || req.path || ''))) {
                const otpService = require('../services/otpService');
                const cookieCredential = readCookie(req, 'albusto_td');
                const nativeCredential = readNativeDeviceCredential(req);
                let trusted = await otpService.isDeviceTrusted(crmUser.id, cookieCredential);
                if (!trusted && nativeCredential && nativeCredential !== cookieCredential) {
                    trusted = await otpService.isDeviceTrusted(crmUser.id, nativeCredential);
                }
                if (!trusted) {
                    return res.status(401).json({
                        code: 'PHONE_VERIFICATION_REQUIRED',
                        message: 'Confirm this device with the SMS code',
                        trace_id: req.traceId,
                    });
                }
            }
        } catch (tfaErr) {
            console.error('[Auth] 2FA check failed:', tfaErr.message);
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

    // Tenant access is derived from req.authz only (PF007-HARDENING-001).
    // Platform-scope users (super_admin) are consistently denied on tenant
    // routes — there is no bypass and no implicit all-companies filter.
    const isPlatformOnly = req.authz?.scope === 'platform'
        || req.authz?.platform_role === 'super_admin';
    if (isPlatformOnly) {
        auditService.log({
            actor_id: req.user?.crmUser?.id,
            actor_email: req.user?.email,
            actor_ip: req.ip,
            action: 'access_denied_403',
            target_type: 'route',
            target_id: `${req.method} ${req.originalUrl}`,
            details: { code: 'PLATFORM_SCOPE_ONLY', platform_role: req.authz?.platform_role || null },
            trace_id: req.traceId,
        }).catch(() => { });
        return res.status(403).json({ code: 'PLATFORM_SCOPE_ONLY', message: 'Platform admins cannot access tenant resources.', trace_id: req.traceId });
    }

    // ONBOARD-FIX-001 (SEC): tenant scope comes ONLY from an active membership
    // (req.authz.company, resolved from company_memberships). The old fallback to
    // req.user.company_id (crm_users.company_id) leaked cross-tenant data: migration
    // 012 backfilled that shadow column to the seed company (…0001), so any user
    // with no active membership resolved to Boston Masters. No membership → 403.
    const companyId = req.authz?.company?.id || null;
    if (!companyId) {
        auditService.log({
            actor_id: req.user?.crmUser?.id,
            actor_email: req.user?.email,
            actor_ip: req.ip,
            action: 'access_denied_403',
            target_type: 'route',
            target_id: `${req.method} ${req.originalUrl}`,
            details: { code: 'TENANT_CONTEXT_REQUIRED', platform_role: req.authz?.platform_role || null },
            trace_id: req.traceId,
        }).catch(() => { });
        return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED', message: 'No company association found', trace_id: req.traceId });
    }

    req.companyFilter = { company_id: companyId };
    next();
}

module.exports = { authenticate, requireRole, requireCompanyAccess };
