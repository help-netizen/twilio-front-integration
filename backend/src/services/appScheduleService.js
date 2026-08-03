'use strict';

const db = require('../db/connection');
const appExecutionService = require('./appExecutionService');
const { appRuntimeError } = require('./appRuntimeErrors');
const { RUN_CALL_LIMIT } = require('./appRuntimeTokenService');
const {
    forecastCost,
    nextRunAt,
    validateCadence,
} = require('./appScheduleCadence');
const { normalizeCompanyTimezone } = require('../utils/companyTime');
const { validateSubscriptions } = require('./appEventCatalog');

function validInstallationId(value) {
    return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function validUuid(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireContext({ companyId, installationId, actorId }) {
    if (!companyId || !actorId) {
        throw appRuntimeError('TENANT_CONTEXT_REQUIRED', 'Company access is required.', 403);
    }
    if (!validInstallationId(String(installationId || ''))) {
        throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
    }
}

function exactBody(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).every(key => keys.includes(key));
}

function versionSummary(context) {
    const available = context.available_version_id
        && String(context.available_version_id) !== String(context.version_id);
    return {
        current: {
            version_id: context.version_id,
            version_number: context.version_number,
            consented_tools: context.consented_tools || [],
            subscribes: context.subscribes || [],
        },
        update_available: Boolean(available),
        available: available ? {
            version_id: context.available_version_id,
            version_number: context.available_version_number,
            tools: context.available_tools || [],
            subscribes: context.available_subscribes || [],
            suggested_schedule: context.available_suggested_schedule || null,
            suggested_cost_forecast: context.available_suggested_schedule
                ? forecastFor(context.available_suggested_schedule, context)
                : null,
        } : null,
    };
}

function forecastFor(cadence, context) {
    return forecastCost(cadence, {
        maxDataReadsPerRun: RUN_CALL_LIMIT,
        maxComputeMsPerRun: appExecutionService.runnerTimeoutMs(),
        dailyRunLimit: context.daily_run_limit,
        dailyComputeLimitMs: context.daily_wall_ms_limit,
        dailyDataReadLimit: context.daily_gateway_call_limit,
    });
}

function scheduleSummary(row, context) {
    const cadence = row?.cadence || null;
    return {
        enabled: Boolean(row?.enabled),
        cadence,
        next_run_at: row?.next_run_at || null,
        last_run_at: row?.last_run_at || null,
        last_status: row?.last_status || null,
        failure_count: Number(row?.failure_count || 0),
        suspended_reason: row?.suspended_reason || null,
        timezone: normalizeCompanyTimezone(context.timezone),
        cost_forecast: cadence ? forecastFor(cadence, context) : null,
    };
}

function createAppScheduleService({
    database = db,
    execution = appExecutionService,
    now = () => new Date(),
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

    async function loadContext(client, companyId, installationId, { forUpdate = false } = {}) {
        const { rows } = await client.query(
            `SELECT installation.id AS installation_id,
                    installation.company_id,
                    installation.app_id,
                    installation.installed_by,
                    company.timezone,
                    version.id AS version_id,
                    version.version_number,
                    COALESCE(
                        installation.metadata->'app_runtime'->'consented_tools',
                        '[]'::jsonb
                    ) AS consented_tools,
                    COALESCE(version.scanner_report->'subscribes', '[]'::jsonb)
                        AS subscribes,
                    ARRAY(
                        SELECT tool.tool_name
                        FROM app_version_tools tool
                        WHERE tool.version_id = version.id
                        ORDER BY tool.tool_name
                    ) AS allowed_tools,
                    COALESCE(control.daily_run_limit, 1000) AS daily_run_limit,
                    COALESCE(control.daily_wall_ms_limit, 600000) AS daily_wall_ms_limit,
                    COALESCE(control.daily_gateway_call_limit, 1000)
                        AS daily_gateway_call_limit,
                    available.id AS available_version_id,
                    available.version_number AS available_version_number,
                    available.suggested_schedule AS available_suggested_schedule,
                    COALESCE(available.subscribes, '[]'::jsonb) AS available_subscribes,
                    COALESCE(available.tools, ARRAY[]::text[]) AS available_tools
             FROM marketplace_installations installation
             JOIN companies company
               ON company.id = installation.company_id
              AND company.status = 'active'
             JOIN marketplace_apps app
               ON app.id = installation.app_id
              AND app.status = 'published'
             JOIN app_versions version
               ON version.app_id = installation.app_id
              AND version.id::text = installation.metadata->'app_runtime'->>'version_id'
              AND version.status = 'published'
             LEFT JOIN app_runtime_installation_controls control
               ON control.company_id = installation.company_id
              AND control.app_id = installation.app_id
              AND control.installation_id = installation.id
             LEFT JOIN LATERAL (
                 SELECT candidate.id, candidate.version_number,
                        candidate.suggested_schedule,
                        COALESCE(candidate.scanner_report->'subscribes', '[]'::jsonb)
                            AS subscribes,
                        ARRAY(
                            SELECT candidate_tool.tool_name
                            FROM app_version_tools candidate_tool
                            WHERE candidate_tool.version_id = candidate.id
                            ORDER BY candidate_tool.tool_name
                        ) AS tools
                 FROM app_versions candidate
                 WHERE candidate.app_id = installation.app_id
                   AND candidate.status = 'published'
                 ORDER BY candidate.published_at DESC NULLS LAST,
                          candidate.created_at DESC,
                          candidate.id DESC
                 LIMIT 1
             ) available ON true
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

    async function loadSchedule(client, companyId, installationId, { forUpdate = false } = {}) {
        const { rows } = await client.query(
            `SELECT schedule.installation_id, schedule.company_id, schedule.enabled,
                    schedule.cadence, schedule.next_run_at, schedule.last_run_at,
                    schedule.last_status, schedule.failure_count,
                    schedule.suspended_reason
             FROM app_installation_schedules schedule
             WHERE schedule.company_id = $1
               AND schedule.installation_id = $2
             ${forUpdate ? 'FOR UPDATE OF schedule' : ''}`,
            [companyId, installationId]
        );
        return rows[0] || null;
    }

    async function getSchedule(input) {
        requireContext(input);
        return withTransaction(async client => {
            const context = await loadContext(
                client,
                input.companyId,
                input.installationId
            );
            await execution.requireViewerAccess(context, input.actorId, client);
            const schedule = await loadSchedule(
                client,
                input.companyId,
                input.installationId
            );
            return {
                schedule: scheduleSummary(schedule, context),
                version: versionSummary(context),
            };
        });
    }

    async function updateSchedule(input) {
        requireContext(input);
        const body = input.body;
        if (!exactBody(body, ['enabled', 'cadence'])
            || typeof body.enabled !== 'boolean') {
            throw appRuntimeError('INVALID_REQUEST', 'Schedule request is invalid.', 400);
        }
        const requestedCadence = body.cadence === undefined
            ? undefined
            : validateCadence(body.cadence);
        return withTransaction(async client => {
            const context = await loadContext(
                client,
                input.companyId,
                input.installationId,
                { forUpdate: true }
            );
            await execution.requireViewerAccess(context, input.actorId, client);
            const current = await loadSchedule(
                client,
                input.companyId,
                input.installationId,
                { forUpdate: true }
            );
            const cadence = requestedCadence === undefined ? current?.cadence || null : requestedCadence;
            if (body.enabled && !cadence) {
                throw appRuntimeError(
                    'INVALID_CADENCE',
                    'A valid cadence is required to enable the schedule.',
                    422
                );
            }
            const next = body.enabled ? nextRunAt(cadence, context.timezone, now()) : null;
            const { rows } = await client.query(
                `INSERT INTO app_installation_schedules
                    (installation_id, company_id, enabled, cadence, next_run_at,
                     last_status, failure_count, suspended_reason, updated_at)
                 VALUES ($2, $1, $3, $4::jsonb, $5, $6, 0, NULL, NOW())
                 ON CONFLICT (installation_id) DO UPDATE
                 SET enabled = EXCLUDED.enabled,
                     cadence = EXCLUDED.cadence,
                     next_run_at = EXCLUDED.next_run_at,
                     last_status = EXCLUDED.last_status,
                     failure_count = 0,
                     suspended_reason = NULL,
                     updated_at = NOW()
                 WHERE app_installation_schedules.company_id = $1
                 RETURNING installation_id, company_id, enabled, cadence,
                           next_run_at, last_run_at, last_status,
                           failure_count, suspended_reason`,
                [
                    input.companyId,
                    input.installationId,
                    body.enabled,
                    cadence ? JSON.stringify(cadence) : null,
                    next,
                    body.enabled ? 'pending' : 'disabled',
                ]
            );
            if (!rows[0]) {
                throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
            }
            return {
                schedule: scheduleSummary(rows[0], context),
                version: versionSummary(context),
            };
        });
    }

    async function acceptVersion(input) {
        requireContext(input);
        if (!exactBody(input.body, ['version_id']) || !validUuid(input.body.version_id)) {
            throw appRuntimeError('INVALID_REQUEST', 'Version acceptance request is invalid.', 400);
        }
        return withTransaction(async client => {
            const context = await loadContext(
                client,
                input.companyId,
                input.installationId,
                { forUpdate: true }
            );
            await execution.requireViewerAccess(context, input.actorId, client);
            if (String(context.version_id) === input.body.version_id) {
                throw appRuntimeError(
                    'VERSION_ALREADY_ACCEPTED',
                    'This app version is already accepted.',
                    409
                );
            }
            const candidateResult = await client.query(
                `SELECT version.id, version.version_number,
                        ARRAY(
                            SELECT tool.tool_name
                            FROM app_version_tools tool
                            WHERE tool.version_id = version.id
                            ORDER BY tool.tool_name
                        ) AS allowed_tools,
                        COALESCE(version.scanner_report->'subscribes', '[]'::jsonb)
                            AS subscribes
                 FROM marketplace_installations installation
                 JOIN app_versions version
                   ON version.app_id = installation.app_id
                  AND version.id = $3
                  AND version.status = 'published'
                 WHERE installation.company_id = $1
                   AND installation.id = $2
                   AND installation.status = 'connected'
                 FOR SHARE OF version`,
                [input.companyId, input.installationId, input.body.version_id]
            );
            if (String(context.available_version_id || '') !== input.body.version_id
                || !candidateResult.rows[0]) {
                throw appRuntimeError(
                    'VERSION_NOT_AVAILABLE',
                    'The requested app version is not available.',
                    409
                );
            }
            const candidate = {
                ...context,
                version_id: candidateResult.rows[0].id,
                version_number: candidateResult.rows[0].version_number,
                allowed_tools: candidateResult.rows[0].allowed_tools || [],
                subscribes: validateSubscriptions(candidateResult.rows[0].subscribes || []),
            };
            await execution.requireViewerAccess(candidate, input.actorId, client);
            if (String(context.installed_by || '') !== String(input.actorId)) {
                await execution.requireViewerAccess(candidate, context.installed_by, client);
            }
            const { rows } = await client.query(
                `UPDATE marketplace_installations installation
                 SET metadata = jsonb_set(
                        COALESCE(installation.metadata, '{}'::jsonb),
                        '{app_runtime}',
                        jsonb_build_object(
                            'version_id', $3::text,
                            'consented_tools', to_jsonb($4::text[])
                        ),
                        true
                     ),
                     updated_at = NOW()
                 WHERE installation.company_id = $1
                   AND installation.id = $2
                   AND installation.status = 'connected'
                   AND installation.app_id = $5
                   AND EXISTS (
                       SELECT 1
                       FROM app_versions accepted
                       WHERE accepted.app_id = installation.app_id
                         AND accepted.id = $3
                         AND accepted.status = 'published'
                   )
                 RETURNING installation.app_id`,
                [
                    input.companyId,
                    input.installationId,
                    candidate.version_id,
                    candidate.allowed_tools,
                    context.app_id,
                ]
            );
            if (!rows[0]) {
                throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
            }
            await client.query(
                `INSERT INTO marketplace_installation_events
                    (company_id, installation_id, app_id, actor_id,
                     event_type, request_id, payload_json)
                 SELECT installation.company_id, installation.id,
                        installation.app_id, $4, 'version_accepted', $5,
                        jsonb_build_object(
                            'previous_version_id', $3::text,
                            'version_id', $6::text,
                            'consented_tools', to_jsonb($7::text[]),
                            'subscribes', $8::jsonb
                        )
                 FROM marketplace_installations installation
                 WHERE installation.company_id = $1
                   AND installation.id = $2`,
                [
                    input.companyId,
                    input.installationId,
                    context.version_id,
                    input.actorId,
                    input.requestId || null,
                    candidate.version_id,
                    candidate.allowed_tools,
                    JSON.stringify(candidate.subscribes),
                ]
            );
            return {
                accepted_version: {
                    version_id: candidate.version_id,
                    version_number: candidate.version_number,
                    consented_tools: candidate.allowed_tools,
                    subscribes: candidate.subscribes,
                },
            };
        });
    }

    return { getSchedule, updateSchedule, acceptVersion };
}

async function applySuggestedSchedule({
    client,
    companyId,
    installationId,
    cadence,
    now = new Date(),
}) {
    if (!cadence) return null;
    const normalized = validateCadence(cadence);
    const { rows: contextRows } = await client.query(
        `SELECT company.timezone
         FROM marketplace_installations installation
         JOIN companies company
           ON company.id = installation.company_id
         WHERE installation.company_id = $1
           AND installation.id = $2`,
        [companyId, installationId]
    );
    if (!contextRows[0]) {
        throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
    }
    const next = nextRunAt(normalized, contextRows[0].timezone, now);
    const { rows } = await client.query(
        `INSERT INTO app_installation_schedules
            (installation_id, company_id, enabled, cadence, next_run_at,
             last_status, failure_count, updated_at)
         VALUES ($2, $1, true, $3::jsonb, $4, 'pending', 0, NOW())
         ON CONFLICT (installation_id) DO NOTHING
         RETURNING *`,
        [companyId, installationId, JSON.stringify(normalized), next]
    );
    return rows[0] || null;
}

const service = createAppScheduleService();

module.exports = {
    ...service,
    applySuggestedSchedule,
    createAppScheduleService,
    forecastFor,
    scheduleSummary,
};
