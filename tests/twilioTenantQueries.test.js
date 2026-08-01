const mockDbQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

const callsQueries = require('../backend/src/db/callsQueries');
const webhookSyncQueries = require('../backend/src/db/webhookSyncQueries');

beforeEach(() => {
    jest.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [{ id: 1 }] });
});

test.each([
    ['call', () => callsQueries.upsertCall({ callSid: 'CA1' })],
    ['recording', () => callsQueries.upsertRecording({ recordingSid: 'RE1', callSid: 'CA1' })],
    ['transcript', () => callsQueries.upsertTranscript({ transcriptionSid: 'TR1', callSid: 'CA1' })],
    ['call event', () => callsQueries.appendCallEvent('CA1', 'x', new Date(), {})],
    ['inbox event', () => webhookSyncQueries.insertInboxEvent({
        eventKey: 'event-1', source: 'voice', eventType: 'x', payload: {},
    })],
])('SAB-TW-DEFAULT: %s persistence rejects absent company before SQL', async (_label, act) => {
    await expect(act()).rejects.toMatchObject({ code: 'TWILIO_TENANT_UNRESOLVED' });
    expect(mockDbQuery).not.toHaveBeenCalled();
});

test('transcript and inbox conflicts are tenant-paired', async () => {
    const companyId = '00000000-0000-0000-0000-000000000001';
    await callsQueries.upsertTranscript({
        transcriptionSid: 'TR1',
        callSid: 'CA1',
        companyId,
    });
    await webhookSyncQueries.insertInboxEvent({
        eventKey: 'event-1',
        source: 'voice',
        eventType: 'x',
        payload: {},
        companyId,
    });

    expect(mockDbQuery.mock.calls[0][0])
        .toContain('ON CONFLICT (company_id, transcription_sid)');
    expect(mockDbQuery.mock.calls[0][1][11]).toBe(companyId);
    expect(mockDbQuery.mock.calls[1][0])
        .toContain('ON CONFLICT (company_id, event_key)');
    expect(mockDbQuery.mock.calls[1][1][9]).toBe(companyId);
});
