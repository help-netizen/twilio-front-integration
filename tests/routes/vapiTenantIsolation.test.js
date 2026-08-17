'use strict';

const express = require('express');
const request = require('supertest');

const mockDbQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockDbQuery }));

const router = require('../../backend/src/routes/vapi');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const LEGACY_SURFACES = Object.freeze([
    ['get', '/api/vapi/connections'],
    ['post', '/api/vapi/connections'],
    ['put', '/api/vapi/connections/connection-a'],
    ['delete', '/api/vapi/connections/connection-a'],
    ['get', '/api/vapi/resources'],
    ['post', '/api/vapi/resources'],
    ['get', '/api/vapi/assistant-profiles'],
    ['post', '/api/vapi/assistant-profiles'],
    ['put', '/api/vapi/assistant-profiles/profile-a'],
    ['get', '/api/vapi/node-configs/flow-a/node-a'],
    ['put', '/api/vapi/node-configs/flow-a/node-a'],
    ['get', '/api/vapi/ai-runs'],
]);

function makeApp({ companyId = COMPANY_A, permissions = [] } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        req.user = { crmUser: { id: `user-${companyId}` } };
        req.authz = { permissions };
        next();
    });
    app.use('/api/vapi', router);
    return app;
}

async function invoke(app, method, path) {
    return request(app)[method](path).send({
        company_id: COMPANY_B,
        api_key: 'must-never-be-consumed',
        sip_uri: 'sip:must-never-be-consumed@sip.vapi.ai',
        vapi_assistant_id: 'must-never-be-consumed',
        base_config_json: '{"assistantOverrides":{"voice":"foreign"}}',
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

test('T-own/T-foreign/T-blast: every former provider-management read/write is gone', async () => {
    const before = Object.freeze({ companyA: 'unchanged-a', companyB: 'unchanged-b' });
    const app = makeApp({
        companyId: COMPANY_A,
        permissions: ['tenant.integrations.manage', 'tenant.company.manage'],
    });

    for (const [method, path] of LEGACY_SURFACES) {
        const response = await invoke(app, method, path);
        expect(response.status).toBe(404);
        expect(JSON.stringify(response.body)).not.toMatch(/vapi|provider|assistant|sip|api_key/i);
    }

    expect(before).toEqual({ companyA: 'unchanged-a', companyB: 'unchanged-b' });
    expect(mockDbQuery).not.toHaveBeenCalled();
});

test.each([
    ['tenant admin allow-cell from legacy API', ['tenant.integrations.manage']],
    ['manager deny-cell', ['jobs.manage']],
    ['dispatcher deny-cell', ['schedule.dispatch']],
    ['provider deny-cell', ['provider.jobs.view']],
    ['custom role without permission', []],
])('R-matrix: %s cannot reach retired management routes', async (_label, permissions) => {
    const app = makeApp({ companyId: COMPANY_A, permissions });
    for (const [method, path] of LEGACY_SURFACES) {
        expect((await invoke(app, method, path)).status).toBe(404);
    }
    expect(mockDbQuery).not.toHaveBeenCalled();
});

test('router contains no hidden provider-management handlers', () => {
    expect(router.stack).toHaveLength(0);
});
