const EventEmitter = require('events');
const express = require('express');
const request = require('supertest');

const mockAddClient = jest.fn((req, res) => res.status(200).json({
    company_id: req.companyFilter?.company_id,
}));

jest.mock('../backend/src/services/realtimeService', () => ({
    addClient: mockAddClient,
    getStats: jest.fn(() => ({})),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (req, _res, next) => {
        req.user = { sub: 'sse-user', crmUser: { id: 'crm-user' } };
        req.authz = {
            company: req.headers['x-company'] ? { id: req.headers['x-company'] } : null,
            membership: { role_key: req.headers['x-role'] || 'dispatcher' },
            permissions: String(req.headers['x-permissions'] || '').split(',').filter(Boolean),
        };
        next();
    },
    requireCompanyAccess: (req, res, next) => {
        const companyId = req.authz?.company?.id;
        if (!companyId) return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED' });
        req.companyFilter = { company_id: companyId };
        return next();
    },
}));

const eventsRouter = require('../backend/src/routes/events');
const actualRealtimeService = jest.requireActual('../backend/src/services/realtimeService');

function makeApp() {
    const app = express();
    app.use('/events', eventsRouter);
    return app;
}

function fakeConnection(companyId) {
    const req = new EventEmitter();
    req.ip = '127.0.0.1';
    req.companyFilter = { company_id: companyId };
    const chunks = [];
    const res = {
        writeHead: jest.fn(),
        write: jest.fn(chunk => { chunks.push(chunk); return true; }),
        end: jest.fn(),
        chunks,
    };
    return { req, res };
}

afterAll(() => {
    for (const connectionId of [...actualRealtimeService.clients.keys()]) {
        actualRealtimeService.removeClient(connectionId);
    }
    actualRealtimeService.stopKeepAlive();
});

describe('GET /events/calls Wave 2 RBAC', () => {
    beforeEach(() => jest.clearAllMocks());

    test('dispatcher with seeded pulse.view can establish the stream', async () => {
        const res = await request(makeApp())
            .get('/events/calls')
            .set('x-company', 'company-a')
            .set('x-role', 'dispatcher')
            .set('x-permissions', 'pulse.view');

        expect(res.status).toBe(200);
        expect(mockAddClient).toHaveBeenCalledTimes(1);
        expect(res.body.company_id).toBe('company-a');
    });

    test('effective-permission deny blocks the handshake', async () => {
        const res = await request(makeApp())
            .get('/events/calls')
            .set('x-company', 'company-a')
            .set('x-role', 'custom_no_pulse');

        expect(res.status).toBe(403);
        expect(mockAddClient).not.toHaveBeenCalled();
    });

    test('company membership is required before the permission gate', async () => {
        const res = await request(makeApp())
            .get('/events/calls')
            .set('x-permissions', 'pulse.view');

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(mockAddClient).not.toHaveBeenCalled();
    });
});

describe('SSE company-filtered delivery', () => {
    test('T-blast: a company A call event is never written to company B', () => {
        const a = fakeConnection('company-a');
        const b = fakeConnection('company-b');
        actualRealtimeService.addClient(a.req, a.res);
        actualRealtimeService.addClient(b.req, b.res);
        a.res.write.mockClear();
        b.res.write.mockClear();
        a.res.chunks.length = 0;
        b.res.chunks.length = 0;

        const result = actualRealtimeService.publishCallUpdate({
            eventType: 'call.updated',
            company_id: 'company-a',
            call_sid: 'CA-shared-natural-key',
            status: 'completed',
        });

        expect(result).toBeUndefined();
        expect(a.res.chunks.join('')).toContain('CA-shared-natural-key');
        expect(b.res.chunks.join('')).toBe('');
    });

    test('message, conversation, delivery, and job publishers retain scoped delivery', () => {
        const clients = [...actualRealtimeService.clients.values()];
        const a = clients.find(client => client.companyId === 'company-a');
        const b = clients.find(client => client.companyId === 'company-b');
        const cases = [
            () => actualRealtimeService.publishMessageAdded(
                { id: 'message-b', company_id: 'company-b' }, { id: 'conversation-b' }, 10
            ),
            () => actualRealtimeService.publishMessageDelivery(
                'message-sid-b', 'delivered', null, 'company-b'
            ),
            () => actualRealtimeService.publishConversationUpdate({
                id: 'conversation-b', company_id: 'company-b',
            }),
            () => actualRealtimeService.publishJobUpdate({
                id: 'job-b', company_id: 'company-b',
            }),
        ];

        for (const publish of cases) {
            a.res.chunks.length = 0;
            b.res.chunks.length = 0;
            publish();
            expect(a.res.chunks.join('')).toBe('');
            expect(b.res.chunks.join('')).toContain('company-b');
        }
    });

    test('unscoped events fail closed instead of broadcasting process-wide', () => {
        const clients = [...actualRealtimeService.clients.values()];
        clients.forEach(client => client.res.write.mockClear());

        const result = actualRealtimeService.broadcast('call.updated', { call_sid: 'CA-unscoped' });

        expect(result).toEqual({ sent: 0, failed: 0 });
        clients.forEach(client => expect(client.res.write).not.toHaveBeenCalled());
    });
});
