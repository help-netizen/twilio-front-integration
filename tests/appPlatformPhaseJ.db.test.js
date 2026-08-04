'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const db = require('../backend/src/db/connection');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');
const {
    createAppInstallationSettingsService,
} = require('../backend/src/services/appInstallationSettingsService');

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
    test('APP-PLATFORM-001 tenancy DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-PLATFORM-001 tenancy DB tests are pending: ${DATABASE.reason}`);
    });
}

const ids = {
    companies: [],
    installations: [],
    versions: [],
    apps: [],
};

async function createCompany(label) {
    const id = crypto.randomUUID();
    await db.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [id, `APP PLATFORM ${label}`, `app-platform-${label}-${id}`]
    );
    ids.companies.push(id);
    return id;
}

afterAll(async () => {
    if (!DATABASE.ready) return;
    if (ids.installations.length > 0) {
        await db.query(
            `DELETE FROM marketplace_installations WHERE id = ANY($1::bigint[])`,
            [ids.installations]
        );
    }
    if (ids.versions.length > 0) {
        await db.query(`DELETE FROM app_versions WHERE id = ANY($1::uuid[])`, [ids.versions]);
    }
    if (ids.apps.length > 0) {
        await db.query(`DELETE FROM marketplace_apps WHERE id = ANY($1::bigint[])`, [ids.apps]);
    }
    if (ids.companies.length > 0) {
        await db.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [ids.companies]);
    }
    await db.pool.end();
});

databaseTest('5 T-blast leaves the foreign installation byte-unchanged and disconnect drops settings', async () => {
    const companyA = await createCompany('A');
    const companyB = await createCompany('B');
    const app = await db.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, 'APP PLATFORM J', 'Albusto Test', 'custom', 'private',
                 'Phase J test app', '[]'::jsonb, 'none', 'published', '{}'::jsonb)
         RETURNING id`,
        [`app-platform-j-${crypto.randomUUID()}`]
    );
    const appId = app.rows[0].id;
    ids.apps.push(appId);
    const source = 'export async function run() { return { view_version: 1, title: "Safe", blocks: [] }; }';
    const versionClient = await db.getClient();
    let versionId;
    try {
        await versionClient.query('BEGIN');
        const version = await versionClient.query(
            `INSERT INTO app_versions
                (app_id, version_number, source_code, source_sha256, scanner_report, status)
             VALUES ($1, '1.0.0', $2, $3, $4::jsonb, 'draft')
             RETURNING id`,
            [
                appId,
                source,
                crypto.createHash('sha256').update(source).digest('hex'),
                JSON.stringify({
                    settings: [{ key: 'threshold', label: 'Threshold', type: 'number' }],
                }),
            ]
        );
        versionId = version.rows[0].id;
        await versionClient.query(
            `SELECT set_config('app.version_transition_service', 'enabled', true)`
        );
        for (const status of ['submitted', 'in_review', 'approved', 'published']) {
            await versionClient.query(
                `UPDATE app_versions SET status = $2, updated_at = NOW() WHERE id = $1`,
                [versionId, status]
            );
        }
        await versionClient.query('COMMIT');
    } catch (error) {
        await versionClient.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        versionClient.release();
    }
    ids.versions.push(versionId);

    async function install(companyId, threshold) {
        const result = await db.query(
            `INSERT INTO marketplace_installations
                (company_id, app_id, status, installed_at, metadata)
             VALUES ($1, $2, 'connected', NOW(), $3::jsonb)
             RETURNING id`,
            [
                companyId,
                appId,
                JSON.stringify({
                    app_runtime: { version_id: versionId, consented_tools: [] },
                    app_settings: { threshold },
                }),
            ]
        );
        ids.installations.push(result.rows[0].id);
        return String(result.rows[0].id);
    }

    const installationA = await install(companyA, 4);
    const installationB = await install(companyB, 99);
    const execution = { requireViewerAccess: jest.fn().mockResolvedValue({
        role_key: 'tenant_admin',
    }) };
    const service = createAppInstallationSettingsService({ execution });
    const beforeForeign = await db.query(
        `SELECT metadata::text AS bytes
         FROM marketplace_installations
         WHERE company_id = $1 AND id = $2`,
        [companyB, installationB]
    );

    await expect(service.updateSettings({
        companyId: companyA,
        installationId: installationB,
        actorId: crypto.randomUUID(),
        settings: { threshold: 1 },
    })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    const afterForeign = await db.query(
        `SELECT metadata::text AS bytes
         FROM marketplace_installations
         WHERE company_id = $1 AND id = $2`,
        [companyB, installationB]
    );
    expect(afterForeign.rows[0].bytes).toBe(beforeForeign.rows[0].bytes);

    await marketplaceQueries.markDisconnected({
        companyId: companyA,
        installationId: installationA,
        actorId: null,
    });
    const disconnected = await db.query(
        `SELECT status, metadata
         FROM marketplace_installations
         WHERE company_id = $1 AND id = $2`,
        [companyA, installationA]
    );
    expect(disconnected.rows[0].status).toBe('disconnected');
    expect(disconnected.rows[0].metadata).not.toHaveProperty('app_settings');
    expect(disconnected.rows[0].metadata.app_runtime.version_id).toBe(String(versionId));
});
