const mockDbQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

const callsQueries = require('../backend/src/db/callsQueries');
const webhookSyncQueries = require('../backend/src/db/webhookSyncQueries');
const groupRouting = require('../backend/src/services/groupRouting');
const callFlowRuntime = require('../backend/src/services/callFlowRuntime');

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

test('call, recording, transcript, and inbox conflicts are tenant-paired', async () => {
    const companyId = '00000000-0000-0000-0000-000000000001';
    await callsQueries.upsertCall({ callSid: 'CA1', companyId });
    await callsQueries.upsertRecording({ recordingSid: 'RE1', callSid: 'CA1', companyId });
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
        .toContain('ON CONFLICT (company_id, call_sid)');
    expect(mockDbQuery.mock.calls[0][1][16]).toBe(companyId);
    expect(mockDbQuery.mock.calls[1][0])
        .toContain('ON CONFLICT (company_id, recording_sid)');
    expect(mockDbQuery.mock.calls[1][1][11]).toBe(companyId);
    expect(mockDbQuery.mock.calls[2][0])
        .toContain('ON CONFLICT (company_id, transcription_sid)');
    expect(mockDbQuery.mock.calls[2][1][11]).toBe(companyId);
    expect(mockDbQuery.mock.calls[3][0])
        .toContain('ON CONFLICT (company_id, event_key)');
    expect(mockDbQuery.mock.calls[3][1][9]).toBe(companyId);
});

test('SAB-TW-GROUP: number routing requires and filters by the resolved company', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await expect(groupRouting.resolveGroupForNumber('+15550001111'))
        .rejects.toMatchObject({ code: 'TWILIO_TENANT_UNRESOLVED' });
    expect(mockDbQuery).not.toHaveBeenCalled();

    await groupRouting.resolveGroupForNumber('+15550001111', 'company-b');
    expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining('pns.company_id::text = $2::text'),
        ['+15550001111', 'company-b']
    );
});

test('SAB-TW-FLOW: execution lookup requires and filters by resolved company plus CallSid', async () => {
    await expect(callFlowRuntime.getExecution('CA-shared'))
        .rejects.toMatchObject({ code: 'TWILIO_TENANT_UNRESOLVED' });
    expect(mockDbQuery).not.toHaveBeenCalled();

    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await callFlowRuntime.getExecution('CA-shared', 'company-b');
    expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining('call_sid = $1 AND company_id::text = $2::text'),
        ['CA-shared', 'company-b']
    );
});
