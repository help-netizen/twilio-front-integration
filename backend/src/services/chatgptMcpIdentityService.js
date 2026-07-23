'use strict';

const db = require('../db/connection');
const {
    APP_KEY,
    BUNDLE_VERSION,
    S1_GRANTS,
    WRITE_BUNDLE_VERSION,
    S2_WRITE_GRANTS,
} = require('./chatgptMcpPermissions');

class ChatgptMcpIdentityError extends Error {
    constructor(code, message, httpStatus = 403) {
        super(message);
        this.name = 'ChatgptMcpIdentityError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function requireValue(value, name) {
    if (!value) throw new ChatgptMcpIdentityError('MCP_CONTEXT_NOT_CONFIGURED', `${name} is required`, 503);
    return value;
}

function configuredIssuer() {
    return requireValue(process.env.KEYCLOAK_REALM_URL, 'KEYCLOAK_REALM_URL').replace(/\/$/, '');
}

function configuredClientId() {
    return requireValue(String(process.env.CHATGPT_MCP_CLIENT_ID || '').trim(), 'CHATGPT_MCP_CLIENT_ID');
}

async function requireTenantAdmin(companyId, actorId, client = null) {
    requireValue(companyId, 'companyId');
    requireValue(actorId, 'actorId');
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT u.id, u.keycloak_sub, u.email, u.full_name
         FROM crm_users u
         JOIN company_memberships cm
           ON cm.user_id = u.id
          AND cm.company_id = $1
          AND cm.status = 'active'
          AND cm.role_key = 'tenant_admin'
         JOIN companies c
           ON c.id = cm.company_id
          AND c.id = $1
          AND c.status = 'active'
         WHERE u.id = $2
           AND u.status = 'active'
           AND u.onboarding_status = 'active'
           AND COALESCE(u.kind, 'user') = 'user'`,
        [companyId, actorId]
    );
    if (rows.length !== 1 || !rows[0].keycloak_sub) {
        throw new ChatgptMcpIdentityError(
            'TENANT_ADMIN_REQUIRED',
            'Only an active tenant administrator can configure this connector.',
            403
        );
    }
    return rows[0];
}

async function provisionInstallation({ companyId, installationId, actorId }, client) {
    const query = queryFor(client);
    const human = await requireTenantAdmin(companyId, actorId, client);
    const issuer = configuredIssuer();
    const clientId = configuredClientId();
    const syntheticSub = `agent:${APP_KEY}:${companyId}`;
    const { rows: aiRows } = await query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, company_id, status,
             platform_role, onboarding_status, kind, updated_at)
         VALUES ($1, $2, 'ChatGPT AI Dispatcher', 'company_member', $3, 'active',
                 'none', 'active', 'agent', NOW())
         ON CONFLICT (keycloak_sub) DO UPDATE
         SET email = EXCLUDED.email,
             full_name = EXCLUDED.full_name,
             status = 'active',
             onboarding_status = 'active',
             updated_at = NOW()
         WHERE crm_users.company_id = EXCLUDED.company_id
           AND crm_users.kind = 'agent'
         RETURNING *`,
        [syntheticSub, `chatgpt-agent+${companyId}@albusto.invalid`, companyId]
    );
    if (aiRows.length !== 1) {
        throw new ChatgptMcpIdentityError('AI_IDENTITY_CONFLICT', 'AI identity provisioning failed.', 409);
    }
    const aiUser = aiRows[0];

    await query(
        `UPDATE chatgpt_mcp_bindings
         SET status = 'revoked', revoked_at = NOW(), revoked_by_user_id = $3, updated_at = NOW()
         WHERE company_id = $1 AND installation_id <> $2 AND status = 'active'`,
        [companyId, installationId, actorId]
    );

    const { rows: bindingRows } = await query(
        `INSERT INTO chatgpt_mcp_bindings
            (company_id, installation_id, authorized_by_user_id,
             oauth_issuer, oauth_subject, oauth_client_id, ai_user_id,
             status, grant_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
         ON CONFLICT (company_id) WHERE status = 'active' DO UPDATE
         SET installation_id = EXCLUDED.installation_id,
             authorized_by_user_id = EXCLUDED.authorized_by_user_id,
             oauth_issuer = EXCLUDED.oauth_issuer,
             oauth_subject = EXCLUDED.oauth_subject,
             oauth_client_id = EXCLUDED.oauth_client_id,
             ai_user_id = EXCLUDED.ai_user_id,
             grant_version = EXCLUDED.grant_version,
             updated_at = NOW(),
             revoked_at = NULL,
             revoked_by_user_id = NULL
         RETURNING *`,
        [companyId, installationId, actorId, issuer, human.keycloak_sub, clientId, aiUser.id, BUNDLE_VERSION]
    );

    await query(
        `DELETE FROM mcp_agent_permission_grants
         WHERE company_id = $1 AND agent_user_id = $2`,
        [companyId, aiUser.id]
    );
    for (const permission of S1_GRANTS) {
        await query(
            `INSERT INTO mcp_agent_permission_grants
                (company_id, agent_user_id, permission_key, bundle_version)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (company_id, agent_user_id, permission_key) DO UPDATE
             SET bundle_version = EXCLUDED.bundle_version, updated_at = NOW()`,
            [companyId, aiUser.id, permission, BUNDLE_VERSION]
        );
    }
    return { binding: bindingRows[0], aiUser };
}

async function revokeInstallation({ companyId, installationId, actorId }, client) {
    const query = queryFor(client);
    await requireTenantAdmin(companyId, actorId, client);
    const { rows } = await query(
        `UPDATE chatgpt_mcp_bindings b
         SET status = 'revoked', revoked_at = NOW(), revoked_by_user_id = $3, updated_at = NOW()
         WHERE b.company_id = $1
           AND b.installation_id = $2
           AND b.status = 'active'
         RETURNING b.ai_user_id`,
        [companyId, installationId, actorId]
    );
    for (const row of rows) {
        await query(
            `DELETE FROM mcp_agent_permission_grants
             WHERE company_id = $1 AND agent_user_id = $2`,
            [companyId, row.ai_user_id]
        );
        await query(
            `UPDATE crm_users
             SET status = 'disabled', onboarding_status = 'disabled', updated_at = NOW()
             WHERE id = $1 AND company_id = $2 AND kind = 'agent'`,
            [row.ai_user_id, companyId]
        );
    }
    return rows.length;
}

async function resolveOAuthContext({ issuer, subject, clientId }) {
    requireValue(issuer, 'issuer');
    requireValue(subject, 'subject');
    requireValue(clientId, 'clientId');
    const { rows } = await db.query(
        `SELECT b.id AS binding_id,
                b.company_id,
                b.installation_id,
                b.authorized_by_user_id,
                b.ai_user_id,
                c.name AS company_name,
                COALESCE(c.timezone, 'America/New_York') AS company_timezone,
                ai.email AS ai_email,
                ai.full_name AS ai_full_name,
                human.email AS authorizer_email,
                ARRAY(
                    SELECT g.permission_key
                    FROM mcp_agent_permission_grants g
                    WHERE g.company_id = b.company_id
                      AND g.agent_user_id = b.ai_user_id
                    ORDER BY g.permission_key
                ) AS permissions
         FROM chatgpt_mcp_bindings b
         JOIN marketplace_installations mi
           ON mi.id = b.installation_id
          AND mi.company_id = b.company_id
          AND mi.status = 'connected'
         JOIN marketplace_apps ma
           ON ma.id = mi.app_id
          AND ma.app_key = $4
          AND ma.status = 'published'
         JOIN companies c
           ON c.id = b.company_id
          AND c.status = 'active'
         JOIN crm_users ai
           ON ai.id = b.ai_user_id
          AND ai.company_id = b.company_id
          AND ai.kind = 'agent'
          AND ai.status = 'active'
          AND ai.onboarding_status = 'active'
         JOIN crm_users human
           ON human.id = b.authorized_by_user_id
          AND human.keycloak_sub = b.oauth_subject
          AND human.status = 'active'
          AND human.onboarding_status = 'active'
          AND COALESCE(human.kind, 'user') = 'user'
         JOIN company_memberships cm
           ON cm.user_id = human.id
          AND cm.company_id = b.company_id
          AND cm.status = 'active'
          AND cm.role_key = 'tenant_admin'
         WHERE b.oauth_issuer = $1
           AND b.oauth_subject = $2
           AND b.oauth_client_id = $3
           AND b.status = 'active'`,
        [issuer, subject, clientId, APP_KEY]
    );
    if (rows.length !== 1) {
        throw new ChatgptMcpIdentityError('MCP_BINDING_INVALID', 'Connector authorization is not active.', 403);
    }
    return rows[0];
}

async function resolveFixedBearerContext({ companyId, agentUserId }) {
    requireValue(companyId, 'companyId');
    requireValue(agentUserId, 'agentUserId');
    const { rows } = await db.query(
        `SELECT b.id AS binding_id,
                b.company_id,
                b.installation_id,
                b.authorized_by_user_id,
                b.ai_user_id,
                c.name AS company_name,
                COALESCE(c.timezone, 'America/New_York') AS company_timezone,
                ai.email AS ai_email,
                ai.full_name AS ai_full_name,
                ARRAY(
                    SELECT g.permission_key
                    FROM mcp_agent_permission_grants g
                    WHERE g.company_id = b.company_id
                      AND g.agent_user_id = b.ai_user_id
                    ORDER BY g.permission_key
                ) AS permissions
         FROM chatgpt_mcp_bindings b
         JOIN marketplace_installations mi
           ON mi.id = b.installation_id
          AND mi.company_id = b.company_id
          AND mi.status = 'connected'
         JOIN marketplace_apps ma
           ON ma.id = mi.app_id AND ma.app_key = $3 AND ma.status = 'published'
         JOIN companies c ON c.id = b.company_id AND c.status = 'active'
         JOIN crm_users ai
           ON ai.id = b.ai_user_id
          AND ai.company_id = b.company_id
          AND ai.kind = 'agent'
          AND ai.status = 'active'
          AND ai.onboarding_status = 'active'
         JOIN crm_users human
           ON human.id = b.authorized_by_user_id
          AND human.company_id = b.company_id
          AND human.keycloak_sub = b.oauth_subject
          AND human.status = 'active'
          AND human.onboarding_status = 'active'
          AND COALESCE(human.kind, 'user') = 'user'
         JOIN company_memberships cm
           ON cm.user_id = human.id
          AND cm.company_id = b.company_id
          AND cm.status = 'active'
          AND cm.role_key = 'tenant_admin'
         WHERE b.company_id = $1
           AND b.ai_user_id = $2
           AND b.status = 'active'`,
        [companyId, agentUserId, APP_KEY]
    );
    if (rows.length !== 1) {
        throw new ChatgptMcpIdentityError('MCP_BINDING_INVALID', 'Fixed-bearer AI context is not active.', 403);
    }
    return rows[0];
}

/**
 * Re-authorize a dispatcher write immediately before its first side effect.
 * The caller must pass the SAME transaction client that the write handler uses.
 * FOR SHARE prevents disconnect/revoke/demotion updates from committing until
 * this transaction completes; a revocation committed before the lock is
 * acquired makes the chain disappear and fails closed.
 */
async function requireLiveBinding({
    bindingId,
    companyId,
    agentUserId,
    authorizerId,
}, client) {
    requireValue(bindingId, 'bindingId');
    requireValue(companyId, 'companyId');
    requireValue(agentUserId, 'agentUserId');
    requireValue(authorizerId, 'authorizerId');
    if (!client?.query) {
        throw new ChatgptMcpIdentityError(
            'MCP_TRANSACTION_REQUIRED',
            'A write transaction is required.',
            500
        );
    }

    const { rows } = await client.query(
        `SELECT b.id,
                ARRAY(
                    SELECT g.permission_key
                    FROM mcp_agent_permission_grants g
                    WHERE g.company_id = b.company_id
                      AND g.agent_user_id = b.ai_user_id
                    ORDER BY g.permission_key
                ) AS permissions
         FROM chatgpt_mcp_bindings b
         JOIN marketplace_installations mi
           ON mi.id = b.installation_id
          AND mi.company_id = b.company_id
          AND mi.status = 'connected'
         JOIN marketplace_apps ma
           ON ma.id = mi.app_id
          AND ma.app_key = $5
          AND ma.status = 'published'
         JOIN companies c
           ON c.id = b.company_id
          AND c.id = $2
          AND c.status = 'active'
         JOIN crm_users ai
           ON ai.id = b.ai_user_id
          AND ai.id = $3
          AND ai.company_id = b.company_id
          AND ai.kind = 'agent'
          AND ai.status = 'active'
          AND ai.onboarding_status = 'active'
         JOIN crm_users human
           ON human.id = b.authorized_by_user_id
          AND human.id = $4
          AND human.company_id = b.company_id
          AND human.keycloak_sub = b.oauth_subject
          AND human.status = 'active'
          AND human.onboarding_status = 'active'
          AND COALESCE(human.kind, 'user') = 'user'
         JOIN company_memberships cm
           ON cm.user_id = human.id
          AND cm.company_id = b.company_id
          AND cm.status = 'active'
          AND cm.role_key = 'tenant_admin'
         WHERE b.id = $1
           AND b.company_id = $2
           AND b.ai_user_id = $3
           AND b.authorized_by_user_id = $4
           AND b.status = 'active'
         FOR SHARE OF b, mi, c, ai, human, cm`,
        [bindingId, companyId, agentUserId, authorizerId, APP_KEY]
    );
    if (rows.length !== 1) {
        throw new ChatgptMcpIdentityError(
            'MCP_BINDING_INVALID',
            'Connector authorization is not active.',
            403
        );
    }
    return rows[0];
}

async function setWriteConsent({ companyId, actorId, enabled }, client) {
    if (!client?.query) {
        throw new ChatgptMcpIdentityError(
            'MCP_TRANSACTION_REQUIRED',
            'A consent transaction is required.',
            500
        );
    }
    await requireTenantAdmin(companyId, actorId, client);
    const { rows } = await client.query(
        `SELECT b.id, b.ai_user_id, b.installation_id
         FROM chatgpt_mcp_bindings b
         JOIN marketplace_installations mi
           ON mi.id = b.installation_id
          AND mi.company_id = b.company_id
          AND mi.status = 'connected'
         JOIN marketplace_apps ma
           ON ma.id = mi.app_id
          AND ma.app_key = $2
          AND ma.status = 'published'
         JOIN crm_users ai
           ON ai.id = b.ai_user_id
          AND ai.company_id = b.company_id
          AND ai.kind = 'agent'
          AND ai.status = 'active'
          AND ai.onboarding_status = 'active'
         WHERE b.company_id = $1
           AND b.status = 'active'
         FOR UPDATE OF b`,
        [companyId, APP_KEY]
    );
    if (rows.length !== 1) {
        throw new ChatgptMcpIdentityError(
            'MCP_BINDING_INVALID',
            'Connector authorization is not active.',
            403
        );
    }
    const binding = rows[0];

    if (enabled) {
        for (const permission of S2_WRITE_GRANTS) {
            await client.query(
                `INSERT INTO mcp_agent_permission_grants
                    (company_id, agent_user_id, permission_key, bundle_version)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (company_id, agent_user_id, permission_key) DO UPDATE
                 SET bundle_version = EXCLUDED.bundle_version, updated_at = NOW()`,
                [companyId, binding.ai_user_id, permission, WRITE_BUNDLE_VERSION]
            );
        }
    } else {
        await client.query(
            `DELETE FROM mcp_agent_permission_grants
             WHERE company_id = $1
               AND agent_user_id = $2
               AND permission_key = ANY($3::text[])`,
            [companyId, binding.ai_user_id, S2_WRITE_GRANTS]
        );
    }
    const grantVersion = enabled ? WRITE_BUNDLE_VERSION : BUNDLE_VERSION;
    await client.query(
        `UPDATE chatgpt_mcp_bindings
         SET grant_version = $3, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND status = 'active'`,
        [binding.id, companyId, grantVersion]
    );
    return {
        enabled: Boolean(enabled),
        binding_id: binding.id,
        installation_id: binding.installation_id,
        agent_user_id: binding.ai_user_id,
        grant_version: grantVersion,
    };
}

async function recordInvocation(context, {
    toolName,
    requestId,
    status,
    confirmationClass = 'R',
    idempotencyKey = null,
    argumentHash = null,
    safeMetadata = {},
    stage = 'S1',
}) {
    if (!context?.bindingId || !context?.companyId || !context?.actorId || !context?.authorizerId) {
        throw new ChatgptMcpIdentityError('MCP_AUDIT_CONTEXT_REQUIRED', 'MCP audit context is incomplete.', 500);
    }
    await db.query(
        `INSERT INTO mcp_tool_invocations
            (company_id, binding_id, created_by, authorized_by_user_id,
             tool_name, stage, request_id, idempotency_key, argument_hash,
             confirmation_class, status, safe_metadata, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())`,
        [
            context.companyId,
            context.bindingId,
            context.actorId,
            context.authorizerId,
            toolName,
            stage,
            requestId || null,
            idempotencyKey,
            argumentHash,
            confirmationClass,
            status,
            JSON.stringify(safeMetadata || {}),
        ]
    );
}

module.exports = {
    APP_KEY,
    ChatgptMcpIdentityError,
    configuredIssuer,
    configuredClientId,
    requireTenantAdmin,
    provisionInstallation,
    revokeInstallation,
    resolveOAuthContext,
    resolveFixedBearerContext,
    requireLiveBinding,
    setWriteConsent,
    recordInvocation,
};
