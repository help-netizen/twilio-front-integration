const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const telephonyProviderRouter = require('../../backend/src/routes/telephonyProvider');

function makeApp(companyId = 'company-1') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/telephony/provider', telephonyProviderRouter);
    return app;
}

describe('F017 telephony provider status', () => {
    const oldEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...oldEnv };
        process.env.TWILIO_ACCOUNT_SID = 'AC1234567890abcdef';
        process.env.TWILIO_AUTH_TOKEN = 'secret-token';
        mockQuery.mockResolvedValue({ rows: [{ count: 9 }] });
    });

    afterAll(() => {
        process.env = oldEnv;
    });

    test('returns provider metadata from env and tenant-scoped local inventory count', async () => {
        const res = await request(makeApp('company-1'))
            .get('/api/telephony/provider');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(expect.objectContaining({
            name: 'Twilio',
            status: 'connected',
            account_sid: 'AC************cdef',
            numbers_count: 9,
            inventory_source: 'phone_number_settings',
            error_log: [],
        }));
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('FROM phone_number_settings'),
            ['company-1']
        );
    });

    test('does not report connected when Twilio credentials are missing', async () => {
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;

        const res = await request(makeApp())
            .get('/api/telephony/provider');

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('error');
        expect(res.body.data.account_sid).toBeNull();
        expect(res.body.data.error_log).toContain('Twilio credentials are not configured');
    });
});
