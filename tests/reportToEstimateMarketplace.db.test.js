'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(
    path.join(MIGRATIONS, '212_seed_report_to_estimate_marketplace_app.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_212_seed_report_to_estimate_marketplace_app.sql'),
    'utf8'
);
const QUERY_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'db', 'marketplaceQueries.js'),
    'utf8'
);

const TAG = `rte-${Date.now()}-${process.pid}`;
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const COMPANY_C = randomUUID();
const COMPANY_D = randomUUID();

jest.setTimeout(60000);

const RUN_DB_TESTS = process.env.RUN_REPORT_TO_ESTIMATE_DB_TESTS === 'true';
const dbTest = RUN_DB_TESTS ? test : test.skip;

beforeAll(async () => {
    if (!RUN_DB_TESTS) return;
    await marketplaceQueries.ensureMarketplaceSchema();
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('REPORT-TO-ESTIMATE-001 migration 212 · real PostgreSQL', () => {
    test('boot replay registration and seed source contain no persisted instruction_text default', () => {
        const migrationOffset = QUERY_SOURCE.indexOf(
            "readMigration('212_seed_report_to_estimate_marketplace_app.sql')"
        );
        const baseOffset = QUERY_SOURCE.indexOf(
            "readMigration('083_create_marketplace_apps.sql')"
        );
        expect(migrationOffset).toBeGreaterThan(baseOffset);
        expect(FORWARD).not.toContain('instruction_text');

        const helperStart = QUERY_SOURCE.indexOf(
            'async function ensureDefaultReportToEstimateInstallation'
        );
        const helperEnd = QUERY_SOURCE.indexOf(
            'async function updateInstallationCredential',
            helperStart
        );
        expect(helperStart).toBeGreaterThanOrEqual(0);
        expect(QUERY_SOURCE.slice(helperStart, helperEnd)).not.toContain('instruction_text');
        expect(QUERY_SOURCE.slice(helperStart, helperEnd)).toContain(
            "WHERE existing.company_id = $1"
        );
        expect(QUERY_SOURCE.slice(helperStart, helperEnd)).not.toContain(
            "existing.status IN"
        );
    });

    dbTest('default-ON, replay disconnect-safety, tenancy, helper, and rollback', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(ROLLBACK);
            await client.query(
                `INSERT INTO companies (id, name, slug)
                 VALUES
                    ($1, $2, $3),
                    ($4, $5, $6)`,
                [
                    COMPANY_A, `Report Estimate A ${TAG}`, `${TAG}-a`,
                    COMPANY_B, `Report Estimate B ${TAG}`, `${TAG}-b`,
                ]
            );

            await client.query(FORWARD);

            const appResult = await client.query(
                `SELECT *
                 FROM marketplace_apps
                 WHERE app_key = 'report-to-estimate'`
            );
            expect(appResult.rows).toHaveLength(1);
            const app = appResult.rows[0];
            expect(app).toMatchObject({
                app_key: 'report-to-estimate',
                name: 'Report → Estimate',
                provider_name: 'Albusto',
                category: 'ai',
                app_type: 'internal',
                requested_scopes: [],
                provisioning_mode: 'none',
                status: 'published',
            });
            expect(Object.keys(app.metadata.assistant).sort()).toEqual([
                'gotchas',
                'outcome',
                'prerequisites',
                'recommend_when',
                'setup_steps',
                'what_it_does',
            ]);

            const seeded = await client.query(
                `SELECT company_id, status, metadata
                 FROM marketplace_installations
                 WHERE app_id = $1
                   AND company_id = ANY($2::uuid[])
                 ORDER BY company_id`,
                [app.id, [COMPANY_A, COMPANY_B]]
            );
            expect(seeded.rows).toHaveLength(2);
            expect(seeded.rows.every(row => row.status === 'connected')).toBe(true);
            expect(seeded.rows.every(row => (
                row.metadata.seeded_by === 'REPORT-TO-ESTIMATE-001'
                && !Object.hasOwn(row.metadata, 'instruction_text')
            ))).toBe(true);

            const aRow = seeded.rows.find(row => row.company_id === COMPANY_A);
            const bRow = seeded.rows.find(row => row.company_id === COMPANY_B);
            expect(aRow).toBeDefined();
            expect(bRow).toBeDefined();

            const installationIds = await client.query(
                `SELECT id, company_id
                 FROM marketplace_installations
                 WHERE app_id = $1
                   AND company_id = ANY($2::uuid[])`,
                [app.id, [COMPANY_A, COMPANY_B]]
            );
            const aId = installationIds.rows.find(row => row.company_id === COMPANY_A).id;
            const bId = installationIds.rows.find(row => row.company_id === COMPANY_B).id;

            const updatedA = await marketplaceQueries.setInstallationInstructions(
                COMPANY_A,
                aId,
                'report-to-estimate',
                { instruction_text: 'Company A custom instruction.' },
                client
            );
            expect(updatedA.metadata).toEqual({
                seeded_by: 'REPORT-TO-ESTIMATE-001',
                instruction_text: 'Company A custom instruction.',
            });

            const aBeforeForeign = await client.query(
                `SELECT *
                 FROM marketplace_installations
                 WHERE company_id = $1
                   AND id = $2`,
                [COMPANY_A, aId]
            );
            await expect(marketplaceQueries.setInstallationInstructions(
                COMPANY_B,
                aId,
                'report-to-estimate',
                { instruction_text: 'Foreign overwrite.' },
                client
            )).resolves.toBeNull();
            const aAfterForeign = await client.query(
                `SELECT *
                 FROM marketplace_installations
                 WHERE company_id = $1
                   AND id = $2`,
                [COMPANY_A, aId]
            );
            expect(aAfterForeign.rows[0]).toStrictEqual(aBeforeForeign.rows[0]);

            const bBeforeBlast = await client.query(
                `SELECT *
                 FROM marketplace_installations
                 WHERE company_id = $1
                   AND id = $2`,
                [COMPANY_B, bId]
            );
            await marketplaceQueries.setInstallationInstructions(
                COMPANY_A,
                aId,
                'report-to-estimate',
                { instruction_text: 'Company A second instruction.' },
                client
            );
            const bAfterBlast = await client.query(
                `SELECT *
                 FROM marketplace_installations
                 WHERE company_id = $1
                   AND id = $2`,
                [COMPANY_B, bId]
            );
            expect(bAfterBlast.rows[0]).toStrictEqual(bBeforeBlast.rows[0]);

            await client.query(
                `UPDATE marketplace_installations
                 SET status = 'disconnected',
                     disconnected_at = NOW()
                 WHERE company_id = $1
                   AND id = $2`,
                [COMPANY_B, bId]
            );
            await client.query(FORWARD);
            await client.query(FORWARD);

            const replayState = await client.query(
                `SELECT company_id, status, metadata
                 FROM marketplace_installations
                 WHERE app_id = $1
                   AND company_id = ANY($2::uuid[])
                 ORDER BY company_id, id`,
                [app.id, [COMPANY_A, COMPANY_B]]
            );
            expect(replayState.rows.filter(row => row.company_id === COMPANY_A))
                .toHaveLength(1);
            expect(replayState.rows.filter(row => row.company_id === COMPANY_B))
                .toEqual([expect.objectContaining({ status: 'disconnected' })]);

            await client.query(
                `INSERT INTO companies (id, name, slug)
                 VALUES ($1, $2, $3), ($4, $5, $6)`,
                [
                    COMPANY_C, `Report Estimate C ${TAG}`, `${TAG}-c`,
                    COMPANY_D, `Report Estimate D ${TAG}`, `${TAG}-d`,
                ]
            );
            const bootstrapped = await marketplaceQueries
                .ensureDefaultReportToEstimateInstallation(COMPANY_C, {
                    seededBy: 'REPORT-TO-ESTIMATE-001-TEST',
                    client,
                });
            expect(bootstrapped).toMatchObject({
                company_id: COMPANY_C,
                status: 'connected',
                metadata: { seeded_by: 'REPORT-TO-ESTIMATE-001-TEST' },
            });
            expect(Object.hasOwn(bootstrapped.metadata, 'instruction_text')).toBe(false);

            await client.query(
                `INSERT INTO marketplace_installations
                    (company_id, app_id, status, installed_at, metadata)
                 VALUES ($1, $2, 'provisioning_failed', NOW(), '{}'::jsonb)`,
                [COMPANY_D, app.id]
            );
            await client.query(FORWARD);
            expect((await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM marketplace_installations
                 WHERE company_id = $1
                   AND app_id = $2`,
                [COMPANY_D, app.id]
            )).rows[0].count).toBe(1);

            await client.query(
                `UPDATE marketplace_installations
                 SET status = 'disconnected'
                 WHERE company_id = $1
                   AND app_id = $2`,
                [COMPANY_C, app.id]
            );
            await marketplaceQueries.ensureDefaultReportToEstimateInstallation(
                COMPANY_C,
                { seededBy: 'REPORT-TO-ESTIMATE-001-TEST', client }
            );
            expect((await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM marketplace_installations
                 WHERE company_id = $1
                   AND app_id = $2`,
                [COMPANY_C, app.id]
            )).rows[0].count).toBe(1);

            const unrelatedBefore = await client.query(
                `SELECT id
                 FROM marketplace_apps
                 WHERE app_key = 'ai-repair-advisor'`
            );
            await client.query(ROLLBACK);
            expect((await client.query(
                `SELECT id
                 FROM marketplace_apps
                 WHERE app_key = 'report-to-estimate'`
            )).rows).toHaveLength(0);
            const unrelatedAfter = await client.query(
                `SELECT id
                 FROM marketplace_apps
                 WHERE app_key = 'ai-repair-advisor'`
            );
            expect(unrelatedAfter.rows).toStrictEqual(unrelatedBefore.rows);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});
