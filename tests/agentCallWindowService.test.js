'use strict';

const mockDispatch = jest.fn();
const mockPartsSettings = jest.fn();
const mockLeadSettings = jest.fn();

jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: (...args) => mockDispatch(...args),
}));
jest.mock('../backend/src/services/outboundCallSettingsService', () => ({
    get: (...args) => mockPartsSettings(...args),
}));
jest.mock('../backend/src/services/outboundLeadCallSettingsService', () => ({
    get: (...args) => mockLeadSettings(...args),
}));

const service = require('../backend/src/services/agentCallWindowService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const INHERIT = {
    calling_window_mode: null,
    custom_start_time: null,
    custom_end_time: null,
    calling_window_work_days: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPartsSettings.mockResolvedValue({ ...INHERIT });
    mockLeadSettings.mockResolvedValue({ ...INHERIT });
    mockDispatch.mockResolvedValue({
        timezone: 'America/New_York',
        work_start_time: '09:00',
        work_end_time: '17:00',
        work_days: [1, 2, 3, 4, 5],
    });
});

afterEach(() => jest.restoreAllMocks());

describe('AGENT-CALL-WINDOW-001 shared resolver', () => {
    test('SAB-CW-INHERIT: null override inherits the company days, hours, and timezone', async () => {
        const now = new Date('2026-07-20T14:00:00.000Z'); // Mon 10:00 EDT
        const allowedAt = await service.nextAllowedAt(COMPANY, service.AGENT_KEYS.LEADS, now);

        expect(allowedAt).toBe(now);
        expect(mockLeadSettings).toHaveBeenCalledWith(COMPANY);
        expect(mockDispatch).toHaveBeenCalledWith(COMPANY);
    });

    test('SAB-CW-OVERRIDE: a complete per-agent override wins over company hours', async () => {
        mockPartsSettings.mockResolvedValue({
            calling_window_mode: 'custom',
            custom_start_time: '07:30',
            custom_end_time: '12:00',
            calling_window_work_days: [2],
        });
        mockDispatch.mockResolvedValue({
            timezone: 'America/Los_Angeles',
            work_start_time: '09:00',
            work_end_time: '17:00',
            work_days: [1, 2, 3, 4, 5],
        });
        const beforeOpen = new Date('2026-07-21T13:00:00.000Z'); // Tue 06:00 PDT

        await expect(service.nextAllowedAt(
            COMPANY,
            service.AGENT_KEYS.PARTS,
            beforeOpen
        )).resolves.toEqual(new Date('2026-07-21T14:30:00.000Z'));
    });

    test('SAB-CW-WEEKEND: off-time wraps to the nearest Monday start', async () => {
        const saturday = new Date('2026-07-18T14:00:00.000Z'); // Sat 10:00 EDT

        await expect(service.nextAllowedAt(
            COMPANY,
            service.AGENT_KEYS.LEADS,
            saturday
        )).resolves.toEqual(new Date('2026-07-20T13:00:00.000Z'));
    });

    test('SAB-CW-TZ: window boundaries use the company timezone, including DST', () => {
        const settings = {
            timezone: 'America/New_York',
            work_start_time: '08:00',
            work_end_time: '18:00',
            work_days: [1, 2, 3, 4, 5],
        };
        const beforeDstMonday = new Date('2026-03-08T14:00:00.000Z'); // Sun after spring-forward

        expect(service.nextWindowStart(beforeDstMonday, settings).toISOString())
            .toBe('2026-03-09T12:00:00.000Z');
    });

    test('SAB-CW-FAIL-CLOSED: resolver faults never throw and use 08:00–18:00 Mon–Fri', async () => {
        mockLeadSettings.mockRejectedValue(new Error('settings unavailable'));
        const saturday = new Date('2026-07-18T14:00:00.000Z');

        const result = await service.nextAllowedAt(COMPANY, service.AGENT_KEYS.LEADS, saturday);

        expect(result.toISOString()).toBe('2026-07-20T12:00:00.000Z');
        expect(console.warn).toHaveBeenCalledWith(
            '[callWindow] resolver failed; using conservative fallback'
        );
        expect(console.warn.mock.calls.flat().join(' ')).not.toContain('settings unavailable');
    });

    test('SAB-CW-PII-LOG: deferral log contains only agent key and allowed timestamp', async () => {
        const saturday = new Date('2026-07-18T14:00:00.000Z');
        await service.nextAllowedAt(COMPANY, service.AGENT_KEYS.PARTS, saturday);

        expect(console.log).toHaveBeenCalledWith(
            '[callWindow] deferred agent=outbound-parts-caller until=2026-07-20T13:00:00.000Z'
        );
        expect(console.log.mock.calls.flat().join(' ')).not.toContain(COMPANY);
    });
});
