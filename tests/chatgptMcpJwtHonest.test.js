'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let mockPublicKeyPem;
const mockGetSigningKey = jest.fn((_kid, callback) => callback(null, {
    getPublicKey: () => mockPublicKeyPem,
}));

// Only the network/JWKS seam is replaced. jsonwebtoken.verify and all RS256
// signature, issuer, audience, and expiry checks below are real.
jest.mock('jwks-rsa', () => jest.fn(() => ({
    getSigningKey: mockGetSigningKey,
})));

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
        configuredClientId: () => process.env.CHATGPT_MCP_CLIENT_ID,
        resolveOAuthContext: jest.fn(async () => ({
            binding_id: 'binding-honest-jwt',
            company_id: 'company-a',
            installation_id: 1,
            authorized_by_user_id: 'human-a',
            ai_user_id: 'agent-a',
            company_name: 'Company A',
            company_timezone: 'America/New_York',
            ai_email: 'agent-a@albusto.invalid',
            ai_full_name: 'ChatGPT AI Dispatcher',
            permissions: [],
        })),
    };
});

const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const { authenticateChatgptMcp } = require('../backend/src/middleware/chatgptMcpAuth');

const RESOURCE = 'https://api.albusto.com/mcp/chatgpt';
const ISSUER = 'https://auth.albusto.test/realms/crm-prod';
let privateKey;
let foreignPrivateKey;

function claims(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
        iss: ISSUER,
        sub: 'human-sub-a',
        aud: [RESOURCE],
        azp: 'chatgpt-crm-mcp',
        resource: RESOURCE,
        scope: 'openid albusto.mcp.read',
        iat: now,
        exp: now + 300,
        ...overrides,
    };
}

function signedToken(overrides = {}, key = privateKey) {
    const payload = claims(overrides);
    for (const [name, value] of Object.entries(payload)) {
        if (value === undefined) delete payload[name];
    }
    return jwt.sign(payload, key, {
        algorithm: 'RS256',
        keyid: 'honest-jwt-test-key',
    });
}

function app() {
    const server = express();
    server.use(express.json());
    server.get('/probe', authenticateChatgptMcp, (req, res) => res.json({
        company_id: req.companyFilter.company_id,
        binding_id: req.chatgptMcpBinding.id,
        scopes: req.authz.oauthScopes,
    }));
    return server;
}

async function probe(token) {
    return request(app())
        .get('/probe')
        .set('Authorization', `Bearer ${token}`);
}

beforeAll(() => {
    const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    privateKey = keyPair.privateKey;
    mockPublicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
    ({ privateKey: foreignPrivateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    }));
});

beforeEach(() => {
    jest.clearAllMocks();
    process.env.KEYCLOAK_REALM_URL = ISSUER;
    process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
    process.env.CHATGPT_MCP_RESOURCE = RESOURCE;
});

afterAll(() => {
    delete process.env.KEYCLOAK_REALM_URL;
    delete process.env.CHATGPT_MCP_CLIENT_ID;
    delete process.env.CHATGPT_MCP_RESOURCE;
});

describe('ChatGPT MCP honest RS256 authorization chain', () => {
    test('a valid signed token passes signature and every connector claim', async () => {
        const res = await probe(signedToken());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            company_id: 'company-a',
            binding_id: 'binding-honest-jwt',
            scopes: ['openid', 'albusto.mcp.read'],
        });
        expect(mockGetSigningKey).toHaveBeenCalledWith(
            'honest-jwt-test-key',
            expect.any(Function)
        );
        expect(identityService.resolveOAuthContext).toHaveBeenCalledWith({
            issuer: ISSUER,
            subject: 'human-sub-a',
            clientId: 'chatgpt-crm-mcp',
        });
    });

    test('a bad RS256 signature is 401 MCP_TOKEN_SIGNATURE', async () => {
        const res = await probe(signedToken({}, foreignPrivateKey));
        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_TOKEN_SIGNATURE');
    });

    test('a foreign issuer is 401 MCP_TOKEN_ISSUER', async () => {
        const res = await probe(signedToken({ iss: 'https://foreign.test/realms/other' }));
        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_TOKEN_ISSUER');
    });

    test('a token without aud is 401 MCP_TOKEN_AUDIENCE', async () => {
        const res = await probe(signedToken({ aud: undefined }));
        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_TOKEN_AUDIENCE');
    });

    test('a foreign authorized party is 401 MCP_TOKEN_CLIENT', async () => {
        const res = await probe(signedToken({ azp: 'foreign-client' }));
        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_TOKEN_CLIENT');
    });

    test('a token without the resource claim is 401 MCP_TOKEN_RESOURCE', async () => {
        const res = await probe(signedToken({ resource: undefined }));
        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_TOKEN_RESOURCE');
    });

    test('a token without read scope is 403 MCP_TOKEN_SCOPE', async () => {
        const res = await probe(signedToken({ scope: 'openid profile' }));
        expect(res.status).toBe(403);
        expect(res.body.error.data.code).toBe('MCP_TOKEN_SCOPE');
    });

    test('an expired token is 401 MCP_TOKEN_EXPIRED', async () => {
        const now = Math.floor(Date.now() / 1000);
        const res = await probe(signedToken({ iat: now - 600, exp: now - 300 }));
        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_TOKEN_EXPIRED');
    });
});
