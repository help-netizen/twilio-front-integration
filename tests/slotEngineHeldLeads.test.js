/**
 * VAPI-SLOT-ENGINE-001 T1 — held-lead occupancy sub-read + tzCombine DST + case-fix.
 *
 * Covers (P0 gate VSE-U-01 tz-combine DST + occupancy-shape + status-fix SQL):
 *  - buildScheduledJobs appends OPEN held leads to the jobs occupancy in the shared
 *    occupancy shape ({ id:'lead:<id>', assigned_technicians:[], window_start/end,
 *    lat/lng, duration_minutes }); coords are Number()-coerced.
 *  - the held-lead sub-read SQL uses case-INSENSITIVE terminal-status (LOWER(status)
 *    NOT IN ('converted','lost','spam')) — the render+occupancy case-fix.
 *  - a geo-less / missing lead_date_time row never enters occupancy (SQL WHERE guards;
 *    a mocked db returns only rows matching the filter, so we assert the emitted set).
 *  - scheduleQueries leads branch mirrors LOWER(l.status) (render half of the case-fix).
 *  - tzCombine is DST-aware: EDT (Jul, UTC−4), EST (Jan, UTC−5), a non-ET tz, and a
 *    'GMT'/no-offset tz (offset 0).
 *
 * Jest mocks the DB (LIST-PAGINATION-001 lesson: a string-only mock can hide a
 * real occupancy-read bug) — the live present/absent proof is T4 (VSE-INT-01) on a
 * real DB. Here we assert the shape + the exact SQL predicate the real query issues.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({ getTeamMembers: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({ listJobs: jest.fn() }));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(async () => ({ timezone: 'America/New_York' })),
}));

const dbConn = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');
const slotEngineService = require('../backend/src/services/slotEngineService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const TZ = 'America/New_York';

beforeEach(() => {
    jest.clearAllMocks();
    jobsService.listJobs.mockReset().mockResolvedValue([]);
    dbConn.query.mockReset().mockResolvedValue({ rows: [] });
});

// ─── Held-lead occupancy sub-read: shape ─────────────────────────────────────

describe('buildScheduledJobs — held-lead occupancy', () => {
    it('appends an open geo\'d held lead to the jobs occupancy in the shared shape', async () => {
        jobsService.listJobs.mockResolvedValue([]); // isolate the lead half
        // 10:00–13:00 EDT (14:00Z–17:00Z) → 180 min hold, unassigned.
        dbConn.query.mockResolvedValue({
            rows: [{
                id: 42,
                lead_date_time: '2026-07-08T14:00:00.000Z',
                lead_end_date_time: '2026-07-08T17:00:00.000Z',
                latitude: '42.3601',
                longitude: '-71.0589',
                job_type: 'Refrigerator Repair',
            }],
        });

        const occ = await slotEngineService._buildScheduledJobs(COMPANY, '2026-07-08', '2026-07-10', TZ);
        expect(occ).toHaveLength(1);
        expect(occ[0]).toEqual({
            id: 'lead:42',
            date: '2026-07-08',
            status: 'scheduled',
            job_type: 'Refrigerator Repair',
            window_start: '10:00',
            window_end: '13:00',
            lat: 42.3601,          // Number()-coerced from the NUMERIC string
            lng: -71.0589,
            duration_minutes: 180,
            assigned_technicians: [],  // unassigned hold → area block for ANY tech
        });
        // coords must be numbers, not the NUMERIC-as-string the pg driver returns
        expect(typeof occ[0].lat).toBe('number');
        expect(typeof occ[0].lng).toBe('number');
    });

    it('held lead with no end time → window_end == start, default duration (75)', async () => {
        dbConn.query.mockResolvedValue({
            rows: [{
                id: 7, lead_date_time: '2026-07-08T14:00:00.000Z', lead_end_date_time: null,
                latitude: 42.0, longitude: -71.0, job_type: null,
            }],
        });
        const occ = await slotEngineService._buildScheduledJobs(COMPANY, '2026-07-08', '2026-07-10', TZ);
        expect(occ[0].job_type).toBe('unknown');
        expect(occ[0].window_start).toBe('10:00');
        expect(occ[0].window_end).toBe('10:00');
        expect(occ[0].duration_minutes).toBe(75);
    });

    it('jobs AND held leads are both emitted (holds appended after jobs)', async () => {
        jobsService.listJobs.mockResolvedValue([
            { id: 1, lat: 42.34, lng: -71.10, blanc_status: 'Submitted', job_type: 'service_call',
              start_date: '2026-07-08T14:00:00.000Z', end_date: '2026-07-08T15:15:00.000Z', assigned_techs: [{ id: 'tech_001' }] },
        ]);
        dbConn.query.mockResolvedValue({
            rows: [{ id: 99, lead_date_time: '2026-07-09T18:00:00.000Z', lead_end_date_time: '2026-07-09T20:00:00.000Z',
                     latitude: 42.5, longitude: -71.2, job_type: 'Dryer Repair' }],
        });
        const occ = await slotEngineService._buildScheduledJobs(COMPANY, '2026-07-08', '2026-07-10', TZ);
        expect(occ.map(o => o.id)).toEqual(['1', 'lead:99']);
        expect(occ.find(o => o.id === '1').assigned_technicians).toEqual(['tech_001']);
        expect(occ.find(o => o.id === 'lead:99').assigned_technicians).toEqual([]);
    });

    it('empty held-lead result → occupancy is jobs-only (no lead rows appended)', async () => {
        jobsService.listJobs.mockResolvedValue([
            { id: 1, lat: 42.34, lng: -71.10, blanc_status: 'Submitted', job_type: 'service_call',
              start_date: '2026-07-08T14:00:00.000Z', end_date: '2026-07-08T15:00:00.000Z', assigned_techs: [] },
        ]);
        dbConn.query.mockResolvedValue({ rows: [] }); // no open geo'd held leads in window
        const occ = await slotEngineService._buildScheduledJobs(COMPANY, '2026-07-08', '2026-07-10', TZ);
        expect(occ).toHaveLength(1);
        expect(occ[0].id).toBe('1');
    });
});

// ─── Held-lead sub-read: SQL predicate (case-fix + company scope + windowing) ─

describe('held-lead sub-read SQL', () => {
    it('uses LOWER(status) NOT IN (…), company scope, coords + date-window guards', async () => {
        await slotEngineService._buildScheduledJobs(COMPANY, '2026-07-08', '2026-07-10', TZ);
        // db.query is called once (the held-lead sub-read); jobsService.listJobs is
        // mocked separately, so this is the only db.query in the path.
        expect(dbConn.query).toHaveBeenCalledTimes(1);
        const [sql, params] = dbConn.query.mock.calls[0];
        const flat = String(sql).replace(/\s+/g, ' ');
        // case-INSENSITIVE terminal-status (the fix), NOT a bare status NOT IN
        expect(flat).toMatch(/LOWER\(status\)\s+NOT IN\s+\('converted','lost','spam'\)/);
        expect(flat).not.toMatch(/[^(]status\s+NOT IN/); // no bare (case-sensitive) form
        // company scope + occupancy guards
        expect(flat).toMatch(/company_id\s*=\s*\$1/);
        expect(flat).toMatch(/lead_date_time IS NOT NULL/);
        expect(flat).toMatch(/latitude IS NOT NULL AND longitude IS NOT NULL/);
        expect(flat).toMatch(/lead_date_time >= \(\$2::date::timestamp AT TIME ZONE \$4\)/);
        expect(flat).toMatch(/lead_date_time < \(\(\$3::date \+ INTERVAL '1 day'\)::timestamp AT TIME ZONE \$4\)/);
        expect(params).toEqual([COMPANY, '2026-07-08', '2026-07-10', TZ]);
    });
});

// ─── scheduleQueries render half of the case-fix ─────────────────────────────

describe('scheduleQueries leads-branch case-fix (render half)', () => {
    it('emits LOWER(l.status) NOT IN (…) in the leads UNION branch', async () => {
        jest.isolateModules(() => {
            jest.doMock('../backend/src/db/connection', () => ({ query: jest.fn() }));
            const conn = require('../backend/src/db/connection');
            const capturedSql = [];
            conn.query.mockImplementation(async (sql) => {
                capturedSql.push(String(sql));
                // countSql resolves first (returns total), then dataSql.
                return { rows: [{ total: '0' }] };
            });
            const scheduleQueries = require('../backend/src/db/scheduleQueries');
            return scheduleQueries.getScheduleItems({
                companyId: COMPANY, entityTypes: ['lead'],
                startDate: '2026-07-08', endDate: '2026-07-10', timezone: TZ,
            }).then(() => {
                const all = capturedSql.join('\n');
                expect(all).toMatch(/LOWER\(l\.status\)\s+NOT IN\s+\('converted','lost','spam'\)/);
                expect(all).not.toMatch(/l\.status\s+NOT IN\s+\('converted'/); // no bare form
            });
        });
    });
});

// ─── tzCombine DST correctness (VSE-U-01, P0) ────────────────────────────────

describe('tzCombine — DST-aware wall-clock → UTC ISO', () => {
    it('EDT: Jul 8 10:00 America/New_York → 14:00Z (UTC−4)', () => {
        expect(slotEngineService.tzCombine('2026-07-08', '10:00', 'America/New_York'))
            .toBe('2026-07-08T14:00:00.000Z');
    });

    it('EST: Jan 15 10:00 America/New_York → 15:00Z (UTC−5)', () => {
        expect(slotEngineService.tzCombine('2026-01-15', '10:00', 'America/New_York'))
            .toBe('2026-01-15T15:00:00.000Z');
    });

    it('non-ET tz: Jul 8 09:00 America/Los_Angeles → 16:00Z (PDT, UTC−7)', () => {
        expect(slotEngineService.tzCombine('2026-07-08', '09:00', 'America/Los_Angeles'))
            .toBe('2026-07-08T16:00:00.000Z');
    });

    it('half-hour offset: Jul 8 10:00 Asia/Kolkata → 04:30Z (UTC+5:30)', () => {
        expect(slotEngineService.tzCombine('2026-07-08', '10:00', 'Asia/Kolkata'))
            .toBe('2026-07-08T04:30:00.000Z');
    });

    it("'GMT'/UTC tz → offset 0 (no shift)", () => {
        // UTC's 'GMT' longOffset resolves to 0 inside dateInTZ → no wall-clock shift.
        expect(slotEngineService.tzCombine('2026-07-08', '10:00', 'UTC'))
            .toBe('2026-07-08T10:00:00.000Z');
    });
});
