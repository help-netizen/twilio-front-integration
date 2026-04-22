/**
 * F014 — Integrations Analytics Router tests.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../backend/src/services/analyticsService', () => {
    class AnalyticsServiceError extends Error {
        constructor(code, message, http = 400) { super(message); this.code = code; this.httpStatus = http; }
    }
    return {
        AnalyticsServiceError,
        getSummary: jest.fn(),
        listCalls: jest.fn(),
        listLeads: jest.fn(),
        listJobs: jest.fn(),
    };
});

jest.mock('../../backend/src/middleware/integrationsAuth', () => ({
    rejectLegacyAuth:       (req, res, next) => next(),
    validateHeaders:        (req, res, next) => next(),
    authenticateIntegration: (req, res, next) => {
        req.integrationScopes = req.headers['x-test-scopes']
            ? req.headers['x-test-scopes'].split(',') : ['analytics:read'];
        req.integrationCompanyId = '00000000-0000-0000-0000-000000000000';
        req.integrationKeyId = 'blanc_ana_test';
        next();
    },
}));
jest.mock('../../backend/src/middleware/rateLimiter',
    () => (req, res, next) => next());

const analytics = require('../../backend/src/services/analyticsService');
const router    = require('../../backend/src/routes/integrations-analytics');

function makeApp() {
    const app = express();
    app.use((req, res, next) => { req.requestId = 'req_test'; next(); });
    app.use('/api/v1/integrations', router);
    return app;
}

describe('GET /api/v1/integrations/analytics/summary', () => {
    let app;
    beforeEach(() => { jest.clearAllMocks(); app = makeApp(); });

    test('returns 200 with summary payload', async () => {
        analytics.getSummary.mockResolvedValue({
            period: { from: '2026-04-16', to: '2026-04-22', tz: 'America/New_York' },
            tracking_number: '+16176444408',
            calls: { total: 42, answered: 31, missed: 11 },
            leads: { created: 7 },
            jobs:  { from_period_leads: 4 },
            funnel: {},
        });
        const res = await request(app)
            .get('/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.calls.total).toBe(42);
        expect(analytics.getSummary).toHaveBeenCalledWith(expect.objectContaining({
            from: '2026-04-16', to: '2026-04-22',
            companyId: '00000000-0000-0000-0000-000000000000',
        }));
    });

    test('403 when scope missing', async () => {
        const res = await request(app)
            .get('/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22')
            .set('x-test-scopes', 'leads:create');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SCOPE_INSUFFICIENT');
    });

    test('400 passes through service validation error', async () => {
        analytics.getSummary.mockRejectedValue(
            new analytics.AnalyticsServiceError('PERIOD_REQUIRED', 'bad', 400));
        const res = await request(app)
            .get('/api/v1/integrations/analytics/summary?from=&to=');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PERIOD_REQUIRED');
    });

    test('500 on unexpected error', async () => {
        analytics.getSummary.mockRejectedValue(new Error('boom'));
        const res = await request(app)
            .get('/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22');
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('INTERNAL_ERROR');
    });
});

describe('list endpoints', () => {
    let app;
    beforeEach(() => { jest.clearAllMocks(); app = makeApp(); });

    test.each([
        ['calls', 'listCalls'],
        ['leads', 'listLeads'],
        ['jobs',  'listJobs'],
    ])('%s returns items + cursor', async (path, method) => {
        analytics[method].mockResolvedValue({ items: [{ id: 1 }], next_cursor: 'c_next' });
        const res = await request(app)
            .get(`/api/v1/integrations/analytics/${path}?from=2026-04-16&to=2026-04-22&limit=10`);
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.next_cursor).toBe('c_next');
    });
});
