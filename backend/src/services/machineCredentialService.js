const crypto = require('crypto');
const db = require('../db/connection');
const { hashSecret } = require('../middleware/integrationsAuth');

const SURFACES = Object.freeze({
    VAPI_TOOLS: 'vapi_tools',
    SALES_MCP_PUBLIC: 'sales_mcp_public',
});

const ACCESS_SCOPES = Object.freeze({
    VAPI_TOOLS: 'vapi_tools:invoke',
    SALES_MCP_PUBLIC: 'sales_mcp_public:access',
});

class MachineCredentialError extends Error {
    constructor(code = 'MACHINE_CREDENTIAL_INVALID', status = 401) {
        super(code);
        this.name = 'MachineCredentialError';
        this.code = code;
        this.status = status;
    }
}

function validateSurface(surface) {
    if (!Object.values(SURFACES).includes(surface)) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_SURFACE_INVALID', 400);
    }
}

function normalizeScopes(scopes) {
    if (!Array.isArray(scopes)) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_SCOPES_INVALID', 400);
    }
    const normalized = [...new Set(scopes.filter((scope) => typeof scope === 'string' && scope.length > 0))];
    if (normalized.length !== scopes.length) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_SCOPES_INVALID', 400);
    }
    return normalized.sort();
}

function generateSecret() {
    return crypto.randomBytes(36).toString('base64url');
}

function generateKeyId(surface) {
    return `machine_${surface}_${crypto.randomBytes(12).toString('hex')}`;
}

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

async function resolveCredential(secret, { surface, requiredScope, client = null } = {}) {
    validateSurface(surface);
    if (typeof secret !== 'string' || secret.length === 0) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_REQUIRED', 401);
    }

    let secretHash;
    try {
        secretHash = hashSecret(secret);
    } catch (_error) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_UNAVAILABLE', 503);
    }

    const query = queryFor(client);
    try {
        const result = await query(
            `SELECT integration.id, integration.company_id, integration.actor_user_id,
                    integration.scopes, integration.expires_at, integration.revoked_at,
                    company.status AS company_status
             FROM api_integrations integration
             JOIN companies company ON company.id = integration.company_id
             WHERE integration.machine_surface = $1
               AND integration.secret_hash = $2
             LIMIT 2`,
            [surface, secretHash]
        );

        if (result.rows.length !== 1) {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_INVALID', 401);
        }
        const row = result.rows[0];
        if (row.revoked_at) {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_REVOKED', 401);
        }
        if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_EXPIRED', 401);
        }
        if (row.company_status !== 'active') {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_COMPANY_INACTIVE', 403);
        }

        let scopes;
        try {
            scopes = normalizeScopes(row.scopes);
        } catch (_error) {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_UNAVAILABLE', 503);
        }
        if (requiredScope && !scopes.includes(requiredScope)) {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_SCOPE_REQUIRED', 403);
        }

        const used = await query(
            `UPDATE api_integrations integration
             SET last_used_at = now()
             FROM companies company
             WHERE integration.id = $1
               AND integration.company_id = $2
               AND integration.machine_surface = $3
               AND integration.secret_hash = $4
               AND integration.scopes = $5::jsonb
               AND integration.revoked_at IS NULL
               AND (integration.expires_at IS NULL OR integration.expires_at > now())
               AND company.id = integration.company_id
               AND company.status = 'active'
             RETURNING integration.id`,
            [row.id, row.company_id, surface, secretHash, JSON.stringify(scopes)]
        );
        if (used.rows.length !== 1) {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_INVALID', 401);
        }

        return {
            id: String(row.id),
            companyId: row.company_id,
            actorUserId: row.actor_user_id || null,
            scopes,
            surface,
        };
    } catch (error) {
        if (error instanceof MachineCredentialError) throw error;
        throw new MachineCredentialError('MACHINE_CREDENTIAL_UNAVAILABLE', 503);
    }
}

async function provisionCredential({
    companyId,
    surface,
    actorUserId = null,
    scopes,
    secret = null,
    expiresAt = null,
    client = null,
}) {
    if (!companyId) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_COMPANY_REQUIRED', 400);
    }
    validateSurface(surface);
    const normalizedScopes = normalizeScopes(scopes);
    const requiredAccessScope = surface === SURFACES.VAPI_TOOLS
        ? ACCESS_SCOPES.VAPI_TOOLS
        : ACCESS_SCOPES.SALES_MCP_PUBLIC;
    if (!normalizedScopes.includes(requiredAccessScope)) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_ACCESS_SCOPE_REQUIRED', 400);
    }
    if (surface === SURFACES.SALES_MCP_PUBLIC && !actorUserId) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_ACTOR_REQUIRED', 400);
    }
    if (secret !== null && (typeof secret !== 'string' || secret.length < 32)) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_SECRET_WEAK', 400);
    }

    const plaintext = secret || generateSecret();
    const secretHash = hashSecret(plaintext);
    const query = queryFor(client);

    const company = await query(
        `SELECT id FROM companies WHERE id = $1 AND status = 'active'`,
        [companyId]
    );
    if (company.rows.length !== 1) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_COMPANY_INVALID', 400);
    }

    if (actorUserId) {
        const membership = await query(
            `SELECT 1
             FROM company_memberships
             WHERE company_id = $1 AND user_id = $2 AND status = 'active'`,
            [companyId, actorUserId]
        );
        if (membership.rows.length !== 1) {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_ACTOR_INVALID', 400);
        }
    }

    const existing = await query(
        `SELECT id, company_id, actor_user_id, scopes, expires_at, revoked_at
         FROM api_integrations
         WHERE machine_surface = $1 AND secret_hash = $2
         LIMIT 2`,
        [surface, secretHash]
    );
    if (existing.rows.length > 1) {
        throw new MachineCredentialError('MACHINE_CREDENTIAL_DUPLICATE', 409);
    }
    if (existing.rows.length === 1) {
        const row = existing.rows[0];
        const sameScopes = JSON.stringify(normalizeScopes(row.scopes)) === JSON.stringify(normalizedScopes);
        if (
            row.company_id !== companyId
            || (row.actor_user_id || null) !== (actorUserId || null)
            || !sameScopes
            || row.revoked_at
            || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
        ) {
            throw new MachineCredentialError('MACHINE_CREDENTIAL_CONFLICT', 409);
        }
        return {
            id: String(row.id),
            companyId,
            surface,
            scopes: normalizedScopes,
            actorUserId: actorUserId || null,
            secret: null,
            created: false,
        };
    }

    const result = await query(
        `INSERT INTO api_integrations
            (client_name, key_id, secret_hash, scopes, expires_at, company_id,
             machine_surface, actor_user_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
         RETURNING id`,
        [
            `${surface} machine credential`,
            generateKeyId(surface),
            secretHash,
            JSON.stringify(normalizedScopes),
            expiresAt,
            companyId,
            surface,
            actorUserId,
        ]
    );
    return {
        id: String(result.rows[0].id),
        companyId,
        surface,
        scopes: normalizedScopes,
        actorUserId: actorUserId || null,
        secret: plaintext,
        created: true,
    };
}

module.exports = {
    SURFACES,
    ACCESS_SCOPES,
    MachineCredentialError,
    normalizeScopes,
    resolveCredential,
    provisionCredential,
};
