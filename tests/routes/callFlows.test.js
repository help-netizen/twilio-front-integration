const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const callFlowsRouter = require('../../backend/src/routes/callFlows');

function makeApp(companyId = 'company-1') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/call-flows', callFlowsRouter);
    return app;
}

describe('F017 call flows active-only API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('saving a flow marks the single graph active immediately', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'cf-1', company_id: 'company-1', status: 'active' }],
        });

        const graph = { states: [{ id: 'start', kind: 'start', name: 'Start' }], transitions: [] };
        const res = await request(makeApp())
            .put('/api/call-flows/cf-1')
            .send({ graph });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining("status = 'active'"),
            expect.arrayContaining(['cf-1', 'company-1'])
        );
    });

    test('publish endpoint is not part of the F017 call flow contract', async () => {
        const res = await request(makeApp())
            .put('/api/call-flows/cf-1/publish')
            .send({});

        expect(res.status).toBe(404);
        expect(mockQuery).not.toHaveBeenCalled();
    });
});
