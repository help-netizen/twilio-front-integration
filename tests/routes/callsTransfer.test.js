const express = require('express');
const request = require('supertest');

jest.mock('../../backend/src/db/queries', () => ({}));
jest.mock('../../backend/src/services/callSummaryService', () => ({
    generateCallSummary: jest.fn(),
}));
jest.mock('../../backend/src/services/operationsDashboard', () => ({
    getOperationsDashboard: jest.fn(),
}));
const mockGetAgentStatus = jest.fn();
jest.mock('../../backend/src/services/agentPresence', () => ({
    getAgentStatus: (...args) => mockGetAgentStatus(...args),
}));
jest.mock('../../backend/src/db/connection', () => ({
    query: jest.fn(),
}));
jest.mock('../../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(),
}));

const db = require('../../backend/src/db/connection');
const { getTwilioClient } = require('../../backend/src/services/twilioClient');
const callsRouter = require('../../backend/src/routes/calls');
const { buildSoftphoneIdentity } = require('../../backend/src/services/softphoneIdentity');

function makeApp(companyId = 'company-1') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/calls', callsRouter);
    return app;
}

describe('F017 calls transfer route', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        mockGetAgentStatus.mockResolvedValue('available');
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('returns 503 before Twilio update when REST credentials are missing', async () => {
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;

        db.query
            .mockResolvedValueOnce({ rows: [{ call_sid: 'CA123', group_id: 'group-1', group_name: 'Dispatch' }] })
            .mockResolvedValueOnce({ rows: [{ user_id: 'user-1', name: 'Agent One', phone_calls_allowed: true }] });

        const res = await request(makeApp())
            .post('/api/calls/CA123/transfer')
            .send({ target_user_id: 'user-1' });

        expect(res.status).toBe(503);
        expect(res.body).toEqual({
            ok: false,
            error: 'Twilio REST credentials are not configured',
        });
        expect(mockGetAgentStatus).toHaveBeenCalledWith('user-1', 'company-1');
        expect(getTwilioClient).not.toHaveBeenCalled();
    });

    test('maps Twilio 20404 update failure to explicit provider response', async () => {
        process.env.TWILIO_ACCOUNT_SID = 'AC_test';
        process.env.TWILIO_AUTH_TOKEN = 'auth_test';

        db.query
            .mockResolvedValueOnce({ rows: [{ call_sid: 'CA123', group_id: 'group-1', group_name: 'Dispatch' }] })
            .mockResolvedValueOnce({ rows: [{ user_id: 'user-1', name: 'Agent One', phone_calls_allowed: true }] });

        const update = jest.fn().mockRejectedValue(Object.assign(new Error('Twilio call not found'), {
            status: 404,
            code: 20404,
        }));
        getTwilioClient.mockReturnValue({
            calls: jest.fn(() => ({ update })),
        });

        const res = await request(makeApp())
            .post('/api/calls/CA123/transfer')
            .send({ target_user_id: 'user-1' });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            ok: false,
            error: 'Twilio could not update the active call',
            twilio_status: 404,
            twilio_code: 20404,
        });
        expect(update).toHaveBeenCalledWith({
            twiml: expect.stringContaining(`<Client>${buildSoftphoneIdentity('company-1', 'user-1')}</Client>`),
        });
    });

    test('rejects transfer to an on-call group member before Twilio update', async () => {
        process.env.TWILIO_ACCOUNT_SID = 'AC_test';
        process.env.TWILIO_AUTH_TOKEN = 'auth_test';
        mockGetAgentStatus.mockResolvedValue('on_call');

        db.query
            .mockResolvedValueOnce({ rows: [{ call_sid: 'CA123', group_id: 'group-1', group_name: 'Dispatch' }] })
            .mockResolvedValueOnce({ rows: [{ user_id: 'user-1', name: 'Agent One', phone_calls_allowed: true }] });

        const res = await request(makeApp())
            .post('/api/calls/CA123/transfer')
            .send({ target_user_id: 'user-1' });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            ok: false,
            error: 'Target agent is not available for transfer',
        });
        expect(getTwilioClient).not.toHaveBeenCalled();
    });
});
