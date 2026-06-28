/**
 * VAPI routes tests — F016
 * TC-F016-001..013 (subset implementable as unit/integration tests)
 */

const express = require('express');
const request = require('supertest');

// Mock node-fetch — vapi.js uses dynamic import('node-fetch').default
// We mock the whole module with a default export that is a jest.fn()
const mockFetch = jest.fn();
jest.mock('node-fetch', () => ({ default: mockFetch, __esModule: true }));

// Mock db
jest.mock('../../backend/src/db/connection', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() },
}));

const db = require('../../backend/src/db/connection');
const vapiRouter = require('../../backend/src/routes/vapi');

function makeApp() {
    const app = express();
    app.use(express.json());
    // Simulate authenticate + requireCompanyAccess middleware
    app.use((req, res, next) => {
        req.user = { id: 'user-1', company_id: 'company-1' };
        req.companyFilter = { company_id: 'company-1' };
        req.authz = { permissions: ['tenant.integrations.manage'] };
        next();
    });
    app.use('/api/vapi', vapiRouter);
    return app;
}

function makeUnauthApp() {
    const app = express();
    app.use(express.json());
    // No auth middleware — simulates unauthenticated request
    app.use('/api/vapi', vapiRouter);
    return app;
}

describe('GET /api/vapi/connections', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        app = makeApp();
        // ensureTables uses CREATE TABLE IF NOT EXISTS — always resolves ok
        db.query.mockResolvedValue({ rows: [] });
    });

    // TC-F016-013: returns connections list
    test('returns connections list', async () => {
        const conn = { id: 'conn-1', status: 'active', display_name: 'My Prod', environment: 'prod' };
        // last call is the SELECT query — return conn
        db.query.mockResolvedValue({ rows: [conn] });
        const res = await request(app).get('/api/vapi/connections');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
    });
});

describe('POST /api/vapi/connections', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        app = makeApp();
    });

    // TC-F016-011: missing api_key
    test('returns 400 when api_key missing', async () => {
        db.query.mockResolvedValue({ rows: [] }); // ensureTables
        const res = await request(app).post('/api/vapi/connections').send({});
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toContain('api_key');
    });

    // TC-F016-002: invalid Vapi API key
    test('returns 400 when Vapi API key is invalid', async () => {
        db.query.mockResolvedValue({ rows: [] });
        mockFetch.mockResolvedValue({ ok: false, status: 401 });

        const res = await request(app)
            .post('/api/vapi/connections')
            .send({ api_key: 'invalid-key-123', environment: 'prod' });

        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBeTruthy();
    });

    // TC-F016-003: Vapi API network error
    test('returns 400 when Vapi API is unreachable', async () => {
        db.query.mockResolvedValue({ rows: [] });
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = await request(app)
            .post('/api/vapi/connections')
            .send({ api_key: 'any-key', environment: 'prod' });

        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBeTruthy();
    });

    // TC-F016-001 (partial): successful connection creation — no key in response
    test('does not expose api_key in response on success', async () => {
        mockFetch.mockResolvedValue({ ok: true, status: 200 });
        const created = { id: 'conn_abc', status: 'active', display_name: 'Test', environment: 'prod', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        db.query
            .mockResolvedValue({ rows: [] })    // ensureTables (all CREATE queries)
            .mockResolvedValueOnce({ rows: [created] }); // SELECT after insert

        const res = await request(app)
            .post('/api/vapi/connections')
            .send({ api_key: 'vapi-valid-key', display_name: 'Test', environment: 'prod' });

        // API key must NOT appear in the response body
        expect(JSON.stringify(res.body)).not.toContain('vapi-valid-key');
    });
});

describe('POST /api/vapi/resources', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        app = makeApp();
    });

    // TC-F016-012: missing required fields
    test('returns 400 when provider_connection_id or sip_uri is missing', async () => {
        db.query.mockResolvedValue({ rows: [] });

        const res1 = await request(app)
            .post('/api/vapi/resources')
            .send({ sip_uri: 'sip:test@sip.vapi.ai' });
        expect(res1.status).toBe(400);
        expect(res1.body.ok).toBe(false);

        const res2 = await request(app)
            .post('/api/vapi/resources')
            .send({ provider_connection_id: 'conn-1' });
        expect(res2.status).toBe(400);
        expect(res2.body.ok).toBe(false);
    });
});

describe('vapi route mount — middleware check', () => {
    // TC-F016-009 / TC-F016-010: verify routes are mounted with auth
    test('server.js mounts /api/vapi with authenticate and requireCompanyAccess', () => {
        const fs = require('fs');
        const path = require('path');
        const serverSource = fs.readFileSync(
            path.join(__dirname, '../../src/server.js'),
            'utf8'
        );
        expect(serverSource).toContain("const vapiRouter = require('../backend/src/routes/vapi');");
        expect(serverSource).toMatch(/app\.use\(['"]\/api\/vapi['"],\s*authenticate.*requireCompanyAccess.*vapiRouter\)/);
    });
});
