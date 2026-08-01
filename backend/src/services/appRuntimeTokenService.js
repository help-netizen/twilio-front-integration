'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');
const identityService = require('./appRuntimeIdentityService');
const catalog = require('./appRuntimeToolCatalog');
const { AppRuntimeError, appRuntimeError } = require('./appRuntimeErrors');

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 300;
const RUN_CALL_LIMIT = 5;
const CLAIM_KEYS = Object.freeze([
    'exp',
    'installation_id',
    'nonce',
    'run_id',
    'version_id',
]);

function configuredSecret() {
    const secret = process.env.APP_RUNTIME_RUN_TOKEN_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
        throw appRuntimeError(
            'APP_RUNTIME_NOT_CONFIGURED',
            'App runtime token signing is not configured.',
            503
        );
    }
    return secret;
}

function normalizedTtl(ttlSeconds) {
    if (ttlSeconds === undefined || ttlSeconds === null || ttlSeconds === '') {
        return DEFAULT_TTL_SECONDS;
    }
    const ttl = Number(ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
        throw appRuntimeError(
            'INVALID_REQUEST',
            `ttl_seconds must be an integer from 1 to ${MAX_TTL_SECONDS}.`,
            400
        );
    }
    return ttl;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceDigest(sourceCode) {
    return sha256(Buffer.from(String(sourceCode), 'utf8'));
}

function validUuid(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validInstallationId(value) {
    return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function validNonce(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    try {
        return Buffer.from(value, 'base64url').length === 32;
    } catch (_error) {
        return false;
    }
}

function sameDigest(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string'
        || left.length !== 64 || right.length !== 64) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function parseConsent(metadata) {
    const runtime = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata.app_runtime
        : null;
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
    if (!validUuid(runtime.version_id) || !Array.isArray(runtime.consented_tools)) return null;
    if (!runtime.consented_tools.every((name) => typeof name === 'string')) return null;
    return {
        versionId: runtime.version_id,
        tools: new Set(runtime.consented_tools),
    };
}

function validateClaims(decoded) {
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    }
    const keys = Object.keys(decoded).sort();
    if (keys.length !== CLAIM_KEYS.length
        || keys.some((key, index) => key !== CLAIM_KEYS[index])) {
        throw appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    }
    if (!validInstallationId(decoded.installation_id)
        || !validUuid(decoded.version_id)
        || !validUuid(decoded.run_id)
        || !validNonce(decoded.nonce)
        || !Number.isInteger(decoded.exp)
        || decoded.exp <= 0) {
        throw appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    }
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp - now > MAX_TTL_SECONDS) {
        throw appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    }
    return decoded;
}

function verifyRunToken(token) {
    if (typeof token !== 'string' || !token) {
        throw appRuntimeError(
            'APP_RUNTIME_AUTH_REQUIRED',
            'Bearer token required.',
            401
        );
    }
    try {
        const decoded = jwt.verify(token, configuredSecret(), { algorithms: ['HS256'] });
        return validateClaims(decoded);
    } catch (error) {
        if (error instanceof AppRuntimeError) throw error;
        if (error?.name === 'TokenExpiredError') {
            throw appRuntimeError(
                'APP_RUNTIME_TOKEN_EXPIRED',
                'App runtime token expired.',
                401
            );
        }
        throw appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    }
}

async function mintRunToken({ installationId, versionId, ttlSeconds }) {
    const secret = configuredSecret();
    const ttl = normalizedTtl(ttlSeconds);
    if (!validUuid(versionId)) {
        throw appRuntimeError('INVALID_REQUEST', 'Version id is invalid.', 400);
    }
    const client = await db.pool.connect();
    let committed = false;
    try {
        await client.query('BEGIN');
        const provisioned = await identityService.provisionInstallationPrincipal({
            installationId,
        }, client);
        const { installation, principal } = provisioned;
        const { rows } = await client.query(
            `SELECT version.id,
                    version.app_id,
                    version.source_code,
                    version.source_sha256,
                    ARRAY(
                        SELECT tool.tool_name
                        FROM app_version_tools tool
                        WHERE tool.version_id = version.id
                        ORDER BY tool.tool_name
                    ) AS allowed_tools
             FROM app_versions version
             WHERE version.id = $1
               AND version.app_id = $2
               AND version.status = 'published'
             FOR SHARE OF version`,
            [versionId, installation.app_id]
        );
        if (rows.length !== 1) {
            throw appRuntimeError(
                'APP_RUNTIME_INACTIVE',
                'App runtime authorization is not active.',
                403
            );
        }
        const version = rows[0];
        if (!sameDigest(sourceDigest(version.source_code), version.source_sha256)) {
            throw appRuntimeError(
                'APP_RUNTIME_INACTIVE',
                'App runtime authorization is not active.',
                403
            );
        }
        const consent = parseConsent(installation.installation_metadata);
        const allowedTools = new Set(version.allowed_tools || []);
        const effectiveTools = catalog.TOOL_NAMES.filter((name) => (
            consent?.versionId === versionId
            && consent.tools.has(name)
            && allowedTools.has(name)
        ));
        if (effectiveTools.length === 0) {
            throw appRuntimeError(
                'TOOL_NOT_CONSENTED',
                'No app runtime tools are consented.',
                403
            );
        }

        const runId = crypto.randomUUID();
        const nonce = crypto.randomBytes(32).toString('base64url');
        const nowSeconds = Math.floor(Date.now() / 1000);
        const exp = nowSeconds + ttl;
        const issuedAt = new Date(nowSeconds * 1000);
        const expiresAt = new Date(exp * 1000);
        await client.query(
            `INSERT INTO app_runs
                (id, company_id, app_id, installation_id, version_id, principal_id,
                 artifact_sha256, nonce_sha256, status, gateway_calls_used,
                 gateway_call_limit, issued_at, expires_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'issued', 0, $9, $10, $11, NOW())`,
            [
                runId,
                installation.company_id,
                installation.app_id,
                installation.installation_id,
                version.id,
                principal.id,
                version.source_sha256,
                sha256(nonce),
                RUN_CALL_LIMIT,
                issuedAt,
                expiresAt,
            ]
        );
        await client.query('COMMIT');
        committed = true;

        const payload = {
            installation_id: String(installation.installation_id),
            version_id: String(version.id),
            run_id: runId,
            exp,
            nonce,
        };
        const token = jwt.sign(payload, secret, {
            algorithm: 'HS256',
            noTimestamp: true,
        });
        return {
            token,
            runId,
            expiresAt: expiresAt.toISOString(),
        };
    } catch (error) {
        if (!committed) await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

function rowIsLive(row) {
    return row.run_status !== 'revoked'
        && !row.run_revoked_at
        && ['issued', 'exhausted'].includes(row.run_status)
        && row.principal_status === 'active'
        && !row.principal_revoked_at
        && row.agent_kind === 'agent'
        && row.agent_status === 'active'
        && row.agent_onboarding_status === 'active'
        && row.installation_status === 'connected'
        && row.app_status === 'published'
        && row.version_status === 'published'
        && row.company_status === 'active'
        && row.delegator_kind === 'user'
        && row.delegator_status === 'active'
        && row.delegator_onboarding_status === 'active'
        && row.membership_status === 'active'
        && String(row.installed_by) === String(row.delegated_by_user_id)
        && sameDigest(row.artifact_sha256, row.version_source_sha256);
}

async function resolveRunContext(claims) {
    const nonceSha256 = sha256(claims.nonce);
    const { rows } = await db.query(
        `SELECT run.id AS run_id,
                run.company_id,
                run.app_id,
                run.installation_id,
                run.version_id,
                run.principal_id,
                run.artifact_sha256,
                run.nonce_sha256,
                run.status AS run_status,
                run.revoked_at AS run_revoked_at,
                run.expires_at,
                run.gateway_calls_used,
                run.gateway_call_limit,
                installation.status AS installation_status,
                installation.installed_by,
                installation.metadata AS installation_metadata,
                app.status AS app_status,
                version.status AS version_status,
                version.source_sha256 AS version_source_sha256,
                principal.status AS principal_status,
                principal.revoked_at AS principal_revoked_at,
                principal.agent_user_id,
                principal.delegated_by_user_id,
                agent.kind AS agent_kind,
                agent.status AS agent_status,
                agent.onboarding_status AS agent_onboarding_status,
                agent.email AS agent_email,
                agent.full_name AS agent_full_name,
                delegator.kind AS delegator_kind,
                delegator.status AS delegator_status,
                delegator.onboarding_status AS delegator_onboarding_status,
                membership.status AS membership_status,
                company.status AS company_status,
                company.name AS company_name,
                COALESCE(company.timezone, 'America/New_York') AS company_timezone,
                ARRAY(
                    SELECT tool.tool_name
                    FROM app_version_tools tool
                    WHERE tool.version_id = run.version_id
                    ORDER BY tool.tool_name
                ) AS allowed_tools
         FROM app_runs run
         LEFT JOIN marketplace_installations installation
           ON installation.id = run.installation_id
          AND installation.company_id = run.company_id
          AND installation.app_id = run.app_id
         LEFT JOIN marketplace_apps app
           ON app.id = run.app_id
          AND app.id = installation.app_id
         LEFT JOIN app_versions version
           ON version.id = run.version_id
          AND version.app_id = run.app_id
         LEFT JOIN app_installation_principals principal
           ON principal.id = run.principal_id
          AND principal.company_id = run.company_id
          AND principal.app_id = run.app_id
          AND principal.installation_id = run.installation_id
         LEFT JOIN crm_users agent
           ON agent.id = principal.agent_user_id
          AND agent.company_id = run.company_id
         LEFT JOIN crm_users delegator
           ON delegator.id = principal.delegated_by_user_id
          AND delegator.company_id = run.company_id
         LEFT JOIN company_memberships membership
           ON membership.user_id = principal.delegated_by_user_id
          AND membership.company_id = run.company_id
         LEFT JOIN companies company
           ON company.id = run.company_id
         WHERE run.id = $1
           AND run.installation_id = $2
           AND run.version_id = $3`,
        [claims.run_id, claims.installation_id, claims.version_id]
    );
    if (rows.length !== 1) {
        throw appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    }
    const row = rows[0];
    if (!sameDigest(nonceSha256, row.nonce_sha256)) {
        throw appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
        throw appRuntimeError(
            'APP_RUNTIME_TOKEN_EXPIRED',
            'App runtime token expired.',
            401
        );
    }
    if (!rowIsLive(row)) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    return {
        ...row,
        nonce_sha256: nonceSha256,
    };
}

async function consumeRunCall(context) {
    const { rows } = await db.query(
        `WITH candidate AS MATERIALIZED (
             SELECT id, status, revoked_at, expires_at,
                    gateway_calls_used, gateway_call_limit
             FROM app_runs
             WHERE id = $1
               AND company_id = $2
               AND app_id = $3
               AND installation_id = $4
               AND version_id = $5
               AND nonce_sha256 = $6
         ), consumed AS (
             UPDATE app_runs run
             SET gateway_calls_used = run.gateway_calls_used + 1,
                 status = CASE
                     WHEN run.gateway_calls_used + 1 >= run.gateway_call_limit
                         THEN 'exhausted'
                     ELSE 'issued'
                 END,
                 updated_at = NOW()
             FROM candidate
             WHERE run.id = candidate.id
               AND run.company_id = $2
               AND run.status = 'issued'
               AND run.revoked_at IS NULL
               AND run.expires_at > NOW()
               AND run.gateway_calls_used < run.gateway_call_limit
             RETURNING run.gateway_calls_used AS call_ordinal
         )
         SELECT candidate.*, consumed.call_ordinal
         FROM candidate
         LEFT JOIN consumed ON true`,
        [
            context.run_id,
            context.company_id,
            context.app_id,
            context.installation_id,
            context.version_id,
            context.nonce_sha256,
        ]
    );
    if (rows.length !== 1) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    if (!rows[0].call_ordinal) {
        if (rows[0].status === 'revoked'
            || rows[0].revoked_at
            || new Date(rows[0].expires_at).getTime() <= Date.now()) {
            throw appRuntimeError(
                'APP_RUNTIME_INACTIVE',
                'App runtime authorization is not active.',
                403
            );
        }
        throw appRuntimeError('RUN_CALL_LIMIT', 'Run call limit reached.', 429, {
            callOrdinal: Number(rows[0].gateway_calls_used) + 1,
        });
    }
    return Number(rows[0].call_ordinal);
}

module.exports = {
    DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
    RUN_CALL_LIMIT,
    CLAIM_KEYS,
    configuredSecret,
    normalizedTtl,
    sha256,
    sourceDigest,
    parseConsent,
    validateClaims,
    verifyRunToken,
    mintRunToken,
    resolveRunContext,
    consumeRunCall,
};
