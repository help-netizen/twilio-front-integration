'use strict';

const db = require('../db/connection');
const executionService = require('./appExecutionService');
const { appRuntimeError } = require('./appRuntimeErrors');
const {
    declaredSettingValues,
    validateSettingDestinations,
    validateSettingValues,
    validateSettings,
} = require('./appSettingsValidator');

function requireInput({ companyId, installationId, actorId }) {
    if (!companyId || !actorId) {
        throw appRuntimeError('TENANT_CONTEXT_REQUIRED', 'Company access is required.', 403);
    }
    if (!/^[1-9]\d*$/.test(String(installationId || ''))) {
        throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
    }
}

function acceptedDeclarations(row) {
    try {
        return validateSettings(row?.declared_settings || []);
    } catch (_error) {
        throw appRuntimeError(
            'APP_SETTINGS_CONFIGURATION_INVALID',
            'Accepted app settings configuration is invalid.',
            503
        );
    }
}

function createAppInstallationSettingsService({
    database = db,
    execution = executionService,
    validateDestinations = validateSettingDestinations,
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

    async function loadInstallation(
        client,
        companyId,
        installationId,
        { forUpdate = false } = {}
    ) {
        const { rows } = await client.query(
            `SELECT installation.id AS installation_id,
                    installation.company_id,
                    installation.app_id,
                    installation.metadata->'app_settings' AS app_settings,
                    COALESCE(version.scanner_report->'settings', '[]'::jsonb)
                        AS declared_settings,
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
             ${forUpdate ? 'FOR UPDATE OF installation' : 'FOR SHARE OF installation'}`,
            [companyId, installationId]
        );
        if (!rows[0]) {
            throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
        }
        return rows[0];
    }

    async function getSettings({ companyId, installationId, actorId }) {
        requireInput({ companyId, installationId, actorId });
        return withTransaction(async client => {
            const installation = await loadInstallation(client, companyId, installationId);
            await execution.requireViewerAccess(installation, actorId, client);
            const declarations = acceptedDeclarations(installation);
            return {
                declarations,
                settings: declaredSettingValues(declarations, installation.app_settings),
            };
        });
    }

    async function updateSettings({ companyId, installationId, actorId, settings }) {
        requireInput({ companyId, installationId, actorId });
        return withTransaction(async client => {
            const installation = await loadInstallation(
                client,
                companyId,
                installationId,
                { forUpdate: true }
            );
            await execution.requireViewerAccess(installation, actorId, client);
            const declarations = acceptedDeclarations(installation);
            const normalized = validateSettingValues(declarations, settings);
            await validateDestinations(declarations, normalized);
            const { rows } = await client.query(
                `UPDATE marketplace_installations installation
                 SET metadata = jsonb_set(
                         COALESCE(installation.metadata, '{}'::jsonb),
                         '{app_settings}',
                         $3::jsonb,
                         true
                     ),
                     updated_at = NOW()
                 WHERE installation.company_id = $1
                   AND installation.id = $2
                   AND installation.status = 'connected'
                 RETURNING installation.id`,
                [companyId, installationId, JSON.stringify(normalized)]
            );
            if (rows.length !== 1) {
                throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
            }
            return { declarations, settings: normalized };
        });
    }

    return { getSettings, updateSettings };
}

const service = createAppInstallationSettingsService();

module.exports = {
    ...service,
    acceptedDeclarations,
    createAppInstallationSettingsService,
};
