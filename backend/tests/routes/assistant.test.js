'use strict';

const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';

const COMPANY_A = '10000000-0000-4000-8000-000000000001';
const COMPANY_B = '20000000-0000-4000-8000-000000000002';
const CRM_USER_ID = '30000000-0000-4000-8000-000000000003';
const USER_EMAIL = 'assistant-user@x.com';

let mockDecoded;
let mockCrmUser;
let mockAuthz;
const mockJwtVerify = jest.fn((_token, _getKey, _options, callback) => callback(null, mockDecoded));
const mockFindOrCreateUser = jest.fn(() => Promise.resolve(mockCrmUser));
const mockResolveAuthzContext = jest.fn(() => Promise.resolve(mockAuthz));
const mockAuditLog = jest.fn(() => Promise.resolve());
const mockChat = jest.fn();
const mockConsumeChatTelemetry = jest.fn();
const mockDbQuery = jest.fn();

jest.mock('jsonwebtoken', () => ({ verify: mockJwtVerify }));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));
jest.mock('../../src/services/userService', () => ({
    findOrCreateUser: mockFindOrCreateUser,
}));
jest.mock('../../src/services/auditService', () => ({
    log: mockAuditLog,
}));
jest.mock('../../src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(),
    resolveAuthzContext: mockResolveAuthzContext,
}));
jest.mock('../../src/services/assistantService', () => ({
    chat: mockChat,
    consumeChatTelemetry: mockConsumeChatTelemetry,
}));
jest.mock('../../src/db/connection', () => ({
    query: mockDbQuery,
}));

const express = require('express');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const assistantRouter = require('../../src/routes/assistant');
const { authenticate, requireCompanyAccess } = require('../../src/middleware/keycloakAuth');

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/assistant', authenticate, requireCompanyAccess, assistantRouter);
    return app;
}

function postChat(body = { history: [], message: 'How do I connect Stripe?' }, authenticated = true) {
    let pending = request(makeApp()).post('/api/assistant/chat').send(body);
    if (authenticated) pending = pending.set('Authorization', 'Bearer valid-token');
    return pending;
}

function flushImmediate() {
    return new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockDecoded = {
        sub: 'keycloak-subject',
        email: USER_EMAIL,
        name: 'Assistant User',
        realm_access: { roles: ['company_member'] },
    };
    mockCrmUser = {
        id: CRM_USER_ID,
        company_id: COMPANY_A,
        email: USER_EMAIL,
    };
    mockAuthz = {
        scope: 'tenant',
        platform_role: 'none',
        company: { id: COMPANY_A, name: 'Company A' },
        membership: { role_key: 'dispatcher' },
        permissions: ['pulse.view'],
    };
    mockChat.mockResolvedValue({
        reply: 'Open Integrations and select Stripe Payments.',
        escalate: false,
    });
    mockConsumeChatTelemetry.mockReturnValue({
        model: 'gemini-2.5-flash',
        latency_ms: 125,
        token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    });
    mockDbQuery.mockResolvedValue({ rows: [] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) restoreEnv(name, value);
});

describe('POST /api/assistant/chat', () => {
    test('returns the public chat contract and uses the authenticated company', async () => {
        const response = await postChat({
            history: [{ role: 'assistant', text: 'What would you like to configure?' }],
            message: '  Connect Stripe for me.  ',
            company_id: COMPANY_B,
        });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            reply: 'Open Integrations and select Stripe Payments.',
            escalate: false,
        });
        expect(mockChat).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            history: [{ role: 'assistant', text: 'What would you like to configure?' }],
            message: 'Connect Stripe for me.',
        });
        expect(mockChat.mock.calls[0][0].companyId).not.toBe(COMPANY_B);
        await flushImmediate();
    });

    test('persists two identity-free rows after responding with a generated session key', async () => {
        const response = await postChat();
        expect(response.status).toBe(200);
        await flushImmediate();

        expect(mockDbQuery).toHaveBeenCalledTimes(1);
        const [sql, values] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO assistant_transcripts/);
        expect(sql).toContain('(session_key, turn_index, role, text, tools_used, model, latency_ms, token_usage)');
        expect(sql).not.toMatch(/company_id|user_id|user_email/i);
        expect(values[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(sql).toContain('COALESCE(MAX(turn_index) + 1, 0)');
        expect(JSON.parse(values[2])).toEqual([]);
        expect(JSON.parse(values[6])).toEqual({
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
        });
        for (const identity of [COMPANY_A, COMPANY_B, CRM_USER_ID, USER_EMAIL, mockDecoded.sub]) {
            expect(values).not.toContain(identity);
        }
    });

    test('continues turn indexes for a provided session key', async () => {
        const response = await postChat({
            session_key: 'assistant_session-123',
            history: [
                { role: 'user', text: 'First question' },
                { role: 'assistant', text: 'First answer' },
            ],
            message: 'Second question',
        });
        expect(response.status).toBe(200);
        await flushImmediate();

        const [sql, values] = mockDbQuery.mock.calls[0];
        expect(values[0]).toBe('assistant_session-123');
        expect(sql).toContain('WHERE session_key = $1');
        expect(sql).toContain("user_turn_index + 1, 'assistant'");
    });

    test('does not wait for best-effort transcript persistence', async () => {
        let finishWrite;
        mockDbQuery.mockReturnValue(new Promise(resolve => { finishWrite = resolve; }));

        const response = await postChat();

        expect(response.status).toBe(200);
        await flushImmediate();
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
        finishWrite({ rows: [] });
        await flushImmediate();
    });

    test.each([
        [{ message: 'missing history' }, 'missing history'],
        [{ history: 'not-an-array', message: 'x' }, 'non-array history'],
        [{ history: Array.from({ length: 13 }, () => ({ role: 'user', text: 'x' })), message: 'x' }, 'too many turns'],
        [{ history: [{ role: 'system', text: 'x' }], message: 'x' }, 'invalid role'],
        [{ history: [{ role: 'user', text: ' ' }], message: 'x' }, 'empty history text'],
        [{ history: [], message: ' ' }, 'empty message'],
        [{ history: [], message: 'x'.repeat(4001) }, 'long message'],
        [{ history: [], message: 'x', session_key: 'bad key!' }, 'invalid session key'],
        [{ history: [], message: 'x', session_key: 'x'.repeat(129) }, 'long session key'],
    ])('returns 400 for %s (%s)', async (body) => {
        const response = await postChat(body);

        expect(response.status).toBe(400);
        expect(mockChat).not.toHaveBeenCalled();
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('maps a per-company limit to friendly 429 escalation', async () => {
        mockChat.mockRejectedValueOnce(Object.assign(new Error('limit'), { status: 429 }));

        const response = await postChat();

        expect(response.status).toBe(429);
        expect(response.body.escalate).toBe(true);
        expect(response.body.reply).toContain('assistant limit');
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('maps provider failure to friendly 503 escalation', async () => {
        mockChat.mockRejectedValueOnce(Object.assign(new Error('provider down'), { status: 503 }));

        const response = await postChat();

        expect(response.status).toBe(503);
        expect(response.body.escalate).toBe(true);
        expect(response.body.reply).toContain('hand this to a person');
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('returns 401 without a bearer token', async () => {
        const response = await postChat(undefined, false);

        expect(response.status).toBe(401);
        expect(mockChat).not.toHaveBeenCalled();
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('returns 403 when the authenticated user lacks company membership', async () => {
        mockAuthz = {
            scope: null,
            platform_role: 'none',
            company: null,
            membership: null,
            permissions: [],
        };

        const response = await postChat();

        expect(response.status).toBe(403);
        expect(mockChat).not.toHaveBeenCalled();
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('effective-permission deny blocks chat before assistant data access', async () => {
        mockAuthz.permissions = [];
        mockAuthz.membership = { role_key: 'custom_no_pulse' };

        const response = await postChat();

        expect(response.status).toBe(403);
        expect(mockChat).not.toHaveBeenCalled();
        expect(mockDbQuery).not.toHaveBeenCalled();
    });
});

describe('server mount', () => {
    test('mounts assistant with authenticate then requireCompanyAccess after feedback', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../../src/server.js'), 'utf8');
        const feedback = "app.use('/api/feedback', authenticate, requireCompanyAccess, require('../backend/src/routes/feedback'));";
        const assistant = "app.use('/api/assistant', authenticate, requireCompanyAccess, require('../backend/src/routes/assistant'));";

        expect(source.match(/app\.use\('\/api\/assistant'/g)).toHaveLength(1);
        expect(source.indexOf(assistant)).toBeGreaterThan(source.indexOf(feedback));
    });
});
