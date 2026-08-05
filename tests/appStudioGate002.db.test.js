'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');
const companyQueries = require('../backend/src/db/companyQueries');

const MIGRATION = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '239_app_studio_per_company_gate.sql'
    ),
    'utf8'
);

jest.setTimeout(30000);

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
    test('APP-STUDIO-GATE-002 DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-STUDIO-GATE-002 DB tests are pending: ${DATABASE.reason}`);
    });
}

afterAll(async () => {
    if (DATABASE.ready) await db.pool.end();
});

databaseTest('migration default, createCompany, and T-blast hold on PostgreSQL', async () => {
    const client = await db.pool.connect();
    const originalConnect = db.pool.connect;
    const originalQuery = db.query;
    const defaultInstallationSpy = jest.spyOn(
        marketplaceQueries,
        'ensureDefaultReportToEstimateInstallation'
    ).mockResolvedValue(undefined);
    const companyASuffix = randomUUID();
    const companyB = randomUUID();
    const savepoint = `app_studio_gate_${randomUUID().replace(/-/g, '')}`;

    try {
        await client.query('BEGIN');
        await client.query(MIGRATION);
        await client.query(MIGRATION);

        const transactionClient = {
            query: async (sql, params) => {
                const text = String(sql).trim();
                if (text === 'BEGIN') return client.query(`SAVEPOINT ${savepoint}`);
                if (text === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${savepoint}`);
                if (text === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                return client.query(sql, params);
            },
            release: () => {},
        };
        db.pool.connect = jest.fn(async () => transactionClient);
        db.query = (sql, params) => client.query(sql, params);

        const created = await companyQueries.createCompany({
            name: 'App Studio Gate A',
            slug: `app-studio-gate-a-${companyASuffix}`,
        });
        expect(created.app_studio_enabled).toBe(false);

        await client.query(
            `INSERT INTO companies (id, name, slug, status)
             VALUES ($1, 'App Studio Gate B', $2, 'active')`,
            [companyB, `app-studio-gate-b-${companyB}`]
        );
        const foreignBefore = await client.query(
            `SELECT to_jsonb(c)::text AS bytes
             FROM companies c
             WHERE c.id = $1`,
            [companyB]
        );

        const updated = await companyQueries.updateCompany(created.id, {
            app_studio_enabled: true,
        });
        const foreignAfter = await client.query(
            `SELECT to_jsonb(c)::text AS bytes
             FROM companies c
             WHERE c.id = $1`,
            [companyB]
        );

        expect(updated.app_studio_enabled).toBe(true);
        expect(foreignAfter.rows[0].bytes).toBe(foreignBefore.rows[0].bytes);
        expect(defaultInstallationSpy).toHaveBeenCalledWith(created.id, {
            seededBy: 'REPORT-TO-ESTIMATE-001-ADMIN',
            client: transactionClient,
        });
    } finally {
        db.pool.connect = originalConnect;
        db.query = originalQuery;
        defaultInstallationSpy.mockRestore();
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
});
