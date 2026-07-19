const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const mockGenerateTokenForCompany = jest.fn();
jest.mock('../../backend/src/services/voiceService', () => ({
    generateToken: jest.fn(() => ({ token: 'token', identity: 'user_test' })),
    generateTokenForCompany: (...args) => mockGenerateTokenForCompany(...args),
}));

jest.mock('../../backend/src/services/callAvailability', () => ({
    STALE_FILTER_SQL: 'is_final = false',
    FINAL_STATUSES: ['completed', 'busy', 'no-answer', 'canceled', 'failed', 'blocked'],
}));

const mockTwilioCallFetch = jest.fn();
jest.mock('../../backend/src/services/twilioClient', () => ({
    getTwilioClient: () => ({ calls: () => ({ fetch: mockTwilioCallFetch }) }),
}));

const mockGroupsForUser = jest.fn();
jest.mock('../../backend/src/services/groupRouting', () => ({
    groupsForUser: (...args) => mockGroupsForUser(...args),
}));

const mockSetAgentStatus = jest.fn();
jest.mock('../../backend/src/services/agentPresence', () => ({
    setAgentStatus: (...args) => mockSetAgentStatus(...args),
}));

jest.mock('../../backend/src/services/walletService', () => ({
    isServiceBlocked: jest.fn(async () => false),
}));

jest.mock('../../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

const mockFindOrCreateTimeline = jest.fn();
const mockUpsertCall = jest.fn();
jest.mock('../../backend/src/db/queries', () => ({
    findOrCreateTimeline: (...args) => mockFindOrCreateTimeline(...args),
    upsertCall: (...args) => mockUpsertCall(...args),
}));

jest.mock('../../backend/src/services/realtimeService', () => ({
    publishCallUpdate: jest.fn(),
}));

const { tokenRouter, twimlRouter } = require('../../backend/src/routes/voice');
const { buildSoftphoneIdentity } = require('../../backend/src/services/softphoneIdentity');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/voice', twimlRouter);
    return app;
}

function makeTokenApp(permissions) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-user-1', email: 'agent@test.local', crmUser: { id: 'crm-user-1' } };
        req.authz = { permissions, company: { id: 'company-1' } };
        req.companyFilter = { company_id: 'company-1' };
        next();
    });
    app.use('/api/voice', tokenRouter);
    return app;
}

// The /twiml/* handlers now reject unsigned requests unless NODE_ENV is
// 'development' (TWILIO-SIG-ENFORCE-001). These suites exercise caller-id /
// tenant business logic, not the signature — run them in development so the
// gate is bypassed, the same convention twilioWebhooks.test.js uses. The
// dedicated enforcement suite (twilioSignatureEnforcement.test.js) covers the
// production gate. Restored in afterAll so no other suite inherits it.
const VOICE_TEST_PRIOR_ENV = process.env.NODE_ENV;
beforeEach(() => { process.env.NODE_ENV = 'development'; });
afterAll(() => { process.env.NODE_ENV = VOICE_TEST_PRIOR_ENV; });

describe('F017 outbound Caller ID validation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindOrCreateTimeline.mockResolvedValue({ id: 10, contact_id: null });
        mockUpsertCall.mockResolvedValue(null);
    });

    test('allows Caller ID assigned to the softphone user group', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ phone_number: '+16175006181' }] });
        const identity = buildSoftphoneIdentity('company-1', 'user-1');

        const res = await request(makeApp())
            .post('/api/voice/twiml/outbound')
            .send({
                From: `client:${identity}`,
                To: '+15551112222',
                CallerId: '+16175006181',
                CallSid: 'CA_outbound',
            });

        expect(res.status).toBe(200);
        expect(res.text).toContain('<Dial callerId="+16175006181"');
        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('user_group_members'), ['+16175006181', 'company-1', 'user-1']);
        expect(mockFindOrCreateTimeline).toHaveBeenCalledWith('+15551112222', 'company-1');
        expect(mockUpsertCall).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }));
    });

    test('rejects Caller ID that is not assigned to the softphone user group', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const identity = buildSoftphoneIdentity('company-1', 'user-1');

        const res = await request(makeApp())
            .post('/api/voice/twiml/outbound')
            .send({
                From: `client:${identity}`,
                To: '+15551112222',
                CallerId: '+16175006181',
            });

        expect(res.status).toBe(403);
        expect(res.text).toContain('Caller ID is not assigned to this user group.');
        expect(res.text).not.toContain('<Dial');
        expect(mockFindOrCreateTimeline).not.toHaveBeenCalled();
    });

    test('rejects legacy softphone identity without company context', async () => {
        const res = await request(makeApp())
            .post('/api/voice/twiml/outbound')
            .send({
                From: 'client:user_user-1',
                To: '+15551112222',
                CallerId: '+16175006181',
            });

        expect(res.status).toBe(403);
        expect(res.text).toContain('Caller ID is not available for this softphone identity.');
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockFindOrCreateTimeline).not.toHaveBeenCalled();
    });
});

describe('RBAC-WAVE1-001 authenticated voice gates', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGroupsForUser.mockResolvedValue([{ id: 'group-1', name: 'Dispatch' }]);
        mockGenerateTokenForCompany.mockResolvedValue({ token: 'voice-token', identity: 'identity-1' });
        mockSetAgentStatus.mockResolvedValue({ status: 'available', companyId: 'company-1' });
        mockTwilioCallFetch.mockResolvedValue({ status: 'in-progress', endTime: null });
    });

    test.each([
        ['GET /token', 'get', '/api/voice/token'],
        ['GET /phone-access', 'get', '/api/voice/phone-access'],
        ['POST /presence', 'post', '/api/voice/presence'],
        ['GET /check-busy', 'get', '/api/voice/check-busy?phone=%2B15085140320'],
        ['GET /blanc-numbers', 'get', '/api/voice/blanc-numbers'],
    ])('%s denies a user without phone_calls.use', async (_label, method, route) => {
        const call = request(makeTokenApp([]))[method](route);
        const res = method === 'post' ? await call.send({ status: 'available' }) : await call;

        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockGenerateTokenForCompany).not.toHaveBeenCalled();
        expect(mockSetAgentStatus).not.toHaveBeenCalled();
        expect(mockTwilioCallFetch).not.toHaveBeenCalled();
    });

    test('GET /token allows phone_calls.use and scopes membership lookup + mint to the selected company', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ allowed: true }] });

        const res = await request(makeTokenApp(['phone_calls.use'])).get('/api/voice/token');

        expect(res.status).toBe(200);
        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('m.company_id = $2'), ['crm-user-1', 'company-1']);
        expect(mockGroupsForUser).toHaveBeenCalledWith('crm-user-1', 'company-1', { includeAllForDev: undefined });
        expect(mockGenerateTokenForCompany).toHaveBeenCalledWith(
            'company-1',
            buildSoftphoneIdentity('company-1', 'crm-user-1')
        );
    });

    test('GET /phone-access allows phone_calls.use and scopes its checks to the selected company', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ allowed: true }] });

        const res = await request(makeTokenApp(['phone_calls.use'])).get('/api/voice/phone-access');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ allowed: true, groups_count: 1 });
        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('m.company_id = $2'), ['crm-user-1', 'company-1']);
        expect(mockGroupsForUser).toHaveBeenCalledWith('crm-user-1', 'company-1', { includeAllForDev: undefined });
    });

    test('POST /presence allows phone_calls.use and writes presence for the selected company', async () => {
        const res = await request(makeTokenApp(['phone_calls.use']))
            .post('/api/voice/presence')
            .send({ status: 'available' });

        expect(res.status).toBe(200);
        expect(mockSetAgentStatus).toHaveBeenCalledWith(
            'crm-user-1', 'company-1', 'available', { source: 'voice.presence' }
        );
    });

    test('T-blast GET /check-busy scopes a shared phone lookup to the selected company', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await request(makeTokenApp(['phone_calls.use']))
            .get('/api/voice/check-busy?phone=%2B15085140320');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ busy: false });
        expect(mockQuery).toHaveBeenCalledWith(expect.stringMatching(/WHERE company_id = \$2[\s\S]*from_number = \$1/), [
            '+15085140320', 'company-1',
        ]);
        expect(mockTwilioCallFetch).not.toHaveBeenCalled();
    });

    test('GET /blanc-numbers allows phone_calls.use and scopes numbers to the selected company', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ phone_number: '+15085550100' }] });

        const res = await request(makeTokenApp(['phone_calls.use'])).get('/api/voice/blanc-numbers');

        expect(res.status).toBe(200);
        expect(res.body.numbers).toEqual([{ phone_number: '+15085550100' }]);
        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE pns.company_id = $1'), [
            'company-1', '', 'crm-user-1',
        ]);
    });
});
