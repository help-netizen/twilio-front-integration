'use strict';

const express = require('express');
const request = require('supertest');

const RESOURCE = 'https://api.albusto.com/mcp/chatgpt';
const ISSUER = 'https://auth.albusto.test/realms/crm-prod';

function buildApp() {
    jest.resetModules();
    jest.doMock('jsonwebtoken', () => ({
        verify: jest.fn((token, _getKey, _options, callback) => {
            if (token === 'invalid') return callback(new Error('invalid signature'));
            callback(null, {
                iss: ISSUER,
                sub: token,
                aud: [RESOURCE],
                azp: 'chatgpt-crm-mcp',
                resource: RESOURCE,
                scope: 'albusto.mcp.read',
            });
        }),
    }));
    jest.doMock('../backend/src/services/chatgptMcpIdentityService', () => {
        class ChatgptMcpIdentityError extends Error {
            constructor(code, message, httpStatus = 403) {
                super(message);
                this.code = code;
                this.httpStatus = httpStatus;
            }
        }
        return {
            ChatgptMcpIdentityError,
            configuredIssuer: () => ISSUER,
            configuredClientId: () => 'chatgpt-crm-mcp',
            resolveOAuthContext: jest.fn(async ({ subject }) => ({
                binding_id: `binding-${subject}`,
                company_id: `company-${subject}`,
                installation_id: subject === 'a' ? 1 : 2,
                authorized_by_user_id: `human-${subject}`,
                ai_user_id: `agent-${subject}`,
                company_name: `Company ${subject.toUpperCase()}`,
                company_timezone: 'America/New_York',
                ai_email: `agent-${subject}@albusto.invalid`,
                ai_full_name: 'ChatGPT AI Dispatcher',
                permissions: [],
            })),
            recordInvocation: jest.fn(async () => {}),
        };
    });

    const connectorRouter = require('../backend/src/routes/chatgptMcp');
    const metadataRouter = require('../backend/src/routes/chatgptMcpResourceMetadata');
    const server = express();
    server.use(express.json());
    server.use('/.well-known/oauth-protected-resource', metadataRouter);
    server.use('/mcp/chatgpt', connectorRouter);
    return server;
}

function initialize(server, token = 'a') {
    return request(server)
        .post('/mcp/chatgpt')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
}

beforeEach(() => {
    process.env.KEYCLOAK_REALM_URL = ISSUER;
    process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
    process.env.CHATGPT_MCP_RESOURCE = RESOURCE;
    process.env.CHATGPT_MCP_RATE_LIMIT = '2';
    process.env.CHATGPT_MCP_RATE_WINDOW_MS = '60';
});

afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
});

afterAll(() => {
    delete process.env.KEYCLOAK_REALM_URL;
    delete process.env.CHATGPT_MCP_CLIENT_ID;
    delete process.env.CHATGPT_MCP_RESOURCE;
    delete process.env.CHATGPT_MCP_RATE_LIMIT;
    delete process.env.CHATGPT_MCP_RATE_WINDOW_MS;
});

describe('ChatGPT MCP rate limiter', () => {
    test('limits one binding inside the configured window and resets after it', async () => {
        const server = buildApp();
        expect((await initialize(server, 'a')).status).toBe(200);
        expect((await initialize(server, 'a')).status).toBe(200);

        const limited = await initialize(server, 'a');
        expect(limited.status).toBe(429);
        expect(limited.body).toEqual(expect.objectContaining({
            jsonrpc: '2.0',
            error: expect.objectContaining({
                code: -32000,
                data: expect.objectContaining({ code: 'RATE_LIMITED' }),
            }),
        }));
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);

        await new Promise((resolve) => setTimeout(resolve, 80));
        expect((await initialize(server, 'a')).status).toBe(200);
    });

    test('bindings have isolated budgets even when requests share an IP', async () => {
        const server = buildApp();
        expect((await initialize(server, 'a')).status).toBe(200);
        expect((await initialize(server, 'a')).status).toBe(200);
        expect((await initialize(server, 'a')).status).toBe(429);

        expect((await initialize(server, 'b')).status).toBe(200);
        expect((await initialize(server, 'b')).status).toBe(200);
        expect((await initialize(server, 'b')).status).toBe(429);
    });

    test('401 traffic is bounded by IP before a binding exists', async () => {
        const server = buildApp();
        const unauthorized = () => request(server)
            .post('/mcp/chatgpt')
            .send({ jsonrpc: '2.0', id: 41, method: 'initialize' });

        expect((await unauthorized()).status).toBe(401);
        expect((await unauthorized()).status).toBe(401);
        const limited = await unauthorized();
        expect(limited.status).toBe(429);
        expect(limited.body.error.data.code).toBe('RATE_LIMITED');
    });

    test('protected-resource metadata is outside both limiter budgets', async () => {
        const server = buildApp();
        for (let index = 0; index < 5; index += 1) {
            const metadata = await request(server)
                .get('/.well-known/oauth-protected-resource/mcp/chatgpt');
            expect(metadata.status).toBe(200);
        }
        expect((await initialize(server, 'a')).status).toBe(200);
        expect((await initialize(server, 'a')).status).toBe(200);
    });
});
