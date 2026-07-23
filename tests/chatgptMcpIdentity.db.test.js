'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const grants = require('../backend/src/services/chatgptMcpPermissions');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '195_chatgpt_crm_mcp.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(MIGRATIONS, 'rollback_195_chatgpt_crm_mcp.sql'), 'utf8');
const SEED = fs.readFileSync(path.join(MIGRATIONS, '196_seed_chatgpt_crm_mcp_marketplace_app.sql'), 'utf8');
const SEED_ROLLBACK = fs.readFileSync(path.join(MIGRATIONS, 'rollback_196_seed_chatgpt_crm_mcp_marketplace_app.sql'), 'utf8');
const CALLS_GRANT = fs.readFileSync(path.join(MIGRATIONS, '198_chatgpt_mcp_list_calls_grant.sql'), 'utf8');
const CALLS_GRANT_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_198_chatgpt_mcp_list_calls_grant.sql'),
    'utf8'
);
const MARKETPLACE_SOURCE = fs.readFileSync(path.join(__dirname, '../backend/src/services/marketplaceService.js'), 'utf8');

jest.setTimeout(60000);

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
        env: probeEnv, encoding: 'utf8', timeout: 6000,
    });
    return { ready: result.status === 0, reason: String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim() };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('ChatGPT MCP identity DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`ChatGPT MCP identity DB tests are pending: ${DATABASE.reason}`);
    });
}

describe('CHATGPT-CRM-MCP S1 identity schema and Marketplace seam', () => {
    test('paired migrations, AI kind, binding/grant tables, and Marketplace hooks are present', () => {
        expect(SCHEMA).toContain("CHECK (kind IN ('user', 'agent'))");
        expect(SCHEMA).toContain('chatgpt_mcp_bindings');
        expect(SCHEMA).toContain('mcp_agent_permission_grants');
        expect(SCHEMA).toContain('mcp_tool_invocations');
        expect(SCHEMA).toContain('idempotency_key');
        expect(SCHEMA).toContain('argument_hash');
        expect(SCHEMA).toContain('confirmation_class');
        expect(SCHEMA).toContain('uq_chatgpt_mcp_binding_active_principal');
        expect(SCHEMA).not.toMatch(/\bcontacts\b/);
        expect(ROLLBACK).not.toMatch(/\bcontacts\b/);
        expect([...SCHEMA.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS\s+(\S+)/g)].map((match) => match[1]))
            .toEqual([
                'uq_crm_users_company_id_id',
                'uq_marketplace_installations_company_id_id',
                'uq_chatgpt_mcp_binding_active_company',
                'uq_chatgpt_mcp_binding_active_principal',
            ]);
        expect(ROLLBACK).toContain('DROP TABLE IF EXISTS chatgpt_mcp_bindings');
        expect(SEED).toContain('"assistant"');
        for (const key of ['what_it_does', 'prerequisites', 'setup_steps', 'outcome', 'recommend_when', 'gotchas']) {
            expect(SEED).toContain(`"${key}"`);
        }
        expect(SEED_ROLLBACK).toContain("app_key = 'chatgpt-crm-mcp'");
        expect(CALLS_GRANT).toContain("'pulse.view'");
        expect(CALLS_GRANT).toContain("'mcp.tool.svc.list_calls'");
        expect(CALLS_GRANT).toContain("'[\"calls:read\"]'::jsonb");
        expect(CALLS_GRANT).toContain('bundle_version = EXCLUDED.bundle_version');
        expect(CALLS_GRANT_ROLLBACK).toContain("'mcp.tool.svc.list_calls'");
        expect(MARKETPLACE_SOURCE).toContain('chatgptMcpIdentityService.provisionInstallation');
        expect(MARKETPLACE_SOURCE).toContain('chatgptMcpIdentityService.revokeInstallation');
        expect(MARKETPLACE_SOURCE).toContain('requireChatgptTenantAdmin');

        const priorClientId = process.env.CHATGPT_MCP_CLIENT_ID;
        delete process.env.CHATGPT_MCP_CLIENT_ID;
        try {
            expect(() => identityService.configuredClientId()).toThrow('CHATGPT_MCP_CLIENT_ID is required');
        } finally {
            if (priorClientId === undefined) delete process.env.CHATGPT_MCP_CLIENT_ID;
            else process.env.CHATGPT_MCP_CLIENT_ID = priorClientId;
        }
    });

    databaseTest('SAB-MCP-OAUTH-TENANT + R-matrix: OAuth and fixed-bearer chains require an active tenant-admin authorizer', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        const priorIssuer = process.env.KEYCLOAK_REALM_URL;
        const priorClientId = process.env.CHATGPT_MCP_CLIENT_ID;
        process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';
        process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
        let dbSpy;
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            await client.query(SEED);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));

            await client.query(
                `INSERT INTO companies (id, name, slug, status, timezone)
                 VALUES ($1, 'MCP A', $2, 'active', 'America/New_York'),
                        ($3, 'MCP B', $4, 'active', 'America/Chicago')`,
                [companyA, `mcp-a-${companyA}`, companyB, `mcp-b-${companyB}`]
            );
            const humans = await client.query(
                `INSERT INTO crm_users
                    (keycloak_sub, email, full_name, role, status, company_id,
                     platform_role, onboarding_status, kind)
                 VALUES ($1, $2, 'Admin A', 'company_member', 'active', $3, 'none', 'active', 'user'),
                        ($4, $5, 'Admin B', 'company_member', 'active', $6, 'none', 'active', 'user')
                 RETURNING id, keycloak_sub, company_id`,
                [
                    `human-a-${companyA}`, `a-${companyA}@example.test`, companyA,
                    `human-b-${companyB}`, `b-${companyB}@example.test`, companyB,
                ]
            );
            const humanA = humans.rows.find((row) => row.company_id === companyA);
            const humanB = humans.rows.find((row) => row.company_id === companyB);
            await client.query(
                `INSERT INTO company_memberships (user_id, company_id, role, role_key, status)
                 VALUES ($1, $2, 'company_admin', 'tenant_admin', 'active'),
                        ($3, $4, 'company_admin', 'tenant_admin', 'active')`,
                [humanA.id, companyA, humanB.id, companyB]
            );
            const backupAdmin = await client.query(
                `INSERT INTO crm_users
                    (keycloak_sub, email, full_name, role, status, company_id,
                     platform_role, onboarding_status, kind)
                 VALUES ($1, $2, 'Backup Admin A', 'company_member', 'active', $3,
                         'none', 'active', 'user')
                 RETURNING id`,
                [`human-a-backup-${companyA}`, `a-backup-${companyA}@example.test`, companyA]
            );
            await client.query(
                `INSERT INTO company_memberships (user_id, company_id, role, role_key, status)
                 VALUES ($1, $2, 'company_admin', 'tenant_admin', 'active')`,
                [backupAdmin.rows[0].id, companyA]
            );
            const backupAdminB = await client.query(
                `INSERT INTO crm_users
                    (keycloak_sub, email, full_name, role, status, company_id,
                     platform_role, onboarding_status, kind)
                 VALUES ($1, $2, 'Backup Admin B', 'company_member', 'active', $3,
                         'none', 'active', 'user')
                 RETURNING id`,
                [`human-b-backup-${companyB}`, `b-backup-${companyB}@example.test`, companyB]
            );
            await client.query(
                `INSERT INTO company_memberships (user_id, company_id, role, role_key, status)
                 VALUES ($1, $2, 'company_admin', 'tenant_admin', 'active')`,
                [backupAdminB.rows[0].id, companyB]
            );
            const app = await client.query(`SELECT id FROM marketplace_apps WHERE app_key = 'chatgpt-crm-mcp'`);
            const installs = await client.query(
                `INSERT INTO marketplace_installations (company_id, app_id, status, installed_by, installed_at)
                 VALUES ($1, $3, 'connected', $4, NOW()), ($2, $3, 'connected', $5, NOW())
                 RETURNING id, company_id`,
                [companyA, companyB, app.rows[0].id, humanA.id, humanB.id]
            );
            const installA = installs.rows.find((row) => row.company_id === companyA);
            const installB = installs.rows.find((row) => row.company_id === companyB);
            const provisionA = await identityService.provisionInstallation({
                companyId: companyA, installationId: installA.id, actorId: humanA.id,
            }, client);
            const provisionB = await identityService.provisionInstallation({
                companyId: companyB, installationId: installB.id, actorId: humanB.id,
            }, client);

            await client.query(
                `DELETE FROM mcp_agent_permission_grants
                 WHERE company_id IN ($1, $2)
                   AND permission_key IN ('pulse.view', 'mcp.tool.svc.list_calls')`,
                [companyA, companyB]
            );
            await client.query(
                `UPDATE mcp_agent_permission_grants
                 SET bundle_version=1
                 WHERE company_id IN ($1, $2)`,
                [companyA, companyB]
            );
            await client.query(
                `UPDATE chatgpt_mcp_bindings
                 SET grant_version=1
                 WHERE company_id IN ($1, $2)`,
                [companyA, companyB]
            );
            await client.query(CALLS_GRANT);
            await client.query(CALLS_GRANT);

            const migratedGrants = await client.query(
                `SELECT company_id, permission_key, bundle_version, COUNT(*)::int AS count
                 FROM mcp_agent_permission_grants
                 WHERE company_id IN ($1, $2)
                   AND permission_key IN ('pulse.view', 'mcp.tool.svc.list_calls')
                 GROUP BY company_id, permission_key, bundle_version
                 ORDER BY company_id, permission_key`,
                [companyA, companyB]
            );
            expect(migratedGrants.rows).toHaveLength(4);
            expect(migratedGrants.rows).toEqual(expect.arrayContaining([
                { company_id: companyA, permission_key: 'pulse.view', bundle_version: 2, count: 1 },
                {
                    company_id: companyA,
                    permission_key: 'mcp.tool.svc.list_calls',
                    bundle_version: 2,
                    count: 1,
                },
                { company_id: companyB, permission_key: 'pulse.view', bundle_version: 2, count: 1 },
                {
                    company_id: companyB,
                    permission_key: 'mcp.tool.svc.list_calls',
                    bundle_version: 2,
                    count: 1,
                },
            ]));
            const migratedBindings = await client.query(
                `SELECT company_id, grant_version
                 FROM chatgpt_mcp_bindings
                 WHERE company_id IN ($1, $2)
                 ORDER BY company_id`,
                [companyA, companyB]
            );
            expect(migratedBindings.rows).toEqual([
                { company_id: companyA, grant_version: 2 },
                { company_id: companyB, grant_version: 2 },
            ].sort((left, right) => left.company_id.localeCompare(right.company_id)));
            const migratedApp = await client.query(
                `SELECT requested_scopes, metadata
                 FROM marketplace_apps
                 WHERE app_key='chatgpt-crm-mcp'`
            );
            expect(migratedApp.rows[0].requested_scopes).toContain('calls:read');
            expect(migratedApp.rows[0].metadata.access_summary).toEqual(expect.arrayContaining([
                'Read recent Calls from Pulse without recordings or provider identifiers',
            ]));
            expect(migratedApp.rows[0].metadata.assistant.recommend_when).toEqual(expect.arrayContaining([
                'User wants ChatGPT to review recent inbound or outbound calls and whether AI answered',
            ]));

            const resolved = await identityService.resolveOAuthContext({
                issuer: process.env.KEYCLOAK_REALM_URL,
                subject: humanA.keycloak_sub,
                clientId: 'chatgpt-crm-mcp',
            });
            expect(resolved.company_id).toBe(companyA);
            expect(resolved.ai_user_id).toBe(provisionA.aiUser.id);
            expect(resolved.permissions.sort()).toEqual([...grants.S1_GRANTS].sort());
            await identityService.recordInvocation({
                companyId: companyA,
                bindingId: provisionA.binding.id,
                actorId: provisionA.aiUser.id,
                authorizerId: humanA.id,
            }, {
                toolName: 'svc.get_job',
                requestId: 'req-owned-read',
                status: 'succeeded',
                safeMetadata: { kind: 'read' },
            });
            const audit = await client.query(
                `SELECT company_id, binding_id, created_by, authorized_by_user_id,
                        tool_name, confirmation_class, status, safe_metadata
                 FROM mcp_tool_invocations
                 WHERE company_id=$1 AND request_id='req-owned-read'`,
                [companyA]
            );
            expect(audit.rows).toEqual([expect.objectContaining({
                company_id: companyA,
                binding_id: provisionA.binding.id,
                created_by: provisionA.aiUser.id,
                authorized_by_user_id: humanA.id,
                tool_name: 'svc.get_job',
                confirmation_class: 'R',
                status: 'succeeded',
                safe_metadata: { kind: 'read' },
            })]);
            const agentMembership = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM company_memberships
                 WHERE user_id=$1 AND company_id=$2`,
                [provisionA.aiUser.id, companyA]
            );
            expect(agentMembership.rows[0].count).toBe(0);

            await expect(identityService.resolveFixedBearerContext({
                companyId: companyA,
                agentUserId: provisionA.aiUser.id,
            })).resolves.toMatchObject({ company_id: companyA, ai_user_id: provisionA.aiUser.id });
            await client.query(
                `UPDATE company_memberships
                 SET role_key='manager', role='company_member'
                 WHERE user_id=$1 AND company_id=$2`,
                [humanA.id, companyA]
            );
            await expect(identityService.resolveFixedBearerContext({
                companyId: companyA,
                agentUserId: provisionA.aiUser.id,
            })).rejects.toMatchObject({ code: 'MCP_BINDING_INVALID' });
            await client.query(
                `UPDATE company_memberships
                 SET role_key='tenant_admin', role='company_admin'
                 WHERE user_id=$1 AND company_id=$2`,
                [humanA.id, companyA]
            );

            await client.query('SAVEPOINT duplicate_principal');
            await expect(client.query(
                `UPDATE chatgpt_mcp_bindings
                 SET oauth_subject = $1
                 WHERE company_id = $2 AND id = $3`,
                [humanA.keycloak_sub, companyB, provisionB.binding.id]
            )).rejects.toMatchObject({ code: '23505' });
            await client.query('ROLLBACK TO SAVEPOINT duplicate_principal');

            const denyCases = [
                [`UPDATE chatgpt_mcp_bindings SET status='revoked' WHERE id=$1 AND company_id=$2`, [provisionA.binding.id, companyA],
                    `UPDATE chatgpt_mcp_bindings SET status='active' WHERE id=$1 AND company_id=$2`, [provisionA.binding.id, companyA]],
                [`UPDATE marketplace_installations SET status='disconnected' WHERE id=$1 AND company_id=$2`, [installA.id, companyA],
                    `UPDATE marketplace_installations SET status='connected' WHERE id=$1 AND company_id=$2`, [installA.id, companyA]],
                [`UPDATE companies SET status='suspended' WHERE id=$1`, [companyA],
                    `UPDATE companies SET status='active' WHERE id=$1`, [companyA]],
                [`UPDATE crm_users SET status='disabled' WHERE id=$1 AND company_id=$2`, [provisionA.aiUser.id, companyA],
                    `UPDATE crm_users SET status='active' WHERE id=$1 AND company_id=$2`, [provisionA.aiUser.id, companyA]],
                [`UPDATE company_memberships SET status='disabled' WHERE user_id=$1 AND company_id=$2`, [humanA.id, companyA],
                    `UPDATE company_memberships SET status='active' WHERE user_id=$1 AND company_id=$2`, [humanA.id, companyA]],
            ];
            for (const [breakSql, breakParams, restoreSql, restoreParams] of denyCases) {
                await client.query(breakSql, breakParams);
                await expect(identityService.resolveOAuthContext({
                    issuer: process.env.KEYCLOAK_REALM_URL,
                    subject: humanA.keycloak_sub,
                    clientId: 'chatgpt-crm-mcp',
                })).rejects.toMatchObject({ code: 'MCP_BINDING_INVALID' });
                await client.query(restoreSql, restoreParams);
            }

            for (const roleKey of ['manager', 'dispatcher', 'provider', null]) {
                await client.query(
                    `UPDATE company_memberships SET role_key=$3, role='company_member'
                     WHERE user_id=$1 AND company_id=$2`,
                    [humanB.id, companyB, roleKey]
                );
                await expect(identityService.requireTenantAdmin(companyB, humanB.id, client))
                    .rejects.toMatchObject({ code: 'TENANT_ADMIN_REQUIRED' });
            }

            await identityService.revokeInstallation({
                companyId: companyA, installationId: installA.id, actorId: humanA.id,
            }, client);
            await expect(identityService.resolveOAuthContext({
                issuer: process.env.KEYCLOAK_REALM_URL,
                subject: humanA.keycloak_sub,
                clientId: 'chatgpt-crm-mcp',
            })).rejects.toMatchObject({ code: 'MCP_BINDING_INVALID' });
            const revoked = await client.query(
                `SELECT b.status AS binding_status, u.status AS agent_status,
                        (SELECT COUNT(*)::int FROM mcp_agent_permission_grants g
                         WHERE g.company_id=b.company_id AND g.agent_user_id=b.ai_user_id) AS grant_count
                 FROM chatgpt_mcp_bindings b
                 JOIN crm_users u ON u.id=b.ai_user_id AND u.company_id=b.company_id
                 WHERE b.id=$1 AND b.company_id=$2`,
                [provisionA.binding.id, companyA]
            );
            expect(revoked.rows[0]).toEqual({ binding_status: 'revoked', agent_status: 'disabled', grant_count: 0 });
        } finally {
            if (dbSpy) dbSpy.mockRestore();
            await client.query('ROLLBACK');
            client.release();
            if (priorIssuer === undefined) delete process.env.KEYCLOAK_REALM_URL;
            else process.env.KEYCLOAK_REALM_URL = priorIssuer;
            if (priorClientId === undefined) delete process.env.CHATGPT_MCP_CLIENT_ID;
            else process.env.CHATGPT_MCP_CLIENT_ID = priorClientId;
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* ignore */ }
});
