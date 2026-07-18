jest.mock('../backend/src/db/timeOffQueries', () => ({
    listOverlappingRange: jest.fn(),
}));
jest.mock('../backend/src/db/membershipQueries', () => ({
    getZenbookerTeamMemberIdForUser: jest.fn(),
}));
jest.mock('../backend/src/db/technicianWorkScheduleQueries', () => ({
    listByTechnicianIds: jest.fn(),
    replace: jest.fn(),
}));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(),
}));
jest.mock('../backend/src/services/technicianRosterService', () => ({
    listActive: jest.fn(),
}));

const timeOffQueries = require('../backend/src/db/timeOffQueries');
const membershipQueries = require('../backend/src/db/membershipQueries');
const scheduleQueries = require('../backend/src/db/technicianWorkScheduleQueries');
const scheduleService = require('../backend/src/services/scheduleService');
const rosterService = require('../backend/src/services/technicianRosterService');
const availabilityService = require('../backend/src/services/technicianAvailabilityService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const TECH = { id: 'tech-1', name: 'Alex Rivera' };

function customRows(overrides = {}) {
    return Array.from({ length: 7 }, (_, day) => {
        const value = overrides[day] || {
            is_working: day >= 1 && day <= 5,
            start: '09:00:00',
            end: '17:00:00',
        };
        return {
            technician_id: TECH.id,
            inherits_company_schedule: false,
            day_of_week: day,
            is_working: value.is_working,
            work_start_time: value.is_working ? value.start : null,
            work_end_time: value.is_working ? value.end : null,
        };
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    scheduleService.getDispatchSettings.mockResolvedValue({
        timezone: 'America/New_York',
        work_start_time: '08:00:00',
        work_end_time: '18:00:00',
        work_days: [1, 2, 3, 4, 5],
    });
    scheduleQueries.listByTechnicianIds.mockResolvedValue([]);
    timeOffQueries.listOverlappingRange.mockResolvedValue([]);
    rosterService.listActive.mockResolvedValue([TECH]);
    membershipQueries.getZenbookerTeamMemberIdForUser.mockResolvedValue(TECH.id);
});

it('derives before/after gaps around inherited company hours', async () => {
    const blocks = await availabilityService.buildUnavailability(COMPANY, {
        from: '2026-07-20T04:00:00.000Z',
        to: '2026-07-21T04:00:00.000Z',
        technicians: [TECH],
    });
    expect(blocks).toEqual([
        expect.objectContaining({
            id: 'schedule:tech-1:2026-07-20:before',
            kind: 'schedule_gap',
            starts_at: '2026-07-20T04:00:00.000Z',
            ends_at: '2026-07-20T12:00:00.000Z',
            source: 'company',
            mutable: false,
        }),
        expect.objectContaining({
            id: 'schedule:tech-1:2026-07-20:after',
            starts_at: '2026-07-20T22:00:00.000Z',
            ends_at: '2026-07-21T04:00:00.000Z',
        }),
    ]);
});

it('SAFETY-COMPANY-CLOSED-WINS: a custom working row still derives a full closed-day gap', async () => {
    scheduleQueries.listByTechnicianIds.mockResolvedValue(customRows({
        0: { is_working: true, start: '10:00:00', end: '14:00:00' },
    }));
    const blocks = await availabilityService.buildUnavailability(COMPANY, {
        from: '2026-07-19T04:00:00.000Z',
        to: '2026-07-20T04:00:00.000Z',
        technicians: [TECH],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
        id: 'schedule:tech-1:2026-07-19:full',
        kind: 'schedule_gap',
        starts_at: '2026-07-19T04:00:00.000Z',
        ends_at: '2026-07-20T04:00:00.000Z',
        source: 'company',
    });
});

it('uses company-local DST boundaries for a full closed day', async () => {
    const blocks = await availabilityService.buildUnavailability(COMPANY, {
        from: '2026-11-01T04:00:00.000Z',
        to: '2026-11-02T05:00:00.000Z',
        technicians: [TECH],
    });
    expect(blocks).toHaveLength(1);
    expect(Date.parse(blocks[0].ends_at) - Date.parse(blocks[0].starts_at)).toBe(25 * 60 * 60 * 1000);
});

it('uses the 23-hour company-local boundary on the spring DST transition', async () => {
    const blocks = await availabilityService.buildUnavailability(COMPANY, {
        from: '2026-03-08T05:00:00.000Z',
        to: '2026-03-09T04:00:00.000Z',
        technicians: [TECH],
    });
    expect(blocks).toHaveLength(1);
    expect(Date.parse(blocks[0].ends_at) - Date.parse(blocks[0].starts_at)).toBe(23 * 60 * 60 * 1000);
});

it('returns explicit exceptions and derived gaps through one kind-tagged collection', async () => {
    timeOffQueries.listOverlappingRange.mockResolvedValue([{
        id: '00000000-0000-0000-0000-000000000111',
        technician_id: TECH.id,
        technician_name: TECH.name,
        starts_at: '2026-07-20T15:00:00.000Z',
        ends_at: '2026-07-20T16:00:00.000Z',
        source: 'individual',
        note: 'Appointment',
    }]);
    const blocks = await availabilityService.buildUnavailability(COMPANY, {
        from: '2026-07-20T04:00:00.000Z',
        to: '2026-07-21T04:00:00.000Z',
        technicians: [TECH],
    });
    expect(blocks.map(block => block.kind)).toEqual(['schedule_gap', 'time_off', 'schedule_gap']);
    expect(blocks.find(block => block.kind === 'time_off')).toMatchObject({ mutable: true, note: 'Appointment' });
    expect(timeOffQueries.listOverlappingRange).toHaveBeenCalledWith(
        COMPANY,
        '2026-07-20T04:00:00.000Z',
        '2026-07-21T04:00:00.000Z'
    );
});

it('provider scope overrides the requested technician id with the caller bridge', async () => {
    await availabilityService.listUnavailability(COMPANY, {
        from: '2026-07-20T04:00:00.000Z',
        to: '2026-07-21T04:00:00.000Z',
        technicianId: 'someone-else',
    }, { assignedOnly: true, userId: 'crm-user' });
    expect(membershipQueries.getZenbookerTeamMemberIdForUser).toHaveBeenCalledWith(COMPANY, 'crm-user');
    expect(timeOffQueries.listOverlappingRange).toHaveBeenCalled();
});

it('company-settings failure rejects instead of returning an all-day-open collection', async () => {
    scheduleService.getDispatchSettings.mockRejectedValue(new Error('settings down'));
    await expect(availabilityService.buildUnavailability(COMPANY, {
        from: '2026-07-20T04:00:00.000Z',
        to: '2026-07-21T04:00:00.000Z',
        technicians: [TECH],
    })).rejects.toMatchObject({ code: 'COMPANY_SCHEDULE_UNAVAILABLE', httpStatus: 503 });
});
