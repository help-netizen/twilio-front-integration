'use strict';

const { appRuntimeError } = require('./appRuntimeErrors');

function requireTransaction(client) {
    if (!client?.query) {
        throw appRuntimeError(
            'APP_RUNTIME_TRANSACTION_REQUIRED',
            'App runtime principal changes require a transaction.',
            500
        );
    }
}

function requireInstallationId(installationId) {
    const value = String(installationId || '');
    if (!/^[1-9]\d*$/.test(value)) {
        throw appRuntimeError('INVALID_REQUEST', 'Installation id is invalid.', 400);
    }
    return value;
}

function principalSub(installationId) {
    return `agent:app-runtime:${installationId}`;
}

function principalEmail(installationId) {
    return `app-runtime+${installationId}@albusto.invalid`;
}

async function requireActiveInstallation(installationId, client) {
    const { rows } = await client.query(
        `SELECT mi.id AS installation_id,
                mi.company_id,
                mi.app_id,
                mi.installed_by,
                mi.metadata AS installation_metadata,
                ma.name AS app_name,
                human.full_name AS delegator_name
         FROM marketplace_installations mi
         JOIN marketplace_apps ma
           ON ma.id = mi.app_id
          AND ma.status = 'published'
         JOIN companies company
           ON company.id = mi.company_id
          AND company.status = 'active'
         JOIN crm_users human
           ON human.id = mi.installed_by
          AND human.company_id = mi.company_id
          AND human.status = 'active'
          AND human.onboarding_status = 'active'
          AND COALESCE(human.kind, 'user') = 'user'
         JOIN company_memberships membership
           ON membership.user_id = human.id
          AND membership.company_id = mi.company_id
          AND membership.status = 'active'
         WHERE mi.id = $1
           AND mi.status = 'connected'
         FOR UPDATE OF mi, ma, company, human, membership`,
        [installationId]
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

async function activatePrincipalUser(installation, currentAgentId, client) {
    const syntheticSub = principalSub(installation.installation_id);
    const target = await client.query(
        `SELECT id, company_id, kind
         FROM crm_users
         WHERE keycloak_sub = $1
         FOR UPDATE`,
        [syntheticSub]
    );
    if (target.rows.length > 1
        || (target.rows.length === 1 && (
            target.rows[0].company_id !== installation.company_id
            || target.rows[0].kind !== 'agent'
            || (currentAgentId && target.rows[0].id !== currentAgentId)
        ))) {
        throw appRuntimeError(
            'APP_RUNTIME_IDENTITY_CONFLICT',
            'App runtime identity provisioning failed.',
            409
        );
    }

    const agentId = target.rows[0]?.id || currentAgentId || null;
    let agentRows;
    try {
        if (agentId) {
            ({ rows: agentRows } = await client.query(
                `UPDATE crm_users
                 SET keycloak_sub = $3,
                     email = $4,
                     full_name = $5,
                     status = 'active',
                     onboarding_status = 'active',
                     updated_at = NOW()
                 WHERE id = $1
                   AND company_id = $2
                   AND kind = 'agent'
                 RETURNING *`,
                [
                    agentId,
                    installation.company_id,
                    syntheticSub,
                    principalEmail(installation.installation_id),
                    `App Runtime: ${installation.app_name}`,
                ]
            ));
        } else {
            ({ rows: agentRows } = await client.query(
                `INSERT INTO crm_users
                    (keycloak_sub, email, full_name, role, company_id, status,
                     platform_role, onboarding_status, kind, updated_at)
                 VALUES ($1, $2, $3, 'company_member', $4, 'active',
                         'none', 'active', 'agent', NOW())
                 RETURNING *`,
                [
                    syntheticSub,
                    principalEmail(installation.installation_id),
                    `App Runtime: ${installation.app_name}`,
                    installation.company_id,
                ]
            ));
        }
    } catch (error) {
        if (error?.code === '23505') {
            throw appRuntimeError(
                'APP_RUNTIME_IDENTITY_CONFLICT',
                'App runtime identity provisioning failed.',
                409
            );
        }
        throw error;
    }
    if (agentRows.length !== 1) {
        throw appRuntimeError(
            'APP_RUNTIME_IDENTITY_CONFLICT',
            'App runtime identity provisioning failed.',
            409
        );
    }
    return agentRows[0];
}

async function provisionInstallationPrincipal({ installationId }, client) {
    requireTransaction(client);
    const normalizedInstallationId = requireInstallationId(installationId);
    const installation = await requireActiveInstallation(normalizedInstallationId, client);
    const existing = await client.query(
        `SELECT principal.*, agent.kind AS agent_kind
         FROM app_installation_principals principal
         JOIN crm_users agent
           ON agent.id = principal.agent_user_id
          AND agent.company_id = principal.company_id
         WHERE principal.installation_id = $1
           AND principal.company_id = $2
           AND principal.app_id = $3
         FOR UPDATE OF principal, agent`,
        [installation.installation_id, installation.company_id, installation.app_id]
    );
    if (existing.rows.length > 1 || existing.rows[0]?.agent_kind !== undefined
        && existing.rows[0].agent_kind !== 'agent') {
        throw appRuntimeError(
            'APP_RUNTIME_IDENTITY_CONFLICT',
            'App runtime identity provisioning failed.',
            409
        );
    }

    const agent = await activatePrincipalUser(
        installation,
        existing.rows[0]?.agent_user_id || null,
        client
    );
    let principalRows;
    try {
        ({ rows: principalRows } = await client.query(
            `INSERT INTO app_installation_principals
                (company_id, app_id, installation_id, agent_user_id,
                 delegated_by_user_id, status, revoked_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'active', NULL, NOW())
             ON CONFLICT (installation_id) DO UPDATE
             SET agent_user_id = EXCLUDED.agent_user_id,
                 delegated_by_user_id = EXCLUDED.delegated_by_user_id,
                 status = 'active',
                 revoked_at = NULL,
                 updated_at = NOW()
             WHERE app_installation_principals.company_id = EXCLUDED.company_id
               AND app_installation_principals.app_id = EXCLUDED.app_id
             RETURNING *`,
            [
                installation.company_id,
                installation.app_id,
                installation.installation_id,
                agent.id,
                installation.installed_by,
            ]
        ));
    } catch (error) {
        if (error?.code === '23505' || error?.code === '23503') {
            throw appRuntimeError(
                'APP_RUNTIME_IDENTITY_CONFLICT',
                'App runtime identity provisioning failed.',
                409
            );
        }
        throw error;
    }
    if (principalRows.length !== 1) {
        throw appRuntimeError(
            'APP_RUNTIME_IDENTITY_CONFLICT',
            'App runtime identity provisioning failed.',
            409
        );
    }

    return {
        installation,
        principal: principalRows[0],
        agent,
    };
}

async function revokeInstallationPrincipal({ companyId, installationId }, client) {
    requireTransaction(client);
    if (!companyId) {
        throw appRuntimeError('TENANT_CONTEXT_REQUIRED', 'Company context is required.', 403);
    }
    const normalizedInstallationId = requireInstallationId(installationId);
    const { rows } = await client.query(
        `UPDATE app_installation_principals
         SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
         WHERE company_id = $1
           AND installation_id = $2
           AND status = 'active'
         RETURNING agent_user_id`,
        [companyId, normalizedInstallationId]
    );
    await client.query(
        `UPDATE app_runs
         SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
         WHERE company_id = $1
           AND installation_id = $2
           AND status <> 'revoked'`,
        [companyId, normalizedInstallationId]
    );
    for (const row of rows) {
        await client.query(
            `UPDATE crm_users agent
             SET status = 'disabled', onboarding_status = 'disabled', updated_at = NOW()
             WHERE agent.id = $1
               AND agent.company_id = $2
               AND agent.kind = 'agent'
               AND NOT EXISTS (
                   SELECT 1
                   FROM app_installation_principals active_principal
                   WHERE active_principal.company_id = $2
                     AND active_principal.agent_user_id = agent.id
                     AND active_principal.status = 'active'
               )`,
            [row.agent_user_id, companyId]
        );
    }
    return rows.length;
}

module.exports = {
    principalSub,
    principalEmail,
    provisionInstallationPrincipal,
    revokeInstallationPrincipal,
};
