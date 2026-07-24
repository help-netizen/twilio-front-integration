'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const authorizationService = require('../backend/src/services/authorizationService');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const permissions = require('../backend/src/services/chatgptMcpPermissions');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const AVATARS = fs.readFileSync(
    path.join(MIGRATIONS, '200_avatars_per_user_identity.sql'),
    'utf8'
);
const AVATARS_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_200_avatars_per_user_identity.sql'),
    'utf8'
);

jest.setTimeout(90000);

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            connectionTimeoutMillis: 2000,
        });
        (async () => {
            try { await client.connect(); await client.query('SELECT 1'); await client.end(); process.exit(0); }
            catch (error) { process.stderr.write(String(error.message || error)); try { await client.end(); } catch {} process.exit(2); }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return {
        ready: result.status === 0,
        reason: String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim(),
    };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('AVATARS Phase A DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`AVATARS Phase A DB tests are pending: ${DATABASE.reason}`);
    });
}

function minimalPreAvatarSchema(schemaName) {
    return `
        CREATE SCHEMA "${schemaName}";
        SET LOCAL search_path TO "${schemaName}", public;

        CREATE TABLE companies (
            id UUID PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE crm_users (
            id UUID PRIMARY KEY,
            keycloak_sub TEXT UNIQUE NOT NULL,
            email TEXT,
            full_name TEXT,
            kind TEXT NOT NULL DEFAULT 'user',
            company_id UUID,
            status TEXT NOT NULL DEFAULT 'active',
            onboarding_status TEXT NOT NULL DEFAULT 'active',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE company_memberships (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES crm_users(id),
            company_id UUID NOT NULL REFERENCES companies(id),
            status TEXT NOT NULL DEFAULT 'active',
            UNIQUE (user_id, company_id)
        );
        CREATE TABLE marketplace_apps (
            app_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE chatgpt_mcp_bindings (
            id UUID PRIMARY KEY,
            company_id UUID NOT NULL REFERENCES companies(id),
            installation_id BIGINT NOT NULL,
            authorized_by_user_id UUID NOT NULL REFERENCES crm_users(id),
            oauth_issuer TEXT NOT NULL,
            oauth_subject TEXT NOT NULL,
            oauth_client_id TEXT NOT NULL,
            ai_user_id UUID NOT NULL REFERENCES crm_users(id),
            status TEXT NOT NULL DEFAULT 'active',
            grant_version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ,
            revoked_by_user_id UUID
        );
        CREATE UNIQUE INDEX uq_chatgpt_mcp_binding_active_company
            ON chatgpt_mcp_bindings(company_id) WHERE status='active';
        CREATE UNIQUE INDEX uq_chatgpt_mcp_binding_active_principal
            ON chatgpt_mcp_bindings(oauth_issuer, oauth_subject, oauth_client_id)
            WHERE status='active';
        CREATE TABLE mcp_agent_permission_grants (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            agent_user_id UUID NOT NULL,
            permission_key TEXT NOT NULL,
            bundle_version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (company_id, agent_user_id, permission_key)
        );
        CREATE TABLE mcp_tool_invocations (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            binding_id UUID NOT NULL,
            created_by UUID NOT NULL
        );
        CREATE TABLE mcp_tool_idempotency (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            agent_user_id UUID NOT NULL,
            tool_name TEXT NOT NULL,
            idempotency_key TEXT NOT NULL
        );
    `;
}

describe('AVATARS-001 Phase A migration and per-owner identity', () => {
    databaseTest('migration 200 backfills the existing binding in place, is idempotent, and rollback refuses multiple avatars', async () => {
        const client = await db.pool.connect();
        const schemaName = `avatars_m200_${randomUUID().replaceAll('-', '')}`;
        const companyId = randomUUID();
        const ownerId = randomUUID();
        const aiUserId = randomUUID();
        const bindingId = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(minimalPreAvatarSchema(schemaName));
            await client.query(
                'INSERT INTO companies (id) VALUES ($1)',
                [companyId]
            );
            await client.query(
                `INSERT INTO crm_users
                    (id, keycloak_sub, email, full_name, kind, company_id)
                 VALUES
                    ($2, $3, 'owner@example.test', 'ABC Owner', 'user', $1),
                    ($4, $5, 'agent@example.test', 'ChatGPT AI Dispatcher', 'agent', $1)`,
                [
                    companyId,
                    ownerId,
                    `owner-sub-${ownerId}`,
                    aiUserId,
                    `agent:chatgpt-crm-mcp:${companyId}`,
                ]
            );
            await client.query(
                `INSERT INTO company_memberships (user_id, company_id)
                 VALUES ($1, $2)`,
                [ownerId, companyId]
            );
            await client.query(
                `INSERT INTO marketplace_apps (app_key, name, metadata)
                 VALUES ('chatgpt-crm-mcp', 'ChatGPT CRM Connector', '{"assistant":{}}')`
            );
            await client.query(
                `INSERT INTO chatgpt_mcp_bindings
                    (id, company_id, installation_id, authorized_by_user_id,
                     oauth_issuer, oauth_subject, oauth_client_id, ai_user_id)
                 VALUES ($1, $2, 195, $3, 'https://issuer.test', $4,
                         'chatgpt-crm-mcp', $5)`,
                [bindingId, companyId, ownerId, `owner-sub-${ownerId}`, aiUserId]
            );
            await client.query(
                `INSERT INTO mcp_agent_permission_grants
                    (company_id, agent_user_id, permission_key, bundle_version)
                 VALUES
                    ($1, $2, 'mcp.tool.svc.create_lead', 3),
                    ($1, $2, 'mcp.tool.svc.send_estimate', 4)`,
                [companyId, aiUserId]
            );
            await client.query(
                `INSERT INTO mcp_tool_invocations
                    (company_id, binding_id, created_by)
                 VALUES ($1, $2, $3)`,
                [companyId, bindingId, aiUserId]
            );
            await client.query(
                `INSERT INTO mcp_tool_idempotency
                    (company_id, agent_user_id, tool_name, idempotency_key)
                 VALUES ($1, $2, 'svc.create_lead', 'existing-replay')`,
                [companyId, aiUserId]
            );

            await client.query(AVATARS);
            await client.query(AVATARS);

            const binding = await client.query(
                `SELECT id, ai_user_id, owner_user_id, writes_enabled, sends_enabled
                 FROM chatgpt_mcp_bindings
                 WHERE id=$1`,
                [bindingId]
            );
            expect(binding.rows).toEqual([{
                id: bindingId,
                ai_user_id: aiUserId,
                owner_user_id: ownerId,
                writes_enabled: true,
                sends_enabled: true,
            }]);
            const ai = await client.query(
                `SELECT id, keycloak_sub, full_name
                 FROM crm_users
                 WHERE id=$1`,
                [aiUserId]
            );
            expect(ai.rows).toEqual([{
                id: aiUserId,
                keycloak_sub: `agent:chatgpt-crm-mcp:${companyId}:${ownerId}`,
                full_name: 'Avatar of ABC Owner',
            }]);
            const preserved = await client.query(
                `SELECT
                    (SELECT COUNT(*)::int FROM mcp_tool_invocations
                     WHERE binding_id=$1 AND created_by=$2) AS audits,
                    (SELECT COUNT(*)::int FROM mcp_tool_idempotency
                     WHERE company_id=$3 AND agent_user_id=$2
                       AND idempotency_key='existing-replay') AS replays`,
                [bindingId, aiUserId, companyId]
            );
            expect(preserved.rows[0]).toEqual({ audits: 1, replays: 1 });
            await client.query('SAVEPOINT avatars_duplicate_owner');
            await expect(client.query(
                `INSERT INTO chatgpt_mcp_bindings
                    (id, company_id, installation_id, authorized_by_user_id,
                     owner_user_id, oauth_issuer, oauth_subject, oauth_client_id,
                     ai_user_id)
                 VALUES ($1,$2,196,$3,$3,'https://issuer.test','other-sub',
                         'chatgpt-crm-mcp',$4)`,
                [randomUUID(), companyId, ownerId, aiUserId]
            )).rejects.toMatchObject({
                code: '23505',
                constraint: 'uq_chatgpt_mcp_binding_active_owner',
            });
            await client.query('ROLLBACK TO SAVEPOINT avatars_duplicate_owner');

            await client.query(AVATARS_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT ai.keycloak_sub, ai.full_name, ma.name,
                        EXISTS (
                            SELECT 1
                            FROM information_schema.columns
                            WHERE table_schema=$2
                              AND table_name='chatgpt_mcp_bindings'
                              AND column_name='owner_user_id'
                        ) AS has_owner_column
                 FROM chatgpt_mcp_bindings b
                 JOIN crm_users ai ON ai.id=b.ai_user_id
                 JOIN marketplace_apps ma ON ma.app_key='chatgpt-crm-mcp'
                 WHERE b.id=$1`,
                [bindingId, schemaName]
            );
            expect(rolledBack.rows[0]).toEqual({
                keycloak_sub: `agent:chatgpt-crm-mcp:${companyId}`,
                full_name: 'ChatGPT AI Dispatcher',
                name: 'ChatGPT CRM Connector',
                has_owner_column: false,
            });
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    databaseTest('rollback 200 aborts rather than choosing among multiple active avatars', async () => {
        const client = await db.pool.connect();
        const schemaName = `avatars_rb200_${randomUUID().replaceAll('-', '')}`;
        const companyId = randomUUID();
        const ownerA = randomUUID();
        const ownerB = randomUUID();
        const agentA = randomUUID();
        const agentB = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(minimalPreAvatarSchema(schemaName));
            await client.query(
                'INSERT INTO companies (id) VALUES ($1)',
                [companyId]
            );
            await client.query(
                `INSERT INTO crm_users (id,keycloak_sub,full_name,kind,company_id)
                 VALUES
                    ($2,$3,'Owner A','user',$1),
                    ($4,$5,'Owner B','user',$1),
                    ($6,$7,'Legacy Agent','agent',$1),
                    ($8,$9,'Second Agent','agent',$1)`,
                [
                    companyId,
                    ownerA,
                    `owner-a-${ownerA}`,
                    ownerB,
                    `owner-b-${ownerB}`,
                    agentA,
                    `agent:chatgpt-crm-mcp:${companyId}`,
                    agentB,
                    `unused-agent-${agentB}`,
                ]
            );
            await client.query(
                `INSERT INTO company_memberships (user_id,company_id)
                 VALUES ($1,$3),($2,$3)`,
                [ownerA, ownerB, companyId]
            );
            await client.query(
                `INSERT INTO marketplace_apps (app_key,name)
                 VALUES ('chatgpt-crm-mcp','ChatGPT CRM Connector')`
            );
            await client.query(
                `INSERT INTO chatgpt_mcp_bindings
                    (id,company_id,installation_id,authorized_by_user_id,
                     oauth_issuer,oauth_subject,oauth_client_id,ai_user_id)
                 VALUES ($1,$2,195,$3,'https://issuer.test',$4,
                         'chatgpt-crm-mcp',$5)`,
                [randomUUID(), companyId, ownerA, `owner-a-${ownerA}`, agentA]
            );
            await client.query(AVATARS);
            await client.query(
                `INSERT INTO chatgpt_mcp_bindings
                    (id,company_id,installation_id,authorized_by_user_id,
                     owner_user_id,oauth_issuer,oauth_subject,oauth_client_id,
                     ai_user_id)
                 VALUES ($1,$2,195,$3,$3,'https://issuer.test',$4,
                         'chatgpt-crm-mcp',$5)`,
                [randomUUID(), companyId, ownerB, `owner-b-${ownerB}`, agentB]
            );

            await client.query('SAVEPOINT avatars_rollback_guard');
            await expect(client.query(AVATARS_ROLLBACK))
                .rejects.toThrow('AVATARS_ROLLBACK_MULTIPLE_ACTIVE_BINDINGS');
            await client.query('ROLLBACK TO SAVEPOINT avatars_rollback_guard');

            const active = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM chatgpt_mcp_bindings
                 WHERE company_id=$1 AND status='active'`,
                [companyId]
            );
            expect(active.rows[0].count).toBe(2);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    databaseTest('live authz and self-provision/revoke are company-scoped, idempotent, and read-only by default', async () => {
        const client = await db.pool.connect();
        const oldIssuer = process.env.KEYCLOAK_REALM_URL;
        const oldClientId = process.env.CHATGPT_MCP_CLIENT_ID;
        process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';
        process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
        const companyA = randomUUID();
        const companyB = randomUUID();
        let ownerA;
        let ownerB;
        let ownerA2;
        try {
            await client.query('BEGIN');
            await client.query(AVATARS);
            await client.query(
                `INSERT INTO companies (id,name,slug,status,timezone)
                 VALUES
                    ($1,'Avatar A',$2,'active','America/New_York'),
                    ($3,'Avatar B',$4,'active','America/Chicago')`,
                [companyA, `avatar-a-${companyA}`, companyB, `avatar-b-${companyB}`]
            );
            const owners = await client.query(
                `INSERT INTO crm_users
                    (keycloak_sub,email,full_name,role,status,company_id,
                     platform_role,onboarding_status,kind)
                 VALUES
                    ($1,$2,'Morgan A','company_member','active',$3,'none','active','user'),
                    ($4,$5,'Morgan B','company_member','active',$6,'none','active','user')
                 RETURNING id,company_id,keycloak_sub`,
                [
                    `avatar-owner-a-${companyA}`,
                    `avatar-owner-a-${companyA}@example.test`,
                    companyA,
                    `avatar-owner-b-${companyB}`,
                    `avatar-owner-b-${companyB}@example.test`,
                    companyB,
                ]
            );
            ownerA = owners.rows.find((row) => row.company_id === companyA);
            ownerB = owners.rows.find((row) => row.company_id === companyB);
            const secondOwner = await client.query(
                `INSERT INTO crm_users
                    (keycloak_sub,email,full_name,role,status,company_id,
                     platform_role,onboarding_status,kind)
                 VALUES ($1,$2,'Taylor A','company_member','active',$3,'none','active','user')
                 RETURNING id,company_id,keycloak_sub`,
                [
                    `avatar-owner-a2-${companyA}`,
                    `avatar-owner-a2-${companyA}@example.test`,
                    companyA,
                ]
            );
            ownerA2 = secondOwner.rows[0];
            const memberships = await client.query(
                `INSERT INTO company_memberships
                    (user_id,company_id,role,role_key,status)
                 VALUES
                    ($1,$2,'company_member','manager','active'),
                    ($3,$4,'company_member','dispatcher','active'),
                    ($5,$2,'company_member','manager','active')
                 RETURNING id,user_id,company_id`,
                [ownerA.id, companyA, ownerB.id, companyB, ownerA2.id]
            );
            const membershipA = memberships.rows.find((row) => row.user_id === ownerA.id);
            const roleConfigs = await client.query(
                `INSERT INTO company_role_configs
                    (company_id,role_key,display_name,is_locked)
                 VALUES
                    ($1,'manager','Manager',false),
                    ($2,'dispatcher','Dispatcher',false)
                 RETURNING id,company_id`,
                [companyA, companyB]
            );
            const roleA = roleConfigs.rows.find((row) => row.company_id === companyA);
            await client.query(
                `INSERT INTO company_role_permissions
                    (role_config_id,permission_key,is_allowed)
                 VALUES
                    ($1,'jobs.view',true),
                    ($1,'schedule.view',true)`,
                [roleA.id]
            );
            await client.query(
                `INSERT INTO company_role_scopes
                    (role_config_id,scope_key,scope_json)
                 VALUES ($1,'job_visibility','"assigned_only"'::jsonb)`,
                [roleA.id]
            );
            await client.query(
                `INSERT INTO company_membership_permission_overrides
                    (membership_id,permission_key,override_mode)
                 VALUES
                    ($1,'schedule.view','deny'),
                    ($1,'contacts.view','allow')`,
                [membershipA.id]
            );
            await client.query(
                `INSERT INTO company_membership_scope_overrides
                    (membership_id,scope_key,scope_json)
                 VALUES ($1,'financial_scope','"summary"'::jsonb)`,
                [membershipA.id]
            );

            const authz = await authorizationService.resolveCompanyUserAuthz(
                companyA,
                ownerA.id,
                { client }
            );
            expect(authz).toMatchObject({
                owner_user_id: ownerA.id,
                owner_display_name: 'Morgan A',
                role_key: 'manager',
                permissions: ['contacts.view', 'jobs.view'],
                scopes: {
                    job_visibility: 'assigned_only',
                    financial_scope: 'summary',
                },
            });
            await expect(authorizationService.resolveCompanyUserAuthz(
                companyB,
                ownerA.id,
                { client }
            )).rejects.toMatchObject({ code: 'COMPANY_USER_ACCESS_INACTIVE' });

            const app = await client.query(
                `SELECT id FROM marketplace_apps
                 WHERE app_key='chatgpt-crm-mcp' AND status='published'`
            );
            const installs = await client.query(
                `INSERT INTO marketplace_installations
                    (company_id,app_id,status,installed_by,installed_at)
                 VALUES
                    ($1,$3,'connected',$4,NOW()),
                    ($2,$3,'connected',$5,NOW())
                 RETURNING id,company_id`,
                [companyA, companyB, app.rows[0].id, ownerA.id, ownerB.id]
            );
            const installA = installs.rows.find((row) => row.company_id === companyA);
            const installB = installs.rows.find((row) => row.company_id === companyB);
            await expect(identityService.provisionAvatar({
                companyId: companyA,
                installationId: installA.id,
                ownerUserId: ownerA.id,
                actorId: ownerB.id,
            }, client)).rejects.toMatchObject({
                code: 'AVATAR_SELF_SERVICE_REQUIRED',
                httpStatus: 403,
            });
            const avatarA = await identityService.provisionAvatar({
                companyId: companyA,
                installationId: installA.id,
                ownerUserId: ownerA.id,
                actorId: ownerA.id,
            }, client);
            const avatarAReplay = await identityService.provisionAvatar({
                companyId: companyA,
                installationId: installA.id,
                ownerUserId: ownerA.id,
                actorId: ownerA.id,
            }, client);
            const avatarB = await identityService.provisionAvatar({
                companyId: companyB,
                installationId: installB.id,
                ownerUserId: ownerB.id,
                actorId: ownerB.id,
            }, client);
            const avatarA2 = await identityService.provisionAvatar({
                companyId: companyA,
                installationId: installA.id,
                ownerUserId: ownerA2.id,
                actorId: ownerA2.id,
            }, client);

            expect(avatarAReplay.binding.id).toBe(avatarA.binding.id);
            expect(avatarAReplay.aiUser.id).toBe(avatarA.aiUser.id);
            expect(avatarA2.binding.id).not.toBe(avatarA.binding.id);
            expect(avatarA2.binding.owner_user_id).toBe(ownerA2.id);
            expect(avatarA.aiUser.full_name).toBe('Avatar of Morgan A');
            expect(avatarA.binding).toMatchObject({
                owner_user_id: ownerA.id,
                authorized_by_user_id: ownerA.id,
                writes_enabled: false,
                sends_enabled: false,
            });
            const avatarAGrants = await client.query(
                `SELECT permission_key
                 FROM mcp_agent_permission_grants
                 WHERE company_id=$1 AND agent_user_id=$2
                 ORDER BY permission_key`,
                [companyA, avatarA.aiUser.id]
            );
            expect(avatarAGrants.rows.map((row) => row.permission_key))
                .toEqual([...permissions.S1_GRANTS].sort());
            expect(avatarAGrants.rows.map((row) => row.permission_key))
                .not.toEqual(expect.arrayContaining([
                    'mcp.tool.svc.create_lead',
                    'mcp.tool.svc.send_estimate',
                ]));

            await client.query(
                `INSERT INTO company_memberships
                    (user_id,company_id,role,role_key,status)
                 VALUES ($1,$2,'company_member','dispatcher','active')`,
                [ownerA.id, companyB]
            );
            await client.query('SAVEPOINT avatar_single_company');
            await expect(identityService.provisionAvatar({
                companyId: companyB,
                installationId: installB.id,
                ownerUserId: ownerA.id,
                actorId: ownerA.id,
            }, client)).rejects.toMatchObject({
                code: 'AVATAR_ALREADY_CONNECTED',
                httpStatus: 409,
            });
            await client.query('ROLLBACK TO SAVEPOINT avatar_single_company');

            await client.query(
                `UPDATE company_memberships
                 SET status='inactive'
                 WHERE user_id=$1 AND company_id=$2`,
                [ownerA.id, companyA]
            );
            await expect(authorizationService.resolveCompanyUserAuthz(
                companyA,
                ownerA.id,
                { client }
            )).rejects.toMatchObject({ code: 'COMPANY_USER_ACCESS_INACTIVE' });
            await client.query(
                `UPDATE company_memberships
                 SET status='active'
                 WHERE user_id=$1 AND company_id=$2`,
                [ownerA.id, companyA]
            );

            const snapshotB = await client.query(
                `SELECT
                    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
                     FROM chatgpt_mcp_bindings x WHERE x.company_id=$1) AS bindings,
                    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
                     FROM mcp_agent_permission_grants x WHERE x.company_id=$1) AS grants,
                    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
                     FROM crm_users x WHERE x.company_id=$1) AS users`,
                [companyB]
            );
            await identityService.revokeAvatar({
                companyId: companyA,
                ownerUserId: ownerA.id,
                actorId: ownerA.id,
            }, client);
            const afterB = await client.query(
                `SELECT
                    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
                     FROM chatgpt_mcp_bindings x WHERE x.company_id=$1) AS bindings,
                    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
                     FROM mcp_agent_permission_grants x WHERE x.company_id=$1) AS grants,
                    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
                     FROM crm_users x WHERE x.company_id=$1) AS users`,
                [companyB]
            );
            expect(afterB.rows[0]).toStrictEqual(snapshotB.rows[0]);
            const revokedA = await client.query(
                `SELECT b.status, ai.status AS agent_status
                 FROM chatgpt_mcp_bindings b
                 JOIN crm_users ai
                   ON ai.id=b.ai_user_id AND ai.company_id=b.company_id
                 WHERE b.id=$1 AND b.company_id=$2`,
                [avatarA.binding.id, companyA]
            );
            expect(revokedA.rows[0]).toEqual({
                status: 'revoked',
                agent_status: 'disabled',
            });
            const stillActiveA2 = await client.query(
                `SELECT status
                 FROM chatgpt_mcp_bindings
                 WHERE id=$1 AND company_id=$2 AND owner_user_id=$3`,
                [avatarA2.binding.id, companyA, ownerA2.id]
            );
            expect(stillActiveA2.rows[0]?.status).toBe('active');
            expect(avatarB.binding.company_id).toBe(companyB);
        } finally {
            await client.query('ROLLBACK');
            client.release();
            if (oldIssuer === undefined) delete process.env.KEYCLOAK_REALM_URL;
            else process.env.KEYCLOAK_REALM_URL = oldIssuer;
            if (oldClientId === undefined) delete process.env.CHATGPT_MCP_CLIENT_ID;
            else process.env.CHATGPT_MCP_CLIENT_ID = oldClientId;
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* ignore */ }
});
