const mockQuery = jest.fn();
const mockBroadcast = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: mockBroadcast }));

const snoozeScheduler = require('../backend/src/services/snoozeScheduler');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('snooze scheduler SSE tenant routing', () => {
    test('worker preserves each returned timeline company in its event', async () => {
        mockQuery.mockResolvedValue({ rows: [
            { id: 10, company_id: 'company-a' },
            { id: 20, company_id: 'company-b' },
        ] });

        await snoozeScheduler.tick();

        expect(mockBroadcast.mock.calls).toEqual([
            ['thread.unsnoozed', { company_id: 'company-a', timelineId: 10 }],
            ['thread.unsnoozed', { company_id: 'company-b', timelineId: 20 }],
        ]);
    });
});
