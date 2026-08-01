'use strict';

const db = require('../db/connection');

const ALLOWED_TRANSITIONS = Object.freeze({
    draft: Object.freeze(['submitted']),
    submitted: Object.freeze(['in_review']),
    in_review: Object.freeze(['approved', 'rejected']),
    approved: Object.freeze(['published']),
    published: Object.freeze(['revoked']),
    rejected: Object.freeze([]),
    revoked: Object.freeze([]),
});

class AppVersionTransitionError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'AppVersionTransitionError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function notFound() {
    return new AppVersionTransitionError(
        'NOT_FOUND',
        'App version review was not found.',
        404
    );
}

function conflict(fromStatus, toStatus) {
    return new AppVersionTransitionError(
        'VERSION_TRANSITION_CONFLICT',
        `Version cannot transition from ${fromStatus} to ${toStatus}.`,
        409
    );
}

function cleanReason(value) {
    if (typeof value !== 'string') {
        throw new AppVersionTransitionError(
            'REJECTION_REASON_REQUIRED',
            'A rejection reason is required.',
            422
        );
    }
    const reason = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!reason || reason.length > 2000) {
        throw new AppVersionTransitionError(
            'REJECTION_REASON_INVALID',
            'Rejection reason must be between 1 and 2,000 characters.',
            422
        );
    }
    return reason;
}

function createAppVersionTransitionService({
    database = db,
    afterVersionLock = null,
} = {}) {
    async function withTransaction(work) {
        const client = await database.getClient();
        try {
            await client.query('BEGIN');
            await client.query(
                `SELECT set_config('app.version_transition_service', 'enabled', true)`
            );
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            if (/APP_VERSION_(?:TRANSITION|ARTIFACT|TOOLS)/.test(String(error?.message || ''))) {
                throw new AppVersionTransitionError(
                    'VERSION_TRANSITION_CONFLICT',
                    'The app version changed before this transition completed.',
                    409
                );
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async function lockVersion(client, { versionId, appId = null, companyId = null }) {
        const { rows } = await client.query(
            `SELECT version.id, version.app_id, version.version_number,
                    version.source_code, version.source_sha256,
                    version.scanner_report, version.status,
                    version.created_by, version.created_at,
                    version.updated_at,
                    (to_jsonb(version)->>'submitted_at')::timestamptz AS submitted_at,
                    version.reviewed_by, version.reviewed_at,
                    version.published_at,
                    to_jsonb(version)->>'rejection_reason' AS rejection_reason,
                    owned.company_id, app.name AS app_name,
                    app.status AS app_status
             FROM app_versions version
             JOIN app_studio_apps owned
               ON owned.app_id = version.app_id
             JOIN marketplace_apps app
               ON app.id = version.app_id
             WHERE version.id = $1
               AND ($2::bigint IS NULL OR version.app_id = $2)
               AND ($3::uuid IS NULL OR owned.company_id = $3)
             FOR UPDATE OF version, app`,
            [versionId, appId, companyId]
        );
        if (!rows[0]) throw notFound();
        if (afterVersionLock) await afterVersionLock(rows[0]);
        return rows[0];
    }

    async function insertTransitionAudit(client, version, {
        actorId,
        fromStatus,
        toStatus,
        reason = null,
        traceId = null,
    }) {
        const { rows } = await client.query(
            `INSERT INTO audit_log
                (actor_id, action, target_type, target_id, company_id, details, trace_id)
             VALUES ($1, 'app_version.transition', 'app_version', $2, $3,
                     $4::jsonb, $5)
             RETURNING id`,
            [
                actorId,
                String(version.id),
                version.company_id,
                JSON.stringify({
                    app_id: String(version.app_id),
                    version_id: String(version.id),
                    from_status: fromStatus,
                    to_status: toStatus,
                    reason,
                }),
                traceId,
            ]
        );
        if (rows.length !== 1) throw new Error('App version transition audit insert failed');
    }

    async function updateStatus(client, version, toStatus, actorId, reason) {
        let sql;
        let params;
        if (toStatus === 'submitted') {
            sql = `UPDATE app_versions
                   SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
                   WHERE id = $1 AND app_id = $2
                   RETURNING *`;
            params = [version.id, version.app_id];
        } else if (toStatus === 'in_review') {
            sql = `UPDATE app_versions
                   SET status = 'in_review', reviewed_by = $3, updated_at = NOW()
                   WHERE id = $1 AND app_id = $2
                   RETURNING *`;
            params = [version.id, version.app_id, actorId];
        } else if (toStatus === 'approved') {
            sql = `UPDATE app_versions
                   SET status = 'approved', reviewed_by = $3,
                       reviewed_at = NOW(), updated_at = NOW()
                   WHERE id = $1 AND app_id = $2
                   RETURNING *`;
            params = [version.id, version.app_id, actorId];
        } else if (toStatus === 'rejected') {
            sql = `UPDATE app_versions
                   SET status = 'rejected', reviewed_by = $3,
                       reviewed_at = NOW(), rejection_reason = $4, updated_at = NOW()
                   WHERE id = $1 AND app_id = $2
                   RETURNING *`;
            params = [version.id, version.app_id, actorId, reason];
        } else if (toStatus === 'published') {
            sql = `UPDATE app_versions
                   SET status = 'published', published_at = NOW(), updated_at = NOW()
                   WHERE id = $1 AND app_id = $2
                   RETURNING *`;
            params = [version.id, version.app_id];
        } else {
            sql = `UPDATE app_versions
                   SET status = 'revoked', updated_at = NOW()
                   WHERE id = $1 AND app_id = $2
                   RETURNING *`;
            params = [version.id, version.app_id];
        }
        const { rows } = await client.query(sql, params);
        if (!rows[0]) throw notFound();
        return { ...version, ...rows[0] };
    }

    async function appendRejectionMessage(client, version, reason) {
        const text = `Version ${version.version_number} was rejected during review. Reason: ${reason}`;
        const { rows } = await client.query(
            `WITH target_chat AS MATERIALIZED (
                 SELECT chat.id, chat.company_id, chat.app_id
                 FROM app_build_chats chat
                 WHERE chat.company_id = $1
                   AND chat.app_id = $2
                 ORDER BY EXISTS (
                     SELECT 1
                     FROM app_build_messages existing
                     WHERE existing.company_id = chat.company_id
                       AND existing.chat_id = chat.id
                       AND existing.app_id = chat.app_id
                       AND existing.version_id = $3
                 ) DESC,
                 chat.updated_at DESC,
                 chat.id DESC
                 LIMIT 1
             ), inserted AS (
                 INSERT INTO app_build_messages
                    (company_id, chat_id, app_id, role, text, model,
                     token_usage, version_id)
                 SELECT target.company_id, target.id, target.app_id, 'assistant',
                        $4, NULL, '{}'::jsonb, $3
                 FROM target_chat target
                 RETURNING chat_id
             )
             UPDATE app_build_chats chat
             SET updated_at = NOW()
             FROM inserted
             WHERE chat.company_id = $1
               AND chat.id = inserted.chat_id
             RETURNING inserted.chat_id`,
            [version.company_id, version.app_id, version.id, text]
        );
        if (rows.length !== 1) {
            throw new Error('Rejected version has no tenant-owned builder chat');
        }
    }

    async function activatePublishedVersion(client, version) {
        const app = await client.query(
            `UPDATE marketplace_apps app
             SET status = 'published', updated_at = NOW()
             WHERE app.id = $2
               AND EXISTS (
                   SELECT 1
                   FROM app_studio_apps owned
                   WHERE owned.company_id = $1
                     AND owned.app_id = app.id
               )
             RETURNING app.id`,
            [version.company_id, version.app_id]
        );
        if (app.rows.length !== 1) throw notFound();

        await client.query(
            `UPDATE marketplace_installations installation
             SET metadata = jsonb_set(
                    jsonb_set(
                        COALESCE(installation.metadata, '{}'::jsonb),
                        '{app_runtime}',
                        COALESCE(installation.metadata->'app_runtime', '{}'::jsonb),
                        true
                    ),
                    '{app_runtime,version_id}',
                    to_jsonb($3::text),
                    true
                 ),
                 updated_at = NOW()
             WHERE installation.company_id = $1
               AND installation.app_id = $2
               AND installation.status = 'connected'
               AND jsonb_typeof(installation.metadata->'app_runtime') = 'object'
               AND jsonb_typeof(
                    installation.metadata->'app_runtime'->'consented_tools'
               ) = 'array'`,
            [version.company_id, version.app_id, version.id]
        );
    }

    async function transitionVersion({
        versionId,
        toStatus,
        actorId,
        appId = null,
        companyId = null,
        reason = null,
        traceId = null,
        idempotentStatus = null,
    }) {
        return withTransaction(async client => {
            const version = await lockVersion(client, { versionId, appId, companyId });
            if (idempotentStatus && version.status === idempotentStatus) return version;
            if (!ALLOWED_TRANSITIONS[version.status]?.includes(toStatus)) {
                throw conflict(version.status, toStatus);
            }
            const rejectionReason = toStatus === 'rejected' ? cleanReason(reason) : null;
            const updated = await updateStatus(
                client,
                version,
                toStatus,
                actorId,
                rejectionReason
            );
            if (toStatus === 'rejected') {
                await appendRejectionMessage(client, updated, rejectionReason);
            }
            if (toStatus === 'published') {
                await activatePublishedVersion(client, updated);
            }
            await insertTransitionAudit(client, updated, {
                actorId,
                fromStatus: version.status,
                toStatus,
                reason: rejectionReason,
                traceId,
            });
            return updated;
        });
    }

    async function forkRejectedVersion({
        versionId,
        actorId,
        appId,
        companyId,
        traceId = null,
    }) {
        return withTransaction(async client => {
            const source = await lockVersion(client, { versionId, appId, companyId });
            if (source.status !== 'rejected') throw conflict(source.status, 'draft_fork');
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
            const fork = await client.query(
                `INSERT INTO app_versions
                    (app_id, version_number, source_code, source_sha256,
                     scanner_report, status, created_by)
                 SELECT owned.app_id, $3, $4, $5, $6::jsonb, 'draft', $7
                 FROM app_studio_apps owned
                 WHERE owned.company_id = $1
                   AND owned.app_id = $2
                 RETURNING *`,
                [
                    companyId,
                    appId,
                    versionNumber,
                    source.source_code,
                    source.source_sha256,
                    JSON.stringify(source.scanner_report || {}),
                    actorId,
                ]
            );
            if (!fork.rows[0]) throw notFound();
            await client.query(
                `INSERT INTO app_version_tools (version_id, tool_name)
                 SELECT $3, tool.tool_name
                 FROM app_version_tools tool
                 JOIN app_versions version ON version.id = tool.version_id
                 JOIN app_studio_apps owned
                   ON owned.app_id = version.app_id
                  AND owned.company_id = $1
                 WHERE tool.version_id = $2
                   AND version.app_id = owned.app_id`,
                [companyId, versionId, fork.rows[0].id]
            );
            const { rows: auditRows } = await client.query(
                `INSERT INTO audit_log
                    (actor_id, action, target_type, target_id, company_id, details, trace_id)
                 VALUES ($1, 'app_version.fork', 'app_version', $2, $3,
                         $4::jsonb, $5)
                 RETURNING id`,
                [
                    actorId,
                    String(fork.rows[0].id),
                    companyId,
                    JSON.stringify({
                        app_id: String(appId),
                        source_version_id: String(versionId),
                        version_id: String(fork.rows[0].id),
                    }),
                    traceId,
                ]
            );
            if (auditRows.length !== 1) throw new Error('App version fork audit insert failed');
            return fork.rows[0];
        });
    }

    return {
        transitionVersion,
        submitVersion: input => transitionVersion({ ...input, toStatus: 'submitted' }),
        startReview: input => transitionVersion({
            ...input,
            toStatus: 'in_review',
            idempotentStatus: 'in_review',
        }),
        approveVersion: input => transitionVersion({ ...input, toStatus: 'approved' }),
        rejectVersion: input => transitionVersion({ ...input, toStatus: 'rejected' }),
        publishVersion: input => transitionVersion({ ...input, toStatus: 'published' }),
        revokeVersion: input => transitionVersion({ ...input, toStatus: 'revoked' }),
        forkRejectedVersion,
    };
}

const service = createAppVersionTransitionService();

module.exports = {
    ...service,
    ALLOWED_TRANSITIONS,
    AppVersionTransitionError,
    cleanReason,
    createAppVersionTransitionService,
};
