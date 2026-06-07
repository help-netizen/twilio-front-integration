const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

jest.mock('../../backend/src/services/voiceService', () => ({
    generateToken: jest.fn(() => ({ token: 'token', identity: 'user_test' })),
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

const { twimlRouter } = require('../../backend/src/routes/voice');
const { buildSoftphoneIdentity } = require('../../backend/src/services/softphoneIdentity');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/voice', twimlRouter);
    return app;
}

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
