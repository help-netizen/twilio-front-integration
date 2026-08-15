'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/agentSkills', () => ({
    runSkill: jest.fn(async () => ({ ok: true, speak: 'ok' })),
}));
jest.mock('../backend/src/services/vapiCallContextService', () => ({
    resolve: jest.fn(),
    looksLikeOutbound: jest.fn(),
}));
jest.mock('../backend/src/services/machineCredentialService', () => ({
    SURFACES: { VAPI_TOOLS: 'vapi_tools' },
    ACCESS_SCOPES: { VAPI_TOOLS: 'vapi_tools:invoke' },
    MachineCredentialError: class MachineCredentialError extends Error {
        constructor(code, status) {
            super(code);
            this.code = code;
            this.status = status;
        }
    },
    resolveCredential: jest.fn(),
}));

const agentSkills = require('../backend/src/services/agentSkills');
const callContextService = require('../backend/src/services/vapiCallContextService');
const machineCredentials = require('../backend/src/services/machineCredentialService');
const router = require('../backend/src/routes/vapi-tools');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const FOREIGN_COMPANY = '00000000-0000-0000-0000-000000000099';

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
    machineCredentials.resolveCredential.mockResolvedValue({
        id: 'credential-a',
        companyId: COMPANY,
        scopes: ['vapi_tools:invoke'],
        surface: 'vapi_tools',
    });
    callContextService.looksLikeOutbound.mockReturnValue(true);
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

test('T-own/T-blast: secret A and secret B dispatch the same tool only in their own company', async () => {
    machineCredentials.resolveCredential.mockImplementation(async (secret) => ({
        id: secret === 'secret-a' ? 'credential-a' : 'credential-b',
        companyId: secret === 'secret-a' ? COMPANY : FOREIGN_COMPANY,
        scopes: ['vapi_tools:invoke'],
        surface: 'vapi_tools',
    }));
    callContextService.resolve.mockResolvedValue({ matched: false, ambiguous: false });
    callContextService.looksLikeOutbound.mockReturnValue(false);

    await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'secret-a')
        .send(payload());
    await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'secret-b')
        .send(payload());

    expect(agentSkills.runSkill.mock.calls.map((call) => call[1])).toEqual([
        COMPANY,
        FOREIGN_COMPANY,
    ]);
});

test.each([
    ['MACHINE_CREDENTIAL_REVOKED', 401],
    ['MACHINE_CREDENTIAL_EXPIRED', 401],
    ['MACHINE_CREDENTIAL_SCOPE_REQUIRED', 403],
])('%s rejects before runSkill', async (code, status) => {
    machineCredentials.resolveCredential.mockRejectedValue(
        new machineCredentials.MachineCredentialError(code, status)
    );

    const response = await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'rejected-secret')
        .send(payload());

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(agentSkills.runSkill).not.toHaveBeenCalled();
    expect(callContextService.resolve).not.toHaveBeenCalled();
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

test('T-foreign/T-blast: a correlated non-Vapi company is refused without dispatch', async () => {
    callContextService.resolve.mockResolvedValue({
        matched: true,
        ambiguous: false,
        companyId: FOREIGN_COMPANY,
        values: { companyId: FOREIGN_COMPANY, jobId: 202 },
    });

    const response = await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'test-vapi-secret')
        .send(payload());

    expect(response.status).toBe(200);
    expect(agentSkills.runSkill).not.toHaveBeenCalled();
    expect(JSON.parse(response.body.results[0].result)).toMatchObject({ ok: false });
});

test('outbound correlation in A plus credential B is refused before dispatch', async () => {
    machineCredentials.resolveCredential.mockResolvedValue({
        id: 'credential-b',
        companyId: FOREIGN_COMPANY,
        scopes: ['vapi_tools:invoke'],
        surface: 'vapi_tools',
    });
    callContextService.resolve.mockResolvedValue({
        matched: true,
        ambiguous: false,
        companyId: COMPANY,
        values: { companyId: COMPANY, jobId: 303 },
    });

    const response = await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'credential-b-secret')
        .send(payload());

    expect(response.status).toBe(200);
    expect(agentSkills.runSkill).not.toHaveBeenCalled();
    expect(JSON.parse(response.body.results[0].result)).toMatchObject({ ok: false });
});

test('T-own/T-blast: uncorrelated inbound body company cannot override the secret-bound company', async () => {
    callContextService.resolve.mockResolvedValue({ matched: false, ambiguous: false });
    callContextService.looksLikeOutbound.mockReturnValue(false);
    const body = payload();
    body.message.call.assistantOverrides.variableValues = { companyId: FOREIGN_COMPANY };
    body.message.toolCallList[0].function.arguments = JSON.stringify({
        companyId: FOREIGN_COMPANY,
        invoiceId: 'invoice-1',
    });

    const response = await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'test-vapi-secret')
        .send(body);

    expect(response.status).toBe(200);
    expect(agentSkills.runSkill).toHaveBeenCalledWith(
        'getInvoiceSummary',
        COMPANY,
        expect.objectContaining({ source: 'vapi' }),
        expect.objectContaining({ companyId: COMPANY, invoiceId: 'invoice-1' })
    );
    expect(JSON.stringify(agentSkills.runSkill.mock.calls[0][3])).not.toContain(FOREIGN_COMPANY);
});

test('uncorrelated outbound identity is refused before dispatch', async () => {
    callContextService.resolve.mockResolvedValue({ matched: false, ambiguous: false });
    callContextService.looksLikeOutbound.mockReturnValue(true);

    const response = await request(makeApp())
        .post('/api/vapi-tools')
        .set('x-vapi-secret', 'test-vapi-secret')
        .send(payload());

    expect(response.status).toBe(200);
    expect(agentSkills.runSkill).not.toHaveBeenCalled();
});
