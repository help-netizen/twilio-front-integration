'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const { createAppDataService } = require('../backend/src/services/appDataService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const DATA_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '235_app_data_phase_d.sql'), 'utf8');
const DATA_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_235_app_data_phase_d.sql'),
    'utf8'
);

jest.setTimeout(120000);

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
    test('APP-DATA-001 Phase D DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-DATA-001 Phase D DB tests are pending: ${DATABASE.reason}`);
    });
}

const DECLARATIONS = [{
    name: 'purchases',
    key_fields: ['estimate_id', 'part_number'],
    columns: [
        { key: 'estimate_id', type: 'number' },
        { key: 'part_number', type: 'text' },
        { key: 'notes', type: 'text' },
        { key: 'amount', type: 'currency' },
        { key: 'status', type: 'badge' },
    ],
}, {
    name: 'archive',
    key_fields: ['id'],
    columns: [
        { key: 'id', type: 'number' },
        { key: 'payload', type: 'text' },
    ],
}];

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function createFixture(client, label) {
    const companyId = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [companyId, `APP DATA D ${label}`, `app-data-d-${label.toLowerCase()}-${randomUUID()}`]
    );
    const human = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, 'company_member', 'active', $4,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-data-d-${label}-${randomUUID()}`,
            `app-data-d-${label}-${randomUUID()}@example.test`,
            `APP DATA D ${label}`,
            companyId,
        ]
    );
    const app = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, $2, 'Albusto Test', 'custom', 'private', 'Phase D test',
                 '[]'::jsonb, 'none', 'published', '{}'::jsonb)
         RETURNING id`,
        [`app-data-d-${label}-${randomUUID()}`, `APP DATA D ${label}`]
    );
    const source = 'export async function run() { return { view_version: 1, title: "Safe", blocks: [] }; }';
    const version = await client.query(
        `INSERT INTO app_versions
            (app_id, version_number, source_code, source_sha256, scanner_report,
             suggested_schedule, data_collections, status, created_by)
         VALUES ($1, '1.0.0', $2, $3, '{}'::jsonb, NULL, $4::jsonb, 'draft', $5)
         RETURNING id`,
        [app.rows[0].id, source, digest(source), JSON.stringify(DECLARATIONS), human.rows[0].id]
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
            human.rows[0].id,
            JSON.stringify({
                app_runtime: {
                    version_id: version.rows[0].id,
                    consented_tools: [],
                },
            }),
        ]
    );
    return {
        companyId,
        humanId: human.rows[0].id,
        appId: app.rows[0].id,
        versionId: version.rows[0].id,
        installationId: installation.rows[0].id,
    };
}

function transactionDatabase(client) {
    let savepoint = 0;
    const wrapped = {
        query: async (sql, params) => {
            if (sql === 'BEGIN') {
                savepoint += 1;
                return client.query(`SAVEPOINT app_data_phase_d_${savepoint}`);
            }
            if (sql === 'COMMIT') {
                return client.query(`RELEASE SAVEPOINT app_data_phase_d_${savepoint}`);
            }
            if (sql === 'ROLLBACK') {
                return client.query(`ROLLBACK TO SAVEPOINT app_data_phase_d_${savepoint}`);
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

function context(fixture, overrides = {}) {
    return {
        company_id: fixture.companyId,
        app_id: String(fixture.appId),
        installation_id: String(fixture.installationId),
        version_id: fixture.versionId,
        ...overrides,
    };
}

function row(overrides = {}) {
    return {
        estimate_id: 4101,
        part_number: 'WD19X25700',
        notes: 'Drain pump',
        amount: 289,
        status: { label: 'To order', tone: 'warning' },
        ...overrides,
    };
}

async function snapshot(client, fixture) {
    const { rows } = await client.query(
        `SELECT to_jsonb(data_row) AS snapshot
         FROM app_data_rows data_row
         WHERE data_row.company_id = $1
           AND data_row.installation_id = $2
         ORDER BY data_row.collection, data_row.row_key`,
        [fixture.companyId, fixture.installationId]
    );
    return rows.map(item => item.snapshot);
}

describe('APP-DATA-001 Phase D storage and tenant boundaries', () => {
    test('migration 230 declares the tenant-paired storage, limits, accounting, and rollback', () => {
        expect(DATA_SCHEMA).toContain('PRIMARY KEY (company_id, installation_id, collection, row_key)');
        expect(DATA_SCHEMA).toContain('REFERENCES marketplace_installations(company_id, id) ON DELETE CASCADE');
        expect(DATA_SCHEMA).toContain('data_calls_made INTEGER NOT NULL DEFAULT 0');
        expect(DATA_SCHEMA).toContain('data_collections JSONB NOT NULL');
        expect(DATA_ROLLBACK).toContain('DROP TABLE IF EXISTS app_data_rows');
        expect(DATA_ROLLBACK).toContain('DROP COLUMN IF EXISTS data_collections');
    });

    databaseTest('migration 230 forward, rollback, and forward are executable and idempotent', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(DATA_SCHEMA);
            await client.query(DATA_SCHEMA);
            await client.query(DATA_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT to_regclass('app_data_rows')::text AS data_rows,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_versions'
                              AND column_name = 'data_collections'
                        ) AS has_declarations,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runs'
                              AND column_name = 'data_calls_made'
                        ) AS has_accounting`
            );
            expect(rolledBack.rows[0]).toEqual({
                data_rows: null,
                has_declarations: false,
                has_accounting: false,
            });
            await client.query(DATA_SCHEMA);
            const reapplied = await client.query(
                `SELECT to_regclass('app_data_rows')::text AS data_rows,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_versions'
                              AND column_name = 'data_collections'
                        ) AS has_declarations,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runs'
                              AND column_name = 'data_calls_made'
                        ) AS has_accounting`
            );
            expect(reapplied.rows[0]).toEqual({
                data_rows: 'app_data_rows',
                has_declarations: true,
                has_accounting: true,
            });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('double upsert derives one server row key, updates data, and rejects caller row_key sabotage', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(DATA_SCHEMA);
            const fixture = await createFixture(client, 'IDEMPOTENT');
            const service = createAppDataService({ database: transactionDatabase(client) });
            await service.upsert(context(fixture), 'purchases', { rows: [row()] });
            const first = await client.query(
                `SELECT row_key, data, updated_at
                 FROM app_data_rows
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyId, fixture.installationId]
            );
            await client.query('SELECT pg_sleep(0.01)');
            await service.upsert(context(fixture), 'purchases', {
                rows: [row({ notes: 'Updated drain pump', amount: 301 })],
            });
            const second = await client.query(
                `SELECT row_key, data, updated_at
                 FROM app_data_rows
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyId, fixture.installationId]
            );
            expect(second.rows).toHaveLength(1);
            expect(second.rows[0].row_key).toBe(first.rows[0].row_key);
            expect(second.rows[0].data).toMatchObject({ notes: 'Updated drain pump', amount: 301 });
            expect(new Date(second.rows[0].updated_at).getTime())
                .toBeGreaterThan(new Date(first.rows[0].updated_at).getTime());

            for (const supplied of ['attacker-a', 'attacker-b']) {
                await expect(service.upsert(context(fixture), 'purchases', {
                    rows: [{ ...row(), row_key: supplied }],
                })).rejects.toThrow(/undeclared column "row_key"/i);
            }
            expect((await snapshot(client, fixture))).toHaveLength(1);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('undeclared collection, extra column, wrong type, and empty key fail without writes', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(DATA_SCHEMA);
            const fixture = await createFixture(client, 'VALIDATION');
            const service = createAppDataService({ database: transactionDatabase(client) });
            const cases = [
                ['missing', { rows: [row()] }, /not declared/i],
                ['purchases', { rows: [row({ surprise: true })] }, /undeclared column/i],
                ['purchases', { rows: [row({ amount: '$289' })] }, /finite number/i],
                ['purchases', { rows: [row({ part_number: '   ' })] }, /non-empty scalar/i],
            ];
            for (const [collection, body, message] of cases) {
                await expect(service.upsert(context(fixture), collection, body)).rejects.toThrow(message);
            }
            expect(await snapshot(client, fixture)).toEqual([]);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('8 KB, 5,000 rows, 100-row batch, and 20 MB limits refuse only the operation', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(DATA_SCHEMA);
            const fixture = await createFixture(client, 'LIMITS');
            const service = createAppDataService({ database: transactionDatabase(client) });

            await expect(service.upsert(context(fixture), 'purchases', {
                rows: [row({ notes: 'x'.repeat(8200) })],
            })).rejects.toThrow(/must not exceed 8 KB/i);
            await expect(service.upsert(context(fixture), 'purchases', {
                rows: Array.from({ length: 101 }, (_, index) => row({
                    estimate_id: index + 1,
                    part_number: `part-${index}`,
                })),
            })).rejects.toThrow(/no more than 100 rows/i);

            await client.query(
                `INSERT INTO app_data_rows
                    (company_id, installation_id, collection, row_key, data)
                 SELECT $1, $2, 'purchases', 'seed-' || value,
                        jsonb_build_object('estimate_id', value, 'part_number', 'seed-' || value)
                 FROM generate_series(1, 5000) value`,
                [fixture.companyId, fixture.installationId]
            );
            await expect(service.upsert(context(fixture), 'purchases', {
                rows: [row({ estimate_id: 9001, part_number: 'new-limit-row' })],
            })).rejects.toThrow(/row limit of 5,000/i);
            await client.query(
                `DELETE FROM app_data_rows
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyId, fixture.installationId]
            );

            await client.query(
                `INSERT INTO app_data_rows
                    (company_id, installation_id, collection, row_key, data)
                 SELECT $1, $2, 'archive', 'large-' || value,
                        jsonb_build_object('id', value, 'payload', repeat('x', 7000))
                 FROM generate_series(1, 3000) value`,
                [fixture.companyId, fixture.installationId]
            );
            await expect(service.upsert(context(fixture), 'purchases', { rows: [row()] }))
                .rejects.toThrow(/data limit of 20 MB/i);
            const after = await client.query(
                `SELECT COUNT(*)::integer AS count
                 FROM app_data_rows
                 WHERE company_id = $1 AND installation_id = $2 AND collection = 'purchases'`,
                [fixture.companyId, fixture.installationId]
            );
            expect(after.rows[0].count).toBe(0);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('T-own/T-foreign/T-blast hold for gateway data and human GET, then parent delete cascades', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(DATA_SCHEMA);
            const companyA = await createFixture(client, 'TENANT-A');
            const companyB = await createFixture(client, 'TENANT-B');
            const execution = { requireViewerAccess: jest.fn().mockResolvedValue({}) };
            const service = createAppDataService({
                database: transactionDatabase(client),
                execution,
            });
            await service.upsert(context(companyA), 'purchases', {
                rows: [row({ notes: 'Owned A' })],
            });
            await service.upsert(context(companyB), 'purchases', {
                rows: [row({ notes: 'Sentinel B' })],
            });
            const beforeB = await snapshot(client, companyB);

            await expect(service.list(context(companyA), 'purchases', { limit: 10, offset: 0 }))
                .resolves.toMatchObject({ rows: [expect.objectContaining({ notes: 'Owned A' })] });
            await expect(service.list(context(companyA, {
                company_id: companyB.companyId,
            }), 'purchases', {})).rejects.toMatchObject({ code: 'APP_RUNTIME_INACTIVE', httpStatus: 403 });
            await expect(service.listForViewer({
                companyId: companyB.companyId,
                installationId: String(companyA.installationId),
                actorId: companyB.humanId,
                collection: 'purchases',
                limit: 10,
                offset: 0,
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            expect(await snapshot(client, companyB)).toEqual(beforeB);

            const humanOwn = await service.listForViewer({
                companyId: companyA.companyId,
                installationId: String(companyA.installationId),
                actorId: companyA.humanId,
                collection: 'purchases',
                limit: 10,
                offset: 0,
            });
            expect(humanOwn.rows[0]).toMatchObject({
                data: expect.objectContaining({ notes: 'Owned A' }),
                created_at: expect.any(Date),
                updated_at: expect.any(Date),
            });
            expect(execution.requireViewerAccess).toHaveBeenCalled();

            await client.query(
                `DELETE FROM marketplace_installations
                 WHERE company_id = $1 AND id = $2`,
                [companyA.companyId, companyA.installationId]
            );
            expect(await snapshot(client, companyA)).toEqual([]);
            expect(await snapshot(client, companyB)).toEqual(beforeB);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
