const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const telephonyOverviewRouter = require('../../backend/src/routes/telephonyOverview');

function makeApp(companyId = 'company-1') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/telephony/overview', telephonyOverviewRouter);
    return app;
}

describe('F017 telephony overview', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ count: 1 }] })
            .mockResolvedValueOnce({ rows: [{ count: 9 }] })
            .mockResolvedValueOnce({ rows: [{ count: 1 }] });
    });

    test('counts phone numbers inside the current company', async () => {
        const res = await request(makeApp('company-1'))
            .get('/api/telephony/overview');

        expect(res.status).toBe(200);
        expect(res.body.data.phone_numbers_count).toBe(9);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('FROM phone_number_settings WHERE company_id = $1'),
            ['company-1']
        );
    });
});
