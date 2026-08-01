'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const identityService = require('../backend/src/services/appRuntimeIdentityService');
const tokenService = require('../backend/src/services/appRuntimeTokenService');
const gatewayService = require('../backend/src/services/appRuntimeGatewayService');
const rateLimit = require('../backend/src/services/appRuntimeRateLimit');
const callMaskingService = require('../backend/src/services/callMaskingService');
const appVersionTransitionModule = require('../backend/src/services/appVersionTransitionService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const MASKING_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '208_call_masking.sql'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '220_app_runtime_gateway.sql'), 'utf8');
const BUILDER_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '221_app_studio_builder.sql'), 'utf8');
const GAP_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '222_app_studio_gap_fixes.sql'), 'utf8');
const ROLE_SEED = fs.readFileSync(path.join(MIGRATIONS, '050_seed_role_configs.sql'), 'utf8');
const TOOLS = ['svc.list_jobs', 'svc.get_job', 'svc.list_tasks'];
const SHARED_SEARCH = `blast-${randomUUID()}`;
const SHARED_PHONE = '+16175550999';
const SHARED_EMAIL = `blast-${randomUUID()}@example.test`;

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
    test('APP-GW-001 tenancy DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-GW-001 tenancy DB tests are pending: ${DATABASE.reason}`);
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
        [id, `APP GW ${label}`, `app-gw-tenancy-${label.toLowerCase()}-${id}`]
    );
    return id;
}

async function insertHuman(client, companyId, label, roleKey) {
    const user = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, $4, 'active', $5,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-gw-${label}-${randomUUID()}`,
            `${label}-${randomUUID()}@example.test`,
            `APP GW ${label}`,
            roleKey === 'tenant_admin' ? 'company_admin' : 'company_member',
            companyId,
        ]
    );
    const membership = await client.query(
        `INSERT INTO company_memberships
            (user_id, company_id, role, role_key, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id`,
        [
            user.rows[0].id,
            companyId,
            roleKey === 'tenant_admin' ? 'company_admin' : 'company_member',
            roleKey,
        ]
    );
    return { id: user.rows[0].id, membershipId: membership.rows[0].id };
}

async function setRole(client, fixture, roleKey) {
    await client.query(
        `UPDATE company_memberships
         SET role = $3, role_key = $4, status = 'active', updated_at = NOW()
         WHERE id = $1 AND company_id = $2`,
        [
            fixture.humanA.membershipId,
            fixture.companyA,
            roleKey === 'tenant_admin' ? 'company_admin' : 'company_member',
            roleKey,
        ]
    );
}

async function configureConsent(client, installationId, versionId) {
    // Prove and guard the PostgreSQL landmine: nested jsonb_set is a no-op when
    // app_runtime does not exist, so writers must create that parent first.
    await client.query(
        `UPDATE marketplace_installations
         SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{app_runtime,version_id}',
             to_jsonb($2::text),
             true
         )
         WHERE id = $1`,
        [installationId, versionId]
    );
    const noOp = await client.query(
        `SELECT metadata->'app_runtime' AS app_runtime
         FROM marketplace_installations WHERE id = $1`,
        [installationId]
    );
    expect(noOp.rows[0].app_runtime).toBeNull();

    await client.query(
        `UPDATE marketplace_installations
         SET metadata = jsonb_set(
             jsonb_set(
                 COALESCE(metadata, '{}'::jsonb),
                 '{app_runtime}',
                 '{}'::jsonb,
                 true
             ),
             '{app_runtime,version_id}',
             to_jsonb($2::text),
             true
         )
         WHERE id = $1`,
        [installationId, versionId]
    );
    await client.query(
        `UPDATE marketplace_installations
         SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{app_runtime,consented_tools}',
             $2::jsonb,
             true
         )
         WHERE id = $1`,
        [installationId, JSON.stringify(TOOLS)]
    );
}

async function setupFixture(client) {
    await client.query(MASKING_SCHEMA);
    await client.query(SCHEMA);
    await client.query(BUILDER_SCHEMA);
    await client.query(GAP_SCHEMA);
    const companyA = await insertCompany(client, 'A');
    const companyB = await insertCompany(client, 'B');
    const humanA = await insertHuman(client, companyA, 'owner-a', 'manager');
    const teammateA = await insertHuman(client, companyA, 'teammate-a', 'provider');
    await insertHuman(client, companyA, 'backup-admin-a', 'tenant_admin');
    const humanB = await insertHuman(client, companyB, 'owner-b', 'manager');
    await client.query(ROLE_SEED);

    const app = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, 'APP GW Tenancy', 'Albusto Test', 'ai', 'private',
                 'APP-GW tenancy test', '[]'::jsonb, 'none', 'published', '{}'::jsonb)
         RETURNING id`,
        [`app-gw-tenancy-${randomUUID()}`]
    );
    const installationRows = await client.query(
        `INSERT INTO marketplace_installations
            (company_id, app_id, status, installed_by, installed_at, metadata)
         VALUES ($1, $3, 'connected', $4, NOW(), '{}'::jsonb),
                ($2, $3, 'connected', $5, NOW(), '{}'::jsonb)
         RETURNING id, company_id`,
        [companyA, companyB, app.rows[0].id, humanA.id, humanB.id]
    );
    const installationA = installationRows.rows.find((row) => row.company_id === companyA).id;
    const installationB = installationRows.rows.find((row) => row.company_id === companyB).id;
    const source = 'module.exports = async function app() { return true; };';
    const version = await client.query(
        `INSERT INTO app_versions
            (app_id, version_number, source_code, source_sha256, status, created_by)
         VALUES ($1, '1.0.0', $2, $3, 'draft', $4)
         RETURNING id`,
        [app.rows[0].id, source, digest(source), humanA.id]
    );
    for (const toolName of TOOLS) {
        await client.query(
            `INSERT INTO app_version_tools (version_id, tool_name) VALUES ($1, $2)`,
            [version.rows[0].id, toolName]
        );
    }
    await client.query(
        `UPDATE app_versions
         SET status = 'published', published_at = NOW()
         WHERE id = $1 AND app_id = $2`,
        [version.rows[0].id, app.rows[0].id]
    );
    await configureConsent(client, installationA, version.rows[0].id);
    await configureConsent(client, installationB, version.rows[0].id);

    const principalA = await identityService.provisionInstallationPrincipal({
        installationId: installationA,
    }, client);
    const principalB = await identityService.provisionInstallationPrincipal({
        installationId: installationB,
    }, client);

    const jobRows = await client.query(
        `INSERT INTO jobs
            (company_id, zenbooker_job_id, job_number, service_name, customer_name,
             customer_phone, customer_email, assigned_provider_user_ids, blanc_status)
         VALUES
            ($1, $3, $6, $6, 'Owned A', $7, $8, $9::jsonb, 'Submitted'),
            ($1, $4, $6, $6, 'Unassigned A', $7, $8, '[]'::jsonb, 'Submitted'),
            ($2, $5, $6, $6, 'Foreign B', $7, $8, $10::jsonb, 'Submitted')
         RETURNING id, company_id, customer_name`,
        [
            companyA,
            companyB,
            `zb-a-owned-${randomUUID()}`,
            `zb-a-unassigned-${randomUUID()}`,
            `zb-b-${randomUUID()}`,
            SHARED_SEARCH,
            SHARED_PHONE,
            SHARED_EMAIL,
            JSON.stringify([humanA.id]),
            JSON.stringify([humanB.id]),
        ]
    );
    const ownedJobA = jobRows.rows.find((row) => row.customer_name === 'Owned A').id;
    const unassignedJobA = jobRows.rows.find((row) => row.customer_name === 'Unassigned A').id;
    const foreignJobB = jobRows.rows.find((row) => row.customer_name === 'Foreign B').id;

    const taskRows = await client.query(
        `INSERT INTO tasks
            (company_id, thread_id, job_id, title, status, owner_user_id,
             author_user_id, created_by)
         VALUES
            ($1, NULL, $3, $6, 'open', $4, $4, 'user'),
            ($1, NULL, $3, $6, 'open', $5, $5, 'user'),
            ($2, NULL, $7, $6, 'open', $8, $8, 'user')
         RETURNING id, company_id, owner_user_id`,
        [
            companyA,
            companyB,
            ownedJobA,
            humanA.id,
            teammateA.id,
            SHARED_SEARCH,
            foreignJobB,
            humanB.id,
        ]
    );

    return {
        companyA,
        companyB,
        humanA,
        teammateA,
        humanB,
        appId: app.rows[0].id,
        installationA,
        installationB,
        versionId: version.rows[0].id,
        artifactSha256: digest(source),
        principalA,
        principalB,
        ownedJobA,
        unassignedJobA,
        foreignJobB,
        ownedTaskA: taskRows.rows.find((row) => row.owner_user_id === humanA.id).id,
        teammateTaskA: taskRows.rows.find((row) => row.owner_user_id === teammateA.id).id,
        foreignTaskB: taskRows.rows.find((row) => row.company_id === companyB).id,
    };
}

async function createRunContext(client, fixture, side = 'A') {
    const principal = side === 'A' ? fixture.principalA : fixture.principalB;
    const companyId = side === 'A' ? fixture.companyA : fixture.companyB;
    const installationId = side === 'A' ? fixture.installationA : fixture.installationB;
    const runId = randomUUID();
    const nonce = crypto.randomBytes(32).toString('base64url');
    await client.query(
        `INSERT INTO app_runs
            (id, company_id, app_id, installation_id, version_id, principal_id,
             artifact_sha256, nonce_sha256, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW() + INTERVAL '5 minutes')`,
        [
            runId,
            companyId,
            fixture.appId,
            installationId,
            fixture.versionId,
            principal.principal.id,
            fixture.artifactSha256,
            tokenService.sha256(nonce),
        ]
    );
    const resolved = await tokenService.resolveRunContext({
        installation_id: String(installationId),
        version_id: String(fixture.versionId),
        run_id: runId,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce,
    });
    return { ...resolved, nonce_for_test: nonce };
}

async function invoke(client, fixture, toolName, args = {}, existingContext = null) {
    const appRuntimeContext = existingContext || await createRunContext(client, fixture);
    const req = {
        requestId: `app-gw-db-${randomUUID()}`,
        appRuntimeContext,
    };
    const data = await gatewayService.execute(req, toolName, args);
    return { data, req, context: appRuntimeContext };
}

async function snapshotCompanyB(client, fixture) {
    const result = await client.query(
        `SELECT jsonb_build_object(
            'jobs', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                     FROM jobs row_value WHERE row_value.company_id = $1),
            'tasks', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                      FROM tasks row_value WHERE row_value.company_id = $1),
            'installations', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                              FROM marketplace_installations row_value WHERE row_value.company_id = $1),
            'principals', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                           FROM app_installation_principals row_value WHERE row_value.company_id = $1),
            'runs', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                     FROM app_runs row_value WHERE row_value.company_id = $1),
            'agents', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                       FROM crm_users row_value WHERE row_value.company_id = $1 AND row_value.kind = 'agent'),
            'audits', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                       FROM audit_log row_value WHERE row_value.company_id = $1 AND row_value.app_id = $2)
        ) AS snapshot`,
        [fixture.companyB, fixture.appId]
    );
    return result.rows[0].snapshot;
}

describe('APP-GW-001 real PostgreSQL gateway matrix', () => {
    databaseTest('SAB company binding + delegator scopes: per-tool T-own/T-foreign/T-blast and R-matrix', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        let maskingSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            rateLimit.resetForTests();

            const bContext = await createRunContext(client, fixture, 'B');
            await client.query(
                `INSERT INTO audit_log
                    (actor_id, action, target_type, target_id, company_id, details,
                     trace_id, app_id, installation_id, app_run_id)
                 VALUES ($1, 'app_runtime.tool_call', 'app_runtime_tool', 'svc.list_jobs',
                         $2, '{}'::jsonb, 'b-snapshot', $3, $4, $5)`,
                [
                    fixture.principalB.agent.id,
                    fixture.companyB,
                    fixture.appId,
                    fixture.installationB,
                    bContext.run_id,
                ]
            );
            const beforeB = await snapshotCompanyB(client, fixture);

            for (const role of ['tenant_admin', 'manager', 'dispatcher']) {
                await setRole(client, fixture, role);
                const jobs = await invoke(client, fixture, 'svc.list_jobs', {
                    search: SHARED_SEARCH,
                    limit: 100,
                });
                expect(jobs.data.results.map((job) => job.id).sort()).toEqual(
                    [fixture.ownedJobA, fixture.unassignedJobA].sort()
                );
                expect(jobs.data.results.every((job) => job.company_id === fixture.companyA)).toBe(true);

                const job = await invoke(client, fixture, 'svc.get_job', {
                    job_id: Number(fixture.ownedJobA),
                });
                expect(job.data.id).toBe(fixture.ownedJobA);

                const tasks = await invoke(client, fixture, 'svc.list_tasks', {
                    search: SHARED_SEARCH,
                    limit: 100,
                });
                expect(tasks.data.tasks.map((task) => task.id).sort()).toEqual(
                    [fixture.ownedTaskA, fixture.teammateTaskA].sort()
                );
                expect(tasks.data.tasks.every((task) => task.company_id === fixture.companyA)).toBe(true);
            }

            await setRole(client, fixture, 'manager');
            await expect(invoke(client, fixture, 'svc.get_job', {
                job_id: Number(fixture.foreignJobB),
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

            const liveDemotionContext = await createRunContext(client, fixture);
            await expect(invoke(client, fixture, 'svc.get_job', {
                job_id: Number(fixture.unassignedJobA),
            }, liveDemotionContext)).resolves.toMatchObject({
                data: { id: fixture.unassignedJobA },
            });
            await setRole(client, fixture, 'provider');
            await expect(invoke(client, fixture, 'svc.get_job', {
                job_id: Number(fixture.unassignedJobA),
            }, liveDemotionContext)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

            const providerJobs = await invoke(client, fixture, 'svc.list_jobs', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(providerJobs.data.results.map((job) => job.id)).toEqual([fixture.ownedJobA]);
            const providerTasks = await invoke(client, fixture, 'svc.list_tasks', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(providerTasks.data.tasks.map((task) => task.id)).toEqual([fixture.ownedTaskA]);

            await client.query(
                `INSERT INTO company_membership_scope_overrides
                    (membership_id, scope_key, scope_json, created_by)
                 VALUES ($1, 'job_visibility', '"unknown_future_scope"'::jsonb, $2)
                 ON CONFLICT (membership_id, scope_key) DO UPDATE
                 SET scope_json = EXCLUDED.scope_json`,
                [fixture.humanA.membershipId, fixture.humanA.id]
            );
            const unknownScope = await invoke(client, fixture, 'svc.list_jobs', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(unknownScope.data.results.map((job) => job.id)).toEqual([fixture.ownedJobA]);
            await client.query(
                `DELETE FROM company_membership_scope_overrides
                 WHERE membership_id = $1 AND scope_key = 'job_visibility'`,
                [fixture.humanA.membershipId]
            );
            await client.query(
                `DELETE FROM company_role_scopes
                 WHERE role_config_id = (
                     SELECT id FROM company_role_configs
                     WHERE company_id = $1 AND role_key = 'provider'
                 ) AND scope_key = 'job_visibility'`,
                [fixture.companyA]
            );
            const missingScope = await invoke(client, fixture, 'svc.list_jobs', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(missingScope.data.results.map((job) => job.id)).toEqual([fixture.ownedJobA]);

            await setRole(client, fixture, 'manager');
            const liveDenyContext = await createRunContext(client, fixture);
            await expect(invoke(client, fixture, 'svc.list_jobs', {}, liveDenyContext)).resolves.toBeDefined();
            await client.query(
                `INSERT INTO company_membership_permission_overrides
                    (membership_id, permission_key, override_mode, created_by)
                 VALUES ($1, 'jobs.view', 'deny', $2)
                 ON CONFLICT (membership_id, permission_key) DO UPDATE
                 SET override_mode = EXCLUDED.override_mode`,
                [fixture.humanA.membershipId, fixture.humanA.id]
            );
            await expect(invoke(client, fixture, 'svc.list_jobs', {}, liveDenyContext))
                .rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
            await client.query(
                `DELETE FROM company_membership_permission_overrides
                 WHERE membership_id = $1 AND permission_key = 'jobs.view'`,
                [fixture.humanA.membershipId]
            );
            await client.query(
                `INSERT INTO company_membership_permission_overrides
                    (membership_id, permission_key, override_mode, created_by)
                 VALUES ($1, 'tasks.view', 'deny', $2)`,
                [fixture.humanA.membershipId, fixture.humanA.id]
            );
            await expect(invoke(client, fixture, 'svc.list_tasks', {}))
                .rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
            await client.query(
                `DELETE FROM company_membership_permission_overrides
                 WHERE membership_id = $1 AND permission_key = 'tasks.view'`,
                [fixture.humanA.membershipId]
            );

            await setRole(client, fixture, 'provider');
            maskingSpy = jest.spyOn(callMaskingService, 'getActiveSettings')
                .mockResolvedValue({ call_masking_enabled: true, call_masking_number: '+16174044425' });
            const masked = await invoke(client, fixture, 'svc.list_jobs', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(JSON.stringify(masked.data)).not.toContain(SHARED_PHONE);
            expect(masked.data.results[0]).not.toHaveProperty('customer_phone');
            maskingSpy.mockRejectedValueOnce(new Error('settings unavailable'));
            const failedClosed = await invoke(client, fixture, 'svc.get_job', {
                job_id: Number(fixture.ownedJobA),
            });
            expect(JSON.stringify(failedClosed.data)).not.toContain(SHARED_PHONE);

            const afterB = await snapshotCompanyB(client, fixture);
            expect(afterB).toEqual(beforeB);

            const audits = await client.query(
                `SELECT actor_id, company_id, app_id, installation_id, app_run_id,
                        target_id, details
                 FROM audit_log
                 WHERE company_id = $1
                   AND app_id = $2
                   AND trace_id LIKE 'app-gw-db-%'
                 ORDER BY id`,
                [fixture.companyA, fixture.appId]
            );
            expect(audits.rows.length).toBeGreaterThan(15);
            expect(audits.rows.every((row) => (
                row.actor_id === fixture.principalA.agent.id
                && row.company_id === fixture.companyA
                && row.app_id === fixture.appId
                && row.installation_id === fixture.installationA
                && row.app_run_id
                && TOOLS.includes(row.target_id)
            ))).toBe(true);
            const auditJson = JSON.stringify(audits.rows);
            expect(auditJson).not.toContain(SHARED_PHONE);
            expect(auditJson).not.toContain(SHARED_EMAIL);
            expect(auditJson).not.toContain(SHARED_SEARCH);
            expect(auditJson).not.toMatch(/nonce|source_code|arguments|response_data|token/i);
        } finally {
            maskingSpy?.mockRestore();
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            rateLimit.resetForTests();
        }
    });

    databaseTest('SAB APP-GAP-F5 consume-time revocation + run/daily ceilings + live kill states', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            const context = await createRunContext(client, fixture);

            await expect(tokenService.resolveRunContext({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: context.run_id,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: crypto.randomBytes(32).toString('base64url'),
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_TOKEN_INVALID', httpStatus: 401 });
            await expect(tokenService.resolveRunContext({
                installation_id: String(fixture.installationB),
                version_id: String(fixture.versionId),
                run_id: context.run_id,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: 'a'.repeat(43),
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_TOKEN_INVALID', httpStatus: 401 });

            const outcomes = await Promise.allSettled(
                Array.from({ length: 6 }, () => tokenService.consumeRunCall(context))
            );
            expect(outcomes.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value).sort())
                .toEqual([1, 2, 3, 4, 5]);
            expect(outcomes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
            expect(outcomes.find((entry) => entry.status === 'rejected').reason)
                .toMatchObject({ code: 'RUN_CALL_LIMIT', httpStatus: 429 });
            const stored = await client.query(
                `SELECT status, gateway_calls_used, gateway_call_limit
                 FROM app_runs WHERE id = $1 AND company_id = $2`,
                [context.run_id, fixture.companyA]
            );
            expect(stored.rows[0]).toEqual({
                status: 'exhausted', gateway_calls_used: 5, gateway_call_limit: 5,
            });

            const completed = await createRunContext(client, fixture);
            await tokenService.recordRunCompletion({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: completed.run_id,
                nonce: completed.nonce_for_test,
            }, {
                wall_ms: 41,
                gateway_calls: 0,
                result_bytes: 17,
                error_code: null,
            });
            const storedCompletion = await client.query(
                `SELECT status, wall_ms, gateway_calls_made, result_bytes, error_code,
                        completed_at IS NOT NULL AS has_completed_at
                 FROM app_runs
                 WHERE id = $1 AND company_id = $2`,
                [completed.run_id, fixture.companyA]
            );
            expect(storedCompletion.rows[0]).toEqual({
                status: 'completed',
                wall_ms: '41',
                gateway_calls_made: 0,
                result_bytes: 17,
                error_code: null,
                has_completed_at: true,
            });

            await client.query(
                `DELETE FROM app_runtime_usage
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_gateway_call_limit = 2,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            const dailyLimited = await createRunContext(client, fixture);
            await expect(tokenService.consumeRunCall(dailyLimited)).resolves.toBe(1);
            await expect(tokenService.consumeRunCall(dailyLimited)).resolves.toBe(2);
            await expect(tokenService.consumeRunCall(dailyLimited)).rejects.toMatchObject({
                code: 'APP_RUNTIME_SUSPENDED', httpStatus: 403,
            });
            const dailyUsage = await client.query(
                `SELECT usage.gateway_calls_used, usage.daily_gateway_call_limit,
                        control.suspension_reason
                 FROM app_runtime_usage usage
                 JOIN app_runtime_installation_controls control
                   ON control.company_id = usage.company_id
                  AND control.app_id = usage.app_id
                  AND control.installation_id = usage.installation_id
                 WHERE usage.company_id = $1
                   AND usage.installation_id = $2
                   AND usage.usage_date = (NOW() AT TIME ZONE 'UTC')::date`,
                [fixture.companyA, fixture.installationA]
            );
            expect(dailyUsage.rows[0]).toEqual({
                gateway_calls_used: 2,
                daily_gateway_call_limit: 2,
                suspension_reason: 'DAILY_GATEWAY_CALL_LIMIT',
            });
            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_gateway_call_limit = 1000,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );

            const killCases = [
                {
                    name: 'run revoked',
                    breakSql: `UPDATE app_runs SET status='revoked', revoked_at=NOW() WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE app_runs SET status='issued', revoked_at=NULL, gateway_calls_used=0 WHERE id=$1 AND company_id=$2`,
                    params: (live) => [live.run_id, fixture.companyA],
                },
                {
                    name: 'principal revoked',
                    breakSql: `UPDATE app_installation_principals SET status='revoked', revoked_at=NOW() WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE app_installation_principals SET status='active', revoked_at=NULL WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.principalA.principal.id, fixture.companyA],
                },
                {
                    name: 'agent disabled',
                    breakSql: `UPDATE crm_users SET status='disabled' WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE crm_users SET status='active' WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.principalA.agent.id, fixture.companyA],
                },
                {
                    name: 'version revoked',
                    breakSql: `UPDATE app_versions SET status='revoked' WHERE id=$1 AND app_id=$2`,
                    restoreSql: `UPDATE app_versions SET status='published' WHERE id=$1 AND app_id=$2`,
                    params: () => [fixture.versionId, fixture.appId],
                },
                {
                    name: 'installation disconnected',
                    breakSql: `UPDATE marketplace_installations SET status='disconnected' WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE marketplace_installations SET status='connected' WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.installationA, fixture.companyA],
                },
                {
                    name: 'app disabled',
                    breakSql: `UPDATE marketplace_apps SET status='disabled' WHERE id=$1`,
                    restoreSql: `UPDATE marketplace_apps SET status='published' WHERE id=$1`,
                    params: () => [fixture.appId],
                },
                {
                    name: 'company suspended',
                    breakSql: `UPDATE companies SET status='suspended' WHERE id=$1`,
                    restoreSql: `UPDATE companies SET status='active' WHERE id=$1`,
                    params: () => [fixture.companyA],
                },
                {
                    name: 'delegator disabled',
                    breakSql: `UPDATE crm_users SET status='disabled' WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE crm_users SET status='active' WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.humanA.id, fixture.companyA],
                },
                {
                    name: 'membership disabled',
                    breakSql: `UPDATE company_memberships SET status='disabled' WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE company_memberships SET status='active' WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.humanA.membershipId, fixture.companyA],
                },
                {
                    name: 'installer cleared',
                    breakSql: `UPDATE marketplace_installations SET installed_by=NULL WHERE id=$1 AND company_id=$2 AND $3::uuid IS NOT NULL`,
                    restoreSql: `UPDATE marketplace_installations SET installed_by=$3 WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.installationA, fixture.companyA, fixture.humanA.id],
                },
            ];

            for (const killCase of killCases) {
                const live = await createRunContext(client, fixture);
                const params = killCase.params(live);
                await client.query(killCase.breakSql, params);
                await expect(tokenService.consumeRunCall(live)).rejects.toMatchObject({
                    code: 'APP_RUNTIME_INACTIVE', httpStatus: 403,
                });
                await expect(tokenService.resolveRunContext({
                    installation_id: String(fixture.installationA),
                    version_id: String(fixture.versionId),
                    run_id: live.run_id,
                    exp: Math.floor(Date.now() / 1000) + 300,
                    nonce: live.nonce_for_test,
                })).rejects.toMatchObject({ code: 'APP_RUNTIME_INACTIVE', httpStatus: 403 });
                await client.query(killCase.restoreSql, params);
            }

        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('F6 membership deletion succeeds and the already-resolved next call fails closed', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            const live = await createRunContext(client, fixture);
            const deleted = await client.query(
                `DELETE FROM company_memberships
                 WHERE id = $1 AND company_id = $2
                 RETURNING id`,
                [fixture.humanA.membershipId, fixture.companyA]
            );
            expect(deleted.rows).toHaveLength(1);
            await expect(tokenService.consumeRunCall(live)).rejects.toMatchObject({
                code: 'APP_RUNTIME_INACTIVE', httpStatus: 403,
            });
            const orphanedPrincipal = await client.query(
                `SELECT delegated_by_user_id
                 FROM app_installation_principals
                 WHERE id = $1 AND company_id = $2`,
                [fixture.principalA.principal.id, fixture.companyA]
            );
            expect(orphanedPrincipal.rows[0].delegated_by_user_id).toBe(fixture.humanA.id);
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('F2 PostgreSQL usage ceiling auto-suspends and app_runs stores completion metrics', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_gateway_call_limit = 2,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            const metered = await createRunContext(client, fixture);
            const completed = await createRunContext(client, fixture);
            await expect(tokenService.consumeRunCall(metered)).resolves.toBe(1);
            await expect(tokenService.consumeRunCall(metered)).resolves.toBe(2);
            await expect(tokenService.consumeRunCall(metered)).rejects.toMatchObject({
                code: 'APP_RUNTIME_SUSPENDED', httpStatus: 403,
            });
            await tokenService.recordRunCompletion({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: completed.run_id,
                nonce: completed.nonce_for_test,
            }, {
                wall_ms: 29,
                gateway_calls: 0,
                result_bytes: null,
                error_code: 'APP_RUNTIME_SUSPENDED',
            });
            const accounting = await client.query(
                `SELECT usage.gateway_calls_used,
                        usage.daily_gateway_call_limit,
                        control.suspension_reason,
                        run.wall_ms,
                        run.gateway_calls_made,
                        run.result_bytes,
                        run.error_code,
                        run.status
                 FROM app_runtime_usage usage
                 JOIN app_runtime_installation_controls control
                   ON control.company_id = usage.company_id
                  AND control.app_id = usage.app_id
                  AND control.installation_id = usage.installation_id
                 JOIN app_runs run
                   ON run.company_id = usage.company_id
                  AND run.app_id = usage.app_id
                  AND run.installation_id = usage.installation_id
                  AND run.id = $3
                 WHERE usage.company_id = $1
                   AND usage.installation_id = $2
                   AND usage.usage_date = (NOW() AT TIME ZONE 'UTC')::date`,
                [fixture.companyA, fixture.installationA, completed.run_id]
            );
            expect(accounting.rows[0]).toEqual({
                gateway_calls_used: 2,
                daily_gateway_call_limit: 2,
                suspension_reason: 'DAILY_GATEWAY_CALL_LIMIT',
                wall_ms: '29',
                gateway_calls_made: 0,
                result_bytes: null,
                error_code: 'APP_RUNTIME_SUSPENDED',
                status: 'failed',
            });
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('APP-MOD-001 revoke kill-switch makes the next gateway resolution return 403', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            await client.query(
                `INSERT INTO app_studio_apps (app_id, company_id, created_by)
                 VALUES ($1, $2, $3)`,
                [fixture.appId, fixture.companyA, fixture.humanA.id]
            );
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => (
                client.query(text, params)
            ));
            const live = await createRunContext(client, fixture);
            let savepointOpen = false;
            const transitionDatabase = {
                getClient: async () => ({
                    query: async (text, params) => {
                        if (text === 'BEGIN') {
                            savepointOpen = true;
                            return client.query('SAVEPOINT app_mod_revoke');
                        }
                        if (text === 'COMMIT') {
                            savepointOpen = false;
                            return client.query('RELEASE SAVEPOINT app_mod_revoke');
                        }
                        if (text === 'ROLLBACK') {
                            if (!savepointOpen) return undefined;
                            savepointOpen = false;
                            return client.query('ROLLBACK TO SAVEPOINT app_mod_revoke');
                        }
                        return client.query(text, params);
                    },
                    release: jest.fn(),
                }),
            };
            const transitionService = appVersionTransitionModule
                .createAppVersionTransitionService({ database: transitionDatabase });
            await expect(transitionService.revokeVersion({
                versionId: fixture.versionId,
                actorId: fixture.humanA.id,
                traceId: 'trace-app-mod-revoke',
            })).resolves.toMatchObject({ status: 'revoked' });

            await expect(tokenService.resolveRunContext({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: live.run_id,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: live.nonce_for_test,
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_INACTIVE', httpStatus: 403 });
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
