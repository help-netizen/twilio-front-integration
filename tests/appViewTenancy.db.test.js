'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const { createAppExecutionService } = require('../backend/src/services/appExecutionService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const RUNTIME_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '220_app_runtime_gateway.sql'), 'utf8');
const GAP_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '222_app_studio_gap_fixes.sql'), 'utf8');
const MODERATION_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '223_app_version_moderation.sql'), 'utf8');
const EXECUTION_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '224_app_runtime_execution_authorization.sql'),
    'utf8'
);
const VIEW_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '228_app_view_phase_a.sql'), 'utf8');
const VIEW_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_228_app_view_phase_a.sql'),
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
    test('APP-VIEW-001 tenancy DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-VIEW-001 tenancy DB tests are pending: ${DATABASE.reason}`);
    });
}

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function createCompany(client, label) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [id, `APP VIEW ${label}`, `app-view-${label.toLowerCase()}-${id}`]
    );
    return id;
}

async function createHuman(client, companyId, label) {
    const user = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, 'company_member', 'active', $4,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-view-human-${label}-${randomUUID()}`,
            `app-view-${label}-${randomUUID()}@example.test`,
            `APP VIEW ${label}`,
            companyId,
        ]
    );
    await client.query(
        `INSERT INTO company_memberships
            (user_id, company_id, role, role_key, status)
         VALUES ($1, $2, 'company_member', 'dispatcher', 'active')`,
        [user.rows[0].id, companyId]
    );
    return user.rows[0].id;
}

async function createFixture(client, label) {
    const companyId = await createCompany(client, label);
    const humanId = await createHuman(client, companyId, label);
    const app = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, $2, 'Albusto Test', 'ai', 'private', 'APP-VIEW test app',
                 '[]'::jsonb, 'none', 'published', '{}'::jsonb)
         RETURNING id`,
        [`app-view-${label}-${randomUUID()}`, `APP VIEW ${label}`]
    );
    const source = 'export async function run() { return { view_version: 1, title: "Safe", blocks: [] }; }';
    const version = await client.query(
        `INSERT INTO app_versions
            (app_id, version_number, source_code, source_sha256, status, created_by)
         VALUES ($1, '1.0.0', $2, $3, 'draft', $4)
         RETURNING id`,
        [app.rows[0].id, source, digest(source), humanId]
    );
    await client.query(
        `INSERT INTO app_version_tools (version_id, tool_name)
         VALUES ($1, 'svc.list_jobs')`,
        [version.rows[0].id]
    );
    await client.query(`SELECT set_config('app.version_transition_service', 'enabled', true)`);
    for (const status of ['submitted', 'in_review', 'approved', 'published']) {
        await client.query(
            `UPDATE app_versions SET status = $2, updated_at = NOW() WHERE id = $1`,
            [version.rows[0].id, status]
        );
    }
    const installation = await client.query(
        `INSERT INTO marketplace_installations
            (company_id, app_id, status, installed_by, installed_at, metadata)
         VALUES ($1, $2, 'connected', $3, NOW(), $4::jsonb)
         RETURNING id`,
        [
            companyId,
            app.rows[0].id,
            humanId,
            JSON.stringify({
                app_runtime: {
                    version_id: version.rows[0].id,
                    consented_tools: ['svc.list_jobs'],
                },
            }),
        ]
    );
    const agent = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, 'company_member', 'active', $4,
                 'none', 'active', 'agent')
         RETURNING id`,
        [
            `agent:app-view:${installation.rows[0].id}:${randomUUID()}`,
            `app-view-agent-${randomUUID()}@albusto.invalid`,
            `APP VIEW Agent ${label}`,
            companyId,
        ]
    );
    const principal = await client.query(
        `INSERT INTO app_installation_principals
            (company_id, app_id, installation_id, agent_user_id,
             delegated_by_user_id, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING id`,
        [
            companyId,
            app.rows[0].id,
            installation.rows[0].id,
            agent.rows[0].id,
            humanId,
        ]
    );
    return {
        companyId,
        humanId,
        appId: app.rows[0].id,
        versionId: version.rows[0].id,
        installationId: installation.rows[0].id,
        principalId: principal.rows[0].id,
        sourceSha256: digest(source),
    };
}

async function createCompletedRun(client, fixture, createdAt, title, { store = true } = {}) {
    const runId = randomUUID();
    await client.query(
        `INSERT INTO app_runs
            (id, company_id, app_id, installation_id, version_id, principal_id,
             artifact_sha256, nonce_sha256, status, gateway_calls_used,
             gateway_call_limit, issued_at, expires_at, execution_authorized_at,
             wall_ms, gateway_calls_made, result_bytes, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', 1,
                 5, $9::timestamptz, $9::timestamptz + INTERVAL '5 minutes',
                 $9::timestamptz, 10, 1, 48, $9::timestamptz, $9::timestamptz)`,
        [
            runId,
            fixture.companyId,
            fixture.appId,
            fixture.installationId,
            fixture.versionId,
            fixture.principalId,
            fixture.sourceSha256,
            digest(`nonce-${runId}`),
            createdAt,
        ]
    );
    if (store) {
        await client.query(
            `INSERT INTO app_run_results
                (run_id, company_id, installation_id, view_document, created_at)
             VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [
                runId,
                fixture.companyId,
                fixture.installationId,
                JSON.stringify({ view_version: 1, title, blocks: [] }),
                createdAt,
            ]
        );
    }
    return runId;
}

function transactionDatabase(client) {
    let savepoint = 0;
    const wrapped = {
        query: async (sql, params) => {
            if (sql === 'BEGIN') {
                savepoint += 1;
                return client.query(`SAVEPOINT app_view_service_${savepoint}`);
            }
            if (sql === 'COMMIT') {
                return client.query(`RELEASE SAVEPOINT app_view_service_${savepoint}`);
            }
            if (sql === 'ROLLBACK') {
                return client.query(`ROLLBACK TO SAVEPOINT app_view_service_${savepoint}`);
            }
            return client.query(sql, params);
        },
        release: () => {},
    };
    return {
        getClient: async () => wrapped,
        query: (sql, params) => client.query(sql, params),
    };
}

describe('APP-VIEW-001 result retention and tenant isolation', () => {
    test('migration and rollback declare tenant-paired result ownership', () => {
        expect(VIEW_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS app_run_results');
        expect(VIEW_SCHEMA).toContain('fk_app_run_results_run');
        expect(VIEW_SCHEMA).toContain('fk_marketplace_installations_latest_run');
        expect(VIEW_SCHEMA).toContain('ADD COLUMN IF NOT EXISTS latest_run_id UUID');
        expect(VIEW_ROLLBACK).toContain('DROP TABLE IF EXISTS app_run_results');
        expect(VIEW_ROLLBACK).toContain('DROP COLUMN IF EXISTS latest_run_id');
    });

    databaseTest('migration forward, rollback and forward are executable and idempotent', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(RUNTIME_SCHEMA);
            await client.query(GAP_SCHEMA);
            await client.query(VIEW_SCHEMA);
            await client.query(VIEW_SCHEMA);
            await client.query(VIEW_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT to_regclass('app_run_results')::text AS results,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'marketplace_installations'
                              AND column_name = 'latest_run_id'
                        ) AS has_latest`
            );
            expect(rolledBack.rows[0]).toEqual({ results: null, has_latest: false });
            await client.query(VIEW_SCHEMA);
            const restored = await client.query(
                `SELECT to_regclass('app_run_results')::text AS results,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'marketplace_installations'
                              AND column_name = 'latest_run_id'
                        ) AS has_latest`
            );
            expect(restored.rows[0]).toEqual({
                results: 'app_run_results',
                has_latest: true,
            });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('T-own/T-foreign/T-blast: the 51st result evicts only its tenant oldest row and latest stays company-bound', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(RUNTIME_SCHEMA);
            await client.query(GAP_SCHEMA);
            await client.query(MODERATION_SCHEMA);
            await client.query(EXECUTION_SCHEMA);
            await client.query(VIEW_SCHEMA);
            const companyA = await createFixture(client, 'A');
            const companyB = await createFixture(client, 'B');

            const runIds = [];
            for (let index = 0; index < 50; index += 1) {
                runIds.push(await createCompletedRun(
                    client,
                    companyA,
                    new Date(Date.UTC(2026, 6, 1, 0, index)),
                    `Company A result ${index + 1}`
                ));
            }
            await client.query(
                `UPDATE marketplace_installations
                 SET latest_run_id = $3
                 WHERE company_id = $1 AND id = $2`,
                [companyA.companyId, companyA.installationId, runIds[49]]
            );
            const companyBRun = await createCompletedRun(
                client,
                companyB,
                new Date(Date.UTC(2026, 3, 1, 2, 0)),
                'Company B sentinel'
            );
            await client.query(
                `UPDATE marketplace_installations
                 SET latest_run_id = $3
                 WHERE company_id = $1 AND id = $2`,
                [companyB.companyId, companyB.installationId, companyBRun]
            );
            const beforeB = await client.query(
                `SELECT to_jsonb(result) AS snapshot
                 FROM app_run_results result
                 WHERE result.company_id = $1
                   AND result.installation_id = $2
                   AND result.run_id = $3`,
                [companyB.companyId, companyB.installationId, companyBRun]
            );
            const newestRun = await createCompletedRun(
                client,
                companyA,
                new Date(Date.UTC(2026, 7, 1, 12, 0)),
                'Company A newest',
                { store: false }
            );
            const authorization = {
                resolveCompanyUserAuthz: jest.fn().mockResolvedValue({
                    role_key: 'dispatcher',
                    permissions: ['jobs.view'],
                }),
            };
            const service = createAppExecutionService({
                database: transactionDatabase(client),
                authorization,
            });
            await service.persistSuccessfulResult({
                companyId: companyA.companyId,
                installationId: String(companyA.installationId),
                runId: newestRun,
                viewDocument: { view_version: 1, title: 'Company A newest', blocks: [] },
            });

            const retainedA = await client.query(
                `SELECT run_id
                 FROM app_run_results
                 WHERE company_id = $1 AND installation_id = $2
                 ORDER BY created_at, run_id`,
                [companyA.companyId, companyA.installationId]
            );
            expect(retainedA.rows).toHaveLength(50);
            expect(retainedA.rows.map(row => row.run_id)).not.toContain(runIds[0]);
            expect(retainedA.rows.map(row => row.run_id)).toContain(newestRun);
            const pointerA = await client.query(
                `SELECT latest_run_id
                 FROM marketplace_installations
                 WHERE company_id = $1 AND id = $2`,
                [companyA.companyId, companyA.installationId]
            );
            expect(pointerA.rows[0].latest_run_id).toBe(newestRun);

            await expect(service.getLatestResult({
                companyId: companyA.companyId,
                installationId: String(companyA.installationId),
                actorId: companyA.humanId,
            })).resolves.toMatchObject({
                run_id: newestRun,
                view_document: { title: 'Company A newest' },
            });
            await expect(service.getLatestResult({
                companyId: companyB.companyId,
                installationId: String(companyA.installationId),
                actorId: companyB.humanId,
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

            const afterB = await client.query(
                `SELECT to_jsonb(result) AS snapshot
                 FROM app_run_results result
                 WHERE result.company_id = $1
                   AND result.installation_id = $2
                   AND result.run_id = $3`,
                [companyB.companyId, companyB.installationId, companyBRun]
            );
            expect(afterB.rows[0].snapshot).toEqual(beforeB.rows[0].snapshot);

            const companyBNewest = await createCompletedRun(
                client,
                companyB,
                new Date(Date.UTC(2026, 7, 1, 13, 0)),
                'Company B newest',
                { store: false }
            );
            await service.persistSuccessfulResult({
                companyId: companyB.companyId,
                installationId: String(companyB.installationId),
                runId: companyBNewest,
                viewDocument: { view_version: 1, title: 'Company B newest', blocks: [] },
            });
            const retainedB = await client.query(
                `SELECT run_id
                 FROM app_run_results
                 WHERE company_id = $1 AND installation_id = $2`,
                [companyB.companyId, companyB.installationId]
            );
            expect(retainedB.rows).toEqual([{ run_id: companyBNewest }]);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
