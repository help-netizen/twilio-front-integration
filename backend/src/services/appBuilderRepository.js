'use strict';

const crypto = require('node:crypto');
const db = require('../db/connection');
const retentionPolicy = require('./appBuilderRetentionPolicy');
const { validateCadence } = require('./appScheduleCadence');
const {
    validateDataCollectionEvolution,
    validateDataCollections,
} = require('./appDataCollectionValidator');
const { validateActions } = require('./appActionValidator');
const { validateSubscriptions } = require('./appEventCatalog');
const { validateConnections } = require('./appConnectionValidator');
const { validateSettings } = require('./appSettingsValidator');

class AppBuilderRepositoryError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'AppBuilderRepositoryError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function notFound() {
    return new AppBuilderRepositoryError('NOT_FOUND', 'App Studio resource not found.', 404);
}

async function withTransaction(work) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* best effort */ }
        throw error;
    } finally {
        client.release();
    }
}

async function createChat(companyId, actorId, { appId = null, title }) {
    const { rows } = await db.query(
        `INSERT INTO app_build_chats (company_id, app_id, created_by, title)
         SELECT $1, $2, $3, $4
         WHERE $2::bigint IS NULL
            OR EXISTS (
                SELECT 1
                FROM app_studio_apps owned
                WHERE owned.company_id = $1
                  AND owned.app_id = $2
            )
         RETURNING id, company_id, app_id, title, created_at, updated_at`,
        [companyId, appId, actorId, title]
    );
    if (!rows[0]) throw notFound();
    return rows[0];
}

async function listChats(companyId) {
    const { rows } = await db.query(
        `SELECT chat.id, chat.app_id, chat.title, chat.created_at, chat.updated_at,
                app.name AS app_name,
                COUNT(message.id)::integer AS message_count
         FROM app_build_chats chat
         LEFT JOIN app_studio_apps owned
           ON owned.company_id = chat.company_id
          AND owned.app_id = chat.app_id
         LEFT JOIN marketplace_apps app
           ON app.id = owned.app_id
         LEFT JOIN app_build_messages message
           ON message.company_id = chat.company_id
          AND message.chat_id = chat.id
         WHERE chat.company_id = $1
         GROUP BY chat.id, app.name
         ORDER BY chat.updated_at DESC, chat.id DESC`,
        [companyId]
    );
    return rows;
}

async function getMessages(companyId, chatId) {
    const chat = await db.query(
        `SELECT id, app_id, title, created_at, updated_at
         FROM app_build_chats
         WHERE company_id = $1
           AND id = $2`,
        [companyId, chatId]
    );
    if (!chat.rows[0]) throw notFound();
    const { rows } = await db.query(
        `SELECT message.id, message.role, message.text, message.model,
                message.token_usage, message.version_id, message.created_at
         FROM app_build_messages message
         JOIN app_build_chats chat
           ON chat.company_id = message.company_id
          AND chat.id = message.chat_id
         WHERE message.company_id = $1
           AND message.chat_id = $2
           AND chat.company_id = $1
         ORDER BY message.created_at ASC, message.id ASC`,
        [companyId, chatId]
    );
    return { chat: chat.rows[0], messages: rows };
}

async function listVersions(companyId, appId) {
    const owned = await db.query(
        `SELECT owned.app_id, app.name
         FROM app_studio_apps owned
         JOIN marketplace_apps app ON app.id = owned.app_id
         WHERE owned.company_id = $1
           AND owned.app_id = $2`,
        [companyId, appId]
    );
    if (!owned.rows[0]) throw notFound();
    const { rows } = await db.query(
        `SELECT version.id, version.version_number, version.source_sha256,
                version.scanner_report, version.suggested_schedule,
                version.data_collections,
                COALESCE(version.scanner_report->'actions', '[]'::jsonb) AS actions,
                COALESCE(version.scanner_report->'subscribes', '[]'::jsonb) AS subscribes,
                COALESCE(version.scanner_report->'connections', '[]'::jsonb) AS connections,
                COALESCE(version.scanner_report->'settings', '[]'::jsonb) AS settings,
                version.status, version.created_at,
                COALESCE(
                    ARRAY_AGG(tool.tool_name ORDER BY tool.tool_name)
                        FILTER (WHERE tool.tool_name IS NOT NULL),
                    ARRAY[]::text[]
                ) AS tools
         FROM app_versions version
         JOIN app_studio_apps owned
           ON owned.app_id = version.app_id
          AND owned.company_id = $1
         LEFT JOIN app_version_tools tool ON tool.version_id = version.id
         WHERE version.app_id = $2
           AND owned.company_id = $1
         GROUP BY version.id
         ORDER BY version.created_at DESC, version.id DESC`,
        [companyId, appId]
    );
    return { app: owned.rows[0], versions: rows };
}

async function appendUserMessage(companyId, actorId, chatId, text) {
    return withTransaction(async client => {
        const chat = await client.query(
            `SELECT id, app_id, title
             FROM app_build_chats
             WHERE company_id = $1
               AND id = $2
             FOR UPDATE`,
            [companyId, chatId]
        );
        if (!chat.rows[0]) throw notFound();
        const message = await client.query(
            `INSERT INTO app_build_messages
                (company_id, chat_id, role, text, token_usage, retention_expires_at)
             VALUES ($1, $2, 'user', $3, '{}'::jsonb, $4)
             RETURNING id, role, text, created_at`,
            [companyId, chatId, text, retentionPolicy.retentionExpiresAt()]
        );
        await client.query(
            `UPDATE app_build_chats
             SET updated_at = NOW()
             WHERE company_id = $1
               AND id = $2`,
            [companyId, chatId]
        );
        return { chat: chat.rows[0], message: message.rows[0], actorId };
    });
}

async function getGenerationContext(companyId, chatId) {
    const chat = await db.query(
        `SELECT chat.id, chat.app_id, chat.title,
                latest.source_code AS current_source,
                latest.data_collections AS current_data_collections,
                latest.actions AS current_actions,
                latest.subscribes AS current_subscribes,
                latest.connections AS current_connections,
                latest.settings AS current_settings
         FROM app_build_chats chat
         LEFT JOIN LATERAL (
             SELECT version.source_code, version.data_collections,
                    COALESCE(version.scanner_report->'actions', '[]'::jsonb) AS actions,
                    COALESCE(version.scanner_report->'subscribes', '[]'::jsonb) AS subscribes,
                    COALESCE(version.scanner_report->'connections', '[]'::jsonb) AS connections,
                    COALESCE(version.scanner_report->'settings', '[]'::jsonb) AS settings
             FROM app_versions version
             JOIN app_studio_apps owned
               ON owned.app_id = version.app_id
              AND owned.company_id = chat.company_id
             WHERE version.app_id = chat.app_id
               AND owned.company_id = $1
             ORDER BY version.created_at DESC, version.id DESC
             LIMIT 1
         ) latest ON true
         WHERE chat.company_id = $1
           AND chat.id = $2`,
        [companyId, chatId]
    );
    if (!chat.rows[0]) throw notFound();
    const history = await db.query(
        `SELECT role, text
         FROM (
             SELECT message.role, message.text, message.created_at, message.id
             FROM app_build_messages message
             JOIN app_build_chats owned_chat
               ON owned_chat.company_id = message.company_id
              AND owned_chat.id = message.chat_id
             WHERE message.company_id = $1
               AND message.chat_id = $2
               AND owned_chat.company_id = $1
             ORDER BY message.created_at DESC, message.id DESC
             LIMIT 20
         ) recent
         ORDER BY recent.created_at ASC, recent.id ASC`,
        [companyId, chatId]
    );
    return { ...chat.rows[0], history: history.rows };
}

async function reserveDailyGeneration(companyId, limit) {
    const usageDate = new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
        `INSERT INTO app_builder_usage_counters
            (company_id, usage_date, generations_used)
         VALUES ($1, $2, 1)
         ON CONFLICT (company_id, usage_date) DO UPDATE
         SET generations_used = app_builder_usage_counters.generations_used + 1,
             updated_at = NOW()
         WHERE app_builder_usage_counters.company_id = $1
           AND app_builder_usage_counters.usage_date = $2
           AND app_builder_usage_counters.generations_used < $3
         RETURNING generations_used`,
        [companyId, usageDate, limit]
    );
    return rows[0] || null;
}

async function insertAudit(client, {
    companyId,
    actorId,
    chatId,
    outcome,
    model,
    tokenUsage,
    appId = null,
    versionId = null,
    errorCode = null,
    requestId = null,
}) {
    await client.query(
        `INSERT INTO audit_log
            (actor_id, action, target_type, target_id, company_id, details, trace_id)
         SELECT $1, 'app_builder.generation', 'app_build_chat', chat.id,
                chat.company_id, $4::jsonb, $5
         FROM app_build_chats chat
         WHERE chat.company_id = $2
           AND chat.id = $3`,
        [
            actorId,
            companyId,
            chatId,
            JSON.stringify({
                outcome,
                model: model || null,
                token_usage: tokenUsage || {},
                app_id: appId == null ? null : String(appId),
                version_id: versionId == null ? null : String(versionId),
                error_code: errorCode,
            }),
            requestId,
        ]
    );
}

async function persistFailure({
    companyId,
    actorId,
    chatId,
    text,
    model = null,
    tokenUsage = {},
    errorCode,
    requestId = null,
}) {
    return withTransaction(async client => {
        const chat = await client.query(
            `SELECT id
             FROM app_build_chats
             WHERE company_id = $1
               AND id = $2
             FOR UPDATE`,
            [companyId, chatId]
        );
        if (!chat.rows[0]) throw notFound();
        const message = await client.query(
            `INSERT INTO app_build_messages
                (company_id, chat_id, role, text, model, token_usage, retention_expires_at)
             VALUES ($1, $2, 'assistant', $3, $4, $5::jsonb, $6)
             RETURNING id, role, text, model, token_usage, version_id, created_at`,
            [
                companyId,
                chatId,
                text,
                model,
                JSON.stringify(tokenUsage || {}),
                retentionPolicy.retentionExpiresAt(),
            ]
        );
        await insertAudit(client, {
            companyId,
            actorId,
            chatId,
            outcome: 'failed',
            model,
            tokenUsage,
            errorCode,
            requestId,
        });
        await client.query(
            `UPDATE app_build_chats SET updated_at = NOW()
             WHERE company_id = $1 AND id = $2`,
            [companyId, chatId]
        );
        return message.rows[0];
    });
}

async function persistSuccess({
    companyId,
    actorId,
    chatId,
    source,
    sourceSha256,
    scannerReport,
    suggestedSchedule = null,
    dataCollections = [],
    actions = [],
    subscribes = [],
    connections = [],
    settings = [],
    tools,
    description,
    model,
    tokenUsage,
    newApp,
    requestId = null,
}) {
    const computedSha256 = typeof source === 'string'
        ? crypto.createHash('sha256').update(source, 'utf8').digest('hex')
        : null;
    if (scannerReport?.dry_run?.ok !== true
        || typeof sourceSha256 !== 'string'
        || sourceSha256 !== computedSha256) {
        throw new AppBuilderRepositoryError(
            'APP_BUILDER_GATE_ATTESTATION_INVALID',
            'App builder gate attestation is invalid.',
            422
        );
    }
    const normalizedSuggestedSchedule = suggestedSchedule
        ? validateCadence(suggestedSchedule)
        : null;
    let normalizedDataCollections = validateDataCollections(dataCollections);
    const normalizedActions = validateActions(actions);
    const normalizedSubscriptions = validateSubscriptions(subscribes);
    const normalizedConnections = validateConnections(connections);
    const normalizedSettings = validateSettings(settings);
    return withTransaction(async client => {
        const chatResult = await client.query(
            `SELECT id, app_id, title
             FROM app_build_chats
             WHERE company_id = $1
               AND id = $2
             FOR UPDATE`,
            [companyId, chatId]
        );
        const chat = chatResult.rows[0];
        if (!chat) throw notFound();

        let appId = chat.app_id;
        if (appId == null) {
            const app = await client.query(
                `INSERT INTO marketplace_apps
                    (app_key, name, provider_name, category, app_type,
                     short_description, long_description, requested_scopes,
                     provisioning_mode, status, metadata)
                 VALUES ($1, $2, 'Albusto App Studio', 'custom', 'private',
                         $3, $3, $4::jsonb, 'none', 'draft', $5::jsonb)
                 RETURNING id`,
                [
                    newApp.appKey,
                    newApp.name,
                    description.slice(0, 500),
                    JSON.stringify(tools),
                    JSON.stringify(newApp.metadata),
                ]
            );
            appId = app.rows[0].id;
            await client.query(
                `INSERT INTO app_studio_apps (app_id, company_id, created_by)
                 VALUES ($1, $2, $3)`,
                [appId, companyId, actorId]
            );
            await client.query(
                `UPDATE app_build_chats
                 SET app_id = $3, title = $4, updated_at = NOW()
                 WHERE company_id = $1
                   AND id = $2`,
                [companyId, chatId, appId, newApp.name]
            );
        }

        const ownedApp = await client.query(
            `SELECT app.id
             FROM marketplace_apps app
             JOIN app_studio_apps owned
               ON owned.app_id = app.id
              AND owned.company_id = $1
             WHERE app.id = $2
               AND owned.company_id = $1
             FOR UPDATE OF app`,
            [companyId, appId]
        );
        if (!ownedApp.rows[0]) throw notFound();
        const previousPublished = await client.query(
            `SELECT version.data_collections
             FROM app_versions version
             JOIN app_studio_apps owned
               ON owned.app_id = version.app_id
              AND owned.company_id = $1
             WHERE version.app_id = $2
               AND version.status = 'published'
             ORDER BY version.published_at DESC NULLS LAST,
                      version.created_at DESC,
                      version.id DESC
             LIMIT 1`,
            [companyId, appId]
        );
        if (previousPublished.rows[0]) {
            normalizedDataCollections = validateDataCollectionEvolution(
                previousPublished.rows[0].data_collections,
                normalizedDataCollections
            );
        }
        const count = await client.query(
            `SELECT COUNT(*)::integer AS count
             FROM app_versions version
             JOIN app_studio_apps owned
               ON owned.app_id = version.app_id
              AND owned.company_id = $1
             WHERE version.app_id = $2
               AND owned.company_id = $1`,
            [companyId, appId]
        );
        const versionNumber = `builder-${Number(count.rows[0].count) + 1}`;
        const version = await client.query(
            `INSERT INTO app_versions
                (app_id, version_number, source_code, source_sha256,
                 scanner_report, suggested_schedule, data_collections, status, created_by)
             SELECT owned.app_id, $3, $4, $5, $6::jsonb, $7::jsonb,
                    $8::jsonb, 'draft', $9
             FROM app_studio_apps owned
             WHERE owned.company_id = $1
               AND owned.app_id = $2
             RETURNING id, app_id, version_number, source_sha256,
                       scanner_report, suggested_schedule, data_collections,
                       status, created_at`,
            [
                companyId,
                appId,
                versionNumber,
                source,
                sourceSha256,
                JSON.stringify({
                    ...scannerReport,
                    actions: normalizedActions,
                    subscribes: normalizedSubscriptions,
                    connections: normalizedConnections,
                    settings: normalizedSettings,
                }),
                normalizedSuggestedSchedule
                    ? JSON.stringify(normalizedSuggestedSchedule)
                    : null,
                JSON.stringify(normalizedDataCollections),
                actorId,
            ]
        );
        if (!version.rows[0]) throw notFound();
        if (tools.length > 0) {
            await client.query(
                `INSERT INTO app_version_tools (version_id, tool_name)
                 SELECT $3, requested.tool_name
                 FROM app_studio_apps owned
                 CROSS JOIN UNNEST($4::text[]) AS requested(tool_name)
                 WHERE owned.company_id = $1
                   AND owned.app_id = $2`,
                [companyId, appId, version.rows[0].id, tools]
            );
        }
        const message = await client.query(
            `INSERT INTO app_build_messages
                (company_id, chat_id, app_id, role, text, model, token_usage,
                 version_id, retention_expires_at)
             SELECT chat.company_id, chat.id, chat.app_id, 'assistant',
                    $3, $4, $5::jsonb, $6, $7
             FROM app_build_chats chat
             JOIN app_studio_apps owned
               ON owned.company_id = chat.company_id
              AND owned.app_id = chat.app_id
             WHERE chat.company_id = $1
               AND chat.id = $2
             RETURNING id, role, text, model, token_usage, version_id, created_at`,
            [
                companyId,
                chatId,
                description,
                model,
                JSON.stringify(tokenUsage || {}),
                version.rows[0].id,
                retentionPolicy.retentionExpiresAt(),
            ]
        );
        await insertAudit(client, {
            companyId,
            actorId,
            chatId,
            outcome: 'created',
            model,
            tokenUsage,
            appId,
            versionId: version.rows[0].id,
            requestId,
        });
        await client.query(
            `UPDATE app_build_chats SET updated_at = NOW()
             WHERE company_id = $1 AND id = $2`,
            [companyId, chatId]
        );
        return {
            app_id: appId,
            version: {
                ...version.rows[0],
                actions: normalizedActions,
                subscribes: normalizedSubscriptions,
                connections: normalizedConnections,
                settings: normalizedSettings,
                tools,
            },
            message: message.rows[0],
        };
    });
}

async function deleteExpiredMessages(companyId, { now = new Date(), batchSize = 1000 } = {}) {
    if (!companyId || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
        throw new AppBuilderRepositoryError(
            'INVALID_REQUEST',
            'Builder retention cleanup parameters are invalid.',
            400
        );
    }
    const { rows } = await db.query(
        `WITH expired AS MATERIALIZED (
             SELECT message.id
             FROM app_build_messages message
             WHERE message.company_id = $1
               AND message.retention_expires_at <= $2
             ORDER BY message.retention_expires_at, message.id
             LIMIT $3
             FOR UPDATE SKIP LOCKED
         )
         DELETE FROM app_build_messages message
         USING expired
         WHERE message.company_id = $1
           AND message.id = expired.id
         RETURNING message.id`,
        [companyId, now, batchSize]
    );
    return rows.length;
}

// tenant-safety-allow T-global-maintenance: ID-only scheduler discovery; every
// content mutation is subsequently invoked with the explicit company id.
async function listCompaniesWithExpiredMessages({
    now = new Date(),
    afterCompanyId = null,
    batchSize = 1000,
} = {}) {
    if ((afterCompanyId !== null && typeof afterCompanyId !== 'string')
        || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
        throw new AppBuilderRepositoryError(
            'INVALID_REQUEST',
            'Builder retention cleanup parameters are invalid.',
            400
        );
    }
    const { rows } = await db.query(
        `SELECT message.company_id
         FROM app_build_messages message
         WHERE message.retention_expires_at <= $1
           AND ($2::uuid IS NULL OR message.company_id > $2)
         GROUP BY message.company_id
         ORDER BY message.company_id
         LIMIT $3`,
        [now, afterCompanyId, batchSize]
    );
    return rows.map(row => row.company_id);
}

module.exports = {
    AppBuilderRepositoryError,
    createChat,
    listChats,
    getMessages,
    listVersions,
    appendUserMessage,
    getGenerationContext,
    reserveDailyGeneration,
    persistFailure,
    persistSuccess,
    deleteExpiredMessages,
    listCompaniesWithExpiredMessages,
};
