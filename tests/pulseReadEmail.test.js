'use strict';

const mockDbQuery = jest.fn();
const mockMarkTimelineRead = jest.fn();
const mockMarkContactRead = jest.fn();
const mockBroadcast = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));
jest.mock('../backend/src/db/queries', () => ({
    markTimelineRead: (...args) => mockMarkTimelineRead(...args),
    markContactRead: (...args) => mockMarkContactRead(...args),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/callSummaryService', () => ({ generateCallSummary: jest.fn() }));
jest.mock('../backend/src/services/operationsDashboard', () => ({ getOperationsDashboard: jest.fn() }));
jest.mock('../backend/src/services/agentPresence', () => ({}));
jest.mock('../backend/src/services/twilioClient', () => ({ getTwilioClient: jest.fn() }));
jest.mock('../backend/src/services/realtimeService', () => ({
    broadcast: (...args) => mockBroadcast(...args),
}));

const express = require('express');
const request = require('supertest');
const emailQueries = require('../backend/src/db/emailQueries');
const callsRouter = require('../backend/src/routes/calls');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const FOREIGN_COMPANY = '00000000-0000-0000-0000-00000000000b';

function makeApp(companyId = COMPANY_A) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'dispatcher@example.com', crmUser: { id: 'user-1' } };
        req.authz = {
            scope: 'tenant',
            permissions: ['pulse.view'],
            scopes: {},
            membership: { role_key: 'manager' },
        };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/calls', callsRouter);
    return app;
}

describe('emailQueries.markContactEmailThreadsRead', () => {
    beforeEach(() => mockDbQuery.mockReset());

    test('bulk update mirrors both Pulse email attribution legs and returns the update count', async () => {
        mockDbQuery.mockResolvedValueOnce({ rowCount: 2 });

        await expect(emailQueries.markContactEmailThreadsRead(42, COMPANY_A)).resolves.toBe(2);

        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(params).toEqual([42, COMPANY_A]);
        expect(sql).toContain('UPDATE email_threads et');
        expect(sql).toContain('et.company_id = $2');
        expect(sql).toContain('et.unread_count > 0');
        expect(sql).toContain('c.id = $1 AND c.company_id = $2');
        expect(sql).toContain('ce.email_normalized = lower(trim(em.from_email))');
        expect(sql).toContain("em.direction = 'inbound'");
        expect(sql).toContain('UNION ALL');
        expect(sql).toContain("em.direction = 'outbound'");
        expect(sql).toContain('em.contact_id = $1');
        expect(sql).toContain('em.on_timeline = true');
        expect((sql.match(/em\.company_id = \$2/g) || [])).toHaveLength(2);
        expect(sql).not.toContain(COMPANY_A);
    });
});

describe('POST /api/calls/timeline/:timelineId/mark-read', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDbQuery.mockResolvedValue({ rows: [] });
        mockMarkTimelineRead.mockResolvedValue({
            id: 77,
            company_id: FOREIGN_COMPANY,
            contact_id: 42,
            phone_e164: null,
        });
        mockMarkContactRead.mockResolvedValue({ id: 42 });
    });

    afterEach(() => jest.restoreAllMocks());

    test('clears linked email threads with the request-scoped company', async () => {
        const markEmailRead = jest.spyOn(emailQueries, 'markContactEmailThreadsRead')
            .mockResolvedValue(2);

        const res = await request(makeApp()).post('/api/calls/timeline/77/mark-read');

        expect(res.status).toBe(200);
        expect(mockMarkTimelineRead).toHaveBeenCalledWith(77);
        expect(markEmailRead).toHaveBeenCalledWith(42, COMPANY_A);
        expect(mockBroadcast).toHaveBeenCalledWith('timeline.read', { timelineId: 77 });
    });

    test('email mark-read failure is best-effort and never turns the endpoint into a 500', async () => {
        jest.spyOn(emailQueries, 'markContactEmailThreadsRead')
            .mockRejectedValue(new Error('email db unavailable'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await request(makeApp()).post('/api/calls/timeline/77/mark-read');

        expect(res.status).toBe(200);
        expect(warn).toHaveBeenCalledWith(
            '[mark-read] email thread mark-read failed:',
            'email db unavailable'
        );
        expect(mockBroadcast).toHaveBeenCalledWith('timeline.read', { timelineId: 77 });
    });
});
