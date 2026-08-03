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
const DATA_CALL_LIMIT = 10;
const WRITE_CALL_LIMIT = 3;
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

async function mintRunTokenWithClient({ installationId, versionId, ttlSeconds }, client) {
    const secret = configuredSecret();
    const ttl = normalizedTtl(ttlSeconds);
    if (!validUuid(versionId)) {
        throw appRuntimeError('INVALID_REQUEST', 'Version id is invalid.', 400);
    }
    if (!client?.query) {
        throw appRuntimeError(
            'APP_RUNTIME_TRANSACTION_REQUIRED',
            'App runtime token creation requires a transaction.',
            500
        );
    }
    const provisioned = await identityService.provisionInstallationPrincipal({
        installationId,
    }, client);
    const { installation, principal } = provisioned;
    const control = await client.query(
        `SELECT suspended_at, suspension_reason
         FROM app_runtime_installation_controls
         WHERE company_id = $1
           AND app_id = $2
           AND installation_id = $3
         FOR UPDATE`,
        [installation.company_id, installation.app_id, installation.installation_id]
    );
    if (control.rows.length !== 1 || control.rows[0].suspended_at) {
        throw appRuntimeError(
            'APP_RUNTIME_SUSPENDED',
            'App runtime installation is suspended.',
            403
        );
    }
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
        artifactSha256: version.source_sha256,
    };
}

async function mintRunToken(input, { client = null } = {}) {
    if (client) return mintRunTokenWithClient(input, client);
    const ownedClient = await db.pool.connect();
    try {
        await ownedClient.query('BEGIN');
        const minted = await mintRunTokenWithClient(input, ownedClient);
        await ownedClient.query('COMMIT');
        return minted;
    } catch (error) {
        await ownedClient.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        ownedClient.release();
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
                run.data_calls_made,
                run.write_calls_made,
                run.execution_authorized_at,
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
                company.timezone AS company_timezone,
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

async function authorizeRunExecution(context, sourceSha256) {
    if (typeof sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
        throw appRuntimeError('INVALID_REQUEST', 'Source SHA-256 is invalid.', 400);
    }
    const { rows } = await db.query(
        `WITH candidate AS MATERIALIZED (
             SELECT run.id,
                    run.status,
                    run.revoked_at,
                    run.expires_at,
                    run.execution_authorized_at,
                    control.suspended_at AS control_suspended_at,
                    control.daily_run_limit,
                    control.daily_wall_ms_limit,
                    control.daily_gateway_call_limit,
                    run.artifact_sha256 = $7::text AS source_matches,
                    (
                        run.status = 'issued'
                        AND run.revoked_at IS NULL
                        AND run.expires_at > NOW()
                        AND principal.status = 'active'
                        AND principal.revoked_at IS NULL
                        AND agent.kind = 'agent'
                        AND agent.status = 'active'
                        AND agent.onboarding_status = 'active'
                        AND installation.status = 'connected'
                        AND app.status = 'published'
                        AND version.status = 'published'
                        AND company.status = 'active'
                        AND delegator.kind = 'user'
                        AND delegator.status = 'active'
                        AND delegator.onboarding_status = 'active'
                        AND membership.status = 'active'
                        AND installation.installed_by = principal.delegated_by_user_id
                        AND run.artifact_sha256 = version.source_sha256
                    ) AS authority_live,
                    (
                        jsonb_typeof(installation.metadata->'app_runtime') = 'object'
                        AND installation.metadata->'app_runtime'->>'version_id' = run.version_id::text
                        AND jsonb_typeof(
                            installation.metadata->'app_runtime'->'consented_tools'
                        ) = 'array'
                        AND EXISTS (
                            SELECT 1
                            FROM app_version_tools tool
                            WHERE tool.version_id = run.version_id
                              AND installation.metadata->'app_runtime'->'consented_tools'
                                  @> to_jsonb(ARRAY[tool.tool_name]::text[])
                        )
                    ) AS consent_live
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
             JOIN app_runtime_installation_controls control
               ON control.company_id = run.company_id
              AND control.app_id = run.app_id
              AND control.installation_id = run.installation_id
             WHERE run.id = $1
               AND run.company_id = $2
               AND run.app_id = $3
               AND run.installation_id = $4
               AND run.version_id = $5
               AND run.nonce_sha256 = $6
             FOR UPDATE OF run, control
         ), usage AS (
             INSERT INTO app_runtime_usage
                (company_id, app_id, installation_id, usage_date,
                 gateway_calls_used, daily_gateway_call_limit,
                 runs_started, daily_run_limit, wall_ms_used,
                 daily_wall_ms_limit, updated_at)
             SELECT $2, $3, $4, (NOW() AT TIME ZONE 'UTC')::date,
                    0, candidate.daily_gateway_call_limit,
                    1, candidate.daily_run_limit, 0,
                    candidate.daily_wall_ms_limit, NOW()
             FROM candidate
             WHERE candidate.authority_live
               AND candidate.consent_live
               AND candidate.source_matches
               AND candidate.execution_authorized_at IS NULL
               AND candidate.control_suspended_at IS NULL
             ON CONFLICT (company_id, app_id, installation_id, usage_date) DO UPDATE
             SET runs_started = app_runtime_usage.runs_started + 1,
                 daily_run_limit = EXCLUDED.daily_run_limit,
                 daily_wall_ms_limit = EXCLUDED.daily_wall_ms_limit,
                 daily_gateway_call_limit = EXCLUDED.daily_gateway_call_limit,
                 updated_at = NOW()
             WHERE app_runtime_usage.company_id = $2
               AND app_runtime_usage.app_id = $3
               AND app_runtime_usage.installation_id = $4
               AND app_runtime_usage.runs_started < EXCLUDED.daily_run_limit
               AND app_runtime_usage.wall_ms_used < EXCLUDED.daily_wall_ms_limit
             RETURNING runs_started, daily_run_limit, wall_ms_used, daily_wall_ms_limit
         ), authorized AS (
             UPDATE app_runs run
             SET execution_authorized_at = NOW(),
                 updated_at = NOW()
             FROM candidate, usage
             WHERE run.id = candidate.id
               AND run.company_id = $2
               AND run.app_id = $3
               AND run.installation_id = $4
               AND run.version_id = $5
               AND run.nonce_sha256 = $6
               AND run.execution_authorized_at IS NULL
             RETURNING run.execution_authorized_at
         ), suspended AS (
             UPDATE app_runtime_installation_controls control
             SET suspended_at = NOW(),
                 suspension_reason = CASE
                     WHEN COALESCE(current_usage.wall_ms_used, 0)
                            >= candidate.daily_wall_ms_limit
                         THEN 'DAILY_WALL_MS_LIMIT'
                     ELSE 'DAILY_RUN_LIMIT'
                 END,
                 updated_at = NOW()
             FROM candidate
             LEFT JOIN app_runtime_usage current_usage
               ON current_usage.company_id = $2
              AND current_usage.app_id = $3
              AND current_usage.installation_id = $4
              AND current_usage.usage_date = (NOW() AT TIME ZONE 'UTC')::date
             WHERE control.company_id = $2
               AND control.app_id = $3
               AND control.installation_id = $4
               AND candidate.authority_live
               AND candidate.consent_live
               AND candidate.source_matches
               AND candidate.execution_authorized_at IS NULL
               AND candidate.control_suspended_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM usage)
             RETURNING control.suspension_reason
         )
         SELECT candidate.*,
                authorized.execution_authorized_at AS authorized_at,
                usage.runs_started,
                usage.wall_ms_used,
                (SELECT suspension_reason FROM suspended LIMIT 1) AS suspension_reason
         FROM candidate
         LEFT JOIN usage ON true
         LEFT JOIN authorized ON true`,
        [
            context.run_id,
            context.company_id,
            context.app_id,
            context.installation_id,
            context.version_id,
            context.nonce_sha256,
            sourceSha256,
        ]
    );
    if (rows.length !== 1 || !rows[0].authority_live) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    const row = rows[0];
    if (!row.source_matches) {
        throw appRuntimeError(
            'APP_RUNTIME_SOURCE_MISMATCH',
            'Application source does not match the approved artifact.',
            403
        );
    }
    if (row.execution_authorized_at) {
        throw appRuntimeError(
            'APP_RUNTIME_ALREADY_STARTED',
            'App runtime execution has already started.',
            409
        );
    }
    if (row.control_suspended_at) {
        throw appRuntimeError(
            'APP_RUNTIME_SUSPENDED',
            'App runtime installation is suspended.',
            403
        );
    }
    if (!row.consent_live) {
        throw appRuntimeError('TOOL_NOT_CONSENTED', 'No app runtime tools are consented.', 403);
    }
    if (!row.authorized_at) {
        throw appRuntimeError(
            row.suspension_reason === 'DAILY_WALL_MS_LIMIT'
                ? 'APP_RUNTIME_DAILY_WALL_LIMIT'
                : 'APP_RUNTIME_DAILY_RUN_LIMIT',
            'Daily app runtime execution limit reached.',
            429
        );
    }
    return {
        execution_authorized_at: row.authorized_at,
        runs_started: Number(row.runs_started),
        wall_ms_used: Number(row.wall_ms_used),
    };
}

async function consumeRunCall(context) {
    const { rows } = await db.query(
        `WITH candidate AS MATERIALIZED (
             SELECT run.id,
                    run.status,
                    run.revoked_at,
                    run.expires_at,
                    run.gateway_calls_used,
                    run.gateway_call_limit,
                    control.daily_gateway_call_limit,
                    control.suspended_at AS control_suspended_at,
                    (
                        run.status IN ('issued', 'exhausted')
                        AND run.revoked_at IS NULL
                        AND run.expires_at > NOW()
                        AND run.execution_authorized_at IS NOT NULL
                        AND principal.status = 'active'
                        AND principal.revoked_at IS NULL
                        AND agent.kind = 'agent'
                        AND agent.status = 'active'
                        AND agent.onboarding_status = 'active'
                        AND installation.status = 'connected'
                        AND app.status = 'published'
                        AND version.status = 'published'
                        AND company.status = 'active'
                        AND delegator.kind = 'user'
                        AND delegator.status = 'active'
                        AND delegator.onboarding_status = 'active'
                        AND membership.status = 'active'
                        AND installation.installed_by = principal.delegated_by_user_id
                        AND run.artifact_sha256 = version.source_sha256
                    ) AS authority_live
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
             JOIN app_runtime_installation_controls control
               ON control.company_id = run.company_id
              AND control.app_id = run.app_id
              AND control.installation_id = run.installation_id
             WHERE run.id = $1
               AND run.company_id = $2
               AND run.app_id = $3
               AND run.installation_id = $4
               AND run.version_id = $5
               AND run.nonce_sha256 = $6
             FOR UPDATE OF run, control
         ), usage AS (
             INSERT INTO app_runtime_usage
                (company_id, app_id, installation_id, usage_date,
                 gateway_calls_used, daily_gateway_call_limit, updated_at)
             SELECT $2, $3, $4, (NOW() AT TIME ZONE 'UTC')::date,
                    1, candidate.daily_gateway_call_limit, NOW()
             FROM candidate
             WHERE candidate.authority_live
               AND candidate.status = 'issued'
               AND candidate.revoked_at IS NULL
               AND candidate.expires_at > NOW()
               AND candidate.gateway_calls_used < candidate.gateway_call_limit
               AND candidate.control_suspended_at IS NULL
             ON CONFLICT (company_id, app_id, installation_id, usage_date) DO UPDATE
             SET gateway_calls_used = app_runtime_usage.gateway_calls_used + 1,
                 daily_gateway_call_limit = EXCLUDED.daily_gateway_call_limit,
                 updated_at = NOW()
             WHERE app_runtime_usage.company_id = $2
               AND app_runtime_usage.app_id = $3
               AND app_runtime_usage.installation_id = $4
               AND app_runtime_usage.gateway_calls_used < EXCLUDED.daily_gateway_call_limit
             RETURNING gateway_calls_used, daily_gateway_call_limit
         ), consumed AS (
             UPDATE app_runs run
             SET gateway_calls_used = run.gateway_calls_used + 1,
                 status = CASE
                     WHEN run.gateway_calls_used + 1 >= run.gateway_call_limit
                         THEN 'exhausted'
                     ELSE 'issued'
                 END,
                 updated_at = NOW()
             FROM candidate, usage
             WHERE run.id = candidate.id
               AND run.company_id = $2
               AND run.status = 'issued'
               AND run.revoked_at IS NULL
               AND run.expires_at > NOW()
               AND run.gateway_calls_used < run.gateway_call_limit
             RETURNING run.gateway_calls_used AS call_ordinal
         ), suspended AS (
             UPDATE app_runtime_installation_controls control
             SET suspended_at = NOW(),
                 suspension_reason = 'DAILY_GATEWAY_CALL_LIMIT',
                 updated_at = NOW()
             FROM candidate
             WHERE control.company_id = $2
               AND control.app_id = $3
               AND control.installation_id = $4
               AND candidate.authority_live
               AND candidate.status = 'issued'
               AND candidate.revoked_at IS NULL
               AND candidate.expires_at > NOW()
               AND candidate.gateway_calls_used < candidate.gateway_call_limit
               AND candidate.control_suspended_at IS NULL
               AND (
                    NOT EXISTS (SELECT 1 FROM usage)
                    OR EXISTS (
                        SELECT 1 FROM usage
                        WHERE usage.gateway_calls_used >= usage.daily_gateway_call_limit
                    )
               )
             RETURNING true AS suspended_now
         )
         SELECT candidate.*,
                consumed.call_ordinal,
                usage.gateway_calls_used AS daily_calls_used,
                COALESCE((SELECT bool_or(suspended_now) FROM suspended), false) AS suspended_now
         FROM candidate
         LEFT JOIN consumed ON true
         LEFT JOIN usage ON true`,
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
    if (!rows[0].authority_live) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    if (rows[0].control_suspended_at) {
        throw appRuntimeError(
            'APP_RUNTIME_SUSPENDED',
            'App runtime installation is suspended.',
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
        if (rows[0].suspended_now) {
            throw appRuntimeError(
                'APP_RUNTIME_DAILY_CALL_LIMIT',
                'Daily app runtime call limit reached.',
                429,
                { callOrdinal: Number(rows[0].gateway_calls_used) + 1 }
            );
        }
        throw appRuntimeError('RUN_CALL_LIMIT', 'Run call limit reached.', 429, {
            callOrdinal: Number(rows[0].gateway_calls_used) + 1,
        });
    }
    return Number(rows[0].call_ordinal);
}

async function consumeRunDataCall(context) {
    const { rows } = await db.query(
        `UPDATE app_runs run
         SET data_calls_made = run.data_calls_made + 1,
             updated_at = NOW()
         WHERE run.id = $1
           AND run.company_id = $2
           AND run.app_id = $3
           AND run.installation_id = $4
           AND run.version_id = $5
           AND run.nonce_sha256 = $6
           AND run.status IN ('issued', 'exhausted')
           AND run.revoked_at IS NULL
           AND run.expires_at > NOW()
           AND run.execution_authorized_at IS NOT NULL
           AND run.completed_at IS NULL
           AND run.data_calls_made < $7
         RETURNING run.data_calls_made AS call_ordinal`,
        [
            context.run_id,
            context.company_id,
            context.app_id,
            context.installation_id,
            context.version_id,
            context.nonce_sha256,
            DATA_CALL_LIMIT,
        ]
    );
    if (rows[0]) return Number(rows[0].call_ordinal);
    const current = await db.query(
        `SELECT run.data_calls_made
         FROM app_runs run
         WHERE run.id = $1
           AND run.company_id = $2
           AND run.app_id = $3
           AND run.installation_id = $4
           AND run.version_id = $5
           AND run.nonce_sha256 = $6
           AND run.status IN ('issued', 'exhausted')
           AND run.revoked_at IS NULL
           AND run.expires_at > NOW()
           AND run.execution_authorized_at IS NOT NULL
           AND run.completed_at IS NULL`,
        [
            context.run_id,
            context.company_id,
            context.app_id,
            context.installation_id,
            context.version_id,
            context.nonce_sha256,
        ]
    );
    if (Number(current.rows[0]?.data_calls_made) >= DATA_CALL_LIMIT) {
        throw appRuntimeError('DATA_CALL_LIMIT', 'Data call limit of 10 reached.', 429, {
            callOrdinal: Number(current.rows[0].data_calls_made) + 1,
        });
    }
    throw appRuntimeError(
        'APP_RUNTIME_INACTIVE',
        'App runtime authorization is not active.',
        403
    );
}

async function consumeRunWriteCall(context) {
    const { rows } = await db.query(
        `UPDATE app_runs run
         SET write_calls_made = run.write_calls_made + 1,
             updated_at = NOW()
         WHERE run.id = $1
           AND run.company_id = $2
           AND run.app_id = $3
           AND run.installation_id = $4
           AND run.version_id = $5
           AND run.nonce_sha256 = $6
           AND run.status IN ('issued', 'exhausted')
           AND run.revoked_at IS NULL
           AND run.expires_at > NOW()
           AND run.execution_authorized_at IS NOT NULL
           AND run.completed_at IS NULL
           AND run.write_calls_made < $7
         RETURNING run.write_calls_made AS call_ordinal`,
        [
            context.run_id,
            context.company_id,
            context.app_id,
            context.installation_id,
            context.version_id,
            context.nonce_sha256,
            WRITE_CALL_LIMIT,
        ]
    );
    if (rows[0]) return Number(rows[0].call_ordinal);
    const current = await db.query(
        `SELECT run.write_calls_made
         FROM app_runs run
         WHERE run.id = $1
           AND run.company_id = $2
           AND run.app_id = $3
           AND run.installation_id = $4
           AND run.version_id = $5
           AND run.nonce_sha256 = $6
           AND run.status IN ('issued', 'exhausted')
           AND run.revoked_at IS NULL
           AND run.expires_at > NOW()
           AND run.execution_authorized_at IS NOT NULL
           AND run.completed_at IS NULL`,
        [
            context.run_id,
            context.company_id,
            context.app_id,
            context.installation_id,
            context.version_id,
            context.nonce_sha256,
        ]
    );
    if (Number(current.rows[0]?.write_calls_made) >= WRITE_CALL_LIMIT) {
        throw appRuntimeError(
            'WRITE_CALL_LIMIT',
            'Write call limit of 3 reached.',
            429,
            { callOrdinal: Number(current.rows[0].write_calls_made) + 1 }
        );
    }
    throw appRuntimeError(
        'APP_RUNTIME_INACTIVE',
        'App runtime authorization is not active.',
        403
    );
}

function validateRunMetrics(metrics) {
    const keys = Object.keys(metrics || {}).sort();
    const expectedKeys = ['data_calls', 'error_code', 'gateway_calls', 'result_bytes', 'wall_ms'];
    if (keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])
        || !Number.isInteger(metrics.wall_ms)
        || metrics.wall_ms < 0
        || metrics.wall_ms > 24 * 60 * 60 * 1000
        || !Number.isInteger(metrics.gateway_calls)
        || metrics.gateway_calls < 0
        || metrics.gateway_calls > RUN_CALL_LIMIT
        || !Number.isInteger(metrics.data_calls)
        || metrics.data_calls < 0
        || metrics.data_calls > DATA_CALL_LIMIT
        || (metrics.result_bytes !== null && (
            !Number.isInteger(metrics.result_bytes)
            || metrics.result_bytes < 0
            || metrics.result_bytes > 64 * 1024
        ))
        || (metrics.error_code !== null && (
            typeof metrics.error_code !== 'string'
            || !/^[A-Z][A-Z0-9_]{0,99}$/.test(metrics.error_code)
        ))) {
        throw appRuntimeError('INVALID_REQUEST', 'Run metrics are invalid.', 400);
    }
    if ((metrics.error_code === null) !== (metrics.result_bytes !== null)) {
        throw appRuntimeError('INVALID_REQUEST', 'Run metrics are invalid.', 400);
    }
    return metrics;
}

async function recordRunCompletion(claims, rawMetrics) {
    const metrics = validateRunMetrics(rawMetrics);
    const nonceSha256 = sha256(claims.nonce);
    const binding = await db.query(
        `SELECT id, company_id, app_id, installation_id, version_id, nonce_sha256,
                execution_authorized_at
         FROM app_runs
         WHERE id = $1
           AND installation_id = $2
           AND version_id = $3`,
        [claims.run_id, claims.installation_id, claims.version_id]
    );
    if (binding.rows.length !== 1
        || !sameDigest(nonceSha256, binding.rows[0].nonce_sha256)) {
        throw appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    }
    const run = binding.rows[0];
    if (!run.execution_authorized_at) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    const { rows } = await db.query(
        `WITH candidate AS MATERIALIZED (
             SELECT run.id, run.company_id, run.app_id, run.installation_id,
                    control.daily_gateway_call_limit,
                    control.daily_run_limit,
                    control.daily_wall_ms_limit
             FROM app_runs run
             JOIN app_runtime_installation_controls control
               ON control.company_id = run.company_id
              AND control.app_id = run.app_id
              AND control.installation_id = run.installation_id
             WHERE run.id = $1
               AND run.company_id = $2
               AND run.app_id = $3
               AND run.installation_id = $4
               AND run.version_id = $5
               AND run.nonce_sha256 = $6
               AND run.execution_authorized_at IS NOT NULL
               AND run.status IN ('issued', 'exhausted')
               AND run.revoked_at IS NULL
               AND run.completed_at IS NULL
             FOR UPDATE OF run, control
         ), completed AS (
             UPDATE app_runs run
             SET wall_ms = $7,
                 gateway_calls_made = $8,
                 result_bytes = $9,
                 error_code = $10,
                 completed_at = NOW(),
                 status = CASE WHEN $10::text IS NULL THEN 'completed' ELSE 'failed' END,
                 updated_at = NOW()
             FROM candidate
             WHERE run.id = candidate.id
               AND run.company_id = candidate.company_id
               AND run.app_id = candidate.app_id
               AND run.installation_id = candidate.installation_id
             RETURNING run.id, run.status, run.wall_ms, run.gateway_calls_made,
                       run.data_calls_made,
                       run.result_bytes, run.error_code, run.completed_at
         ), usage AS (
             INSERT INTO app_runtime_usage
                (company_id, app_id, installation_id, usage_date,
                 gateway_calls_used, daily_gateway_call_limit,
                 runs_started, daily_run_limit, wall_ms_used,
                 daily_wall_ms_limit, updated_at)
             SELECT candidate.company_id, candidate.app_id, candidate.installation_id,
                    (NOW() AT TIME ZONE 'UTC')::date,
                    0, candidate.daily_gateway_call_limit,
                    0, candidate.daily_run_limit, $7,
                    candidate.daily_wall_ms_limit, NOW()
             FROM candidate, completed
             ON CONFLICT (company_id, app_id, installation_id, usage_date) DO UPDATE
             SET wall_ms_used = app_runtime_usage.wall_ms_used + EXCLUDED.wall_ms_used,
                 daily_run_limit = EXCLUDED.daily_run_limit,
                 daily_wall_ms_limit = EXCLUDED.daily_wall_ms_limit,
                 daily_gateway_call_limit = EXCLUDED.daily_gateway_call_limit,
                 updated_at = NOW()
             WHERE app_runtime_usage.company_id = $2
               AND app_runtime_usage.app_id = $3
               AND app_runtime_usage.installation_id = $4
             RETURNING wall_ms_used, daily_wall_ms_limit
         ), suspended AS (
             UPDATE app_runtime_installation_controls control
             SET suspended_at = COALESCE(control.suspended_at, NOW()),
                 suspension_reason = COALESCE(
                     control.suspension_reason,
                     'DAILY_WALL_MS_LIMIT'
                 ),
                 updated_at = NOW()
             FROM candidate, usage
             WHERE control.company_id = candidate.company_id
               AND control.app_id = candidate.app_id
               AND control.installation_id = candidate.installation_id
               AND usage.wall_ms_used >= usage.daily_wall_ms_limit
             RETURNING control.installation_id
         )
         SELECT completed.*
         FROM completed`,
        [
            run.id,
            run.company_id,
            run.app_id,
            run.installation_id,
            run.version_id,
            nonceSha256,
            metrics.wall_ms,
            metrics.gateway_calls,
            metrics.result_bytes,
            metrics.error_code,
        ]
    );
    if (rows.length !== 1) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    return rows[0];
}

module.exports = {
    DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
    RUN_CALL_LIMIT,
    DATA_CALL_LIMIT,
    WRITE_CALL_LIMIT,
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
    authorizeRunExecution,
    consumeRunCall,
    consumeRunDataCall,
    consumeRunWriteCall,
    validateRunMetrics,
    recordRunCompletion,
};
