const express = require('express');
const http = require('http');
const request = require('supertest');

jest.mock('../../backend/src/services/crmAccountsService', () => ({ listAccounts: jest.fn() }));
jest.mock('../../backend/src/services/crmDealsService', () => ({ updateDeal: jest.fn() }));
jest.mock('../../backend/src/services/machineCredentialService', () => {
    class MachineCredentialError extends Error {
        constructor(code, status) {
            super(code);
            this.code = code;
            this.status = status;
        }
    }
    return {
        SURFACES: { SALES_MCP_PUBLIC: 'sales_mcp_public' },
        ACCESS_SCOPES: { SALES_MCP_PUBLIC: 'sales_mcp_public:access' },
        MachineCredentialError,
        resolveCredential: jest.fn(),
    };
});
jest.mock('../../backend/src/services/authorizationService', () => {
    class CompanyUserAuthzError extends Error {
        constructor(code = 'COMPANY_USER_ACCESS_INACTIVE') {
            super(code);
            this.code = code;
            this.httpStatus = 403;
        }
    }
    return {
        CompanyUserAuthzError,
        resolveCompanyUserAuthz: jest.fn(),
    };
});

const accountsService = require('../../backend/src/services/crmAccountsService');
const dealsService = require('../../backend/src/services/crmDealsService');
const machineCredentials = require('../../backend/src/services/machineCredentialService');
const authorizationService = require('../../backend/src/services/authorizationService');
const crmMcpPublicRouter = require('../../backend/src/routes/crmMcpPublic');

const READ_PERMISSIONS = ['contacts.view', 'leads.view', 'tasks.view'];

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'req-public-test';
        next();
    });
    app.use('/mcp/crm', crmMcpPublicRouter);
    return app;
}

function setPublicContext({
    credentialScopes = ['sales_mcp_public:access', ...READ_PERMISSIONS],
    livePermissions = [...READ_PERMISSIONS, 'sales.crm.write'],
    credentialId = 'credential-1',
    companyId = 'company-1',
    actorUserId = 'user-1',
} = {}) {
    process.env.SALES_MCP_PUBLIC_ENABLED = 'true';
    machineCredentials.resolveCredential.mockImplementation(async (token) => {
        if (token !== 'test-token') {
            throw new machineCredentials.MachineCredentialError('MCP_PUBLIC_UNAUTHORIZED', 401);
        }
        return {
            id: credentialId,
            companyId,
            actorUserId,
            scopes: credentialScopes,
            surface: 'sales_mcp_public',
        };
    });
    authorizationService.resolveCompanyUserAuthz.mockResolvedValue({
        owner_user_id: actorUserId,
        owner_email: 'public-mcp@test.local',
        owner_display_name: 'Public MCP Actor',
        company: { id: companyId, status: 'active', timezone: 'America/New_York' },
        membership: { id: 'membership-1', status: 'active' },
        role_key: 'manager',
        permissions: livePermissions,
        scopes: {},
    });
}

async function openSse(app, token = 'test-token') {
    const server = app.listen(0);
    const { port } = server.address();
    let sseReq;
    let chunks = '';
    const sessionId = await new Promise((resolve, reject) => {
        sseReq = http.get({
            hostname: '127.0.0.1',
            port,
            path: '/mcp/crm/sse',
            headers: { Authorization: `Bearer ${token}` },
        }, res => {
            res.on('data', chunk => {
                chunks += String(chunk);
                const match = /session_id=([^"}]+)/.exec(chunks);
                if (match) resolve(match[1]);
            });
            res.once('error', reject);
        });
        sseReq.once('error', reject);
    });
    return {
        sessionId,
        chunks: () => chunks,
        async close() {
            sseReq.destroy();
            await new Promise(resolve => server.close(resolve));
        },
    };
}

describe('public CRM MCP transport', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setPublicContext();
    });

    afterEach(() => {
        delete process.env.SALES_MCP_PUBLIC_ENABLED;
    });

    test('rejects missing bearer token before live RBAC resolution', async () => {
        const res = await request(makeApp())
            .post('/mcp/crm')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_PUBLIC_UNAUTHORIZED');
        expect(authorizationService.resolveCompanyUserAuthz).not.toHaveBeenCalled();
    });

    test('rejects requests when public transport is disabled', async () => {
        process.env.SALES_MCP_PUBLIC_ENABLED = 'false';
        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

        expect(res.status).toBe(403);
        expect(res.body.error.data.code).toBe('MCP_PUBLIC_DISABLED');
        expect(machineCredentials.resolveCredential).not.toHaveBeenCalled();
    });

    test('supports initialize and credential-scoped tools/list over public HTTP', async () => {
        const init = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        expect(init.status).toBe(200);
        expect(init.body.result.serverInfo.name).toBe('blanc-sales-crm-mcp');

        const list = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { kind: 'read' } });
        expect(list.body.result.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'crm.search_accounts',
                annotations: expect.objectContaining({ readOnlyHint: true }),
            }),
        ]));
        expect(list.body.result.tools.map(tool => tool.name)).not.toContain('crm.update_deal_field');
    });

    test('executes read tool with credential company and real actor', async () => {
        accountsService.listAccounts.mockResolvedValue([{ id: 1, name: 'Acme' }]);
        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({
                jsonrpc: '2.0', id: 3, method: 'tools/call',
                params: { name: 'crm.search_accounts', arguments: { q: 'acme' } },
            });

        expect(res.status).toBe(200);
        expect(res.body.result.structuredContent).toEqual([{ id: 1, name: 'Acme' }]);
        expect(accountsService.listAccounts).toHaveBeenCalledWith('company-1', { q: 'acme' });
        expect(authorizationService.resolveCompanyUserAuthz).toHaveBeenCalledWith('company-1', 'user-1');
    });

    test.each([
        ['credential lacks write scope', READ_PERMISSIONS, [...READ_PERMISSIONS, 'sales.crm.write']],
        ['live actor lacks write permission', [...READ_PERMISSIONS, 'sales.crm.write'], READ_PERMISSIONS],
    ])('%s: effective RBAC intersection denies write', async (_label, credentialPermissions, livePermissions) => {
        setPublicContext({
            credentialScopes: ['sales_mcp_public:access', ...credentialPermissions],
            livePermissions,
        });
        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({
                jsonrpc: '2.0', id: 4, method: 'tools/call',
                params: {
                    name: 'crm.update_deal_field',
                    arguments: { deal_id: 9, field: 'next_step', value: 'New' },
                    confirmation: { confirmed: true, confirmation_id: 'confirm-public' },
                },
            });

        expect(res.status).toBe(200);
        expect(res.body.error.data.code).toBe('access_denied');
        expect(dealsService.updateDeal).not.toHaveBeenCalled();
    });

    test('write passes only with credential scope, live permission, and confirmation', async () => {
        setPublicContext({
            credentialScopes: ['sales_mcp_public:access', ...READ_PERMISSIONS, 'sales.crm.write'],
        });
        dealsService.updateDeal.mockResolvedValue({ before: 'Old', after: 'New' });
        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({
                jsonrpc: '2.0', id: 5, method: 'tools/call',
                params: {
                    name: 'crm.update_deal_field',
                    arguments: { deal_id: 9, field: 'next_step', value: 'New' },
                    confirmation: { confirmed: true, confirmation_id: 'confirm-public' },
                },
            });

        expect(res.body.result.structuredContent).toEqual({ before: 'Old', after: 'New' });
        expect(dealsService.updateDeal).toHaveBeenCalledWith(
            'company-1', 9, { next_step: 'New' },
            expect.objectContaining({
                actorId: 'user-1',
                actorEmail: 'public-mcp@test.local',
                confirmation: { confirmationId: 'confirm-public', reason: null },
            })
        );
    });

    test('membership revocation closes access on the next request', async () => {
        authorizationService.resolveCompanyUserAuthz.mockRejectedValue(
            new authorizationService.CompanyUserAuthzError()
        );
        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({
                jsonrpc: '2.0', id: 6, method: 'tools/call',
                params: { name: 'crm.search_accounts', arguments: { q: 'closed' } },
            });

        expect(res.status).toBe(403);
        expect(res.body.error.data.code).toBe('COMPANY_USER_ACCESS_INACTIVE');
        expect(accountsService.listAccounts).not.toHaveBeenCalled();
    });

    test('SSE uses freshly resolved live authorization for every message', async () => {
        const app = makeApp();
        const sse = await openSse(app);
        accountsService.listAccounts.mockResolvedValue([{ id: 2, name: 'Beta' }]);
        try {
            const post = await request(app)
                .post(`/mcp/crm/messages?session_id=${sse.sessionId}`)
                .set('Authorization', 'Bearer test-token')
                .send({
                    jsonrpc: '2.0', id: 7, method: 'tools/call',
                    params: { name: 'crm.search_accounts', arguments: { q: 'beta' } },
                });
            expect(post.status).toBe(202);
            expect(authorizationService.resolveCompanyUserAuthz).toHaveBeenCalledTimes(2);
            await new Promise((resolve, reject) => {
                const started = Date.now();
                const timer = setInterval(() => {
                    if (sse.chunks().includes('"id":7') && sse.chunks().includes('"Beta"')) {
                        clearInterval(timer);
                        resolve();
                    } else if (Date.now() - started > 1000) {
                        clearInterval(timer);
                        reject(new Error(`SSE response not received: ${sse.chunks()}`));
                    }
                }, 10);
            });
        } finally {
            await sse.close();
        }
    });

    test('SSE session rejects a different credential before tool execution', async () => {
        const app = makeApp();
        const sse = await openSse(app);
        machineCredentials.resolveCredential.mockImplementation(async (token) => ({
            id: token === 'test-token' ? 'credential-1' : 'credential-foreign',
            companyId: token === 'test-token' ? 'company-1' : 'company-2',
            actorUserId: 'user-1',
            scopes: ['sales_mcp_public:access', ...READ_PERMISSIONS],
            surface: 'sales_mcp_public',
        }));
        authorizationService.resolveCompanyUserAuthz.mockImplementation(async (companyId) => ({
            owner_user_id: 'user-1',
            owner_email: 'public-mcp@test.local',
            owner_display_name: 'Public MCP Actor',
            company: { id: companyId, status: 'active' },
            membership: { id: 'membership-1', status: 'active' },
            role_key: 'manager',
            permissions: READ_PERMISSIONS,
            scopes: {},
        }));
        try {
            const post = await request(app)
                .post(`/mcp/crm/messages?session_id=${sse.sessionId}`)
                .set('Authorization', 'Bearer foreign-token')
                .send({
                    jsonrpc: '2.0', id: 8, method: 'tools/call',
                    params: { name: 'crm.search_accounts', arguments: { q: 'foreign' } },
                });
            expect(post.status).toBe(403);
            expect(post.body.error.data.code).toBe('MCP_SSE_CREDENTIAL_MISMATCH');
            expect(accountsService.listAccounts).not.toHaveBeenCalled();
        } finally {
            await sse.close();
        }
    });
});
