/**
 * F017 Agent Presence
 *
 * Tenant-scoped automatic status registry for Softphone users.
 * Status is driven by Twilio Device lifecycle from the frontend and by active-call
 * transitions. Presence is stored in Postgres with a short TTL so routing stays
 * safe across tenants and across multiple app instances.
 */

const db = require('../db/connection');
const realtimeService = require('./realtimeService');

const VALID_STATUSES = new Set(['available', 'on_call', 'offline']);
const PRESENCE_TTL_SECONDS = Math.max(15, Number(process.env.AGENT_PRESENCE_TTL_SECONDS || 90));

function normalizeStatus(status) {
    return VALID_STATUSES.has(status) ? status : 'offline';
}

function normalizeGroupIds(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}

async function getGroupIdsForUser(userId, companyId) {
    if (!userId || !companyId) return [];
    const result = await db.query(
        `SELECT ugm.group_id
         FROM user_group_members ugm
         JOIN user_groups ug ON ug.id = ugm.group_id
         WHERE ugm.user_id = $1
           AND ug.company_id = $2
           AND COALESCE(ugm.is_active, true) = true
         ORDER BY ug.name`,
        [String(userId), companyId]
    );
    return result.rows.map(r => r.group_id);
}

async function getCurrentPresence(userId, companyId) {
    if (!userId || !companyId) return null;
    const result = await db.query(
        `SELECT user_id, company_id, status, group_ids, updated_at, expires_at
         FROM agent_presence
         WHERE company_id = $1
           AND user_id = $2
           AND expires_at > NOW()
         LIMIT 1`,
        [String(companyId), String(userId)]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
        userId: String(row.user_id),
        companyId: String(row.company_id),
        status: normalizeStatus(row.status),
        groupIds: normalizeGroupIds(row.group_ids),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    };
}

async function setAgentStatus(userId, companyId, status, details = {}) {
    if (!userId || !companyId) return null;

    const normalizedUserId = String(userId);
    const normalizedCompanyId = String(companyId);
    const normalized = normalizeStatus(status);
    const [groupIds, current] = await Promise.all([
        getGroupIdsForUser(normalizedUserId, normalizedCompanyId),
        getCurrentPresence(normalizedUserId, normalizedCompanyId),
    ]);
    const result = await db.query(
        `INSERT INTO agent_presence (
             company_id,
             user_id,
             status,
             group_ids,
             details,
             updated_at,
             expires_at
         )
         VALUES (
             $1,
             $2,
             $3,
             $4::jsonb,
             $5::jsonb,
             NOW(),
             CASE WHEN $3 = 'offline'
                  THEN NOW()
                  ELSE NOW() + ($6::int * INTERVAL '1 second')
             END
         )
         ON CONFLICT (company_id, user_id) DO UPDATE SET
             status = EXCLUDED.status,
             group_ids = EXCLUDED.group_ids,
             details = EXCLUDED.details,
             updated_at = NOW(),
             expires_at = EXCLUDED.expires_at
         RETURNING user_id, company_id, status, group_ids, details, updated_at, expires_at`,
        [
            normalizedCompanyId,
            normalizedUserId,
            normalized,
            JSON.stringify(groupIds),
            JSON.stringify(details || {}),
            PRESENCE_TTL_SECONDS,
        ]
    );
    const row = result.rows[0];
    const next = {
        userId: String(row?.user_id || normalizedUserId),
        companyId: String(row?.company_id || normalizedCompanyId),
        status: normalizeStatus(row?.status || normalized),
        groupIds: normalizeGroupIds(row?.group_ids || groupIds),
        updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
        expiresAt: row?.expires_at ? new Date(row.expires_at).toISOString() : null,
        details: row?.details || details,
    };

    if (!current || current.status !== next.status || JSON.stringify(current.groupIds) !== JSON.stringify(next.groupIds)) {
        realtimeService.broadcast('agent.status.changed', {
            userId: next.userId,
            companyId: next.companyId,
            groupIds: next.groupIds,
            status: next.status,
            updated_at: next.updatedAt,
        });
    }

    return next;
}

async function getAgentStatus(userId, companyId) {
    const current = await getCurrentPresence(userId, companyId);
    return current?.status || 'offline';
}

async function getPresenceSnapshot(userIds, companyId) {
    const ids = [...new Set((userIds || []).map(id => String(id)).filter(Boolean))];
    const snapshot = new Map(ids.map(id => [id, 'offline']));
    if (ids.length === 0 || !companyId) return snapshot;

    const result = await db.query(
        `SELECT user_id, status
         FROM agent_presence
         WHERE company_id = $1
           AND user_id = ANY($2::text[])
           AND expires_at > NOW()`,
        [String(companyId), ids]
    );
    for (const row of result.rows) {
        snapshot.set(String(row.user_id), normalizeStatus(row.status));
    }
    return snapshot;
}

module.exports = {
    setAgentStatus,
    getAgentStatus,
    getGroupIdsForUser,
    getPresenceSnapshot,
};
