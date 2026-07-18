jest.mock('../backend/src/db/technicianWorkScheduleQueries', () => ({
    listByTechnicianIds: jest.fn(),
    replace: jest.fn(),
}));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(),
}));

const queries = require('../backend/src/db/technicianWorkScheduleQueries');
const scheduleService = require('../backend/src/services/scheduleService');
const service = require('../backend/src/services/technicianWorkScheduleService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const TECH = { id: 'tech-1', name: 'Alex Rivera' };
const COMPANY_SETTINGS = {
    timezone: 'America/New_York',
    work_start_time: '08:00:00',
    work_end_time: '18:00:00',
    work_days: [1, 2, 3, 4, 5],
};

function storedRows({ inherits = false, overrides = {} } = {}) {
    return Array.from({ length: 7 }, (_, day) => {
        const value = overrides[day] || {
            is_working: day >= 1 && day <= 5,
            start: '09:00:00',
            end: '17:00:00',
        };
        return {
            technician_id: TECH.id,
            inherits_company_schedule: inherits,
            day_of_week: day,
            is_working: value.is_working,
            work_start_time: value.is_working ? value.start : null,
            work_end_time: value.is_working ? value.end : null,
        };
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    scheduleService.getDispatchSettings.mockResolvedValue({ ...COMPANY_SETTINGS });
    queries.listByTechnicianIds.mockResolvedValue([]);
    queries.replace.mockResolvedValue();
});

it('missing schedule inherits the visible company week', async () => {
    const result = await service.getSettings(COMPANY, TECH);
    expect(result.inherits_company_schedule).toBe(true);
    expect(result.effective_week.find(day => day.day_of_week === 1)).toMatchObject({
        is_working: true,
        work_start_time: '08:00',
        work_end_time: '18:00',
        source: 'company',
    });
    expect(result.effective_week.find(day => day.day_of_week === 0).is_working).toBe(false);
});

it('custom hours may exceed company hours and produce a notice', async () => {
    queries.listByTechnicianIds.mockResolvedValue(storedRows({
        overrides: { 1: { is_working: true, start: '07:00:00', end: '19:30:00' } },
    }));
    const result = await service.getSettings(COMPANY, TECH);
    expect(result.inherits_company_schedule).toBe(false);
    expect(result.exceeds_company_hours).toBe(true);
    expect(result.wider_days).toEqual(expect.arrayContaining([
        expect.objectContaining({ day_name: 'Mon', technician_interval: '07:00–19:30' }),
    ]));
});

it('TC-WS-CLOSED-01 — stored working interval cannot reopen company-closed day', async () => {
    queries.listByTechnicianIds.mockResolvedValue(storedRows({
        overrides: { 0: { is_working: true, start: '10:00:00', end: '14:00:00' } },
    }));
    const result = await service.getSettings(COMPANY, TECH);
    expect(result.effective_week.find(day => day.day_of_week === 0)).toMatchObject({
        is_working: false,
        company_closed: true,
        source: 'company',
    });
});

it('override-query failure falls back to company hours and discloses degradation', async () => {
    queries.listByTechnicianIds.mockRejectedValue(new Error('schedule table unavailable'));
    const result = await service.getSettings(COMPANY, TECH);
    expect(result.degraded_to_company_schedule).toBe(true);
    expect(result.inherits_company_schedule).toBe(true);
    expect(result.effective_week.find(day => day.day_of_week === 1).work_start_time).toBe('08:00');
});

it('company-schedule failure is explicit and never fabricates all-day hours', async () => {
    scheduleService.getDispatchSettings.mockRejectedValue(new Error('dispatch settings down'));
    await expect(service.getSettings(COMPANY, TECH)).rejects.toMatchObject({
        code: 'COMPANY_SCHEDULE_UNAVAILABLE',
        httpStatus: 503,
    });
});

it('save rejects a working override on a company-closed day before any write', async () => {
    const days = Array.from({ length: 7 }, (_, day) => ({
        day_of_week: day,
        is_working: true,
        work_start_time: '08:00',
        work_end_time: '17:00',
    }));
    await expect(service.save(COMPANY, TECH, {
        inherits_company_schedule: false,
        days,
    }, 'crm-user')).rejects.toMatchObject({ code: 'COMPANY_CLOSED_DAY', httpStatus: 422 });
    expect(queries.replace).not.toHaveBeenCalled();
});

it('save permits wider hours on open days and scopes the audit user into replacement', async () => {
    const days = Array.from({ length: 7 }, (_, day) => ({
        day_of_week: day,
        is_working: day >= 1 && day <= 5,
        work_start_time: day >= 1 && day <= 5 ? '07:00' : null,
        work_end_time: day >= 1 && day <= 5 ? '19:00' : null,
    }));
    queries.listByTechnicianIds.mockResolvedValue(storedRows());
    await service.save(COMPANY, TECH, { inherits_company_schedule: false, days }, 'crm-user');
    expect(queries.replace).toHaveBeenCalledWith(COMPANY, TECH.id, expect.objectContaining({
        inheritsCompanySchedule: false,
        updatedBy: 'crm-user',
    }));
});
