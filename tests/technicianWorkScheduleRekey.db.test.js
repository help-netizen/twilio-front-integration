'use strict';

jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(async () => ({
        timezone: 'America/New_York',
        work_start_time: '08:00:00',
        work_end_time: '18:00:00',
        work_days: [1, 2, 3, 4, 5],
    })),
}));

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const service = require('../backend/src/services/technicianWorkScheduleService');

jest.setTimeout(60000);

function customWeek(start, end) {
    return Array.from({ length: 7 }, (_, day) => ({
        day_of_week: day,
        is_working: day >= 1 && day <= 5,
        work_start_time: day >= 1 && day <= 5 ? start : null,
        work_end_time: day >= 1 && day <= 5 ? end : null,
    }));
}

function comparable(result) {
    const { technician_id, technician_name, ...rest } = result;
    return rest;
}

describe('technician work-schedule native UUID re-key (real PostgreSQL)', () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const suffix = randomUUID();
    const nativeExternal = `zb-schedule-native-${suffix}`;
    const sharedExternal = `zb-schedule-shared-${suffix}`;
    let nativeTechnician;
    let legacyTechnician;
    let foreignTechnician;

    async function settings(companyId, id, name = 'Technician') {
        return service.getSettings(companyId, { id: String(id), name });
    }

    beforeAll(async () => {
        await db.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'Schedule rekey DB A', $3, 'active', 'America/New_York'),
                    ($2, 'Schedule rekey DB B', $4, 'active', 'America/New_York')`,
            [companyA, companyB, `schedule-rekey-a-${suffix}`, `schedule-rekey-b-${suffix}`]
        );
        nativeTechnician = await directoryQueries.createTechnician({
            companyId: companyA,
            displayName: 'Native Schedule Tech',
        });
        legacyTechnician = await directoryQueries.createTechnician({
            companyId: companyA,
            displayName: 'Legacy Schedule Tech',
        });
        foreignTechnician = await directoryQueries.createTechnician({
            companyId: companyB,
            displayName: 'Foreign Schedule Tech',
        });
        await Promise.all([
            directoryQueries.upsertExternalIdentity({
                companyId: companyA,
                source: 'zenbooker',
                externalId: nativeExternal,
                technicianId: nativeTechnician.id,
            }),
            directoryQueries.upsertExternalIdentity({
                companyId: companyA,
                source: 'zenbooker',
                externalId: sharedExternal,
                technicianId: legacyTechnician.id,
            }),
            directoryQueries.upsertExternalIdentity({
                companyId: companyB,
                source: 'zenbooker',
                externalId: sharedExternal,
                technicianId: foreignTechnician.id,
            }),
        ]);

        await service.save(companyA, { id: nativeTechnician.id, name: 'Native Schedule Tech' }, {
            inherits_company_schedule: false,
            days: customWeek('09:00', '17:00'),
        }, null);

        for (const [companyId, start, end] of [
            [companyA, '10:00', '16:00'],
            [companyB, '11:00', '15:00'],
        ]) {
            await db.query(
                `INSERT INTO technician_work_schedules
                    (company_id, technician_id, technician_uuid, inherits_company_schedule)
                 VALUES ($1, $2, NULL, FALSE)`,
                [companyId, sharedExternal]
            );
            await db.query(
                `INSERT INTO technician_work_schedule_days
                    (company_id, technician_id, technician_uuid,
                     day_of_week, is_working, work_start_time, work_end_time)
                 SELECT $1, $2, NULL, day,
                        day BETWEEN 1 AND 5,
                        CASE WHEN day BETWEEN 1 AND 5 THEN $3::time ELSE NULL END,
                        CASE WHEN day BETWEEN 1 AND 5 THEN $4::time ELSE NULL END
                 FROM generate_series(0, 6) AS day`,
                [companyId, sharedExternal, start, end]
            );
        }
    });

    test('native replace dual-writes parent/days and rerun is idempotent', async () => {
        await service.save(companyA, { id: nativeExternal, name: 'Native Schedule Tech' }, {
            inherits_company_schedule: false,
            days: customWeek('09:00', '17:00'),
        }, null);
        const parent = (await db.query(
            `SELECT technician_id, technician_uuid
             FROM technician_work_schedules
             WHERE company_id = $1 AND technician_uuid = $2`,
            [companyA, nativeTechnician.id]
        )).rows;
        const days = (await db.query(
            `SELECT technician_id, technician_uuid
             FROM technician_work_schedule_days
             WHERE company_id = $1 AND technician_uuid = $2`,
            [companyA, nativeTechnician.id]
        )).rows;
        expect(parent).toEqual([{
            technician_id: nativeExternal,
            technician_uuid: nativeTechnician.id,
        }]);
        expect(days).toHaveLength(7);
        expect(new Set(days.map(day => day.technician_id))).toEqual(new Set([nativeExternal]));
        expect(new Set(days.map(day => day.technician_uuid))).toEqual(new Set([nativeTechnician.id]));
    });

    test('native and legacy rows each read identically through UUID and ZB keys', async () => {
        expect(comparable(await settings(companyA, nativeTechnician.id))).toEqual(
            comparable(await settings(companyA, nativeExternal))
        );
        const legacyViaUuid = await settings(companyA, legacyTechnician.id);
        const legacyViaExternal = await settings(companyA, sharedExternal);
        expect(comparable(legacyViaUuid)).toEqual(comparable(legacyViaExternal));
        expect(legacyViaUuid).toMatchObject({
            has_schedule: true,
            inherits_company_schedule: false,
        });
        expect(legacyViaUuid.saved_week.find(day => day.day_of_week === 1)).toMatchObject({
            work_start_time: '10:00',
            work_end_time: '16:00',
        });

        const legacyRows = (await db.query(
            `SELECT technician_uuid
             FROM technician_work_schedules
             WHERE company_id = $1 AND technician_id = $2
             UNION ALL
             SELECT technician_uuid
             FROM technician_work_schedule_days
             WHERE company_id = $1 AND technician_id = $2`,
            [companyA, sharedExternal]
        )).rows;
        expect(legacyRows).toHaveLength(8);
        expect(legacyRows.every(row => row.technician_uuid === null)).toBe(true);
    });

    test('same ZB id resolves per company and foreign UUID cannot cross (SAB-T3B2-SCHEDULE control)', async () => {
        const local = await settings(companyA, sharedExternal);
        const foreign = await settings(companyB, sharedExternal);
        expect(local.saved_week.find(day => day.day_of_week === 1).work_start_time).toBe('10:00');
        expect(foreign.saved_week.find(day => day.day_of_week === 1).work_start_time).toBe('11:00');

        const foreignThroughA = await settings(companyA, foreignTechnician.id);
        expect(foreignThroughA.has_schedule).toBe(false);
        expect(foreignThroughA.inherits_company_schedule).toBe(true);
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
            await db.query('DELETE FROM technicians WHERE company_id = $1', [companyId]).catch(() => {});
        }
        await db.query(
            'DELETE FROM companies WHERE id = ANY($1::uuid[])',
            [[companyA, companyB]]
        ).catch(() => {});
        try { await db.pool.end(); } catch (_) { /* already closed */ }
    });
});
