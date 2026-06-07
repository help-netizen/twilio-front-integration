const express = require('express');
const request = require('supertest');

const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};
const mockDbQuery = jest.fn();

jest.mock('../../backend/src/db/connection', () => ({
    pool: { connect: jest.fn(() => Promise.resolve(mockClient)) },
    query: (...args) => mockDbQuery(...args),
}));

jest.mock('../../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(),
}));

const phoneNumbersRouter = require('../../backend/src/routes/phoneNumbers');

function makeApp(companyId = 'company-1') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/phone-numbers', phoneNumbersRouter);
    return app;
}

describe('F017 phone number group assignment isolation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDbQuery.mockResolvedValue({
            rows: [{ id: 'pn-1', number: '+16175006181', friendly_name: 'Main', group_id: 'ug-1', group: 'Dispatch' }],
        });
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;
        mockClient.query.mockImplementation(sql => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
            if (sql.includes('FROM phone_number_settings') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 'pn-1', phone_number: '+16175006181', friendly_name: 'Main', group_id: null }] };
            }
            if (sql.includes('FROM user_groups WHERE id')) {
                return { rows: [{ id: 'ug-1', name: 'Dispatch' }] };
            }
            if (sql.includes('SELECT') && sql.includes('pns.id::text')) {
                return { rows: [{ id: 'pn-1', number: '+16175006181', friendly_name: 'Main', group_id: 'ug-1', group: 'Dispatch' }] };
            }
            return { rows: [] };
        });
    });

    test('deletes user_group_numbers by phone only inside the current company', async () => {
        const res = await request(makeApp())
            .put('/api/phone-numbers/pn-1/group')
            .send({ group_id: 'ug-1' });

        expect(res.status).toBe(200);
        const deleteCall = mockClient.query.mock.calls.find(([sql]) => String(sql).startsWith('DELETE FROM user_group_numbers'));
        expect(deleteCall).toBeTruthy();
        expect(deleteCall[0]).toContain('USING user_groups ug');
        expect(deleteCall[0]).toContain('ug.company_id = $2');
        expect(deleteCall[1]).toEqual(['+16175006181', 'company-1']);
    });
});
