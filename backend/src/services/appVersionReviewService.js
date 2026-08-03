'use strict';

const db = require('../db/connection');
const { AppVersionTransitionError } = require('./appVersionTransitionService');

const STATUS_FILTERS = Object.freeze({
    pending: ['submitted', 'in_review'],
    published: ['published'],
    rejected: ['rejected'],
    revoked: ['revoked'],
});
const MAX_DIFF_LINES = 240;

function boundedLineDiff(previousSource, currentSource) {
    const before = typeof previousSource === 'string' ? previousSource.split('\n') : [];
    const after = typeof currentSource === 'string' ? currentSource.split('\n') : [];
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < before.length - prefix
        && suffix < after.length - prefix
        && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
        suffix += 1;
    }
    const changes = [];
    const contextStart = Math.max(0, prefix - 3);
    for (let index = contextStart; index < prefix; index += 1) {
        changes.push({ type: 'context', old_line: index + 1, new_line: index + 1, text: before[index] });
    }
    const removed = before.slice(prefix, before.length - suffix);
    const added = after.slice(prefix, after.length - suffix);
    for (let index = 0; index < removed.length; index += 1) {
        changes.push({ type: 'removed', old_line: prefix + index + 1, new_line: null, text: removed[index] });
    }
    for (let index = 0; index < added.length; index += 1) {
        changes.push({ type: 'added', old_line: null, new_line: prefix + index + 1, text: added[index] });
    }
    for (let index = 0; index < Math.min(3, suffix); index += 1) {
        changes.push({
            type: 'context',
            old_line: before.length - suffix + index + 1,
            new_line: after.length - suffix + index + 1,
            text: after[after.length - suffix + index],
        });
    }
    return {
        lines: changes.slice(0, MAX_DIFF_LINES),
        truncated: changes.length > MAX_DIFF_LINES,
        added_lines: added.length,
        removed_lines: removed.length,
    };
}

async function listReviews({ status = 'pending', page = 1, limit = 25 } = {}) {
    const statuses = STATUS_FILTERS[status];
    if (!statuses) {
        throw new AppVersionTransitionError(
            'INVALID_REVIEW_STATUS',
            'Review status filter is invalid.',
            422
        );
    }
    const offset = (page - 1) * limit;
    const { rows } = await db.query(
        `SELECT version.id AS version_id, version.app_id,
                version.version_number, version.status,
                version.submitted_at, version.created_at,
                version.reviewed_at, version.published_at,
                version.rejection_reason,
                app.app_key, app.name AS app_name, app.app_type,
                owned.company_id, company.name AS company_name,
                COALESCE(company.timezone, 'America/New_York') AS company_timezone,
                COUNT(*) OVER()::integer AS total
         FROM app_versions version
         JOIN app_studio_apps owned ON owned.app_id = version.app_id
         JOIN marketplace_apps app ON app.id = version.app_id
         JOIN companies company ON company.id = owned.company_id
         WHERE version.status = ANY($1::text[])
         ORDER BY COALESCE(version.submitted_at, version.created_at) ASC,
                  version.id ASC
         LIMIT $2 OFFSET $3`,
        [statuses, limit, offset]
    );
    return {
        requests: rows.map(({ total: _total, ...row }) => row),
        total: rows[0]?.total || 0,
        page,
        limit,
    };
}

async function getReview(versionId, {
    actorId,
    traceId = null,
    includeCode = false,
} = {}) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT version.*, owned.company_id,
                    app.app_key, app.name AS app_name, app.provider_name,
                    app.category, app.app_type, app.short_description,
                    app.long_description, app.logo_url, app.requested_scopes,
                    app.metadata AS app_metadata,
                    company.name AS company_name,
                    COALESCE(company.timezone, 'America/New_York') AS company_timezone
             FROM app_versions version
             JOIN app_studio_apps owned ON owned.app_id = version.app_id
             JOIN marketplace_apps app ON app.id = version.app_id
             JOIN companies company ON company.id = owned.company_id
             WHERE version.id = $1`,
            [versionId]
        );
        if (!current.rows[0]) {
            throw new AppVersionTransitionError(
                'NOT_FOUND',
                'App version review was not found.',
                404
            );
        }
        const version = current.rows[0];
        const previous = await client.query(
            `SELECT prior.id, prior.version_number, prior.status,
                    prior.source_code, prior.source_sha256,
                    prior.reviewed_at, prior.published_at
             FROM app_versions prior
             JOIN app_studio_apps owned
               ON owned.app_id = prior.app_id
              AND owned.company_id = $2
             WHERE prior.app_id = $1
               AND prior.id <> $3
               AND prior.status IN ('approved', 'published', 'revoked')
               AND (prior.created_at, prior.id) < ($4::timestamptz, $3::uuid)
             ORDER BY COALESCE(prior.published_at, prior.reviewed_at, prior.created_at) DESC,
                      prior.id DESC
             LIMIT 1`,
            [version.app_id, version.company_id, version.id, version.created_at]
        );
        const tools = await client.query(
            `SELECT tool.tool_name
             FROM app_version_tools tool
             JOIN app_versions scoped ON scoped.id = tool.version_id
             JOIN app_studio_apps owned
               ON owned.app_id = scoped.app_id
              AND owned.company_id = $2
             WHERE tool.version_id = $1
               AND scoped.app_id = $3
             ORDER BY tool.tool_name`,
            [version.id, version.company_id, version.app_id]
        );
        const messages = await client.query(
            `SELECT chat.id AS chat_id, chat.title AS chat_title,
                    chat.created_at AS chat_created_at,
                    message.id, message.role, message.text, message.model,
                    message.token_usage, message.version_id, message.created_at
             FROM app_build_chats chat
             LEFT JOIN app_build_messages message
               ON message.company_id = chat.company_id
              AND message.chat_id = chat.id
              AND message.app_id = chat.app_id
             WHERE chat.company_id = $1
               AND chat.app_id = $2
             ORDER BY chat.created_at, chat.id, message.created_at, message.id`,
            [version.company_id, version.app_id]
        );
        const audit = await client.query(
            `INSERT INTO audit_log
                (actor_id, action, target_type, target_id, company_id, details, trace_id)
             VALUES ($1, 'app_version.review_access', 'app_version', $2, $3,
                     $4::jsonb, $5)
             RETURNING id`,
            [
                actorId,
                String(version.id),
                version.company_id,
                JSON.stringify({
                    app_id: String(version.app_id),
                    version_id: String(version.id),
                    code_revealed: includeCode,
                }),
                traceId,
            ]
        );
        if (audit.rows.length !== 1) throw new Error('App review access audit insert failed');
        await client.query('COMMIT');

        const chatsById = new Map();
        for (const row of messages.rows) {
            if (!chatsById.has(row.chat_id)) {
                chatsById.set(row.chat_id, {
                    id: row.chat_id,
                    title: row.chat_title,
                    created_at: row.chat_created_at,
                    messages: [],
                });
            }
            if (row.id) {
                chatsById.get(row.chat_id).messages.push({
                    id: row.id,
                    role: row.role,
                    text: row.text,
                    model: row.model,
                    token_usage: row.token_usage,
                    version_id: row.version_id,
                    created_at: row.created_at,
                });
            }
        }
        const previousVersion = previous.rows[0] || null;
        const result = {
            version: {
                id: version.id,
                app_id: version.app_id,
                version_number: version.version_number,
                source_sha256: version.source_sha256,
                scanner_report: version.scanner_report,
                suggested_schedule: version.suggested_schedule || null,
                data_collections: version.data_collections || [],
                actions: version.scanner_report?.actions || [],
                sandbox_run: version.scanner_report?.dry_run || null,
                status: version.status,
                created_at: version.created_at,
                submitted_at: version.submitted_at,
                reviewed_at: version.reviewed_at,
                published_at: version.published_at,
                rejection_reason: version.rejection_reason,
                tools: tools.rows.map(row => row.tool_name),
                ...(includeCode ? { source_code: version.source_code } : {}),
            },
            app: {
                id: version.app_id,
                app_key: version.app_key,
                name: version.app_name,
                provider_name: version.provider_name,
                category: version.category,
                app_type: version.app_type,
                short_description: version.short_description,
                long_description: version.long_description,
                logo_url: version.logo_url,
                requested_scopes: version.requested_scopes,
                metadata: version.app_metadata,
            },
            company: {
                id: version.company_id,
                name: version.company_name,
                timezone: version.company_timezone,
            },
            previous_version: previousVersion ? {
                id: previousVersion.id,
                version_number: previousVersion.version_number,
                status: previousVersion.status,
                source_sha256: previousVersion.source_sha256,
            } : null,
            source_diff: boundedLineDiff(previousVersion?.source_code, version.source_code),
            chats: Array.from(chatsById.values()),
        };
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    STATUS_FILTERS,
    boundedLineDiff,
    getReview,
    listReviews,
};
