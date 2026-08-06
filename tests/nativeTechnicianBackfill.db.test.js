'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const { run } = require('../scripts/backfillNativeTechnicians');

jest.setTimeout(60000);

function probeMigratedDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const requiredTables = [
        'technicians',
        'technician_external_identities',
        'technician_profiles',
        'technician_base_locations',
        'technician_time_off',
        'technician_work_schedules',
        'technician_work_schedule_days',
        'technician_district_assignments',
        'technician_radius_assignments',
        'technician_area_wildcards',
    ];
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            connectionTimeoutMillis: 2000,
        });
        const required = ${JSON.stringify(requiredTables)};
        (async () => {
            try {
                await client.connect();
                const tables = await client.query(
                    \`SELECT COUNT(*)::int AS count
                     FROM unnest($1::text[]) name
                     WHERE to_regclass('public.' || name) IS NOT NULL\`,
                    [required]
                );
                const columns = await client.query(
                    \`SELECT COUNT(*)::int AS count
                     FROM information_schema.columns
                     WHERE table_schema = 'public'
                       AND table_name = ANY($1::text[])
                       AND column_name = 'technician_uuid'\`,
                    [required.slice(2)]
                );
                await client.end();
                process.exit(tables.rows[0].count === required.length && columns.rows[0].count === 8 ? 0 : 3);
            } catch (error) {
                process.stderr.write(String(error.message || error));
                try { await client.end(); } catch {}
                process.exit(2);
            }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return {
        ready: result.status === 0,
        reason: result.status === 3
            ? 'migration 240 and all eight technician_uuid columns are not present'
            : String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim(),
    };
}

const DATABASE = probeMigratedDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;

describe('native technician backfill real PostgreSQL round-trip', () => {
    databaseTest('imports live/history/config once, preserves UUIDs on rerun, and leaves another tenant unchanged', async () => {
        const companyA = randomUUID();
        const companyB = randomUUID();
        const suffix = randomUUID();
        const liveExternal = `zb-live-${suffix}`;
        const historyExternal = `zb-history-${suffix}`;
        const configExternal = `zb-config-${suffix}`;
        const sharedExternal = `zb-shared-${suffix}`;
        let foreignTechnicianId;

        const zenbookerClient = {
            getClientForCompany: jest.fn().mockResolvedValue({ companyScoped: true }),
            getTeamMembers: jest.fn().mockImplementation(async (_params, companyId) => {
                if (companyId !== companyA) throw new Error('unexpected company');
                return [
                    { id: liveExternal, first_name: 'Live', last_name: 'Provider' },
                    { id: sharedExternal, name: 'Shared Provider A' },
                ];
            }),
        };
        const dependencies = { db, zenbookerClient, output: jest.fn() };

        try {
            await db.query(
                `INSERT INTO companies (id, name, slug, status, timezone)
                 VALUES ($1, 'ZB backfill DB A', $3, 'active', 'America/New_York'),
                        ($2, 'ZB backfill DB B', $4, 'active', 'America/New_York')`,
                [companyA, companyB, `zb-backfill-a-${suffix}`, `zb-backfill-b-${suffix}`]
            );
            await db.query(
                `INSERT INTO jobs (company_id, assigned_techs)
                 VALUES ($1, $2::jsonb)`,
                [companyA, JSON.stringify([{ id: historyExternal, name: 'Historical Provider' }])]
            );
            await db.query(
                `INSERT INTO technician_profiles (company_id, tech_id, name)
                 VALUES ($1, $2, 'Config Profile Provider')`,
                [companyA, configExternal]
            );
            await db.query(
                `INSERT INTO technician_base_locations (company_id, tech_id, lat, lng)
                 VALUES ($1, '__company__', 42.0, -71.0)`,
                [companyA]
            );

            const foreign = await directoryQueries.createTechnician({
                companyId: companyB,
                displayName: 'Foreign Shared Provider',
                active: true,
            });
            foreignTechnicianId = foreign.id;
            await directoryQueries.upsertExternalIdentity({
                companyId: companyB,
                source: 'zenbooker',
                externalId: sharedExternal,
                technicianId: foreign.id,
            });
            const foreignBefore = JSON.stringify((await db.query(
                `SELECT to_jsonb(t) AS snapshot
                 FROM technicians t
                 WHERE t.company_id = $1 AND t.id = $2`,
                [companyB, foreign.id]
            )).rows[0].snapshot);

            const first = await run(['--company-id', companyA, '--apply'], dependencies);
            expect(first.summary.create_technicians).toBe(4);
            const firstRows = (await db.query(
                `SELECT e.external_id, t.id, t.display_name, t.active
                 FROM technician_external_identities e
                 JOIN technicians t
                   ON t.company_id = e.company_id AND t.id = e.technician_id
                 WHERE e.company_id = $1 AND e.source = 'zenbooker'
                 ORDER BY e.external_id`,
                [companyA]
            )).rows;
            expect(firstRows).toEqual(expect.arrayContaining([
                expect.objectContaining({ external_id: liveExternal, display_name: 'Live Provider', active: true }),
                expect.objectContaining({ external_id: sharedExternal, display_name: 'Shared Provider A', active: true }),
                expect.objectContaining({ external_id: historyExternal, display_name: 'Historical Provider', active: false }),
                expect.objectContaining({ external_id: configExternal, display_name: 'Config Profile Provider', active: false }),
            ]));
            expect(firstRows.some(row => row.external_id === '__company__')).toBe(false);

            const uuidByExternal = new Map(firstRows.map(row => [row.external_id, String(row.id)]));
            const second = await run(['--company-id', companyA, '--apply'], dependencies);
            expect(second.writes_performed).toBe(0);
            const secondRows = (await db.query(
                `SELECT e.external_id, t.id
                 FROM technician_external_identities e
                 JOIN technicians t
                   ON t.company_id = e.company_id AND t.id = e.technician_id
                 WHERE e.company_id = $1 AND e.source = 'zenbooker'`,
                [companyA]
            )).rows;
            expect(new Map(secondRows.map(row => [row.external_id, String(row.id)]))).toEqual(uuidByExternal);

            const foreignAfter = JSON.stringify((await db.query(
                `SELECT to_jsonb(t) AS snapshot
                 FROM technicians t
                 WHERE t.company_id = $1 AND t.id = $2`,
                [companyB, foreign.id]
            )).rows[0].snapshot);
            expect(foreignAfter).toBe(foreignBefore);
        } finally {
            await db.query('DELETE FROM jobs WHERE company_id = $1', [companyA]).catch(() => {});
            await db.query('DELETE FROM technician_profiles WHERE company_id = $1', [companyA]).catch(() => {});
            await db.query('DELETE FROM technician_base_locations WHERE company_id = $1', [companyA]).catch(() => {});
            if (foreignTechnicianId) {
                await db.query('DELETE FROM technicians WHERE company_id = $1 AND id = $2', [companyB, foreignTechnicianId]).catch(() => {});
            }
            await db.query('DELETE FROM technicians WHERE company_id = $1', [companyA]).catch(() => {});
            await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[companyA, companyB]]).catch(() => {});
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});
