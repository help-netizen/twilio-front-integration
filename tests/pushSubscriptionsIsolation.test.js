'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('web-push', () => ({
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const webpush = require('web-push');
const router = require('../backend/src/routes/push-subscriptions');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const USER_A = '10000000-0000-4000-8000-00000000000a';
const SUB_A = '30000000-0000-4000-8000-00000000000a';
const SHARED_ENDPOINT = 'https://push.example/shared-natural-key';

function makeApp({ companyId = COMPANY_A, userId = USER_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = { crmUser: userId ? { id: userId } : null };
        next();
    });
    app.use('/', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    process.env.VAPID_PUBLIC_KEY = 'public';
    process.env.VAPID_PRIVATE_KEY = 'private';
});

describe('push subscription tenant/user isolation', () => {
    test('POST upserts the full company/user/endpoint tuple without owner reassignment', async () => {
        const response = await request(makeApp()).post('/').send({
            endpoint: SHARED_ENDPOINT,
            keys: { p256dh: 'p256dh', auth: 'auth' },
        });
        expect(response.status).toBe(200);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('ON CONFLICT (company_id, user_id, endpoint)');
        expect(sql).not.toMatch(/DO UPDATE SET\s+company_id/i);
        expect(sql).not.toMatch(/DO UPDATE SET[\s\S]*user_id\s*=/i);
        expect(params.slice(0, 3)).toEqual([COMPANY_A, USER_A, SHARED_ENDPOINT]);
    });

    test('DELETE includes company, user, and endpoint in the mutation key', async () => {
        const response = await request(makeApp()).delete('/').send({ endpoint: SHARED_ENDPOINT });
        expect(response.status).toBe(200);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/company_id = \$1 AND user_id = \$2 AND endpoint = \$3/);
        expect(params).toEqual([COMPANY_A, USER_A, SHARED_ENDPOINT]);
    });

    test('expired test subscription is deactivated by row id plus tenant/user', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: SUB_A, endpoint: SHARED_ENDPOINT, p256dh: 'p', auth: 'a' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        webpush.sendNotification.mockRejectedValue({ statusCode: 410 });

        const response = await request(makeApp()).post('/test').send({});
        expect(response.status).toBe(200);
        expect(response.body.failed).toBe(1);
        const [sql, params] = db.query.mock.calls[1];
        expect(sql).toMatch(/id = \$1 AND company_id = \$2 AND user_id = \$3/);
        expect(params).toEqual([SUB_A, COMPANY_A, USER_A]);
    });

    test.each(['GET /status', 'POST /', 'DELETE /', 'POST /test'])(
        '%s fails closed without company context',
        async label => {
            const [method, path] = label.split(' ');
            let call = request(makeApp({ companyId: null }))[method.toLowerCase()](path);
            if (method !== 'GET') call = call.send(method === 'DELETE' ? { endpoint: SHARED_ENDPOINT } : {});
            const response = await call;
            expect(response.status).toBe(403);
            expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
            expect(db.query).not.toHaveBeenCalled();
        }
    );
});

