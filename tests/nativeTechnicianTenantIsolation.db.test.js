'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const membershipQueries = require('../backend/src/db/membershipQueries');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const serviceAreaQueries = require('../backend/src/db/technicianServiceAreaQueries');
const baseLocationQueries = require('../backend/src/db/technicianBaseLocationQueries');
const timeOffQueries = require('../backend/src/db/timeOffQueries');
const workScheduleQueries = require('../backend/src/db/technicianWorkScheduleQueries');
const serviceAreaService = require('../backend/src/services/technicianServiceAreaService');

jest.setTimeout(60000);

function probeMigratedDatabase() {
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
            try {
                await client.connect();
                const result = await client.query(
                    \`SELECT to_regclass('public.technicians') IS NOT NULL
                            AND to_regclass('public.technician_external_identities') IS NOT NULL
                            AND to_regclass('public.technician_area_wildcards') IS NOT NULL AS ready\`
                );
                await client.end();
                process.exit(result.rows[0].ready ? 0 : 3);
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
    return result.status === 0;
}

const databaseTest = probeMigratedDatabase() ? test : test.skip;

describe('native technician re-key tenant isolation attacks against real PostgreSQL', () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const technicianA = randomUUID();
    const technicianB = randomUUID();
    const radiusB = randomUUID();
    const suffix = randomUUID();
    const externalA = `zb-tenant-a-${suffix}`;
    const externalB = `zb-tenant-b-${suffix}`;
    const attackDistrict = `Foreign Attack District ${suffix}`;
    let crmUserA;
    let crmUserB;

    beforeAll(async () => {
        await db.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'Native tenant attack A', $3, 'active', 'America/New_York'),
                    ($2, 'Native tenant attack B', $4, 'active', 'America/New_York')`,
            [companyA, companyB, `native-tenant-a-${suffix}`, `native-tenant-b-${suffix}`]
        );
        const users = await db.query(
            `INSERT INTO crm_users
                (keycloak_sub, email, full_name, role, status, company_id,
                 platform_role, onboarding_status, kind)
             VALUES ($1, $2, 'Tenant Attack A', 'company_member', 'active', $3,
                     'none', 'active', 'user'),
                    ($4, $5, 'Tenant Attack B', 'company_member', 'active', $6,
                     'none', 'active', 'user')
             RETURNING id, company_id`,
            [
                `native-tenant-user-a-${suffix}`,
                `native-tenant-user-a-${suffix}@test.invalid`,
                companyA,
                `native-tenant-user-b-${suffix}`,
                `native-tenant-user-b-${suffix}@test.invalid`,
                companyB,
            ]
        );
        crmUserA = users.rows.find(row => row.company_id === companyA).id;
        crmUserB = users.rows.find(row => row.company_id === companyB).id;

        await db.query(
            `INSERT INTO company_memberships
                (user_id, company_id, role, role_key, status)
             VALUES ($1, $2, 'company_member', 'provider', 'active'),
                    ($3, $4, 'company_member', 'provider', 'active')`,
            [crmUserA, companyA, crmUserB, companyB]
        );
        await db.query(
            `INSERT INTO technicians
                (id, company_id, display_name, active, crm_user_id)
             VALUES ($1, $2, 'Tenant A Technician', TRUE, $3),
                    ($4, $5, 'Tenant B Technician', TRUE, $6)`,
            [technicianA, companyA, crmUserA, technicianB, companyB, crmUserB]
        );
        await db.query(
            `INSERT INTO technician_external_identities
                (company_id, source, external_id, technician_id)
             VALUES ($1, 'zenbooker', $2, $3),
                    ($4, 'zenbooker', $5, $6)`,
            [companyA, externalA, technicianA, companyB, externalB, technicianB]
        );

        await db.query(
            `INSERT INTO service_territories (company_id, zip, area, city, state)
             VALUES ($1, '02135', $3, 'Boston', 'MA'),
                    ($2, '10001', $3, 'New York', 'NY')`,
            [companyA, companyB, attackDistrict]
        );
        await db.query(
            `INSERT INTO company_territory_settings (company_id, active_mode)
             VALUES ($1, 'list')`,
            [companyA]
        );
        await db.query(
            `INSERT INTO territory_radii
                (id, company_id, zip, lat, lon, radius_miles, position)
             VALUES ($1, $2, '10001', 40.750000, -73.990000, 10, 0)`,
            [radiusB, companyB]
        );
        await db.query(
            `INSERT INTO technician_district_assignments
                (company_id, technician_uuid, district_name)
             VALUES ($1, $2, $3)`,
            [companyB, technicianB, attackDistrict]
        );
        await db.query(
            `INSERT INTO technician_radius_assignments
                (company_id, technician_uuid, radius_id)
             VALUES ($1, $2, $3)`,
            [companyB, technicianB, radiusB]
        );
        await db.query(
            `INSERT INTO technician_area_wildcards
                (company_id, technician_uuid)
             VALUES ($1, $2)`,
            [companyB, technicianB]
        );
        await db.query(
            `INSERT INTO technician_base_locations
                (company_id, technician_uuid, is_company_default, lat, lng, label, address)
             VALUES ($1, $2, FALSE, 40.750000, -73.990000,
                     'TENANT-B-BASE', 'Tenant B only')`,
            [companyB, technicianB]
        );
        await db.query(
            `INSERT INTO technician_time_off
                (company_id, technician_uuid, technician_name,
                 starts_at, ends_at, note, source)
             VALUES ($1, $2, 'Tenant B Technician',
                     '2036-04-01T13:00:00.000Z', '2036-04-01T17:00:00.000Z',
                     'TENANT-B-TIME-OFF', 'individual')`,
            [companyB, technicianB]
        );
        await db.query(
            `INSERT INTO technician_work_schedules
                (company_id, technician_uuid, inherits_company_schedule)
             VALUES ($1, $2, FALSE)`,
            [companyB, technicianB]
        );
        await db.query(
            `INSERT INTO technician_work_schedule_days
                (company_id, technician_uuid,
                 day_of_week, is_working, work_start_time, work_end_time)
             VALUES ($1, $2, 1, TRUE, '11:00', '15:00')`,
            [companyB, technicianB]
        );
    });

    databaseTest('rejects B external id in the external-to-UUID resolver under A', async () => {
        await expect(directoryQueries.resolveExternalToUuid(
            companyA,
            'zenbooker',
            externalB
        )).resolves.toBeNull();
    });

    databaseTest('rejects B native UUID in the UUID-to-external resolver under A', async () => {
        await expect(directoryQueries.resolveUuidToExternal(
            companyA,
            'zenbooker',
            technicianB
        )).resolves.toBeNull();
    });

    databaseTest('ZB-leak guard drops B native UUID before an A provider push', async () => {
        await expect(directoryQueries.resolveCompatibilityIdsToExternal(
            companyA,
            'zenbooker',
            [technicianB]
        )).resolves.toEqual([]);
    });

    databaseTest('A active directory lists only A and never B', async () => {
        const roster = await directoryQueries.listActiveTechnicians(companyA);
        expect(roster.map(row => String(row.id))).toEqual([technicianA]);
        expect(roster.map(row => String(row.id))).not.toContain(technicianB);
    });

    databaseTest('A cannot find B technician through B crm_user_id', async () => {
        await expect(directoryQueries.findActiveTechnicianByCrmUserId(companyA, crmUserB))
            .resolves.toBeNull();
    });

    databaseTest('authz mirror grants no B crm_user through UUID or external id under A', async () => {
        await expect(membershipQueries.resolveProviderUserIds(companyA, [technicianB]))
            .resolves.toEqual([]);
        await expect(membershipQueries.resolveProviderUserIds(companyA, [externalB]))
            .resolves.toEqual([]);
    });

    databaseTest('B district, radius, and wildcard rows never make B eligible under A', async () => {
        const assignments = await serviceAreaQueries.listValidAssignments(companyA);
        const wildcards = await serviceAreaQueries.listWildcardTechnicians(companyA);
        expect(assignments).toEqual({ districts: [], radii: [] });
        expect(wildcards).toEqual([]);

        const filtered = await serviceAreaService.filterEligibleTechnicians(
            companyA,
            [{ id: technicianB, name: 'Tenant B Technician' }],
            { query: '02135' }
        );
        expect(filtered.technicians).toEqual([]);
        expect(filtered.matches).toEqual([{
            technician_id: technicianB,
            wildcard: false,
            unassigned: true,
            eligible: false,
        }]);
    });

    databaseTest('A base, time-off, and work-schedule reads return no B UUID-keyed rows', async () => {
        await expect(baseLocationQueries.listByCompany(companyA)).resolves.toEqual([]);
        await expect(timeOffQueries.listRange(companyA, {
            from: '2035-01-01T00:00:00.000Z',
            to: '2037-01-01T00:00:00.000Z',
        })).resolves.toEqual([]);
        await expect(timeOffQueries.listRange(companyA, {
            from: '2035-01-01T00:00:00.000Z',
            to: '2037-01-01T00:00:00.000Z',
            technicianId: technicianB,
        })).resolves.toEqual([]);
        await expect(workScheduleQueries.listByTechnicianIds(companyA, [technicianB]))
            .resolves.toEqual([]);
    });

    afterAll(async () => {
        for (const companyId of [companyA, companyB]) {
            await db.query(
                'DELETE FROM technician_work_schedule_days WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query(
                'DELETE FROM technician_work_schedules WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query(
                'DELETE FROM technician_time_off WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query(
                'DELETE FROM technician_base_locations WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query(
                'DELETE FROM technician_area_wildcards WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query(
                'DELETE FROM technician_district_assignments WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query(
                'DELETE FROM technician_radius_assignments WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query('DELETE FROM technicians WHERE company_id = $1', [companyId]).catch(() => {});
            await db.query(
                'DELETE FROM company_memberships WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
        }
        if (crmUserA || crmUserB) {
            await db.query(
                'DELETE FROM crm_users WHERE id = ANY($1::uuid[])',
                [[crmUserA, crmUserB].filter(Boolean)]
            ).catch(() => {});
        }
        await db.query(
            'DELETE FROM companies WHERE id = ANY($1::uuid[])',
            [[companyA, companyB]]
        ).catch(() => {});
        try { await db.pool.end(); } catch (_) { /* already closed */ }
    });
});
