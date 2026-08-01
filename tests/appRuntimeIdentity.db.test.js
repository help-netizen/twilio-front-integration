'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const identityService = require('../backend/src/services/appRuntimeIdentityService');
const tokenService = require('../backend/src/services/appRuntimeTokenService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '220_app_runtime_gateway.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_220_app_runtime_gateway.sql'),
    'utf8'
);

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
    test('APP-GW-001 identity DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-GW-001 identity DB tests are pending: ${DATABASE.reason}`);
    });
}

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function insertCompany(client, label) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [id, `APP GW ${label}`, `app-gw-${label.toLowerCase()}-${id}`]
    );
    return id;
}

async function insertHuman(client, companyId, label, roleKey = 'manager') {
    const user = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, 'company_member', 'active', $4,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-gw-human-${label}-${randomUUID()}`,
            `app-gw-${label}-${randomUUID()}@example.test`,
            `APP GW ${label}`,
            companyId,
        ]
    );
    const membership = await client.query(
        `INSERT INTO company_memberships
            (user_id, company_id, role, role_key, status)
         VALUES ($1, $2, 'company_member', $3, 'active')
         RETURNING id`,
        [user.rows[0].id, companyId, roleKey]
    );
    return { id: user.rows[0].id, membershipId: membership.rows[0].id };
}

async function insertApp(client, label) {
    const app = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, $2, 'Albusto Test', 'ai', 'private', 'APP-GW test app',
                 '[]'::jsonb, 'none', 'published', '{}'::jsonb)
         RETURNING id`,
        [`app-gw-${label}-${randomUUID()}`, `APP GW ${label}`]
    );
    return app.rows[0].id;
}

async function insertInstallation(client, companyId, appId, installedBy) {
    const result = await client.query(
        `INSERT INTO marketplace_installations
            (company_id, app_id, status, installed_by, installed_at, metadata)
         VALUES ($1, $2, 'connected', $3, NOW(), '{}'::jsonb)
         RETURNING id`,
        [companyId, appId, installedBy]
    );
    return result.rows[0].id;
}

describe('APP-GW-001 schema and principal lifecycle', () => {
    test('migration/rollback are paired, consent is not seeded, and composite invariants are declared', () => {
        expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS app_versions');
        expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS app_version_tools');
        expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS app_installation_principals');
        expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS app_runs');
        expect(SCHEMA).toContain('fk_app_runtime_principal_installation');
        expect(SCHEMA).toContain('fk_app_runs_principal');
        expect(SCHEMA).toContain('fk_audit_log_app_runtime_run');
        expect(SCHEMA).toContain('APP_VERSION_ARTIFACT_IMMUTABLE');
        expect(SCHEMA).toContain('APP_VERSION_TOOLS_IMMUTABLE');
        expect(SCHEMA).not.toMatch(/INSERT INTO marketplace_apps|UPDATE marketplace_apps/);
        expect(ROLLBACK).toContain('DROP TABLE IF EXISTS app_runs');
        expect(ROLLBACK).not.toMatch(/DELETE FROM marketplace_apps|DELETE FROM crm_users/);
    });

    databaseTest('SAB published artifact/version identity is immutable and composite FKs reject cross-tenant wiring', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            await client.query(SCHEMA);

            const companyA = await insertCompany(client, 'Schema A');
            const companyB = await insertCompany(client, 'Schema B');
            const humanA = await insertHuman(client, companyA, 'schema-a');
            const humanB = await insertHuman(client, companyB, 'schema-b');
            const appA = await insertApp(client, 'schema-a');
            const appB = await insertApp(client, 'schema-b');
            const installationA = await insertInstallation(client, companyA, appA, humanA.id);
            const installationB = await insertInstallation(client, companyB, appB, humanB.id);
            const agentA = await client.query(
                `INSERT INTO crm_users
                    (keycloak_sub, email, full_name, role, status, company_id,
                     platform_role, onboarding_status, kind)
                 VALUES ($1, $2, 'Schema Agent A', 'company_member', 'active', $3,
                         'none', 'active', 'agent')
                 RETURNING id`,
                [
                    `agent:app-runtime:schema-${randomUUID()}`,
                    `schema-agent-${randomUUID()}@albusto.invalid`,
                    companyA,
                ]
            );
            const source = 'module.exports = async () => ({ ok: true });';
            const version = await client.query(
                `INSERT INTO app_versions
                    (app_id, version_number, source_code, source_sha256, status, created_by)
                 VALUES ($1, '1.0.0', $2, $3, 'draft', $4)
                 RETURNING id`,
                [appA, source, digest(source), humanA.id]
            );
            await client.query(
                `INSERT INTO app_version_tools (version_id, tool_name)
                 VALUES ($1, 'svc.list_jobs')`,
                [version.rows[0].id]
            );
            await client.query(
                `UPDATE app_versions
                 SET status = 'published', published_at = NOW()
                 WHERE id = $1 AND app_id = $2`,
                [version.rows[0].id, appA]
            );

            await client.query('SAVEPOINT artifact_update');
            await expect(client.query(
                `UPDATE app_versions SET source_code = 'changed' WHERE id = $1 AND app_id = $2`,
                [version.rows[0].id, appA]
            )).rejects.toThrow(/APP_VERSION_ARTIFACT_IMMUTABLE/);
            await client.query('ROLLBACK TO SAVEPOINT artifact_update');

            await client.query('SAVEPOINT tool_insert');
            await expect(client.query(
                `INSERT INTO app_version_tools (version_id, tool_name)
                 VALUES ($1, 'svc.get_job')`,
                [version.rows[0].id]
            )).rejects.toThrow(/APP_VERSION_TOOLS_IMMUTABLE/);
            await client.query('ROLLBACK TO SAVEPOINT tool_insert');

            await client.query('SAVEPOINT tool_delete');
            await expect(client.query(
                `DELETE FROM app_version_tools
                 WHERE version_id = $1 AND tool_name = 'svc.list_jobs'`,
                [version.rows[0].id]
            )).rejects.toThrow(/APP_VERSION_TOOLS_IMMUTABLE/);
            await client.query('ROLLBACK TO SAVEPOINT tool_delete');

            await client.query('SAVEPOINT cross_tenant_principal');
            await expect(client.query(
                `INSERT INTO app_installation_principals
                    (company_id, app_id, installation_id, agent_user_id, delegated_by_user_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [companyA, appB, installationB, agentA.rows[0].id, humanA.id]
            )).rejects.toMatchObject({ code: '23503' });
            await client.query('ROLLBACK TO SAVEPOINT cross_tenant_principal');

            const untouched = await client.query(
                `SELECT source_code, source_sha256, status
                 FROM app_versions WHERE id = $1 AND app_id = $2`,
                [version.rows[0].id, appA]
            );
            expect(untouched.rows[0]).toEqual({
                source_code: source,
                source_sha256: digest(source),
                status: 'published',
            });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('forward → rollback → forward is idempotent and preserves Marketplace/audit/MCP rows', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const before = await client.query(
                `SELECT
                    (SELECT COUNT(*)::int FROM marketplace_apps) AS apps,
                    (SELECT COUNT(*)::int FROM marketplace_installations) AS installations,
                    (SELECT COUNT(*)::int FROM audit_log) AS audits,
                    to_regclass('mcp_tool_invocations')::text AS mcp_table`
            );
            await client.query(SCHEMA);
            await client.query(SCHEMA);
            await client.query(ROLLBACK);
            const afterRollback = await client.query(
                `SELECT
                    (SELECT COUNT(*)::int FROM marketplace_apps) AS apps,
                    (SELECT COUNT(*)::int FROM marketplace_installations) AS installations,
                    (SELECT COUNT(*)::int FROM audit_log) AS audits,
                    to_regclass('mcp_tool_invocations')::text AS mcp_table,
                    to_regclass('app_runs')::text AS app_runs`
            );
            expect(afterRollback.rows[0]).toEqual({
                ...before.rows[0],
                app_runs: null,
            });
            await client.query(ROLLBACK);
            await client.query(SCHEMA);
            const afterForward = await client.query(
                `SELECT to_regclass('app_versions')::text AS versions,
                        to_regclass('app_version_tools')::text AS tools,
                        to_regclass('app_installation_principals')::text AS principals,
                        to_regclass('app_runs')::text AS runs`
            );
            expect(afterForward.rows[0]).toEqual({
                versions: 'app_versions',
                tools: 'app_version_tools',
                principals: 'app_installation_principals',
                runs: 'app_runs',
            });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('SAB principal is per installation/company: provision is idempotent and revoke disables only its agent', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            const companyA = await insertCompany(client, 'Principal A');
            const companyB = await insertCompany(client, 'Principal B');
            const humanA = await insertHuman(client, companyA, 'principal-a');
            const humanB = await insertHuman(client, companyB, 'principal-b');
            const app = await insertApp(client, 'principal');
            const installationA = await insertInstallation(client, companyA, app, humanA.id);
            const installationB = await insertInstallation(client, companyB, app, humanB.id);

            const first = await identityService.provisionInstallationPrincipal({
                installationId: installationA,
            }, client);
            const second = await identityService.provisionInstallationPrincipal({
                installationId: installationA,
            }, client);
            const other = await identityService.provisionInstallationPrincipal({
                installationId: installationB,
            }, client);
            expect(second.principal.id).toBe(first.principal.id);
            expect(second.agent.id).toBe(first.agent.id);
            expect(other.agent.id).not.toBe(first.agent.id);
            expect(first.principal).toMatchObject({
                company_id: companyA,
                app_id: app,
                installation_id: installationA,
                delegated_by_user_id: humanA.id,
                status: 'active',
            });

            const forbiddenMembership = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM company_memberships
                 WHERE company_id = $1 AND user_id = $2`,
                [companyA, first.agent.id]
            );
            const forbiddenGrants = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM mcp_agent_permission_grants
                 WHERE company_id = $1 AND agent_user_id = $2`,
                [companyA, first.agent.id]
            );
            expect(forbiddenMembership.rows[0].count).toBe(0);
            expect(forbiddenGrants.rows[0].count).toBe(0);

            await client.query('SAVEPOINT cross_tenant_principal');
            await expect(client.query(
                `UPDATE app_installation_principals
                 SET company_id = $1
                 WHERE id = $2 AND company_id = $3`,
                [companyA, other.principal.id, companyB]
            )).rejects.toMatchObject({ code: '23503' });
            await client.query('ROLLBACK TO SAVEPOINT cross_tenant_principal');

            expect(await identityService.revokeInstallationPrincipal({
                companyId: companyA,
                installationId: installationA,
            }, client)).toBe(1);
            const states = await client.query(
                `SELECT principal.company_id, principal.status AS principal_status,
                        agent.status AS agent_status, agent.onboarding_status
                 FROM app_installation_principals principal
                 JOIN crm_users agent
                   ON agent.id = principal.agent_user_id
                  AND agent.company_id = principal.company_id
                 WHERE principal.installation_id IN ($1, $2)
                 ORDER BY principal.company_id`,
                [installationA, installationB]
            );
            expect(states.rows).toEqual(expect.arrayContaining([
                {
                    company_id: companyA,
                    principal_status: 'revoked',
                    agent_status: 'disabled',
                    onboarding_status: 'disabled',
                },
                {
                    company_id: companyB,
                    principal_status: 'active',
                    agent_status: 'active',
                    onboarding_status: 'active',
                },
            ]));
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('mint derives tenant/app from installation, persists only nonce digest, and rejects a cross-app version', async () => {
        const client = await db.pool.connect();
        let connectSpy;
        const previousSecret = process.env.APP_RUNTIME_RUN_TOKEN_SECRET;
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            const companyA = await insertCompany(client, 'Mint A');
            const humanA = await insertHuman(client, companyA, 'mint-a');
            const appA = await insertApp(client, 'mint-a');
            const appB = await insertApp(client, 'mint-b');
            const installationA = await insertInstallation(client, companyA, appA, humanA.id);
            const source = 'module.exports = async () => ({ ok: true });';
            const versionA = await client.query(
                `INSERT INTO app_versions
                    (app_id, version_number, source_code, source_sha256, status, created_by)
                 VALUES ($1, '1.0.0', $2, $3, 'draft', $4)
                 RETURNING id`,
                [appA, source, digest(source), humanA.id]
            );
            const versionB = await client.query(
                `INSERT INTO app_versions
                    (app_id, version_number, source_code, source_sha256, status, created_by)
                 VALUES ($1, '1.0.0', $2, $3, 'draft', $4)
                 RETURNING id`,
                [appB, source, digest(source), humanA.id]
            );
            for (const toolName of ['svc.list_jobs', 'svc.get_job', 'svc.list_tasks']) {
                await client.query(
                    `INSERT INTO app_version_tools (version_id, tool_name) VALUES ($1, $2)`,
                    [versionA.rows[0].id, toolName]
                );
            }
            await client.query(
                `UPDATE app_versions
                 SET status = 'published', published_at = NOW()
                 WHERE id IN ($1, $2)`,
                [versionA.rows[0].id, versionB.rows[0].id]
            );
            await client.query(
                `UPDATE marketplace_installations
                 SET metadata = jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{app_runtime}',
                     $2::jsonb,
                     true
                 )
                 WHERE id = $1 AND company_id = $3`,
                [
                    installationA,
                    JSON.stringify({
                        version_id: versionA.rows[0].id,
                        consented_tools: ['svc.list_jobs', 'svc.get_job', 'svc.list_tasks'],
                    }),
                    companyA,
                ]
            );

            let savepointOpen = false;
            const transactionalClient = {
                query: async (text, params) => {
                    if (text === 'BEGIN') {
                        savepointOpen = true;
                        return client.query('SAVEPOINT app_runtime_mint');
                    }
                    if (text === 'COMMIT') {
                        savepointOpen = false;
                        return client.query('RELEASE SAVEPOINT app_runtime_mint');
                    }
                    if (text === 'ROLLBACK') {
                        if (!savepointOpen) return undefined;
                        savepointOpen = false;
                        await client.query('ROLLBACK TO SAVEPOINT app_runtime_mint');
                        return client.query('RELEASE SAVEPOINT app_runtime_mint');
                    }
                    return client.query(text, params);
                },
                release: () => {},
            };
            connectSpy = jest.spyOn(db.pool, 'connect').mockResolvedValue(transactionalClient);
            process.env.APP_RUNTIME_RUN_TOKEN_SECRET = '0123456789abcdef0123456789abcdef';

            const minted = await tokenService.mintRunToken({
                installationId: installationA,
                versionId: versionA.rows[0].id,
                ttlSeconds: 120,
            });
            const claims = tokenService.verifyRunToken(minted.token);
            expect(claims).toMatchObject({
                installation_id: String(installationA),
                version_id: versionA.rows[0].id,
                run_id: minted.runId,
            });
            expect(Object.keys(claims).sort()).toEqual(tokenService.CLAIM_KEYS);
            const stored = await client.query(
                `SELECT company_id, app_id, installation_id, version_id,
                        nonce_sha256, artifact_sha256
                 FROM app_runs
                 WHERE id = $1 AND company_id = $2`,
                [minted.runId, companyA]
            );
            expect(stored.rows[0]).toMatchObject({
                company_id: companyA,
                app_id: appA,
                installation_id: installationA,
                version_id: versionA.rows[0].id,
                artifact_sha256: digest(source),
                nonce_sha256: tokenService.sha256(claims.nonce),
            });
            expect(JSON.stringify(stored.rows[0])).not.toContain(claims.nonce);
            expect(JSON.stringify(stored.rows[0])).not.toContain(minted.token);

            await expect(tokenService.mintRunToken({
                installationId: installationA,
                versionId: versionB.rows[0].id,
                ttlSeconds: 120,
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_INACTIVE', httpStatus: 403 });
        } finally {
            connectSpy?.mockRestore();
            if (previousSecret === undefined) delete process.env.APP_RUNTIME_RUN_TOKEN_SECRET;
            else process.env.APP_RUNTIME_RUN_TOKEN_SECRET = previousSecret;
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
