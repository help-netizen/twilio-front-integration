'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const db = require('../backend/src/db/connection');
const { createAppEventSubscriber } = require('../backend/src/services/appEventSubscriber');
const { createAppEventWorker } = require('../backend/src/services/appEventWorker');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const EVENT_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '232_app_event_deliveries.sql'), 'utf8');
const EVENT_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_232_app_event_deliveries.sql'),
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
    test('APP-DATA-001 Phase F DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-DATA-001 Phase F DB tests are pending: ${DATABASE.reason}`);
    });
}

function digest(source) {
    return crypto.createHash('sha256').update(source).digest('hex');
}

async function createCompany(client, label) {
    const companyId = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [companyId, `APP EVENTS ${label}`, `app-events-${label.toLowerCase()}-${randomUUID()}`]
    );
    const { rows } = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, 'company_member', 'active', $4,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-events-${label}-${randomUUID()}`,
            `app-events-${label}-${randomUUID()}@example.test`,
            `APP EVENTS ${label}`,
            companyId,
        ]
    );
    return { companyId, actorId: rows[0].id };
}

async function createInstallation(client, fixture, label, subscribes) {
    const app = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, $2, 'Albusto Test', 'custom', 'private', 'Phase F test',
                 '[]'::jsonb, 'none', 'published', '{}'::jsonb)
         RETURNING id`,
        [`app-events-${label}-${randomUUID()}`, `APP EVENTS ${label}`]
    );
    const source = 'export async function run() { return { view_version: 1, title: "Event", blocks: [] }; }';
    const version = await client.query(
        `INSERT INTO app_versions
            (app_id, version_number, source_code, source_sha256,
             scanner_report, status, created_by)
         VALUES ($1, '1.0.0', $2, $3, $4::jsonb, 'draft', $5)
         RETURNING id`,
        [
            app.rows[0].id,
            source,
            digest(source),
            JSON.stringify({ subscribes }),
            fixture.actorId,
        ]
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
            fixture.companyId,
            app.rows[0].id,
            fixture.actorId,
            JSON.stringify({
                app_runtime: { version_id: version.rows[0].id, consented_tools: [] },
            }),
        ]
    );
    return installation.rows[0].id;
}

function transactionDatabase(client) {
    let savepoint = 0;
    return {
        getClient: async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN') {
                    savepoint += 1;
                    return client.query(`SAVEPOINT app_event_phase_f_${savepoint}`);
                }
                if (sql === 'COMMIT') {
                    return client.query(`RELEASE SAVEPOINT app_event_phase_f_${savepoint}`);
                }
                if (sql === 'ROLLBACK') {
                    return client.query(`ROLLBACK TO SAVEPOINT app_event_phase_f_${savepoint}`);
                }
                return client.query(sql, params);
            },
            release: () => {},
        }),
        query: (sql, params) => client.query(sql, params),
    };
}

describe('APP-DATA-001 Phase F outbox database boundaries', () => {
    test('migration 232 declares the paired cascade FK, due index, active coalescing key and rollback', () => {
        expect(EVENT_SCHEMA).toContain('REFERENCES marketplace_installations(company_id, id) ON DELETE CASCADE');
        expect(EVENT_SCHEMA).toContain('ON app_event_deliveries(status, next_attempt_at)');
        expect(EVENT_SCHEMA).toContain("WHERE status IN ('pending', 'running')");
        expect(EVENT_ROLLBACK).toContain('DROP TABLE IF EXISTS app_event_deliveries');
    });

    databaseTest('migration 232 forward, rollback, and forward are executable and idempotent', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(EVENT_SCHEMA);
            await client.query(EVENT_SCHEMA);
            await client.query(EVENT_ROLLBACK);
            await client.query(EVENT_SCHEMA);
            const { rows } = await client.query(
                `SELECT to_regclass('app_event_deliveries') AS relation`
            );
            expect(rows[0].relation).toBe('app_event_deliveries');
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('emitter projection reaches only connected installations whose pinned version declares it', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(EVENT_SCHEMA);
            const own = await createCompany(client, 'OWN');
            const foreign = await createCompany(client, 'FOREIGN');
            const subscribedId = await createInstallation(
                client,
                own,
                'SUBSCRIBED',
                ['estimate.approved']
            );
            const unsubscribedId = await createInstallation(client, own, 'UNSUBSCRIBED', []);
            const foreignId = await createInstallation(
                client,
                foreign,
                'FOREIGN',
                ['estimate.approved']
            );
            const subscriber = createAppEventSubscriber({
                database: { query: (sql, params) => client.query(sql, params) },
            });

            await subscriber.onEvent({
                company_id: own.companyId,
                event_type: 'estimate.approved',
                payload: {
                    estimate_id: 41,
                    estimate_number: 'EST-41',
                    job_id: 9,
                    contact_id: 7,
                    order_list_count: 2,
                    customer_email: 'must-not-enter-outbox@example.test',
                },
            });
            const { rows } = await client.query(
                `SELECT company_id, installation_id, event_type, payload, status
                 FROM app_event_deliveries
                 WHERE company_id = ANY($1::uuid[])
                 ORDER BY installation_id`,
                [[own.companyId, foreign.companyId]]
            );
            expect(rows).toEqual([{
                company_id: own.companyId,
                installation_id: String(subscribedId),
                event_type: 'estimate.approved',
                payload: {
                    estimate_id: 41,
                    estimate_number: 'EST-41',
                    job_id: 9,
                    contact_id: 7,
                    order_list_count: 2,
                },
                status: 'pending',
            }]);
            expect(rows.some(row => String(row.installation_id) === String(unsubscribedId))).toBe(false);
            expect(rows.some(row => String(row.installation_id) === String(foreignId))).toBe(false);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('three events coalesce into one active row with the newest payload', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(EVENT_SCHEMA);
            const own = await createCompany(client, 'COALESCE');
            const installationId = await createInstallation(
                client,
                own,
                'COALESCE',
                ['estimate.approved']
            );
            const subscriber = createAppEventSubscriber({
                database: { query: (sql, params) => client.query(sql, params) },
            });
            for (const estimateId of [41, 42, 43]) {
                await subscriber.onEvent({
                    company_id: own.companyId,
                    event_type: 'estimate.approved',
                    payload: {
                        estimate_id: estimateId,
                        estimate_number: `EST-${estimateId}`,
                        job_id: null,
                        contact_id: null,
                        order_list_count: estimateId - 40,
                    },
                });
            }
            const { rows } = await client.query(
                `SELECT payload, status, attempts, coalesced_count
                 FROM app_event_deliveries
                 WHERE company_id = $1
                   AND installation_id = $2
                   AND event_type = 'estimate.approved'`,
                [own.companyId, installationId]
            );
            expect(rows).toEqual([{
                payload: {
                    estimate_id: 43,
                    estimate_number: 'EST-43',
                    job_id: null,
                    contact_id: null,
                    order_list_count: 3,
                },
                status: 'pending',
                attempts: 0,
                coalesced_count: 2,
            }]);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('dispatcher delivers, retries at 1m/5m, fails on attempt three, and defers single-flight', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(EVENT_SCHEMA);
            const own = await createCompany(client, 'WORKER');
            const installationId = await createInstallation(
                client,
                own,
                'WORKER',
                ['estimate.approved']
            );
            const database = transactionDatabase(client);
            const subscriber = createAppEventSubscriber({ database });
            const event = {
                company_id: own.companyId,
                event_type: 'estimate.approved',
                payload: {
                    estimate_id: 51,
                    estimate_number: 'EST-51',
                    job_id: null,
                    contact_id: null,
                    order_list_count: 1,
                },
            };
            await subscriber.onEvent(event);
            const execution = { run: jest.fn().mockResolvedValue({ status: 'completed' }) };
            const worker = createAppEventWorker({ database, execution });
            const firstTick = new Date(Date.now() + 1000);
            await expect(worker.tick(firstTick)).resolves.toEqual({
                claimed: 1,
                outcomes: ['delivered'],
            });
            expect(execution.run).toHaveBeenCalledWith(expect.objectContaining({
                companyId: own.companyId,
                installationId: String(installationId),
                trigger: 'event',
                event: { type: 'estimate.approved', payload: event.payload },
            }));
            let row = await client.query(
                `SELECT status, attempts FROM app_event_deliveries
                 WHERE company_id = $1 AND installation_id = $2`,
                [own.companyId, installationId]
            );
            expect(row.rows[0]).toEqual({ status: 'delivered', attempts: 0 });

            await subscriber.onEvent({
                ...event,
                payload: { ...event.payload, estimate_id: 52, estimate_number: 'EST-52' },
            });
            const failingExecution = {
                run: jest.fn().mockRejectedValue(new Error('runner failed safely')),
            };
            const failingWorker = createAppEventWorker({ database, execution: failingExecution });
            const retryOne = new Date(firstTick.getTime() + 1000);
            await failingWorker.tick(retryOne);
            row = await client.query(
                `SELECT status, attempts, next_attempt_at, last_error
                 FROM app_event_deliveries
                 WHERE company_id = $1 AND installation_id = $2
                   AND status <> 'delivered'`,
                [own.companyId, installationId]
            );
            expect(row.rows[0]).toMatchObject({
                status: 'pending', attempts: 1, last_error: 'runner failed safely',
            });
            expect(row.rows[0].next_attempt_at).toEqual(new Date(retryOne.getTime() + 60 * 1000));
            const retryTwo = row.rows[0].next_attempt_at;
            await failingWorker.tick(retryTwo);
            row = await client.query(
                `SELECT status, attempts, next_attempt_at, last_error
                 FROM app_event_deliveries
                 WHERE company_id = $1 AND installation_id = $2
                   AND status <> 'delivered'`,
                [own.companyId, installationId]
            );
            expect(row.rows[0]).toMatchObject({ status: 'pending', attempts: 2 });
            expect(row.rows[0].next_attempt_at).toEqual(new Date(retryTwo.getTime() + 5 * 60 * 1000));
            await failingWorker.tick(row.rows[0].next_attempt_at);
            row = await client.query(
                `SELECT status, attempts, last_error
                 FROM app_event_deliveries
                 WHERE company_id = $1 AND installation_id = $2
                   AND status <> 'delivered'`,
                [own.companyId, installationId]
            );
            expect(row.rows[0]).toEqual({
                status: 'failed', attempts: 3, last_error: 'runner failed safely',
            });

            await subscriber.onEvent({
                ...event,
                payload: { ...event.payload, estimate_id: 53, estimate_number: 'EST-53' },
            });
            const busyExecution = { run: jest.fn().mockResolvedValue({ status: 'running' }) };
            const busyWorker = createAppEventWorker({ database, execution: busyExecution });
            const busyTick = new Date(Date.now() + 2000);
            await expect(busyWorker.tick(busyTick)).resolves.toEqual({
                claimed: 1,
                outcomes: ['deferred'],
            });
            row = await client.query(
                `SELECT status, attempts, next_attempt_at
                 FROM app_event_deliveries
                 WHERE company_id = $1 AND installation_id = $2
                   AND status = 'pending'`,
                [own.companyId, installationId]
            );
            expect(row.rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
            expect(row.rows[0].next_attempt_at)
                .toEqual(new Date(busyTick.getTime() + 30 * 1000));
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
