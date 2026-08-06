'use strict';

jest.mock('../backend/src/services/technicianRosterService', () => ({
    listActive: jest.fn(),
    requireActive: jest.fn(),
}));
jest.mock('../backend/src/services/googlePlacesService', () => ({
    geocodeAddress: jest.fn(),
}));
jest.mock('../backend/src/services/storageService', () => ({
    generateStorageKey: jest.fn(),
    uploadFile: jest.fn(),
    deleteFile: jest.fn(),
    getPresignedUrl: jest.fn(),
}));

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const baseQueries = require('../backend/src/db/technicianBaseLocationQueries');
const scheduleQueries = require('../backend/src/db/technicianWorkScheduleQueries');
const timeOffQueries = require('../backend/src/db/timeOffQueries');
const serviceAreaQueries = require('../backend/src/db/technicianServiceAreaQueries');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const rosterService = require('../backend/src/services/technicianRosterService');
const storageService = require('../backend/src/services/storageService');
const baseService = require('../backend/src/services/technicianBaseLocationsService');
const serviceAreaService = require('../backend/src/services/technicianServiceAreaService');
const profilesService = require('../backend/src/services/technicianProfilesService');

jest.setTimeout(60000);

function customWeek() {
    return Array.from({ length: 7 }, (_, day) => ({
        day_of_week: day,
        is_working: day >= 1 && day <= 5,
        work_start_time: day >= 1 && day <= 5 ? '09:00' : null,
        work_end_time: day >= 1 && day <= 5 ? '17:00' : null,
    }));
}

function baseValues(row) {
    return row && {
        lat: row.lat,
        lng: row.lng,
        label: row.label,
        address: row.address,
        has_base: row.has_base,
    };
}

function scheduleValues(rows) {
    return rows.map(({ technician_id, ...row }) => row);
}

function profileValues(row) {
    if (!row) return row;
    const { tech_id, ...rest } = row;
    return rest;
}

describe('technician re-key preserves the empty-directory legacy state (real PostgreSQL)', () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const suffix = randomUUID();
    const legacyId = `zb-empty-directory-${suffix}`;
    const radiusA = randomUUID();
    const radiusB = randomUUID();
    const from = '2035-01-01T00:00:00.000Z';
    const to = '2037-01-01T00:00:00.000Z';
    let nativeTechnician;

    beforeAll(async () => {
        await db.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'Empty directory DB A', $3, 'active', 'America/New_York'),
                    ($2, 'Empty directory DB B', $4, 'active', 'America/New_York')`,
            [companyA, companyB, `empty-directory-a-${suffix}`, `empty-directory-b-${suffix}`]
        );
        await db.query(
            `INSERT INTO service_territories (company_id, zip, area, city, state)
             VALUES ($1, '02135', 'North', 'Boston', 'MA'),
                    ($2, '10001', 'North', 'New York', 'NY')`,
            [companyA, companyB]
        );
        await db.query(
            `INSERT INTO territory_radii
                (id, company_id, zip, lat, lon, radius_miles, position)
             VALUES ($1, $3, '02135', 42.350000, -71.080000, 5, 0),
                    ($2, $4, '10001', 40.750000, -73.990000, 5, 0)`,
            [radiusA, radiusB, companyA, companyB]
        );
        await db.query(
            `INSERT INTO company_territory_settings (company_id, active_mode)
             VALUES ($1, 'list'), ($2, 'list')`,
            [companyA, companyB]
        );

        rosterService.listActive.mockResolvedValue([]);
        storageService.generateStorageKey.mockImplementation(
            (companyId, _entity, techId) => `profiles/${companyId}/${techId}-${suffix}.jpg`
        );
        storageService.uploadFile.mockResolvedValue();
        storageService.deleteFile.mockResolvedValue();
    });

    test('legacy reads and writes remain complete with zero native identities', async () => {
        const directoryCounts = await db.query(
            `SELECT
                (SELECT COUNT(*)::int FROM technicians WHERE company_id = $1) AS technicians,
                (SELECT COUNT(*)::int
                 FROM technician_external_identities WHERE company_id = $1) AS identities`,
            [companyA]
        );
        expect(directoryCounts.rows[0]).toEqual({ technicians: 0, identities: 0 });

        await baseQueries.upsert(companyA, legacyId, {
            lat: 42.351,
            lng: -71.081,
            label: 'Legacy base',
            address: '1 Legacy Way',
        });
        const bases = await baseQueries.listByCompany(companyA);
        expect(bases).toEqual([expect.objectContaining({
            tech_id: legacyId,
            technician_uuid: null,
            lat: 42.351,
            lng: -71.081,
            label: 'Legacy base',
        })]);

        await scheduleQueries.replace(companyA, legacyId, {
            inheritsCompanySchedule: false,
            days: customWeek(),
            updatedBy: null,
        });
        const schedule = await scheduleQueries.listByTechnicianIds(companyA, [legacyId]);
        expect(schedule).toHaveLength(7);
        expect(schedule.every(day => day.technician_id === legacyId)).toBe(true);
        const storedSchedule = await db.query(
            `SELECT technician_uuid
             FROM technician_work_schedules
             WHERE company_id = $1 AND technician_id = $2
             UNION ALL
             SELECT technician_uuid
             FROM technician_work_schedule_days
             WHERE company_id = $1 AND technician_id = $2`,
            [companyA, legacyId]
        );
        expect(storedSchedule.rows).toHaveLength(8);
        expect(storedSchedule.rows.every(row => row.technician_uuid === null)).toBe(true);

        await timeOffQueries.insertOne(companyA, {
            technicianId: legacyId,
            technicianName: 'Legacy Technician',
            startsAt: '2036-04-01T13:00:00.000Z',
            endsAt: '2036-04-01T17:00:00.000Z',
            note: 'Legacy time off',
        });
        await expect(timeOffQueries.listRange(companyA, {
            from,
            to,
            technicianId: legacyId,
        })).resolves.toEqual([expect.objectContaining({
            technician_id: legacyId,
            note: 'Legacy time off',
        })]);
        await expect(db.query(
            `SELECT technician_uuid
             FROM technician_time_off
             WHERE company_id = $1 AND technician_id = $2`,
            [companyA, legacyId]
        )).resolves.toMatchObject({ rows: [{ technician_uuid: null }] });

        await serviceAreaQueries.replaceTechnicianDistricts(
            companyA,
            legacyId,
            ['North'],
            null
        );
        await serviceAreaQueries.replaceTechnicianRadii(
            companyA,
            legacyId,
            [radiusA],
            null
        );
        const assignments = await serviceAreaQueries.listValidAssignments(companyA);
        expect(assignments.districts).toEqual([{
            technician_id: legacyId,
            district_name: 'North',
        }]);
        expect(assignments.radii).toEqual([{
            technician_id: legacyId,
            radius_id: radiusA,
        }]);
        const districtEligible = await serviceAreaService.filterEligibleTechnicians(
            companyA,
            [{ id: legacyId, name: 'Legacy Technician' }],
            { query: '02135' }
        );
        expect(districtEligible.technicians).toEqual([
            { id: legacyId, name: 'Legacy Technician' },
        ]);
        await db.query(
            `UPDATE company_territory_settings SET active_mode = 'radius' WHERE company_id = $1`,
            [companyA]
        );
        const radiusEligible = await serviceAreaService.filterEligibleTechnicians(
            companyA,
            [{ id: legacyId, name: 'Legacy Technician' }],
            { lat: 42.35, lng: -71.08 }
        );
        expect(radiusEligible.technicians).toEqual([
            { id: legacyId, name: 'Legacy Technician' },
        ]);
        await db.query(
            `UPDATE company_territory_settings SET active_mode = 'list' WHERE company_id = $1`,
            [companyA]
        );

        await profilesService.uploadPhoto(companyA, legacyId, {
            name: 'Legacy profile',
            file: {
                originalname: 'legacy.jpg',
                mimetype: 'image/jpeg',
                buffer: Buffer.from('legacy-profile'),
            },
        });
        await expect(profilesService.getProfile(companyA, legacyId)).resolves.toMatchObject({
            tech_id: legacyId,
            name: 'Legacy profile',
        });
        await expect(db.query(
            `SELECT technician_uuid
             FROM technician_profiles
             WHERE company_id = $1 AND tech_id = $2`,
            [companyA, legacyId]
        )).resolves.toMatchObject({ rows: [{ technician_uuid: null }] });

        expect(await baseQueries.listByCompany(companyB)).toEqual([]);
        expect(await scheduleQueries.listByTechnicianIds(companyB, [legacyId])).toEqual([]);
        expect(await timeOffQueries.listRange(companyB, {
            from,
            to,
            technicianId: legacyId,
        })).toEqual([]);
        expect(await serviceAreaQueries.listValidAssignments(companyB)).toEqual({
            districts: [],
            radii: [],
        });
        const foreignEligibility = await serviceAreaService.filterEligibleTechnicians(
            companyB,
            [{ id: legacyId, name: 'Foreign same-id technician' }],
            { query: '10001' }
        );
        expect(foreignEligibility.technicians).toEqual([]);
        expect(await profilesService.getProfile(companyB, legacyId)).toBeNull();
    });

    test('the same NULL-UUID rows remain readable by legacy id and UUID after mapping', async () => {
        nativeTechnician = await directoryQueries.createTechnician({
            companyId: companyA,
            displayName: 'Mapped Legacy Technician',
        });
        await directoryQueries.upsertExternalIdentity({
            companyId: companyA,
            source: 'zenbooker',
            externalId: legacyId,
            technicianId: nativeTechnician.id,
        });

        rosterService.listActive.mockResolvedValueOnce([{ id: legacyId, name: 'Legacy Technician' }]);
        const baseViaLegacy = (await baseService.list(companyA))[0];
        rosterService.listActive.mockResolvedValueOnce([{
            id: nativeTechnician.id,
            name: 'Legacy Technician',
        }]);
        const baseViaUuid = (await baseService.list(companyA))[0];
        expect(baseValues(baseViaLegacy)).toEqual(baseValues(baseViaUuid));
        expect(baseValues(baseViaUuid)).toMatchObject({ label: 'Legacy base', has_base: true });

        const scheduleViaLegacy = await scheduleQueries.listByTechnicianIds(companyA, [legacyId]);
        const scheduleViaUuid = await scheduleQueries.listByTechnicianIds(
            companyA,
            [nativeTechnician.id]
        );
        expect(scheduleViaLegacy).toHaveLength(7);
        expect(scheduleValues(scheduleViaLegacy)).toEqual(scheduleValues(scheduleViaUuid));

        const timeOffViaLegacy = await timeOffQueries.listRange(companyA, {
            from,
            to,
            technicianId: legacyId,
        });
        const timeOffViaUuid = await timeOffQueries.listRange(companyA, {
            from,
            to,
            technicianId: nativeTechnician.id,
        });
        expect(timeOffViaLegacy).toEqual(timeOffViaUuid);
        expect(timeOffViaUuid).toHaveLength(1);

        const serviceAreaViaLegacy = await serviceAreaService.filterEligibleTechnicians(
            companyA,
            [{ id: legacyId, name: 'Legacy Technician' }],
            { query: '02135' }
        );
        const serviceAreaViaUuid = await serviceAreaService.filterEligibleTechnicians(
            companyA,
            [{ id: nativeTechnician.id, name: 'Legacy Technician' }],
            { query: '02135' }
        );
        expect(serviceAreaViaLegacy.matches[0]).toMatchObject({ eligible: true });
        expect(serviceAreaViaUuid.matches[0]).toMatchObject({ eligible: true });

        const profileViaLegacy = await profilesService.getProfile(companyA, legacyId);
        const profileViaUuid = await profilesService.getProfile(companyA, nativeTechnician.id);
        expect(profileValues(profileViaLegacy)).toEqual(profileValues(profileViaUuid));
        expect(profileValues(profileViaUuid)).toMatchObject({ name: 'Legacy profile' });

        const nullUuidRows = await db.query(
            `SELECT technician_uuid FROM technician_base_locations
             WHERE company_id = $1 AND tech_id = $2
             UNION ALL
             SELECT technician_uuid FROM technician_work_schedules
             WHERE company_id = $1 AND technician_id = $2
             UNION ALL
             SELECT technician_uuid FROM technician_time_off
             WHERE company_id = $1 AND technician_id = $2
             UNION ALL
             SELECT technician_uuid FROM technician_district_assignments
             WHERE company_id = $1 AND technician_id = $2
             UNION ALL
             SELECT technician_uuid FROM technician_radius_assignments
             WHERE company_id = $1 AND technician_id = $2
             UNION ALL
             SELECT technician_uuid FROM technician_profiles
             WHERE company_id = $1 AND tech_id = $2`,
            [companyA, legacyId]
        );
        expect(nullUuidRows.rows).toHaveLength(6);
        expect(nullUuidRows.rows.every(row => row.technician_uuid === null)).toBe(true);

        expect(await scheduleQueries.listByTechnicianIds(companyB, [legacyId])).toEqual([]);
        expect(await scheduleQueries.listByTechnicianIds(companyB, [nativeTechnician.id])).toEqual([]);
        expect(await profilesService.getProfile(companyB, legacyId)).toBeNull();
        expect(await profilesService.getProfile(companyB, nativeTechnician.id)).toBeNull();
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
            for (const table of [
                'technician_profiles',
                'technician_base_locations',
                'technician_time_off',
                'technician_district_assignments',
                'technician_radius_assignments',
                'technician_area_wildcards',
            ]) {
                await db.query(`DELETE FROM ${table} WHERE company_id = $1`, [companyId])
                    .catch(() => {});
            }
            await db.query('DELETE FROM territory_radii WHERE company_id = $1', [companyId])
                .catch(() => {});
            await db.query('DELETE FROM service_territories WHERE company_id = $1', [companyId])
                .catch(() => {});
            await db.query('DELETE FROM technicians WHERE company_id = $1', [companyId])
                .catch(() => {});
        }
        await db.query(
            'DELETE FROM companies WHERE id = ANY($1::uuid[])',
            [[companyA, companyB]]
        ).catch(() => {});
        try { await db.pool.end(); } catch (_) { /* already closed */ }
    });
});
