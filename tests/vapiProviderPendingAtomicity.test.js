'use strict';

const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};

jest.mock('../backend/src/db/connection', () => ({
    getClient: jest.fn(async () => mockClient),
    query: jest.fn(),
}));

const identity = require('../backend/src/services/vapiCallIdentityService');

beforeEach(() => {
    jest.clearAllMocks();
});

test('FIX-19 terminal provider-pending transition rolls back when human follow-up fails', async () => {
    const candidate = {
        session_id: 'session-atomic',
        attempt_id: '123',
        company_id: '00000000-0000-4000-8000-000000000019',
        scenario: 'parts_visit',
    };
    mockClient.query.mockImplementation(async (sql) => {
        if (/WITH candidates AS/.test(sql)) return { rows: [candidate] };
        return { rows: [] };
    });
    const followUp = jest.fn(async () => {
        throw new Error('task write failed');
    });

    await expect(identity.reapStaleOutboundPlacements({
        onExhaustedWithClient: followUp,
    })).rejects.toThrow('task write failed');

    expect(followUp).toHaveBeenCalledWith(candidate, mockClient);
    expect(mockClient.query.mock.calls.map(([sql]) => sql)).toEqual([
        'BEGIN',
        expect.stringMatching(/WITH candidates AS/),
        'ROLLBACK',
    ]);
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
});
