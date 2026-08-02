'use strict';

const db = require('../db/connection');
const authorizationService = require('./authorizationService');
const tokenService = require('./appRuntimeTokenService');
const toolCatalog = require('./appRuntimeToolCatalog');
const { appRuntimeError } = require('./appRuntimeErrors');
const {
    AppViewDocumentValidationError,
    validateViewDocument,
} = require('./appViewDocumentValidator');

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_RUNNER_RESPONSE_BYTES = 384 * 1024;
const RESULT_RETENTION_COUNT = 50;
const RESULT_RETENTION_DAYS = 90;

function runnerTimeoutMs() {
    const parsed = Number.parseInt(process.env.APP_RUNNER_REQUEST_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function runnerBaseUrl() {
    const configured = String(process.env.APP_RUNNER_BASE_URL || '').trim();
    let url;
    try {
        url = new URL(configured);
    } catch (_error) {
        throw appRuntimeError(
            'APP_RUNNER_NOT_CONFIGURED',
            'App runner service URL is not configured.',
            503
        );
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.search
        || url.hash
        || (url.pathname !== '/' && url.pathname !== '')) {
        throw appRuntimeError(
            'APP_RUNNER_NOT_CONFIGURED',
            'App runner service URL configuration is invalid.',
            503
        );
    }
    return url.origin;
}

function runnerServiceToken() {
    const token = String(process.env.APP_RUNNER_SERVICE_TOKEN || '').trim();
    if (!token) {
        throw appRuntimeError(
            'APP_RUNNER_NOT_CONFIGURED',
            'App runner service authentication is not configured.',
            503
        );
    }
    return token;
}

function validInstallationId(value) {
    return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function validUuid(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireRunInput({ companyId, installationId, trigger, actorId }) {
    if (!companyId || !actorId) {
        throw appRuntimeError(
            'TENANT_CONTEXT_REQUIRED',
            'Company access is required.',
            403
        );
    }
    if (!validInstallationId(String(installationId || ''))) {
        throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
    }
    if (!['manual', 'schedule'].includes(trigger)) {
        throw appRuntimeError(
            'INVALID_TRIGGER',
            'App run trigger is invalid.',
            422
        );
    }
}

function safeErrorCode(value, fallback = 'APP_RUNTIME_EXECUTION_FAILED') {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value)
        ? value
        : fallback;
}

function safeErrorMessage(value, fallback = 'Application execution failed.') {
    const message = typeof value === 'string' ? value : fallback;
    const normalized = message
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (normalized || fallback).slice(0, 500);
}

async function readBoundedJson(response) {
    let text;
    try {
        if (response?.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const chunks = [];
            let bytes = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_RUNNER_RESPONSE_BYTES) {
                    await reader.cancel().catch(() => {});
                    throw appRuntimeError(
                        'APP_RUNNER_PROTOCOL_ERROR',
                        'App runner response exceeded the allowed size.',
                        502
                    );
                }
                chunks.push(Buffer.from(value));
            }
            text = Buffer.concat(chunks, bytes).toString('utf8');
        } else {
            text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_RUNNER_RESPONSE_BYTES) {
                throw appRuntimeError(
                    'APP_RUNNER_PROTOCOL_ERROR',
                    'App runner response exceeded the allowed size.',
                    502
                );
            }
        }
        return JSON.parse(text);
    } catch (error) {
        if (error?.code === 'APP_RUNNER_PROTOCOL_ERROR') throw error;
        throw appRuntimeError(
            'APP_RUNNER_PROTOCOL_ERROR',
            'App runner returned an invalid response.',
            502
        );
    }
}

function normalizedUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const wallMs = value.wall_ms;
    const gatewayCalls = value.gateway_calls;
    const dataCalls = value.data_calls;
    const resultBytes = value.result_bytes;
    const errorCode = value.error_code;
    if (!Number.isInteger(wallMs) || wallMs < 0 || wallMs > 24 * 60 * 60 * 1000
        || !Number.isInteger(gatewayCalls) || gatewayCalls < 0 || gatewayCalls > 5
        || !Number.isInteger(dataCalls) || dataCalls < 0 || dataCalls > 10
        || (resultBytes !== null && (!Number.isInteger(resultBytes) || resultBytes < 0))
        || (errorCode !== null && safeErrorCode(errorCode, null) === null)) {
        return null;
    }
    return {
        wall_ms: wallMs,
        gateway_calls: gatewayCalls,
        data_calls: dataCalls,
        result_bytes: resultBytes,
        error_code: errorCode,
    };
}

async function executeOnRunner({ sourceCode, sourceSha256, runToken }, fetchImpl) {
    if (typeof fetchImpl !== 'function') {
        throw appRuntimeError(
            'APP_RUNNER_UNAVAILABLE',
            'App runner service is unavailable.',
            503
        );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), runnerTimeoutMs());
    try {
        const response = await fetchImpl(`${runnerBaseUrl()}/v1/run`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${runnerServiceToken()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                source: sourceCode,
                expectedSourceSha256: sourceSha256,
                runToken,
                input: { today: new Date().toISOString().slice(0, 10) },
            }),
            signal: controller.signal,
        });
        const payload = await readBoundedJson(response);
        const usage = normalizedUsage(payload?.usage);
        if (!response.ok || payload?.ok !== true) {
            const error = appRuntimeError(
                safeErrorCode(payload?.error?.code),
                safeErrorMessage(payload?.error?.message),
                response.status >= 500 ? 502 : 422,
                { usage }
            );
            throw error;
        }
        if (!Object.prototype.hasOwnProperty.call(payload, 'result') || !usage) {
            throw appRuntimeError(
                'APP_RUNNER_PROTOCOL_ERROR',
                'App runner returned an invalid execution result.',
                502
            );
        }
        const resultBytes = Buffer.byteLength(JSON.stringify(payload.result), 'utf8');
        if (usage.error_code !== null
            || usage.result_bytes === null
            || usage.result_bytes !== resultBytes) {
            throw appRuntimeError(
                'APP_RUNNER_PROTOCOL_ERROR',
                'App runner returned inconsistent execution accounting.',
                502,
                { usage }
            );
        }
        return { result: payload.result, usage };
    } catch (error) {
        if (error?.code) throw error;
        if (controller.signal.aborted || error?.name === 'AbortError') {
            throw appRuntimeError(
                'APP_RUNNER_TIMEOUT',
                'Application execution exceeded the runner service timeout.',
                504
            );
        }
        throw appRuntimeError(
            'APP_RUNNER_UNAVAILABLE',
            'App runner service is unavailable.',
            503
        );
    } finally {
        clearTimeout(timer);
    }
}

function runSummary(row) {
    return {
        run_id: row.run_id || row.id,
        status: row.status,
        started_at: row.started_at || row.issued_at,
        completed_at: row.completed_at,
        duration_ms: row.duration_ms === undefined ? row.wall_ms : row.duration_ms,
        gateway_calls: row.gateway_calls === undefined
            ? row.gateway_calls_made
            : row.gateway_calls,
        data_calls: Number(row.data_calls === undefined ? row.data_calls_made || 0 : row.data_calls),
        result_bytes: row.result_bytes,
        error_code: row.error_code,
        error_message: row.error_message,
        has_result: Boolean(row.has_result),
    };
}

function createAppExecutionService({
    database = db,
    tokens = tokenService,
    authorization = authorizationService,
    fetchImpl = globalThis.fetch,
} = {}) {
    async function withTransaction(work) {
        const client = await database.getClient();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async function loadInstallation(client, companyId, installationId, { forUpdate = false } = {}) {
        const { rows } = await client.query(
            `SELECT installation.id AS installation_id,
                    installation.company_id,
                    installation.app_id,
                    installation.latest_run_id,
                    version.id AS version_id,
                    version.source_code,
                    version.source_sha256,
                    ARRAY(
                        SELECT tool.tool_name
                        FROM app_version_tools tool
                        WHERE tool.version_id = version.id
                        ORDER BY tool.tool_name
                    ) AS allowed_tools
             FROM marketplace_installations installation
             JOIN marketplace_apps app
               ON app.id = installation.app_id
              AND app.status = 'published'
             JOIN app_versions version
               ON version.app_id = installation.app_id
              AND version.id::text = installation.metadata->'app_runtime'->>'version_id'
              AND version.status = 'published'
             WHERE installation.company_id = $1
               AND installation.id = $2
               AND installation.status = 'connected'
             ${forUpdate ? 'FOR UPDATE OF installation' : ''}`,
            [companyId, installationId]
        );
        if (!rows[0]) {
            throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
        }
        return rows[0];
    }

    async function requireViewerAccess(context, actorId, client) {
        let authz;
        try {
            authz = await authorization.resolveCompanyUserAuthz(
                context.company_id,
                actorId,
                { client }
            );
        } catch (_error) {
            throw appRuntimeError(
                'ACCESS_DENIED',
                'You do not have permission to view this application.',
                403
            );
        }
        const requiredPermissions = new Set();
        for (const toolName of context.allowed_tools || []) {
            const tool = toolCatalog.getTool(toolName);
            if (!tool) {
                throw appRuntimeError(
                    'ACCESS_DENIED',
                    'You do not have permission to view this application.',
                    403
                );
            }
            requiredPermissions.add(tool.businessPermission);
        }
        if (requiredPermissions.size === 0) {
            if (authz.role_key !== 'tenant_admin') {
                throw appRuntimeError(
                    'ACCESS_DENIED',
                    'You do not have permission to view this application.',
                    403
                );
            }
            return authz;
        }
        const viewerPermissions = new Set(authz.permissions || []);
        if (![...requiredPermissions].every(permission => viewerPermissions.has(permission))) {
            throw appRuntimeError(
                'ACCESS_DENIED',
                'You do not have permission to view this application.',
                403
            );
        }
        return authz;
    }

    async function claimRun({ companyId, installationId, actorId }) {
        return withTransaction(async client => {
            const installation = await loadInstallation(
                client,
                companyId,
                installationId,
                { forUpdate: true }
            );
            await requireViewerAccess(installation, actorId, client);
            await client.query(
                `UPDATE app_runs
                 SET status = 'failed',
                     error_code = 'APP_RUNTIME_EXPIRED',
                     error_message = 'Application run expired before completion.',
                     completed_at = NOW(),
                     updated_at = NOW()
                 WHERE company_id = $1
                   AND installation_id = $2
                   AND completed_at IS NULL
                   AND status IN ('issued', 'exhausted')
                   AND expires_at <= NOW()`,
                [companyId, installationId]
            );
            const current = await client.query(
                `SELECT id AS run_id, status, issued_at AS started_at,
                        completed_at, wall_ms AS duration_ms,
                        COALESCE(gateway_calls_made, gateway_calls_used) AS gateway_calls,
                        data_calls_made AS data_calls,
                        result_bytes, error_code, error_message, false AS has_result
                 FROM app_runs
                 WHERE company_id = $1
                   AND installation_id = $2
                   AND completed_at IS NULL
                   AND status IN ('issued', 'exhausted')
                   AND expires_at > NOW()
                 ORDER BY issued_at DESC, id DESC
                 LIMIT 1
                 FOR UPDATE`,
                [companyId, installationId]
            );
            if (current.rows[0]) {
                return { inFlight: true, run: runSummary(current.rows[0]) };
            }
            const minted = await tokens.mintRunToken({
                installationId: String(installationId),
                versionId: String(installation.version_id),
            }, { client });
            return { inFlight: false, installation, minted };
        });
    }

    async function markRunFailed({ companyId, installationId, runId, error }) {
        const usage = normalizedUsage(error?.details?.usage);
        const errorCode = error instanceof AppViewDocumentValidationError
            ? error.code
            : safeErrorCode(error?.code);
        const errorMessage = safeErrorMessage(error?.message);
        const updated = await database.query(
            `UPDATE app_runs
             SET status = 'failed',
                 wall_ms = COALESCE(wall_ms, $4),
                 gateway_calls_made = COALESCE(gateway_calls_made, $5),
                 result_bytes = COALESCE(result_bytes, $6),
                 error_code = $7,
                 error_message = $8,
                 completed_at = COALESCE(completed_at, NOW()),
                 updated_at = NOW()
             WHERE company_id = $1
               AND installation_id = $2
               AND id = $3
             RETURNING id`,
            [
                companyId,
                installationId,
                runId,
                usage?.wall_ms ?? null,
                usage?.gateway_calls ?? null,
                usage?.result_bytes ?? null,
                errorCode,
                errorMessage,
            ]
        );
        if (updated.rows.length !== 1) {
            throw appRuntimeError(
                'APP_RUNTIME_RESULT_PERSISTENCE_FAILED',
                'Application run result could not be recorded.',
                503
            );
        }
    }

    async function persistSuccessfulResult({
        companyId,
        installationId,
        runId,
        viewDocument,
    }) {
        return withTransaction(async client => {
            const accounting = await client.query(
                `SELECT id AS run_id, status, issued_at AS started_at,
                        completed_at, wall_ms AS duration_ms,
                        COALESCE(gateway_calls_made, gateway_calls_used) AS gateway_calls,
                        data_calls_made AS data_calls,
                        result_bytes, error_code, error_message
                 FROM app_runs
                 WHERE company_id = $1
                   AND installation_id = $2
                   AND id = $3
                 FOR UPDATE`,
                [companyId, installationId, runId]
            );
            if (accounting.rows[0]?.status !== 'completed') {
                throw appRuntimeError(
                    'APP_RUNTIME_ACCOUNTING_INCOMPLETE',
                    'Application run accounting was not completed.',
                    503
                );
            }
            await client.query(
                `INSERT INTO app_run_results
                    (run_id, company_id, installation_id, view_document, created_at)
                 VALUES ($1, $2, $3, $4::jsonb, NOW())`,
                [runId, companyId, installationId, JSON.stringify(viewDocument)]
            );
            const moved = await client.query(
                `UPDATE marketplace_installations installation
                 SET latest_run_id = $3,
                     updated_at = NOW()
                 WHERE installation.company_id = $1
                   AND installation.id = $2
                   AND EXISTS (
                       SELECT 1
                       FROM app_run_results result
                       WHERE result.company_id = installation.company_id
                         AND result.installation_id = installation.id
                         AND result.run_id = $3
                   )
                 RETURNING installation.latest_run_id`,
                [companyId, installationId, runId]
            );
            if (moved.rows.length !== 1) {
                throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
            }
            await client.query(
                `DELETE FROM app_run_results result
                 WHERE result.company_id = $1
                   AND result.installation_id = $2
                   AND (
                       result.created_at < NOW() - INTERVAL '${RESULT_RETENTION_DAYS} days'
                       OR result.run_id IN (
                           SELECT expired.run_id
                           FROM app_run_results expired
                           WHERE expired.company_id = $1
                             AND expired.installation_id = $2
                           ORDER BY expired.created_at DESC, expired.run_id DESC
                           OFFSET ${RESULT_RETENTION_COUNT}
                       )
                   )`,
                [companyId, installationId]
            );
            return {
                ...runSummary({ ...accounting.rows[0], has_result: true }),
                view_document: viewDocument,
            };
        });
    }

    async function run({ companyId, installationId, trigger, actorId }) {
        requireRunInput({ companyId, installationId, trigger, actorId });
        const claimed = await claimRun({ companyId, installationId, actorId });
        if (claimed.inFlight) return { ...claimed.run, status: 'running' };

        const { installation, minted } = claimed;
        try {
            const execution = await executeOnRunner({
                sourceCode: installation.source_code,
                sourceSha256: installation.source_sha256,
                runToken: minted.token,
            }, fetchImpl);
            const validated = validateViewDocument(execution.result);
            return await persistSuccessfulResult({
                companyId,
                installationId: String(installationId),
                runId: minted.runId,
                viewDocument: validated.document,
            });
        } catch (error) {
            await markRunFailed({
                companyId,
                installationId: String(installationId),
                runId: minted.runId,
                error,
            });
            throw error;
        }
    }

    async function withViewerAccess({ companyId, installationId, actorId }, work) {
        return withTransaction(async client => {
            const installation = await loadInstallation(client, companyId, installationId);
            await requireViewerAccess(installation, actorId, client);
            return work(client, installation);
        });
    }

    async function listRuns({ companyId, installationId, actorId }) {
        return withViewerAccess({ companyId, installationId, actorId }, async client => {
            const { rows } = await client.query(
                `SELECT run.id AS run_id, run.status,
                        run.issued_at AS started_at, run.completed_at,
                        run.wall_ms AS duration_ms,
                        COALESCE(run.gateway_calls_made, run.gateway_calls_used) AS gateway_calls,
                        run.data_calls_made AS data_calls,
                        run.result_bytes, run.error_code, run.error_message,
                        (result.run_id IS NOT NULL) AS has_result
                 FROM app_runs run
                 LEFT JOIN app_run_results result
                   ON result.company_id = run.company_id
                  AND result.installation_id = run.installation_id
                  AND result.run_id = run.id
                 WHERE run.company_id = $1
                   AND run.installation_id = $2
                 ORDER BY run.issued_at DESC, run.id DESC
                 LIMIT 50`,
                [companyId, installationId]
            );
            return rows.map(runSummary);
        });
    }

    async function getRunResult({ companyId, installationId, runId, actorId }) {
        if (!validUuid(runId)) {
            throw appRuntimeError('NOT_FOUND', 'App run result was not found.', 404);
        }
        return withViewerAccess({ companyId, installationId, actorId }, async client => {
            const { rows } = await client.query(
                `SELECT run.id AS run_id, run.status,
                        run.issued_at AS started_at, run.completed_at,
                        run.wall_ms AS duration_ms,
                        COALESCE(run.gateway_calls_made, run.gateway_calls_used) AS gateway_calls,
                        run.data_calls_made AS data_calls,
                        run.result_bytes, run.error_code, run.error_message,
                        (result.run_id IS NOT NULL) AS has_result,
                        result.view_document
                 FROM app_runs run
                 LEFT JOIN app_run_results result
                   ON result.company_id = run.company_id
                  AND result.installation_id = run.installation_id
                  AND result.run_id = run.id
                 WHERE run.company_id = $1
                   AND run.installation_id = $2
                   AND run.id = $3`,
                [companyId, installationId, runId]
            );
            if (!rows[0]) {
                throw appRuntimeError('NOT_FOUND', 'App run result was not found.', 404);
            }
            return { ...runSummary(rows[0]), view_document: rows[0].view_document || null };
        });
    }

    async function getLatestResult({ companyId, installationId, actorId }) {
        return withViewerAccess({ companyId, installationId, actorId }, async (
            client,
            installation
        ) => {
            if (!installation.latest_run_id) {
                throw appRuntimeError('NOT_FOUND', 'No app run result is available.', 404);
            }
            const { rows } = await client.query(
                `SELECT run.id AS run_id, run.status,
                        run.issued_at AS started_at, run.completed_at,
                        run.wall_ms AS duration_ms,
                        COALESCE(run.gateway_calls_made, run.gateway_calls_used) AS gateway_calls,
                        run.data_calls_made AS data_calls,
                        run.result_bytes, run.error_code, run.error_message,
                        true AS has_result, result.view_document
                 FROM marketplace_installations installation
                 JOIN app_run_results result
                   ON result.company_id = installation.company_id
                  AND result.installation_id = installation.id
                  AND result.run_id = installation.latest_run_id
                 JOIN app_runs run
                   ON run.company_id = result.company_id
                  AND run.installation_id = result.installation_id
                  AND run.id = result.run_id
                 WHERE installation.company_id = $1
                   AND installation.id = $2
                   AND installation.latest_run_id = $3`,
                [companyId, installationId, installation.latest_run_id]
            );
            if (!rows[0]) {
                throw appRuntimeError('NOT_FOUND', 'No app run result is available.', 404);
            }
            return { ...runSummary(rows[0]), view_document: rows[0].view_document };
        });
    }

    return {
        run,
        listRuns,
        getRunResult,
        getLatestResult,
        requireViewerAccess,
        persistSuccessfulResult,
    };
}

const service = createAppExecutionService();

module.exports = {
    ...service,
    DEFAULT_TIMEOUT_MS,
    MAX_RUNNER_RESPONSE_BYTES,
    RESULT_RETENTION_COUNT,
    RESULT_RETENTION_DAYS,
    createAppExecutionService,
    executeOnRunner,
    normalizedUsage,
    runnerBaseUrl,
    runnerServiceToken,
    runnerTimeoutMs,
};
