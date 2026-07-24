'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const identityService = require('../services/chatgptMcpIdentityService');
const { READ_SCOPE } = require('../services/chatgptMcpPermissions');
const { unauthenticatedLimiter } = require('./chatgptMcpRateLimit');

let cachedJwks = null;
let cachedJwksUri = null;

function realmIssuer() {
    return identityService.configuredIssuer();
}

function resourceUri() {
    const resource = String(process.env.CHATGPT_MCP_RESOURCE || '').trim().replace(/\/$/, '');
    if (!resource) throw new Error('CHATGPT_MCP_RESOURCE is required');
    return resource;
}

function metadataUri() {
    return String(
        process.env.CHATGPT_MCP_RESOURCE_METADATA
        || 'https://api.albusto.com/.well-known/oauth-protected-resource/mcp/chatgpt'
    );
}

function challenge() {
    return `Bearer resource_metadata="${metadataUri()}", scope="${READ_SCOPE}"`;
}

function getJwksClient() {
    const uri = `${realmIssuer()}/protocol/openid-connect/certs`;
    if (!cachedJwks || cachedJwksUri !== uri) {
        cachedJwks = jwksClient({
            jwksUri: uri,
            cache: true,
            cacheMaxAge: 600000,
            rateLimit: true,
            jwksRequestsPerMinute: 10,
        });
        cachedJwksUri = uri;
    }
    return cachedJwks;
}

function signingKey(header, callback) {
    if (header?.alg !== 'RS256' || !header?.kid) {
        return callback(new Error('Invalid JWT header'));
    }
    getJwksClient().getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
    });
}

function bearerToken(req) {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+([^\s]+)$/i.exec(header);
    return match ? match[1] : null;
}

function values(claim) {
    if (Array.isArray(claim)) return claim.map(String);
    if (claim === undefined || claim === null) return [];
    return [String(claim)];
}

function tokenScopes(decoded) {
    const scopes = new Set();
    if (typeof decoded.scope === 'string') {
        decoded.scope.split(/\s+/).filter(Boolean).forEach((scope) => scopes.add(scope));
    }
    values(decoded.scp).forEach((scope) => scopes.add(scope));
    return [...scopes];
}

function validateConnectorClaims(decoded) {
    const expectedResource = resourceUri();
    const expectedClient = identityService.configuredClientId();
    if (!values(decoded.aud).includes(expectedResource)) {
        throw Object.assign(new Error('Invalid token audience'), { code: 'MCP_TOKEN_AUDIENCE' });
    }
    if ((decoded.azp || decoded.client_id) !== expectedClient) {
        throw Object.assign(new Error('Invalid authorized party'), { code: 'MCP_TOKEN_CLIENT' });
    }
    if (!values(decoded.resource).includes(expectedResource)) {
        throw Object.assign(new Error('Invalid token resource'), { code: 'MCP_TOKEN_RESOURCE' });
    }
    const scopes = tokenScopes(decoded);
    if (!scopes.includes(READ_SCOPE)) {
        throw Object.assign(new Error('Required OAuth scope missing'), { code: 'MCP_TOKEN_SCOPE' });
    }
    if (!decoded.sub) {
        throw Object.assign(new Error('Token subject missing'), { code: 'MCP_TOKEN_SUBJECT' });
    }
    return scopes;
}

function verifyToken(token) {
    return new Promise((resolve, reject) => {
        let issuer;
        let audience;
        try {
            issuer = realmIssuer();
            audience = resourceUri();
        } catch (err) {
            reject(err);
            return;
        }
        jwt.verify(token, signingKey, {
            algorithms: ['RS256'],
            issuer,
            audience,
        }, (err, decoded) => {
            if (err) reject(err);
            else resolve(decoded);
        });
    });
}

function sendAuthError(req, res, status, code, message, requestId) {
    return unauthenticatedLimiter(req, res, () => {
        res.set('WWW-Authenticate', challenge());
        return res.status(status).json({
            jsonrpc: '2.0',
            id: req.body?.id ?? null,
            error: {
                code: status === 401 ? -32000 : -32001,
                message,
                data: { code, request_id: requestId || null },
            },
        });
    });
}

function tokenFailure(err) {
    if (String(err?.code || '').startsWith('MCP_TOKEN_')) {
        return {
            status: err.code === 'MCP_TOKEN_SCOPE' ? 403 : 401,
            code: err.code,
        };
    }
    if (err?.name === 'TokenExpiredError') {
        return { status: 401, code: 'MCP_TOKEN_EXPIRED' };
    }
    const message = String(err?.message || '');
    if (/issuer/i.test(message)) return { status: 401, code: 'MCP_TOKEN_ISSUER' };
    if (/audience/i.test(message)) return { status: 401, code: 'MCP_TOKEN_AUDIENCE' };
    if (/signature/i.test(message)) return { status: 401, code: 'MCP_TOKEN_SIGNATURE' };
    return { status: 401, code: 'AUTH_INVALID' };
}

async function authenticateChatgptMcp(req, res, next) {
    req.requestId = req.requestId || req.traceId || `chatgpt-mcp-${crypto.randomUUID()}`;
    const token = bearerToken(req);
    if (!token) {
        return sendAuthError(req, res, 401, 'AUTH_REQUIRED', 'Bearer token required', req.requestId);
    }
    try {
        const decoded = await verifyToken(token);
        const oauthScopes = validateConnectorClaims(decoded);
        const binding = await identityService.resolveOAuthContext({
            issuer: decoded.iss,
            subject: decoded.sub,
            clientId: decoded.azp || decoded.client_id,
        });
        req.companyFilter = { company_id: binding.company_id };
        req.user = {
            email: binding.ai_email,
            name: binding.ai_full_name,
            kind: 'agent',
            crmUser: {
                id: binding.ai_user_id,
                email: binding.ai_email,
                full_name: binding.ai_full_name,
                company_id: binding.company_id,
                kind: 'agent',
                status: 'active',
            },
            oauthAuthorizerId: binding.authorized_by_user_id,
            avatarOwnerId: binding.owner_user_id,
        };
        req.authz = {
            company: {
                id: binding.company_id,
                name: binding.company_name,
                status: 'active',
                timezone: binding.company_timezone,
            },
            membership: null,
            permissions: binding.permissions || [],
            oauthScopes,
            avatarOwner: {
                id: binding.owner_user_id,
                display_name: binding.owner_display_name,
                role_key: binding.owner_role_key,
                membership: binding.owner_membership,
                permissions: binding.owner_permissions || [],
                scopes: binding.owner_scopes || {},
            },
        };
        req.chatgptMcpBinding = {
            id: binding.binding_id,
            installationId: binding.installation_id,
            authorizerId: binding.authorized_by_user_id,
            ownerUserId: binding.owner_user_id,
        };
        return next();
    } catch (err) {
        const bindingFailure = err instanceof identityService.ChatgptMcpIdentityError;
        const tokenError = bindingFailure ? null : tokenFailure(err);
        const status = bindingFailure ? err.httpStatus || 403 : tokenError.status;
        const code = bindingFailure ? err.code : tokenError.code;
        return sendAuthError(
            req,
            res,
            status,
            code,
            bindingFailure ? 'Connector authorization is not active.' : 'Invalid or expired token',
            req.requestId
        );
    }
}

module.exports = {
    authenticateChatgptMcp,
    bearerToken,
    challenge,
    metadataUri,
    resourceUri,
    tokenScopes,
    tokenFailure,
    validateConnectorClaims,
    verifyToken,
};
