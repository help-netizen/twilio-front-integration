'use strict';

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const rosterService = require('../backend/src/services/technicianRosterService');
const {
    canonicalizeJobTechnicianIds,
} = require('../backend/src/services/jobTechnicianIdCanonicalizationService');

jest.setTimeout(60000);

async function createBackfillSchema() {
    const schema = `tech_id_backfill_${randomUUID().replace(/-/g, '')}`;
    const setup = await db.getClient();
    try {
        await setup.query(`CREATE SCHEMA ${schema}`);
        await setup.query(`SET search_path TO ${schema}, public`);
        await setup.query(`
            CREATE TABLE technicians (
                id UUID NOT NULL,
                company_id UUID NOT NULL,
                display_name TEXT NOT NULL,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                crm_user_id UUID,
                merged_into UUID,
                PRIMARY KEY (company_id, id)
            );
            CREATE TABLE technician_external_identities (
                company_id UUID NOT NULL,
                source TEXT NOT NULL,
                external_id TEXT NOT NULL,
                technician_id UUID NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (company_id, source, external_id)
            );
            CREATE TABLE jobs (
                id BIGSERIAL PRIMARY KEY,
                company_id UUID NOT NULL,
                assigned_techs JSONB,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
    } finally {
        setup.release();
    }
    const database = {
        getClient: async () => {
            const client = await db.getClient();
            await client.query(`SET search_path TO ${schema}, public`);
            return client;
        },
    };
    const query = async (sql, params = []) => {
        const client = await db.getClient();
        try {
            await client.query(`SET search_path TO ${schema}, public`);
            return await client.query(sql, params);
        } finally {
            client.release();
        }
    };
    return { schema, database, runner: { query }, query };
}

describe('TECH-ID-CANON runtime against real PostgreSQL', () => {
    test('backfills one tenant, preserves names, dry-runs, and reruns as zero-change', async () => {
        const companyA = randomUUID();
        const companyB = randomUUID();
        const technicianA = randomUUID();
        const technicianB = randomUUID();
        const externalId = `zb-shared-${randomUUID()}`;
        const fixture = await createBackfillSchema();
        let jobA;
        let nativeJobA;
        let jobB;
        try {
            await fixture.query(
                `INSERT INTO technicians (id, company_id, display_name)
                 VALUES ($1, $2, 'A technician'), ($3, $4, 'B technician')`,
                [technicianA, companyA, technicianB, companyB]
            );
            await fixture.query(
                `INSERT INTO technician_external_identities
                    (company_id, source, external_id, technician_id)
                 VALUES ($1, 'zenbooker', $3, $4),
                        ($2, 'zenbooker', $3, $5)`,
                [companyA, companyB, externalId, technicianA, technicianB]
            );
            const jobs = await fixture.query(
                `INSERT INTO jobs (company_id, assigned_techs)
                 VALUES ($1, $3::jsonb), ($1, $4::jsonb), ($2, $5::jsonb)
                 RETURNING id`,
                [
                    companyA,
                    companyB,
                    JSON.stringify([{ id: externalId, name: 'Historical A' }]),
                    JSON.stringify([{ id: technicianA, name: 'Native A' }]),
                    JSON.stringify([{ id: externalId, name: 'Historical B' }]),
                ]
            );
            [jobA, nativeJobA, jobB] = jobs.rows.map(row => row.id);

            const logger = { info: jest.fn() };
            const dryRun = await canonicalizeJobTechnicianIds({
                companyId: companyA,
                dryRun: true,
                logger,
                database: fixture.database,
            });
            expect(dryRun).toMatchObject({
                status: 'dry-run',
                changed_jobs: 1,
                changed_assignments: 1,
                before: { legacy_assignments: 1, native_assignments: 1 },
                after: { legacy_assignments: 0, native_assignments: 2 },
            });
            expect((await fixture.query(
                'SELECT assigned_techs FROM jobs WHERE company_id = $1 AND id = $2',
                [companyA, jobA]
            )).rows[0].assigned_techs).toEqual([{ id: externalId, name: 'Historical A' }]);

            const foreignBefore = (await fixture.query(
                'SELECT to_jsonb(j) AS value FROM jobs j WHERE company_id = $1 AND id = $2',
                [companyB, jobB]
            )).rows[0].value;
            const applied = await canonicalizeJobTechnicianIds({
                companyId: companyA,
                dryRun: false,
                logger,
                database: fixture.database,
            });
            expect(applied).toMatchObject({
                status: 'applied',
                changed_jobs: 1,
                changed_assignments: 1,
                after: { legacy_assignments: 0, native_assignments: 2 },
            });
            expect((await fixture.query(
                `SELECT assigned_techs FROM jobs
                 WHERE company_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`,
                [companyA, [jobA, nativeJobA]]
            )).rows.map(row => row.assigned_techs)).toEqual([
                [{ id: technicianA, name: 'Historical A' }],
                [{ id: technicianA, name: 'Native A' }],
            ]);
            expect((await fixture.query(
                'SELECT to_jsonb(j) AS value FROM jobs j WHERE company_id = $1 AND id = $2',
                [companyB, jobB]
            )).rows[0].value).toEqual(foreignBefore);

            await expect(canonicalizeJobTechnicianIds({
                companyId: companyA,
                dryRun: false,
                logger,
                database: fixture.database,
            })).resolves.toMatchObject({ changed_jobs: 0, changed_assignments: 0 });
        } finally {
            await db.query(`DROP SCHEMA IF EXISTS ${fixture.schema} CASCADE`).catch(() => {});
        }
    });

    test('roster emits UUID and accepts UUID or tenant-scoped legacy input', async () => {
        const companyA = randomUUID();
        const companyB = randomUUID();
        const technicianA = randomUUID();
        const technicianB = randomUUID();
        const externalId = `zb-roster-shared-${randomUUID()}`;
        const fixture = await createBackfillSchema();
        try {
            await fixture.query(
                `INSERT INTO technicians (id, company_id, display_name, active)
                 VALUES ($1, $2, 'Same name', TRUE), ($3, $4, 'Same name', TRUE)`,
                [technicianA, companyA, technicianB, companyB]
            );
            await fixture.query(
                `INSERT INTO technician_external_identities
                    (company_id, source, external_id, technician_id)
                 VALUES ($1, 'zenbooker', $3, $4), ($2, 'zenbooker', $3, $5)`,
                [companyA, companyB, externalId, technicianA, technicianB]
            );

            await expect(rosterService.listActive(companyA, { runner: fixture.runner })).resolves.toEqual([{
                id: technicianA,
                name: 'Same name',
                active: true,
                technician_uuid: technicianA,
            }]);
            await expect(rosterService.requireActive(companyA, technicianA, { runner: fixture.runner }))
                .resolves.toMatchObject({ id: technicianA });
            await expect(rosterService.requireActive(companyA, externalId, { runner: fixture.runner }))
                .resolves.toMatchObject({ id: technicianA });
            await expect(rosterService.requireActive(companyB, externalId, { runner: fixture.runner }))
                .resolves.toMatchObject({ id: technicianB });
        } finally {
            await db.query(`DROP SCHEMA IF EXISTS ${fixture.schema} CASCADE`).catch(() => {});
        }
    });

});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});
