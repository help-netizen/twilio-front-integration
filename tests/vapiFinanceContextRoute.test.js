'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/agentSkills', () => ({
    runSkill: jest.fn(async () => ({ ok: true, speak: 'ok' })),
}));
jest.mock('../backend/src/services/vapiCallContextService', () => ({
    resolve: jest.fn(),
}));

const agentSkills = require('../backend/src/services/agentSkills');
const callContextService = require('../backend/src/services/vapiCallContextService');
const router = require('../backend/src/routes/vapi-tools');

const COMPANY = '00000000-0000-0000-0000-000000000099';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/vapi-tools', router);
    return app;
}

function payload() {
    return {
        message: {
            type: 'tool-calls',
            call: {
                id: 'vapi-call-99',
                customer: { number: '+16175551212' },
                assistantOverrides: {
                    variableValues: {
                        companyId: 'spoof-company',
                        jobId: 'spoof-job',
                        contactId: 'spoof-contact',
                        scenario: 'parts_visit',
                    },
                },
            },
            toolCallList: [{
                id: 'tool-1',
                function: {
                    name: 'getInvoiceSummary',
                    arguments: JSON.stringify({ jobId: 'model-job', invoiceId: 'invoice-1' }),
                },
            }],
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.VAPI_TOOLS_SECRET = 'test-vapi-secret';
});

afterAll(() => {
    delete process.env.VAPI_TOOLS_SECRET;
});

test('SAB-FIN-OUTBOUND-SPOOF: route dispatches with stored company and subject context', async () => {
    callContextService.resolve.mockResolvedValue({
        matched: true,
        ambiguous: false,
        companyId: COMPANY,
        values: {
            companyId: COMPANY,
            jobId: 101,
            contactId: 501,
            phone: '+16175551212',
            scenario: 'parts_visit',
        },
    });

    const response = await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'test-vapi-secret')
        .send(payload());

    expect(response.status).toBe(200);
    expect(agentSkills.runSkill).toHaveBeenCalledWith(
        'getInvoiceSummary',
        COMPANY,
        expect.objectContaining({ source: 'vapi' }),
        expect.objectContaining({
            companyId: COMPANY,
            jobId: 101,
            contactId: 501,
            phone: '+16175551212',
            invoiceId: 'invoice-1',
        }),
    );
});

test('duplicate VAPI call id across companies fails closed before skill dispatch', async () => {
    callContextService.resolve.mockResolvedValue({ matched: false, ambiguous: true });

    const response = await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'test-vapi-secret')
        .send(payload());

    expect(response.status).toBe(200);
    expect(agentSkills.runSkill).not.toHaveBeenCalled();
    const result = JSON.parse(response.body.results[0].result);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toMatch(/spoof|invoice-1|101|501/);
});
