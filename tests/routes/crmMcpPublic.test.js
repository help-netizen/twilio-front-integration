const express = require('express');
const http = require('http');
const request = require('supertest');

jest.mock('../../backend/src/services/crmAccountsService', () => ({
    listAccounts: jest.fn(),
}));
jest.mock('../../backend/src/services/crmDealsService', () => ({
    updateDeal: jest.fn(),
}));

const accountsService = require('../../backend/src/services/crmAccountsService');
const dealsService = require('../../backend/src/services/crmDealsService');
const crmMcpPublicRouter = require('../../backend/src/routes/crmMcpPublic');

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

function setPublicEnv({ write = false } = {}) {
    process.env.SALES_MCP_PUBLIC_ENABLED = 'true';
    process.env.SALES_MCP_PUBLIC_TOKEN = 'test-token';
    process.env.SALES_MCP_PUBLIC_COMPANY_ID = 'company-1';
    process.env.SALES_MCP_PUBLIC_USER_ID = 'user-1';
    process.env.SALES_MCP_PUBLIC_USER_EMAIL = 'public-mcp@test.local';
    process.env.SALES_MCP_PUBLIC_WRITE_ENABLED = write ? 'true' : 'false';
}

describe('public CRM MCP transport', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setPublicEnv();
    });

    afterEach(() => {
        delete process.env.SALES_MCP_PUBLIC_ENABLED;
        delete process.env.SALES_MCP_PUBLIC_TOKEN;
        delete process.env.SALES_MCP_PUBLIC_COMPANY_ID;
        delete process.env.SALES_MCP_PUBLIC_USER_ID;
        delete process.env.SALES_MCP_PUBLIC_USER_EMAIL;
        delete process.env.SALES_MCP_PUBLIC_WRITE_ENABLED;
    });

    test('rejects missing bearer token', async () => {
        const res = await request(makeApp())
            .post('/mcp/crm')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_PUBLIC_UNAUTHORIZED');
    });

    test('rejects requests when public transport is disabled', async () => {
        process.env.SALES_MCP_PUBLIC_ENABLED = 'false';

        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

        expect(res.status).toBe(403);
        expect(res.body.error.data.code).toBe('MCP_PUBLIC_DISABLED');
    });

    test('supports initialize and tools/list over public HTTP', async () => {
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

    test('executes read tool with env-bound public context', async () => {
        accountsService.listAccounts.mockResolvedValue([{ id: 1, name: 'Acme' }]);

        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'crm.search_accounts', arguments: { q: 'acme' } },
            });

        expect(res.status).toBe(200);
        expect(res.body.result.structuredContent).toEqual([{ id: 1, name: 'Acme' }]);
        expect(accountsService.listAccounts).toHaveBeenCalledWith('company-1', { q: 'acme' });
    });

    test('public write tool fails unless public writes are explicitly enabled', async () => {
        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
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

    test('public write tool passes when public writes are enabled', async () => {
        setPublicEnv({ write: true });
        dealsService.updateDeal.mockResolvedValue({ before: 'Old', after: 'New' });

        const res = await request(makeApp())
            .post('/mcp/crm')
            .set('Authorization', 'Bearer test-token')
            .send({
                jsonrpc: '2.0',
                id: 5,
                method: 'tools/call',
                params: {
                    name: 'crm.update_deal_field',
                    arguments: { deal_id: 9, field: 'next_step', value: 'New' },
                    confirmation: { confirmed: true, confirmation_id: 'confirm-public' },
                },
            });

        expect(res.body.result.structuredContent).toEqual({ before: 'Old', after: 'New' });
        expect(dealsService.updateDeal).toHaveBeenCalledWith(
            'company-1',
            9,
            { next_step: 'New' },
            expect.objectContaining({
                actorId: 'user-1',
                actorEmail: 'public-mcp@test.local',
                confirmation: { confirmationId: 'confirm-public', reason: null },
            })
        );
    });

    test('legacy SSE session receives response from messages endpoint', async () => {
        const app = makeApp();
        const server = app.listen(0);
        const { port } = server.address();
        accountsService.listAccounts.mockResolvedValue([{ id: 2, name: 'Beta' }]);
        let sseReq;
        let sseChunks = '';

        try {
            const sessionId = await new Promise((resolve, reject) => {
                sseReq = http.get({
                    hostname: '127.0.0.1',
                    port,
                    path: '/mcp/crm/sse',
                    headers: { Authorization: 'Bearer test-token' },
                }, res => {
                    res.on('data', chunk => {
                        sseChunks += String(chunk);
                        const match = /session_id=([^"}]+)/.exec(sseChunks);
                        if (match) resolve(match[1]);
                    });
                    res.once('error', reject);
                });
                sseReq.once('error', reject);
            });

            const post = await request(app)
                .post(`/mcp/crm/messages?session_id=${sessionId}`)
                .set('Authorization', 'Bearer test-token')
                .send({
                    jsonrpc: '2.0',
                    id: 6,
                    method: 'tools/call',
                    params: { name: 'crm.search_accounts', arguments: { q: 'beta' } },
                });

            expect(post.status).toBe(202);
            expect(accountsService.listAccounts).toHaveBeenCalledWith('company-1', { q: 'beta' });
            await new Promise((resolve, reject) => {
                const started = Date.now();
                const timer = setInterval(() => {
                    if (sseChunks.includes('"id":6') && sseChunks.includes('"Beta"')) {
                        clearInterval(timer);
                        resolve();
                    } else if (Date.now() - started > 1000) {
                        clearInterval(timer);
                        reject(new Error(`SSE response not received: ${sseChunks}`));
                    }
                }, 10);
            });
        } finally {
            if (sseReq) sseReq.destroy();
            server.close();
        }
    });
});
