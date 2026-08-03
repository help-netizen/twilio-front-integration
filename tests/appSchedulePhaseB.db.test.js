'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const { createAppScheduleService } = require('../backend/src/services/appScheduleService');
const { createAppScheduleWorker } = require('../backend/src/services/appScheduleWorker');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const RUNTIME_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '220_app_runtime_gateway.sql'), 'utf8');
const GAP_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '222_app_studio_gap_fixes.sql'), 'utf8');
const MODERATION_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '223_app_version_moderation.sql'), 'utf8');
const EXECUTION_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '224_app_runtime_execution_authorization.sql'),
    'utf8'
);
const VIEW_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '228_app_view_phase_a.sql'), 'utf8');
const SCHEDULE_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '234_app_view_phase_b.sql'), 'utf8');
const SCHEDULE_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_234_app_view_phase_b.sql'),
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
    test('APP-VIEW-001 Phase B DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-VIEW-001 Phase B DB tests are pending: ${DATABASE.reason}`);
    });
}

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function applyPrerequisites(client) {
    await client.query(RUNTIME_SCHEMA);
    await client.query(GAP_SCHEMA);
    await client.query(MODERATION_SCHEMA);
    await client.query(EXECUTION_SCHEMA);
    await client.query(VIEW_SCHEMA);
    await client.query(SCHEDULE_SCHEMA);
}

async function createCompany(client, label) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [id, `APP SCHEDULE ${label}`, `app-schedule-${label.toLowerCase()}-${id}`]
    );
    return id;
}

async function createHuman(client, companyId, label) {
    const { rows } = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, 'company_member', 'active', $4,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-schedule-${label}-${randomUUID()}`,
            `app-schedule-${label}-${randomUUID()}@example.test`,
            `APP SCHEDULE ${label}`,
            companyId,
        ]
    );
    await client.query(
        `INSERT INTO company_memberships
            (user_id, company_id, role, role_key, status)
         VALUES ($1, $2, 'company_member', 'dispatcher', 'active')`,
        [rows[0].id, companyId]
    );
    return rows[0].id;
}

async function createPublishedVersion(client, appId, actorId, number, publishedAt, suggested) {
    const source = `export async function run() { return { view_version: 1, title: '${number}', blocks: [] }; }`;
    const { rows } = await client.query(
        `INSERT INTO app_versions
            (app_id, version_number, source_code, source_sha256,
             scanner_report, suggested_schedule, status, created_by)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5::jsonb, 'draft', $6)
         RETURNING id`,
        [
            appId,
            number,
            source,
            digest(source),
            suggested ? JSON.stringify(suggested) : null,
            actorId,
        ]
    );
    await client.query(
        `INSERT INTO app_version_tools (version_id, tool_name)
         VALUES ($1, 'svc.list_jobs')`,
        [rows[0].id]
    );
    await client.query(`SELECT set_config('app.version_transition_service', 'enabled', true)`);
    for (const status of ['submitted', 'in_review', 'approved']) {
        await client.query(
            `UPDATE app_versions SET status = $2, updated_at = NOW() WHERE id = $1`,
            [rows[0].id, status]
        );
    }
    await client.query(
        `UPDATE app_versions
         SET status = 'published', published_at = $2::timestamptz, updated_at = NOW()
         WHERE id = $1`,
        [rows[0].id, publishedAt]
    );
    return rows[0].id;
}

async function createFixture(client, label) {
    const companyId = await createCompany(client, label);
    const actorId = await createHuman(client, companyId, label);
    const app = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, $2, 'Albusto Test', 'ai', 'private', 'Phase B test app',
                 '[]'::jsonb, 'none', 'published', '{}'::jsonb)
         RETURNING id`,
        [`app-schedule-${label}-${randomUUID()}`, `Phase B ${label}`]
    );
    const currentVersionId = await createPublishedVersion(
        client,
        app.rows[0].id,
        actorId,
        '1.0.0',
        '2026-07-01T12:00:00.000Z',
        { kind: 'daily', at: '07:00' }
    );
    const availableVersionId = await createPublishedVersion(
        client,
        app.rows[0].id,
        actorId,
        '2.0.0',
        '2026-08-01T12:00:00.000Z',
        { kind: 'hourly', minute: 5 }
    );
    const installation = await client.query(
        `INSERT INTO marketplace_installations
            (company_id, app_id, status, installed_by, installed_at, metadata)
         VALUES ($1, $2, 'connected', $3, NOW(), $4::jsonb)
         RETURNING id`,
        [
            companyId,
            app.rows[0].id,
            actorId,
            JSON.stringify({
                app_runtime: {
                    version_id: currentVersionId,
                    consented_tools: ['svc.list_jobs'],
                },
            }),
        ]
    );
    return {
        companyId,
        actorId,
        appId: app.rows[0].id,
        installationId: installation.rows[0].id,
        currentVersionId,
        availableVersionId,
    };
}

function transactionDatabase(client) {
    let savepoint = 0;
    return {
        getClient: async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN') {
                    savepoint += 1;
                    return client.query(`SAVEPOINT app_schedule_service_${savepoint}`);
                }
                if (sql === 'COMMIT') {
                    return client.query(`RELEASE SAVEPOINT app_schedule_service_${savepoint}`);
                }
                if (sql === 'ROLLBACK') {
                    return client.query(`ROLLBACK TO SAVEPOINT app_schedule_service_${savepoint}`);
                }
                return client.query(sql, params);
            },
            release: () => {},
        }),
        query: (sql, params) => client.query(sql, params),
    };
}

function permissiveExecution() {
    return { requireViewerAccess: jest.fn().mockResolvedValue({ role_key: 'dispatcher' }) };
}

describe('APP-VIEW-001 Phase B database boundaries', () => {
    databaseTest('6. two workers contend on one due row with SKIP LOCKED and execute exactly once', async () => {
        const admin = await db.pool.connect();
        const schema = `app_schedule_race_${randomUUID().replace(/-/g, '')}`;
        const quoted = `"${schema}"`;
        try {
            await admin.query(`CREATE SCHEMA ${quoted}`);
            await admin.query(`SET search_path TO ${quoted}, public`);
            await admin.query(`
                CREATE TABLE companies (
                    id UUID PRIMARY KEY, status TEXT NOT NULL, timezone TEXT NOT NULL
                );
                CREATE TABLE marketplace_apps (
                    id BIGINT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL
                );
                CREATE TABLE marketplace_installations (
                    id BIGINT PRIMARY KEY, company_id UUID NOT NULL,
                    app_id BIGINT NOT NULL, status TEXT NOT NULL, installed_by UUID
                );
                CREATE TABLE app_installation_schedules (
                    installation_id BIGINT PRIMARY KEY, company_id UUID NOT NULL,
                    enabled BOOLEAN NOT NULL, cadence JSONB, next_run_at TIMESTAMPTZ,
                    last_run_at TIMESTAMPTZ, last_status TEXT, failure_count INTEGER,
                    suspended_reason TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            const companyId = randomUUID();
            const actorId = randomUUID();
            const tickNow = new Date('2026-08-02T12:00:00.000Z');
            await admin.query(
                `INSERT INTO companies VALUES ($1, 'active', 'America/New_York')`,
                [companyId]
            );
            await admin.query(
                `INSERT INTO marketplace_apps VALUES (1, 'Race app', 'published')`
            );
            await admin.query(
                `INSERT INTO marketplace_installations VALUES (91, $1, 1, 'connected', $2)`,
                [companyId, actorId]
            );
            await admin.query(
                `INSERT INTO app_installation_schedules
                    (installation_id, company_id, enabled, cadence, next_run_at,
                     last_status, failure_count)
                 VALUES (91, $1, true, '{"kind":"every_minutes","n":1}'::jsonb,
                         $2::timestamptz - INTERVAL '2 hours', 'pending', 0)`,
                [companyId, tickNow]
            );

            const scopedDatabase = {
                getClient: async () => {
                    const client = await db.pool.connect();
                    await client.query(`SET search_path TO ${quoted}, public`);
                    return client;
                },
                query: async (sql, params) => {
                    const client = await db.pool.connect();
                    try {
                        await client.query(`SET search_path TO ${quoted}, public`);
                        return await client.query(sql, params);
                    } finally {
                        client.release();
                    }
                },
            };
            const execution = {
                run: jest.fn().mockResolvedValue({ status: 'completed' }),
            };
            const workerA = createAppScheduleWorker({ database: scopedDatabase, execution });
            const workerB = createAppScheduleWorker({ database: scopedDatabase, execution });
            const results = await Promise.all([workerA.tick(tickNow), workerB.tick(tickNow)]);

            expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
            expect(execution.run).toHaveBeenCalledTimes(1);
            const stored = await admin.query(
                `SELECT last_status, next_run_at FROM app_installation_schedules WHERE installation_id = 91`
            );
            expect(stored.rows[0].last_status).toBe('succeeded');
            expect(new Date(stored.rows[0].next_run_at).getTime()).toBeGreaterThan(tickNow.getTime());
        } finally {
            await admin.query('RESET search_path').catch(() => {});
            await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
            admin.release();
        }
    });

    databaseTest('the third real PostgreSQL failure update disables the schedule and inserts a CRM task', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await applyPrerequisites(client);
            const fixture = await createFixture(client, 'FAILURES');
            await client.query(
                `INSERT INTO app_installation_schedules
                    (installation_id, company_id, enabled, cadence, next_run_at,
                     last_status, failure_count)
                 VALUES ($2, $1, true, '{"kind":"every_minutes","n":1}'::jsonb,
                         '2026-08-02T12:01:00.000Z', 'pending', 0)`,
                [fixture.companyId, fixture.installationId]
            );
            const worker = createAppScheduleWorker({
                database: transactionDatabase(client),
                execution: {
                    run: jest.fn().mockRejectedValue(Object.assign(new Error('Runner failed'), {
                        code: 'APP_RUNNER_UNAVAILABLE',
                    })),
                },
            });
            for (let index = 0; index < 3; index += 1) {
                const claimedAt = new Date(Date.UTC(2026, 7, 2, 12, index));
                const claimedNextRunAt = new Date(claimedAt.getTime() + 60_000);
                await client.query(
                    `UPDATE app_installation_schedules
                     SET enabled = true, last_status = 'running',
                         last_run_at = $3, next_run_at = $4
                     WHERE company_id = $1 AND installation_id = $2`,
                    [fixture.companyId, fixture.installationId, claimedAt, claimedNextRunAt]
                );
                await worker.executeClaim({
                    installation_id: fixture.installationId,
                    company_id: fixture.companyId,
                    actor_id: fixture.actorId,
                    app_name: 'Phase B FAILURES',
                    claimed_at: claimedAt,
                    claimed_next_run_at: claimedNextRunAt,
                });
            }
            const schedule = await client.query(
                `SELECT enabled, next_run_at, last_status, failure_count, suspended_reason
                 FROM app_installation_schedules
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyId, fixture.installationId]
            );
            expect(schedule.rows[0]).toEqual({
                enabled: false,
                next_run_at: null,
                last_status: 'suspended',
                failure_count: 3,
                suspended_reason: 'THREE_CONSECUTIVE_FAILURES',
            });
            const tasks = await client.query(
                `SELECT title, description, status, priority, owner_user_id, created_by
                 FROM tasks
                 WHERE company_id = $1
                   AND title = 'App schedule disabled: Phase B FAILURES'`,
                [fixture.companyId]
            );
            expect(tasks.rows).toHaveLength(1);
            expect(tasks.rows[0]).toMatchObject({
                description: expect.stringContaining('three consecutive failures'),
                status: 'open',
                priority: 'p1',
                owner_user_id: fixture.actorId,
                created_by: 'system',
            });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('7. explicit acceptance updates version/tools and audit while the installation stays pinned beforehand', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await applyPrerequisites(client);
            const fixture = await createFixture(client, 'ACCEPT');
            const service = createAppScheduleService({
                database: transactionDatabase(client),
                execution: permissiveExecution(),
            });
            const before = await client.query(
                `SELECT metadata->'app_runtime' AS runtime
                 FROM marketplace_installations
                 WHERE company_id = $1 AND id = $2`,
                [fixture.companyId, fixture.installationId]
            );
            expect(before.rows[0].runtime.version_id).toBe(fixture.currentVersionId);

            const settings = await service.getSchedule({
                companyId: fixture.companyId,
                installationId: String(fixture.installationId),
                actorId: fixture.actorId,
            });
            expect(settings.version).toMatchObject({
                update_available: true,
                current: { version_id: fixture.currentVersionId },
                available: {
                    version_id: fixture.availableVersionId,
                    suggested_schedule: { kind: 'hourly', minute: 5 },
                },
            });
            expect(JSON.stringify(settings)).not.toMatch(/source_code|source_sha256/);

            await expect(service.acceptVersion({
                companyId: fixture.companyId,
                installationId: String(fixture.installationId),
                actorId: fixture.actorId,
                body: { version_id: fixture.availableVersionId },
                requestId: 'accept-version-test',
            })).resolves.toMatchObject({
                accepted_version: {
                    version_id: fixture.availableVersionId,
                    consented_tools: ['svc.list_jobs'],
                },
            });
            const after = await client.query(
                `SELECT metadata->'app_runtime' AS runtime
                 FROM marketplace_installations
                 WHERE company_id = $1 AND id = $2`,
                [fixture.companyId, fixture.installationId]
            );
            expect(after.rows[0].runtime).toEqual({
                version_id: fixture.availableVersionId,
                consented_tools: ['svc.list_jobs'],
            });
            const audit = await client.query(
                `SELECT event_type, actor_id, payload_json
                 FROM marketplace_installation_events
                 WHERE company_id = $1
                   AND installation_id = $2
                   AND event_type = 'version_accepted'`,
                [fixture.companyId, fixture.installationId]
            );
            expect(audit.rows).toHaveLength(1);
            expect(audit.rows[0]).toMatchObject({ actor_id: fixture.actorId });
            expect(audit.rows[0].payload_json).toMatchObject({
                previous_version_id: fixture.currentVersionId,
                version_id: fixture.availableVersionId,
                consented_tools: ['svc.list_jobs'],
            });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('8. T-own/T-foreign/T-blast: schedule reads and writes stay company-paired', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await applyPrerequisites(client);
            const companyA = await createFixture(client, 'TENANT-A');
            const companyB = await createFixture(client, 'TENANT-B');
            const service = createAppScheduleService({
                database: transactionDatabase(client),
                execution: permissiveExecution(),
                now: () => new Date('2026-08-02T12:00:00.000Z'),
            });
            await service.updateSchedule({
                companyId: companyA.companyId,
                installationId: String(companyA.installationId),
                actorId: companyA.actorId,
                body: { enabled: true, cadence: { kind: 'daily', at: '07:00' } },
            });
            await service.updateSchedule({
                companyId: companyB.companyId,
                installationId: String(companyB.installationId),
                actorId: companyB.actorId,
                body: { enabled: true, cadence: { kind: 'weekly', dow: 1, at: '08:00' } },
            });
            const beforeB = await client.query(
                `SELECT to_jsonb(schedule) AS snapshot
                 FROM app_installation_schedules schedule
                 WHERE schedule.company_id = $1
                   AND schedule.installation_id = $2`,
                [companyB.companyId, companyB.installationId]
            );

            await expect(service.getSchedule({
                companyId: companyB.companyId,
                installationId: String(companyA.installationId),
                actorId: companyB.actorId,
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            await expect(service.updateSchedule({
                companyId: companyB.companyId,
                installationId: String(companyA.installationId),
                actorId: companyB.actorId,
                body: { enabled: false },
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

            const own = await service.updateSchedule({
                companyId: companyA.companyId,
                installationId: String(companyA.installationId),
                actorId: companyA.actorId,
                body: { enabled: false },
            });
            expect(own.schedule.enabled).toBe(false);
            const afterB = await client.query(
                `SELECT to_jsonb(schedule) AS snapshot
                 FROM app_installation_schedules schedule
                 WHERE schedule.company_id = $1
                   AND schedule.installation_id = $2`,
                [companyB.companyId, companyB.installationId]
            );
            expect(afterB.rows[0].snapshot).toStrictEqual(beforeB.rows[0].snapshot);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('migration 229 and rollback are executable, idempotent, and restore the previous artifact guard', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SCHEDULE_SCHEMA);
            await client.query(SCHEDULE_SCHEMA);
            const forward = await client.query(
                `SELECT to_regclass('app_installation_schedules')::text AS schedules,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_versions'
                              AND column_name = 'suggested_schedule'
                        ) AS has_suggestion`
            );
            expect(forward.rows[0]).toEqual({
                schedules: 'app_installation_schedules',
                has_suggestion: true,
            });
            await client.query(SCHEDULE_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT to_regclass('app_installation_schedules')::text AS schedules,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_versions'
                              AND column_name = 'suggested_schedule'
                        ) AS has_suggestion`
            );
            expect(rolledBack.rows[0]).toEqual({ schedules: null, has_suggestion: false });
            await client.query(SCHEDULE_SCHEMA);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
