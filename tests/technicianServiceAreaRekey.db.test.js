'use strict';

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const serviceAreaQueries = require('../backend/src/db/technicianServiceAreaQueries');
const service = require('../backend/src/services/technicianServiceAreaService');

jest.setTimeout(60000);

describe('SAB-A-ZONE-UUID-PARITY real PostgreSQL control', () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const suffix = randomUUID();
    const externalA = `zb-zone-a-${suffix}`;
    const externalB = `zb-zone-b-${suffix}`;
    const sharedExternal = `zb-zone-shared-${suffix}`;
    const northRadius = randomUUID();
    const southRadius = randomUUID();
    let technicianA;
    let technicianB;
    let technicianC;
    let foreignTechnician;

    function roster(keyType) {
        const id = (technician, externalId) => (
            keyType === 'uuid' ? String(technician.id) : externalId
        );
        return [
            { id: id(technicianA, externalA), name: 'Tech A' },
            { id: id(technicianB, externalB), name: 'Tech B' },
            { id: id(technicianC, sharedExternal), name: 'Tech C' },
        ];
    }

    function eligibleNames(result) {
        return result.technicians.map(technician => technician.name).sort();
    }

    async function assertEligibilityParity(location, expectedNames) {
        const uuidRoster = roster('uuid');
        const externalRoster = roster('external');
        const [uuidResult, externalResult] = await Promise.all([
            service.filterEligibleTechnicians(companyA, uuidRoster, location),
            service.filterEligibleTechnicians(companyA, externalRoster, location),
        ]);

        expect(eligibleNames(uuidResult)).toEqual(expectedNames);
        expect(eligibleNames(externalResult)).toEqual(expectedNames);
        expect(uuidResult.matches.map(match => match.technician_id)).toEqual(
            uuidRoster.map(technician => technician.id)
        );
        expect(externalResult.matches.map(match => match.technician_id)).toEqual(
            externalRoster.map(technician => technician.id)
        );
        expect(uuidResult.matches.find(match => match.technician_id === String(technicianB.id)))
            .toMatchObject({ wildcard: false, unassigned: true, eligible: false });
        expect(externalResult.matches.find(match => match.technician_id === externalB))
            .toMatchObject({ wildcard: false, unassigned: true, eligible: false });
    }

    beforeAll(async () => {
        await db.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'Zone rekey DB A', $3, 'active', 'America/New_York'),
                    ($2, 'Zone rekey DB B', $4, 'active', 'America/New_York')`,
            [companyA, companyB, `zone-rekey-a-${suffix}`, `zone-rekey-b-${suffix}`]
        );

        technicianA = await directoryQueries.createTechnician({
            companyId: companyA,
            displayName: 'Tech A',
        });
        technicianB = await directoryQueries.createTechnician({
            companyId: companyA,
            displayName: 'Tech B',
        });
        technicianC = await directoryQueries.createTechnician({
            companyId: companyA,
            displayName: 'Tech C',
        });
        foreignTechnician = await directoryQueries.createTechnician({
            companyId: companyB,
            displayName: 'Foreign Tech C',
        });
        await Promise.all([
            directoryQueries.upsertExternalIdentity({
                companyId: companyA,
                source: 'zenbooker',
                externalId: externalA,
                technicianId: technicianA.id,
            }),
            directoryQueries.upsertExternalIdentity({
                companyId: companyA,
                source: 'zenbooker',
                externalId: externalB,
                technicianId: technicianB.id,
            }),
            directoryQueries.upsertExternalIdentity({
                companyId: companyA,
                source: 'zenbooker',
                externalId: sharedExternal,
                technicianId: technicianC.id,
            }),
            directoryQueries.upsertExternalIdentity({
                companyId: companyB,
                source: 'zenbooker',
                externalId: sharedExternal,
                technicianId: foreignTechnician.id,
            }),
        ]);

        await db.query(
            `INSERT INTO service_territories (company_id, zip, area, city, state)
             VALUES ($1, '02135', 'North', 'Boston', 'MA'),
                    ($1, '02118', 'South', 'Boston', 'MA'),
                    ($2, '10001', 'Foreign', 'New York', 'NY')`,
            [companyA, companyB]
        );
        await db.query(
            `INSERT INTO territory_radii
                (id, company_id, zip, lat, lon, radius_miles, position)
             VALUES ($1, $3, '02135', 42.350000, -71.080000, 5, 0),
                    ($2, $3, '02118', 40.710000, -74.000000, 5, 1)`,
            [northRadius, southRadius, companyA]
        );

        // The native-key configuration is written through both replacement
        // directions. Each row retains the compatibility TEXT id and carries
        // the canonical UUID alongside it.
        await serviceAreaQueries.replaceDistrictTechnicians(
            companyA,
            'North',
            [String(technicianA.id)],
            null
        );
        await serviceAreaQueries.replaceTechnicianRadii(
            companyA,
            externalA,
            [northRadius],
            null
        );
        await serviceAreaQueries.setWildcardTechnician(companyA, sharedExternal, true, null);

        const dualWritten = (await db.query(
            `SELECT technician_id, technician_uuid
             FROM technician_district_assignments
             WHERE company_id = $1 AND district_name = 'North'
             UNION ALL
             SELECT technician_id, technician_uuid
             FROM technician_radius_assignments
             WHERE company_id = $1 AND radius_id = $2
             UNION ALL
             SELECT technician_id, technician_uuid
             FROM technician_area_wildcards
             WHERE company_id = $1`,
            [companyA, northRadius]
        )).rows;
        expect(dualWritten).toEqual(expect.arrayContaining([
            { technician_id: externalA, technician_uuid: technicianA.id },
            { technician_id: externalA, technician_uuid: technicianA.id },
            { technician_id: sharedExternal, technician_uuid: technicianC.id },
        ]));

        // Tech C expresses the same Albusto-owned district/radius/wildcard
        // values only through the legacy TEXT key, exercising NULL-UUID fallback.
        await db.query(
            `UPDATE technician_area_wildcards
             SET technician_uuid = NULL
             WHERE company_id = $1 AND technician_id = $2`,
            [companyA, sharedExternal]
        );
        await db.query(
            `INSERT INTO technician_district_assignments
                (company_id, technician_id, technician_uuid, district_name)
             VALUES ($1, $2, NULL, 'North')`,
            [companyA, sharedExternal]
        );
        await db.query(
            `INSERT INTO technician_radius_assignments
                (company_id, technician_id, technician_uuid, radius_id)
             VALUES ($1, $2, NULL, $3)`,
            [companyA, sharedExternal, northRadius]
        );
    });

    test('SAB-A-ZONE-UUID-PARITY — UUID and ZB caller keys yield A/C then C in list and radius mode', async () => {
        const externalState = await service.getAssignmentState(companyA, roster('external'));
        expect(externalState.technician_assignments).toEqual(expect.arrayContaining([
            expect.objectContaining({
                technician_id: externalA,
                district_names: ['North'],
                radius_ids: [northRadius],
            }),
            expect.objectContaining({
                technician_id: sharedExternal,
                district_names: ['North'],
                radius_ids: [northRadius],
                serves_all_territory: true,
            }),
        ]));

        await db.query(
            `INSERT INTO company_territory_settings (company_id, active_mode)
             VALUES ($1, 'list')
             ON CONFLICT (company_id) DO UPDATE SET active_mode = EXCLUDED.active_mode`,
            [companyA]
        );
        await assertEligibilityParity({ query: '02135' }, ['Tech A', 'Tech C']);
        await assertEligibilityParity({ query: '02118' }, ['Tech C']);

        await db.query(
            `UPDATE company_territory_settings
             SET active_mode = 'radius'
             WHERE company_id = $1`,
            [companyA]
        );
        await assertEligibilityParity(
            { lat: 42.35, lng: -71.08 },
            ['Tech A', 'Tech C']
        );
        await assertEligibilityParity(
            { lat: 40.71, lng: -74.00 },
            ['Tech C']
        );
    });

    test('shared ZB ids resolve per company and a foreign native UUID never inherits local eligibility', async () => {
        await db.query(
            `UPDATE company_territory_settings
             SET active_mode = 'list'
             WHERE company_id = $1`,
            [companyA]
        );
        const local = await service.filterEligibleTechnicians(
            companyA,
            [
                { id: String(technicianC.id), name: 'Local Tech C' },
                { id: String(foreignTechnician.id), name: 'Foreign Tech C' },
            ],
            { query: '02135' }
        );
        expect(local.technicians.map(technician => technician.id)).toEqual([
            String(technicianC.id),
        ]);

        await db.query(
            `UPDATE company_territory_settings
             SET active_mode = 'radius'
             WHERE company_id = $1`,
            [companyA]
        );
        const localRadius = await service.filterEligibleTechnicians(
            companyA,
            [
                { id: String(technicianC.id), name: 'Local Tech C' },
                { id: String(foreignTechnician.id), name: 'Foreign Tech C' },
            ],
            { lat: 42.35, lng: -71.08 }
        );
        expect(localRadius.technicians.map(technician => technician.id)).toEqual([
            String(technicianC.id),
        ]);

        const foreign = await service.filterEligibleTechnicians(
            companyB,
            [{ id: sharedExternal, name: 'Foreign Tech C' }],
            { query: '10001' }
        );
        expect(foreign.matches).toEqual([
            {
                technician_id: sharedExternal,
                wildcard: false,
                unassigned: true,
                eligible: false,
            },
        ]);
        expect(foreign.technicians).toEqual([]);
    });

    afterAll(async () => {
        for (const companyId of [companyA, companyB]) {
            await db.query(
                'DELETE FROM technician_district_assignments WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query(
                'DELETE FROM technician_radius_assignments WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query(
                'DELETE FROM technician_area_wildcards WHERE company_id = $1',
                [companyId]
            ).catch(() => {});
            await db.query('DELETE FROM technicians WHERE company_id = $1', [companyId]).catch(() => {});
        }
        await db.query(
            'DELETE FROM companies WHERE id = ANY($1::uuid[])',
            [[companyA, companyB]]
        ).catch(() => {});
        try { await db.pool.end(); } catch (_) { /* already closed */ }
    });
});
