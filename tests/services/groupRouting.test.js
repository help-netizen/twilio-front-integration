const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const mockGetPresenceSnapshot = jest.fn();
jest.mock('../../backend/src/services/agentPresence', () => ({
    getPresenceSnapshot: (...args) => mockGetPresenceSnapshot(...args),
}));

const mockGetBusyClientIdentities = jest.fn();
const mockVerifyAndFixStaleCalls = jest.fn();
jest.mock('../../backend/src/services/callAvailability', () => ({
    getBusyClientIdentities: (...args) => mockGetBusyClientIdentities(...args),
    verifyAndFixStaleCalls: (...args) => mockVerifyAndFixStaleCalls(...args),
}));

const {
    availableAgentsForGroup,
    isBusinessHours,
    isBusinessHoursForRows,
    normalizeDayOfWeek,
} = require('../../backend/src/services/groupRouting');
const { buildSoftphoneIdentity } = require('../../backend/src/services/softphoneIdentity');

describe('F017 groupRouting.availableAgentsForGroup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.mockResolvedValue({
            rows: [
                { user_id: 'u-available', name: 'Available Agent', phone_calls_allowed: true },
                { user_id: 'u-on-call', name: 'On Call Agent', phone_calls_allowed: true },
                { user_id: 'u-offline', name: 'Offline Agent', phone_calls_allowed: true },
                { user_id: 'u-busy-db', name: 'Busy DB Agent', phone_calls_allowed: true },
                { user_id: 'u-no-phone', name: 'No Phone Agent', phone_calls_allowed: false },
            ],
        });
        mockGetPresenceSnapshot.mockReturnValue(new Map([
            ['u-available', 'available'],
            ['u-on-call', 'on_call'],
            ['u-offline', 'offline'],
            ['u-busy-db', 'available'],
        ]));
        mockGetBusyClientIdentities.mockResolvedValue({
            busyIdentities: new Set([buildSoftphoneIdentity('company-1', 'u-busy-db')]),
            callSids: [],
        });
    });

    it('returns only phone-enabled available group agents that are not busy', async () => {
        const agents = await availableAgentsForGroup('ug-1', 'company-1', 'test');

        expect(agents).toEqual([
            { user_id: 'u-available', identity: buildSoftphoneIdentity('company-1', 'u-available'), name: 'Available Agent' },
        ]);
        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE ugm.group_id = $1'), ['ug-1', 'company-1']);
        expect(mockGetPresenceSnapshot).toHaveBeenCalledWith(['u-available', 'u-on-call', 'u-offline', 'u-busy-db'], 'company-1');
    });

    it('computes business hours in the group timezone', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [
                { day_of_week: 'Fri', is_open: true, open_time: '09:00', close_time: '17:00' },
            ],
        });

        const open = await isBusinessHours(
            { id: 'ug-1', timezone: 'America/Los_Angeles' },
            new Date('2026-06-05T16:30:00Z')
        );

        expect(open).toBe(true);
    });

    it('SAB-CW-INBOUND-NO-FLIP: UI-written short row still wins over a stale full-name duplicate', () => {
        const rows = [
            { day_of_week: 'Sat', is_open: true, open_time: '07:00', close_time: '17:00' },
            { day_of_week: 'Saturday', is_open: false, open_time: null, close_time: null },
        ];
        const saturdayMorning = new Date('2026-07-18T14:00:00.000Z');

        expect(isBusinessHoursForRows(
            rows,
            { timezone: 'America/New_York' },
            saturdayMorning
        )).toBe(true);
    });

    it('reader accepts full-name rows defensively and normalizes all write aliases', () => {
        expect(isBusinessHoursForRows(
            [{ day_of_week: 'Monday', is_open: true, open_time: '09:00', close_time: '17:00' }],
            { timezone: 'America/New_York' },
            new Date('2026-07-20T14:00:00.000Z')
        )).toBe(true);
        expect(normalizeDayOfWeek('Thursday')).toBe('Thu');
        expect(normalizeDayOfWeek('thu')).toBe('Thu');
        expect(normalizeDayOfWeek('noday')).toBeNull();
    });
});
