const bridgeInstances = [];

class MockAssemblyAISession {
    constructor(options) {
        this.options = options;
        this.ready = true;
        this.sendAudio = jest.fn();
        this.connect = jest.fn();
        this.terminate = jest.fn().mockResolvedValue(undefined);
        this.destroy = jest.fn();
        bridgeInstances.push(this);
    }
}

jest.mock('../backend/src/services/assemblyAIBridge', () => ({
    AssemblyAISession: MockAssemblyAISession,
}));
jest.mock('../backend/src/services/realtimeService', () => ({
    broadcast: jest.fn(),
}));
jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const service = require('../backend/src/services/realtimeTranscriptService');

const COMPANY_A = '00000000-0000-0000-0000-000000000001';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const CALL_SID = 'CA-shared';

beforeEach(() => {
    bridgeInstances.length = 0;
    process.env.ASSEMBLYAI_API_KEY = 'test-key';
    service.destroyAll();
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    service.destroyAll();
    console.log.mockRestore();
});

test('SAB-TW-SID-BLAST: same CallSid creates independent company sessions and audio routes', () => {
    const sessionA = service.createSession(COMPANY_A, CALL_SID, { direction: 'outbound' });
    const sessionB = service.createSession(COMPANY_B, CALL_SID, { direction: 'outbound' });

    expect(sessionA).not.toBe(sessionB);
    expect(service.getActiveSessions()).toEqual(expect.arrayContaining([
        expect.objectContaining({ companyId: COMPANY_A, callSid: CALL_SID }),
        expect.objectContaining({ companyId: COMPANY_B, callSid: CALL_SID }),
    ]));
    expect(service.getActiveSessions()).toHaveLength(2);

    const audioA = Buffer.from('audio-a');
    service.routeAudio(COMPANY_A, CALL_SID, 'inbound', audioA);

    expect(sessionA.aaiInbound.sendAudio).toHaveBeenCalledWith(audioA);
    expect(sessionB.aaiInbound.sendAudio).not.toHaveBeenCalled();
});
