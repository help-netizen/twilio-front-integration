'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../backend/src/services/chatgptMcpIdentityService', () => {
    class ChatgptMcpIdentityError extends Error {
        constructor(code, message, httpStatus = 403) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        ChatgptMcpIdentityError,
        configuredIssuer: () => process.env.KEYCLOAK_REALM_URL,
        configuredClientId: () => {
            const value = String(process.env.CHATGPT_MCP_CLIENT_ID || '').trim();
            if (!value) {
                throw new ChatgptMcpIdentityError(
                    'MCP_CONTEXT_NOT_CONFIGURED',
                    'CHATGPT_MCP_CLIENT_ID is required',
                    503
                );
            }
            return value;
        },
        resolveOAuthContext: jest.fn(),
        recordInvocation: jest.fn(async () => {}),
    };
});

const jwt = require('jsonwebtoken');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const metadataRouter = require('../backend/src/routes/chatgptMcpResourceMetadata');
const connectorRouter = require('../backend/src/routes/chatgptMcp');

const RESOURCE = 'https://api.albusto.com/mcp/chatgpt';
const ISSUER = 'https://auth.albusto.com/realms/crm-prod';

function claims(overrides = {}) {
    return {
        iss: ISSUER,
        sub: 'human-sub-a',
        aud: [RESOURCE],
        azp: 'chatgpt-crm-mcp',
        resource: RESOURCE,
        scope: 'openid albusto.mcp.read',
        ...overrides,
    };
}

function app() {
    const server = express();
    server.use(express.json());
    server.use('/.well-known/oauth-protected-resource', metadataRouter);
    server.use('/mcp/chatgpt', connectorRouter);
    return server;
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.KEYCLOAK_REALM_URL = ISSUER;
    process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
    process.env.CHATGPT_MCP_RESOURCE = RESOURCE;
    jwt.verify.mockImplementation((_token, _getKey, _options, callback) => callback(null, claims()));
    identityService.resolveOAuthContext.mockResolvedValue({
        binding_id: 'binding-a',
        company_id: 'company-a',
        installation_id: 101,
        authorized_by_user_id: 'human-a',
        ai_user_id: 'agent-a',
        company_name: 'Company A',
        company_timezone: 'America/New_York',
        ai_email: 'agent-a@albusto.invalid',
        ai_full_name: 'ChatGPT AI Dispatcher',
        permissions: ['jobs.view', 'mcp.tool.svc.get_job'],
    });
});

afterAll(() => {
    delete process.env.KEYCLOAK_REALM_URL;
    delete process.env.CHATGPT_MCP_CLIENT_ID;
    delete process.env.CHATGPT_MCP_RESOURCE;
});

describe('CHATGPT-CRM-MCP OAuth protected resource', () => {
    test.each(['/', '/mcp/chatgpt'])(
        'metadata %s advertises the exact resource, AS, and no payment scope',
        async (suffix) => {
            const res = await request(app()).get(`/.well-known/oauth-protected-resource${suffix === '/' ? '' : suffix}`);
            expect(res.status).toBe(200);
            expect(res.body.resource).toBe(RESOURCE);
            expect(res.body.authorization_servers).toEqual([ISSUER]);
            expect(res.body.scopes_supported).toEqual([
                'albusto.mcp.read', 'albusto.mcp.write', 'albusto.mcp.send',
            ]);
            expect(res.body.scopes_supported).not.toContain('albusto.mcp.payments');
        }
    );

    test('missing bearer is 401 with RFC 9728 discovery challenge; query token is ignored', async () => {
        const res = await request(app())
            .post('/mcp/chatgpt?token=forbidden')
            .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toContain('oauth-protected-resource/mcp/chatgpt');
        expect(res.headers['www-authenticate']).toContain('albusto.mcp.read');
        expect(jwt.verify).not.toHaveBeenCalled();
    });

    test('valid token maps through the active binding and filters discovery to exact grants', async () => {
        const res = await request(app())
            .post('/mcp/chatgpt')
            .set('Authorization', 'Bearer valid')
            .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        expect(res.status).toBe(200);
        expect(identityService.resolveOAuthContext).toHaveBeenCalledWith({
            issuer: ISSUER, subject: 'human-sub-a', clientId: 'chatgpt-crm-mcp',
        });
        expect(res.body.result.tools.map((tool) => tool.name)).toEqual(['svc.get_job']);
    });

    test.each([
        ['audience', { aud: ['other-resource'] }],
        ['authorized party', { azp: 'other-client' }],
        ['resource', { resource: 'https://api.albusto.com/mcp/other' }],
        ['scope', { scope: 'openid profile' }],
        ['subject', { sub: null }],
    ])('forged %s fails before the binding query', async (_label, override) => {
        jwt.verify.mockImplementation((_token, _getKey, _options, callback) => callback(null, claims(override)));
        const res = await request(app())
            .post('/mcp/chatgpt')
            .set('Authorization', 'Bearer forged')
            .send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
        expect(res.status).toBe(401);
        expect(identityService.resolveOAuthContext).not.toHaveBeenCalled();
    });

    test('missing MCP client id or resource fails closed before binding resolution', async () => {
        delete process.env.CHATGPT_MCP_CLIENT_ID;
        let res = await request(app())
            .post('/mcp/chatgpt')
            .set('Authorization', 'Bearer valid')
            .send({ jsonrpc: '2.0', id: 31, method: 'tools/list' });
        expect(res.status).toBe(503);
        expect(res.body.error.data.code).toBe('MCP_CONTEXT_NOT_CONFIGURED');
        expect(identityService.resolveOAuthContext).not.toHaveBeenCalled();

        process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
        delete process.env.CHATGPT_MCP_RESOURCE;
        res = await request(app())
            .post('/mcp/chatgpt')
            .set('Authorization', 'Bearer valid')
            .send({ jsonrpc: '2.0', id: 32, method: 'tools/list' });
        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('AUTH_INVALID');
        expect(identityService.resolveOAuthContext).not.toHaveBeenCalled();

        res = await request(app()).get('/.well-known/oauth-protected-resource/mcp/chatgpt');
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('MCP_AUTH_MISCONFIGURED');
    });

    test('revoked/ambiguous binding fails closed with zero protocol work', async () => {
        identityService.resolveOAuthContext.mockRejectedValue(
            new identityService.ChatgptMcpIdentityError('MCP_BINDING_INVALID', 'inactive', 403)
        );
        const res = await request(app())
            .post('/mcp/chatgpt')
            .set('Authorization', 'Bearer valid')
            .send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
        expect(res.status).toBe(403);
        expect(res.body.error.data.code).toBe('MCP_BINDING_INVALID');
    });

    test('authenticated GET is standards-shaped 405 and never opens legacy SSE', async () => {
        const res = await request(app())
            .get('/mcp/chatgpt')
            .set('Authorization', 'Bearer valid');
        expect(res.status).toBe(405);
        expect(res.headers.allow).toBe('POST');
        expect(res.headers['content-type']).toContain('application/json');
    });
});
