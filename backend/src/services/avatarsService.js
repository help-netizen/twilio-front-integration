'use strict';

const db = require('../db/connection');
const avatarBases = require('../config/avatarBases');
const authorizationService = require('./authorizationService');
const chatgptMcpIdentityService = require('./chatgptMcpIdentityService');
const marketplaceService = require('./marketplaceService');
const { APP_KEY } = require('./chatgptMcpPermissions');

class AvatarsServiceError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'AvatarsServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function requireContext(companyId, actorId) {
    if (!companyId) {
        throw new AvatarsServiceError(
            'TENANT_CONTEXT_REQUIRED',
            'Company context is required.',
            403
        );
    }
    if (!actorId) {
        throw new AvatarsServiceError(
            'AVATAR_MEMBER_REQUIRED',
            'An active company member is required.',
            403
        );
    }
}

function translateError(err) {
    if (err instanceof AvatarsServiceError) return err;
    if (err instanceof chatgptMcpIdentityService.ChatgptMcpIdentityError
        || err instanceof marketplaceService.MarketplaceServiceError
        || err instanceof authorizationService.CompanyUserAuthzError) {
        return new AvatarsServiceError(
            err.code || 'AVATARS_REQUEST_FAILED',
            err.message,
            err.httpStatus || 400
        );
    }
    return err;
}

async function requireActiveMember(companyId, actorId, client) {
    try {
        return await authorizationService.resolveCompanyUserAuthz(
            companyId,
            actorId,
            { client }
        );
    } catch (err) {
        if (err instanceof authorizationService.CompanyUserAuthzError) {
            throw new AvatarsServiceError(
                'AVATAR_MEMBER_REQUIRED',
                'An active company member is required.',
                403
            );
        }
        throw err;
    }
}

async function withTransaction(work, { readOnly = false } = {}) {
    const client = await db.pool.connect();
    try {
        await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw translateError(err);
    } finally {
        client.release();
    }
}

async function getInstallation(companyId, client, { lock = false } = {}) {
    const { rows } = await client.query(
        `SELECT mi.id
         FROM marketplace_installations mi
         JOIN marketplace_apps ma
           ON ma.id = mi.app_id
          AND ma.app_key = $2
          AND ma.status = 'published'
         JOIN companies c
           ON c.id = mi.company_id
          AND c.id = $1
          AND c.status = 'active'
         WHERE mi.company_id = $1
           AND mi.status = 'connected'
         ORDER BY mi.updated_at DESC, mi.id
         LIMIT 1
         ${lock ? 'FOR SHARE OF mi' : ''}`,
        [companyId, APP_KEY]
    );
    return rows[0] || null;
}

async function listRoster(companyId, actorId, client) {
    const { rows } = await client.query(
        `WITH active_members AS (
             SELECT cm.user_id AS owner_user_id,
                    COALESCE(NULLIF(BTRIM(owner.full_name), ''), 'User') AS owner_name,
                    owner.keycloak_sub AS owner_keycloak_sub
             FROM company_memberships cm
             JOIN companies c
               ON c.id = cm.company_id
              AND c.id = $1
              AND c.status = 'active'
             JOIN crm_users owner
               ON owner.id = cm.user_id
              AND owner.status = 'active'
              AND owner.onboarding_status = 'active'
              AND COALESCE(owner.kind, 'user') = 'user'
             WHERE cm.company_id = $1
               AND cm.status = 'active'
         ),
         latest_binding AS (
             SELECT DISTINCT ON (b.owner_user_id)
                    b.id,
                    b.company_id,
                    b.installation_id,
                    b.ai_user_id,
                    b.owner_user_id,
                    b.authorized_by_user_id,
                    b.oauth_subject,
                    b.status,
                    b.base,
                    b.writes_enabled,
                    b.sends_enabled,
                    b.updated_at
             FROM chatgpt_mcp_bindings b
             JOIN active_members member
               ON member.owner_user_id = b.owner_user_id
             WHERE b.company_id = $1
             ORDER BY b.owner_user_id,
                      CASE WHEN b.status = 'active' THEN 0 ELSE 1 END,
                      b.updated_at DESC,
                      b.id DESC
         )
         SELECT binding.owner_user_id,
                member.owner_name,
                binding.base,
                (
                    binding.status = 'active'
                    AND binding.authorized_by_user_id = binding.owner_user_id
                    AND binding.oauth_subject = member.owner_keycloak_sub
                    AND installation.status = 'connected'
                    AND app.app_key = $2
                    AND app.status = 'published'
                    AND ai.status = 'active'
                    AND ai.onboarding_status = 'active'
                ) AS connected,
                binding.writes_enabled,
                binding.sends_enabled,
                activity.last_activity_at >= NOW() - INTERVAL '15 minutes' AS recently_active
         FROM latest_binding binding
         JOIN active_members member
           ON member.owner_user_id = binding.owner_user_id
         LEFT JOIN marketplace_installations installation
           ON installation.id = binding.installation_id
          AND installation.company_id = binding.company_id
          AND installation.company_id = $1
         LEFT JOIN marketplace_apps app
           ON app.id = installation.app_id
          AND app.app_key = $2
         LEFT JOIN crm_users ai
           ON ai.id = binding.ai_user_id
          AND ai.company_id = binding.company_id
          AND ai.company_id = $1
          AND ai.kind = 'agent'
         LEFT JOIN LATERAL (
             SELECT MAX(invocation.started_at) AS last_activity_at
             FROM mcp_tool_invocations invocation
             WHERE invocation.company_id = binding.company_id
               AND invocation.company_id = $1
               AND invocation.binding_id = binding.id
         ) activity ON TRUE
         ORDER BY member.owner_name, binding.owner_user_id`,
        [companyId, APP_KEY]
    );

    const roster = rows.map((row) => {
        const connected = row.connected === true;
        const recentlyActive = connected && row.recently_active === true;
        return {
            owner_user_id: row.owner_user_id,
            owner_name: row.owner_name,
            base: row.base,
            connection_status: connected ? 'connected' : 'disconnected',
            presence: recentlyActive ? 'active' : 'idle',
            is_me: row.owner_user_id === actorId,
        };
    });
    const ownRow = rows.find((row) => row.owner_user_id === actorId) || null;
    const ownConnected = ownRow?.connected === true;
    return {
        roster,
        me: ownRow ? {
            connected: ownConnected,
            base: ownRow.base,
            mode: 'mcp',
            writes_enabled: ownConnected && ownRow.writes_enabled === true,
            sends_enabled: ownConnected && ownRow.sends_enabled === true,
        } : null,
    };
}

async function getOverview(companyId, actorId) {
    requireContext(companyId, actorId);
    return withTransaction(async (client) => {
        await requireActiveMember(companyId, actorId, client);
        const installation = await getInstallation(companyId, client);
        const { me, roster } = await listRoster(companyId, actorId, client);
        return {
            installation_enabled: Boolean(installation),
            me,
            roster,
        };
    }, { readOnly: true });
}

async function connectSelf(companyId, actorId, base = 'chatgpt') {
    requireContext(companyId, actorId);
    if (!avatarBases.isSupportedBase(base)) {
        throw new AvatarsServiceError(
            'AVATAR_BASE_UNSUPPORTED',
            'Avatar base must be chatgpt or claude.',
            400
        );
    }
    return withTransaction(async (client) => {
        await requireActiveMember(companyId, actorId, client);
        const installation = await getInstallation(companyId, client, { lock: true });
        if (!installation) {
            throw new AvatarsServiceError(
                'AVATARS_NOT_ENABLED',
                'Avatars is not enabled for this company.',
                409
            );
        }
        const provisioned = await chatgptMcpIdentityService.provisionAvatar({
            companyId,
            installationId: installation.id,
            ownerUserId: actorId,
            actorId,
            base,
        }, client);
        return {
            connected: true,
            base: provisioned.binding.base,
            mode: 'mcp',
            writes_enabled: provisioned.binding.writes_enabled === true,
            sends_enabled: provisioned.binding.sends_enabled === true,
        };
    });
}

async function setWrites(companyId, actorId, enabled, { requestId = null } = {}) {
    requireContext(companyId, actorId);
    try {
        const result = await marketplaceService.setChatgptMcpWrites(
            companyId,
            actorId,
            enabled,
            { requestId }
        );
        return {
            writes_enabled: result.writes_enabled === true,
            sends_enabled: result.sends_enabled === true,
        };
    } catch (err) {
        throw translateError(err);
    }
}

async function setSends(companyId, actorId, enabled, { requestId = null } = {}) {
    requireContext(companyId, actorId);
    try {
        const result = await marketplaceService.setChatgptMcpSends(
            companyId,
            actorId,
            enabled,
            { requestId }
        );
        return {
            writes_enabled: result.writes_enabled === true,
            sends_enabled: result.sends_enabled === true,
        };
    } catch (err) {
        throw translateError(err);
    }
}

async function disconnectSelf(companyId, actorId) {
    requireContext(companyId, actorId);
    return withTransaction(async (client) => {
        await chatgptMcpIdentityService.revokeAvatar({
            companyId,
            ownerUserId: actorId,
            actorId,
        }, client);
        return { connected: false };
    });
}

module.exports = {
    AvatarsServiceError,
    getOverview,
    connectSelf,
    setWrites,
    setSends,
    disconnectSelf,
};
