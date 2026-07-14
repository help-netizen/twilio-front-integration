/**
 * RATE-ME-CRM-002 — jobs-surface rating-link delivery and attribution status.
 *
 * Mirrors tests/jobsEta.test.js: a tiny HTTP helper mounts the real jobs router,
 * while service boundaries are mocked and requirePermission runs for real.
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

function request(app, method, requestPath, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: server.address().port,
                path: requestPath,
                method: method.toUpperCase(),
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let parsed = data;
                    try { parsed = JSON.parse(data); } catch (_) { /* keep raw body */ }
                    server.close();
                    resolve({ status: res.statusCode, body: parsed });
                });
            });
            req.on('error', (error) => {
                server.close();
                reject(error);
            });
            if (body != null) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

const mockGetJobById = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: mockGetJobById,
}));

const mockGetOrCreateConversation = jest.fn();
const mockSendMessage = jest.fn();
jest.mock('../backend/src/services/conversationsService', () => ({
    getOrCreateConversation: mockGetOrCreateConversation,
    sendMessage: mockSendMessage,
}));

const mockSendEmail = jest.fn();
jest.mock('../backend/src/services/emailService', () => ({
    sendEmail: mockSendEmail,
}));

const mockMintToken = jest.fn();
jest.mock('../backend/src/services/rateMeService', () => {
    class RateMeServiceError extends Error {
        constructor(message, code, httpStatus = 400) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return { mintToken: mockMintToken, RateMeServiceError };
});

const mockStampTokenSent = jest.fn();
const mockGetJobRateStatus = jest.fn();
jest.mock('../backend/src/db/rateMeQueries', () => ({
    stampTokenSent: mockStampTokenSent,
    getJobRateStatus: mockGetJobRateStatus,
}));

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));

// Cheap require-time stubs for unrelated jobs-router dependencies.
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1,
    MAX_FILES_PER_NOTE: 1,
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
    actorName: jest.fn(),
    getEntityHistory: jest.fn(),
}));
jest.mock('../backend/src/services/routeDistanceService', () => ({ computePair: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));
jest.mock('../backend/src/db/companyQueries', () => ({ getCompanyById: jest.fn() }));
jest.mock('../backend/src/services/stripePaymentsService', () => ({
    StripePaymentsError: class extends Error {},
}));

const jobsRouter = require('../backend/src/routes/jobs');
const rateMeService = require('../backend/src/services/rateMeService');

const COMPANY_X = '00000000-0000-0000-0000-00000000000a';
const COMPANY_Y = '00000000-0000-0000-0000-00000000000b';
const TOKEN = 'Xtok_xxxxxxxxxxxxxxxxxxxxxxxxxxx';
const RATE_URL = `https://rate.albusto.com/r/${TOKEN}`;
const SENT_AT = '2026-07-14T15:00:00.000Z';
const ORIGINAL_SOFTPHONE_CALLER_ID = process.env.SOFTPHONE_CALLER_ID;

const HAPPY_JOB = {
    id: 41,
    company_id: COMPANY_X,
    customer_phone: '(617) 555-1234',
    customer_email: 'sarah@example.com',
    assigned_techs: [{ id: 'zb-77', name: 'Alex Petrov' }],
};

const EMPTY_STATUS = {
    has_token: false,
    sent_at: null,
    sent_via: null,
    opened_at: null,
    google_click_at: null,
    rating: null,
};

function routeApp({
    permissions = ['messages.send', 'jobs.view'],
    companyFilter = { company_id: COMPANY_X },
} = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'u@x.com', crmUser: { id: 'crm-user-1' } };
        req.authz = { scope: 'tenant', permissions, scopes: {} };
        req.companyFilter = companyFilter;
        req.companyId = 'LEGACY-DO-NOT-USE';
        next();
    });
    app.use('/', jobsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetJobById.mockResolvedValue({ ...HAPPY_JOB });
    mockMintToken.mockResolvedValue({ token: TOKEN, url: RATE_URL });
    mockStampTokenSent.mockResolvedValue({ sent_at: SENT_AT });
    mockGetJobRateStatus.mockResolvedValue({ ...EMPTY_STATUS });
    mockDbQuery.mockResolvedValue({ rows: [{ proxy_e164: '+16175550000' }] });
    mockGetOrCreateConversation.mockResolvedValue({ id: 'conv-1' });
    mockSendMessage.mockResolvedValue(undefined);
    mockSendEmail.mockResolvedValue(undefined);
    process.env.SOFTPHONE_CALLER_ID = '+16175557777';
});

afterAll(() => {
    if (ORIGINAL_SOFTPHONE_CALLER_ID === undefined) delete process.env.SOFTPHONE_CALLER_ID;
    else process.env.SOFTPHONE_CALLER_ID = ORIGINAL_SOFTPHONE_CALLER_ID;
});

describe('POST /api/jobs/:id/rate-link', () => {
    test('TC-RM2-SL-01: copy returns the URL and stamps the token', async () => {
        const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'copy' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            data: { channel: 'copy', sent_at: SENT_AT, url: RATE_URL },
        });
        expect(mockGetJobById).toHaveBeenCalledWith(
            41,
            COMPANY_X,
            { assignedOnly: false, userId: null }
        );
        expect(mockMintToken).toHaveBeenCalledWith(COMPANY_X, {
            jobId: 41,
            techId: 'zb-77',
            techName: 'Alex Petrov',
        });
        expect(mockStampTokenSent).toHaveBeenCalledWith(TOKEN, COMPANY_X, 'copy');
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('TC-RM2-SL-02: SMS follows the ETA chain, omits URL, and stamps after send', async () => {
        const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'sms' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { channel: 'sms', sent_at: SENT_AT } });
        expect(res.body.data).not.toHaveProperty('url');
        expect(mockGetOrCreateConversation).toHaveBeenCalledWith(
            '+16175551234',
            '+16175550000',
            COMPANY_X
        );
        expect(mockSendMessage).toHaveBeenCalledWith('conv-1', {
            body: expect.stringContaining(RATE_URL),
            author: 'agent',
        });
        expect(mockStampTokenSent).toHaveBeenCalledWith(TOKEN, COMPANY_X, 'sms');
        expect(mockMintToken.mock.invocationCallOrder[0])
            .toBeLessThan(mockSendMessage.mock.invocationCallOrder[0]);
        expect(mockSendMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mockStampTokenSent.mock.invocationCallOrder[0]);
    });

    test.each([null, 'not-a-phone'])(
        'TC-RM2-SL-03: missing/unusable phone %p returns NO_PHONE without a stamp',
        async (customerPhone) => {
            mockGetJobById.mockResolvedValue({ ...HAPPY_JOB, customer_phone: customerPhone });

            const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'sms' });

            expect(res.status).toBe(422);
            expect(res.body).toEqual({
                ok: false,
                code: 'NO_PHONE',
                message: 'No phone number on file for this customer.',
            });
            expect(mockSendMessage).not.toHaveBeenCalled();
            expect(mockStampTokenSent).not.toHaveBeenCalled();
        }
    );

    test('TC-RM2-SL-03: missing company proxy returns NO_PROXY without a stamp', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });
        delete process.env.SOFTPHONE_CALLER_ID;

        const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'sms' });

        expect(res.status).toBe(422);
        expect(res.body).toEqual({
            ok: false,
            code: 'NO_PROXY',
            message: 'No sending number configured for your company.',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockStampTokenSent).not.toHaveBeenCalled();
    });

    test.each([
        [
            'wallet blocked',
            Object.assign(new Error('blocked'), { code: 'WALLET_BLOCKED', httpStatus: 402 }),
            402,
            'WALLET_BLOCKED',
            'Messaging is paused — top up your balance.',
        ],
        [
            'transport error',
            new Error('twilio failed'),
            502,
            'SMS_FAILED',
            "Couldn't send the message. Please try again.",
        ],
    ])(
        'TC-RM2-SL-04: %s does not produce a false sent stamp',
        async (_label, error, status, code, message) => {
            mockSendMessage.mockRejectedValue(error);

            const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'sms' });

            expect(res.status).toBe(status);
            expect(res.body).toEqual({ ok: false, code, message });
            expect(mockStampTokenSent).not.toHaveBeenCalled();
        }
    );

    test('TC-RM2-SL-05: email uses the CRM user id, omits URL, and stamps success', async () => {
        const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'email' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { channel: 'email', sent_at: SENT_AT } });
        expect(res.body.data).not.toHaveProperty('url');
        expect(mockSendEmail).toHaveBeenCalledWith(COMPANY_X, {
            to: 'sarah@example.com',
            subject: expect.any(String),
            body: expect.stringContaining(RATE_URL),
            userId: 'crm-user-1',
        });
        expect(mockStampTokenSent).toHaveBeenCalledWith(TOKEN, COMPANY_X, 'email');
        expect(mockSendEmail.mock.invocationCallOrder[0])
            .toBeLessThan(mockStampTokenSent.mock.invocationCallOrder[0]);
    });

    test('TC-RM2-SL-06: missing email returns NO_EMAIL without calling the mailer', async () => {
        mockGetJobById.mockResolvedValue({ ...HAPPY_JOB, customer_email: null });

        const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'email' });

        expect(res.status).toBe(422);
        expect(res.body).toEqual({
            ok: false,
            code: 'NO_EMAIL',
            message: 'No email on file for this customer.',
        });
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockStampTokenSent).not.toHaveBeenCalled();
    });

    test('TC-RM2-SL-06: disconnected mailbox returns MAIL_DISCONNECTED without a stamp', async () => {
        mockSendEmail.mockRejectedValue(
            Object.assign(new Error('Mailbox requires reconnection'), { statusCode: 409 })
        );

        const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'email' });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            ok: false,
            code: 'MAIL_DISCONNECTED',
            message: 'Connect a mailbox to send email.',
        });
        expect(mockStampTokenSent).not.toHaveBeenCalled();
    });

    test('TC-RM2-SL-07: real messages.send gate returns 403 before the handler', async () => {
        const res = await request(
            routeApp({ permissions: [] }),
            'POST',
            '/41/rate-link',
            { channel: 'copy' }
        );

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockGetJobById).not.toHaveBeenCalled();
        expect(mockMintToken).not.toHaveBeenCalled();
    });

    test('TC-RM2-SL-08: a foreign job is a tenant-scoped 404 with no side effects', async () => {
        mockGetJobById.mockResolvedValue(null);

        const res = await request(routeApp(), 'POST', '/942/rate-link', { channel: 'sms' });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ ok: false, code: 'JOB_NOT_FOUND', message: 'Job not found' });
        expect(mockGetJobById).toHaveBeenCalledWith(
            942,
            COMPANY_X,
            { assignedOnly: false, userId: null }
        );
        expect(mockMintToken).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockStampTokenSent).not.toHaveBeenCalled();
    });

    test('TC-RM2-SL-09: disconnected Rate Me app returns APP_NOT_INSTALLED', async () => {
        mockMintToken.mockRejectedValue(new rateMeService.RateMeServiceError(
            'Marketplace app is not installed.',
            'APP_NOT_INSTALLED',
            404
        ));

        const res = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'copy' });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            ok: false,
            code: 'APP_NOT_INSTALLED',
            message: 'Marketplace app is not installed.',
        });
        expect(mockStampTokenSent).not.toHaveBeenCalled();
    });

    test.each([{ channel: 'fax' }, {}])(
        'TC-RM2-SL-10: invalid/missing channel is rejected before job load and mint (%p)',
        async (body) => {
            const res = await request(routeApp(), 'POST', '/41/rate-link', body);

            expect(res.status).toBe(400);
            expect(res.body).toEqual({
                ok: false,
                code: 'INVALID_CHANNEL',
                message: 'Channel must be one of: sms, email, copy.',
            });
            expect(mockGetJobById).not.toHaveBeenCalled();
            expect(mockMintToken).not.toHaveBeenCalled();
        }
    );

    test('TC-RM2-SL-11: consecutive sends mint fresh tokens and stamp each company-scoped token', async () => {
        const tokenOne = 'token_one_xxxxxxxxxxxxxxxxxxxxxxx';
        const tokenTwo = 'token_two_xxxxxxxxxxxxxxxxxxxxxxx';
        mockMintToken
            .mockResolvedValueOnce({ token: tokenOne, url: `https://rate.albusto.com/r/${tokenOne}` })
            .mockResolvedValueOnce({ token: tokenTwo, url: `https://rate.albusto.com/r/${tokenTwo}` });
        mockStampTokenSent
            .mockResolvedValueOnce({ sent_at: '2026-07-14T15:00:00.000Z' })
            .mockResolvedValueOnce({ sent_at: '2026-07-14T15:01:00.000Z' });

        const first = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'copy' });
        const second = await request(routeApp(), 'POST', '/41/rate-link', { channel: 'copy' });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body.data.sent_at).toBe('2026-07-14T15:01:00.000Z');
        expect(mockMintToken).toHaveBeenCalledTimes(2);
        expect(mockMintToken).toHaveBeenNthCalledWith(1, COMPANY_X, {
            jobId: 41,
            techId: 'zb-77',
            techName: 'Alex Petrov',
        });
        expect(mockMintToken).toHaveBeenNthCalledWith(2, COMPANY_X, {
            jobId: 41,
            techId: 'zb-77',
            techName: 'Alex Petrov',
        });
        expect(mockStampTokenSent).toHaveBeenNthCalledWith(1, tokenOne, COMPANY_X, 'copy');
        expect(mockStampTokenSent).toHaveBeenNthCalledWith(2, tokenTwo, COMPANY_X, 'copy');
        expect(mockMintToken.mock.invocationCallOrder[0])
            .toBeLessThan(mockStampTokenSent.mock.invocationCallOrder[0]);
        expect(mockMintToken.mock.invocationCallOrder[1])
            .toBeLessThan(mockStampTokenSent.mock.invocationCallOrder[1]);
    });
});

describe('GET /api/jobs/:id/rate-status', () => {
    test('TC-RM2-JS-01: full timeline is returned in the jobs envelope', async () => {
        const status = {
            has_token: true,
            sent_at: '2026-07-14T15:00:00.000Z',
            sent_via: 'sms',
            opened_at: '2026-07-14T15:05:00.000Z',
            google_click_at: '2026-07-14T15:07:00.000Z',
            rating: { stars: 5, created_at: '2026-07-14T15:06:00.000Z' },
        };
        mockGetJobRateStatus.mockResolvedValue(status);

        const res = await request(routeApp(), 'GET', '/41/rate-status');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: status });
        expect(mockGetJobRateStatus).toHaveBeenCalledWith(COMPANY_X, 41);
    });

    test('TC-RM2-JS-02: no token and no rating returns the complete null aggregate', async () => {
        const res = await request(routeApp(), 'GET', '/41/rate-status');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: EMPTY_STATUS });
    });

    test('TC-RM2-JS-03: sent-only status preserves null opened/click/rating fields', async () => {
        const status = {
            has_token: true,
            sent_at: SENT_AT,
            sent_via: 'copy',
            opened_at: null,
            google_click_at: null,
            rating: null,
        };
        mockGetJobRateStatus.mockResolvedValue(status);

        const res = await request(routeApp(), 'GET', '/41/rate-status');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: status });
    });

    test('TC-RM2-JS-04: real jobs.view gate returns 403 before the status query', async () => {
        const res = await request(
            routeApp({ permissions: [] }),
            'GET',
            '/41/rate-status'
        );

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockGetJobRateStatus).not.toHaveBeenCalled();
    });

    test('TC-RM2-JS-05: foreign-company job status is empty and cannot leak attribution', async () => {
        mockGetJobRateStatus.mockImplementation(async (companyId) => (
            companyId === COMPANY_X
                ? { ...EMPTY_STATUS }
                : {
                    has_token: true,
                    sent_at: 'COMPANY-Y-SENT',
                    sent_via: 'sms',
                    opened_at: 'COMPANY-Y-OPENED',
                    google_click_at: null,
                    rating: { stars: 1, created_at: 'COMPANY-Y-RATING' },
                }
        ));

        const res = await request(routeApp(), 'GET', '/942/rate-status');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: EMPTY_STATUS });
        expect(mockGetJobRateStatus).toHaveBeenCalledWith(COMPANY_X, 942);
        expect(JSON.stringify(res.body)).not.toContain(COMPANY_Y);
        expect(JSON.stringify(res.body)).not.toContain('COMPANY-Y');
    });

    test('TC-RM2-JS-06: a rating survives a fresh re-send while events come from the new token', async () => {
        const app = routeApp();
        const resend = await request(app, 'POST', '/41/rate-link', { channel: 'copy' });
        expect(resend.status).toBe(200);

        const newestTokenStatus = {
            has_token: true,
            sent_at: '2026-07-14T16:00:00.000Z',
            sent_via: 'copy',
            opened_at: null,
            google_click_at: null,
            rating: { stars: 4, created_at: '2026-07-13T13:00:00.000Z' },
        };
        mockGetJobRateStatus.mockResolvedValue(newestTokenStatus);

        const res = await request(app, 'GET', '/41/rate-status');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: newestTokenStatus });
        expect(res.body.data.rating).toEqual({
            stars: 4,
            created_at: '2026-07-13T13:00:00.000Z',
        });
        expect(res.body.data.sent_at).toBe('2026-07-14T16:00:00.000Z');
        expect(mockGetJobRateStatus).toHaveBeenCalledWith(COMPANY_X, 41);
    });
});

test('TC-RM2-ST-01: jobs routes retain authenticated mount, company scope, gates, and jobs envelopes', () => {
    const root = path.resolve(__dirname, '..');
    const jobsSource = fs.readFileSync(path.join(root, 'backend/src/routes/jobs.js'), 'utf8');
    const serverSource = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
    const rateLinkStart = jobsSource.indexOf("router.post('/:id/rate-link'");
    const rateStatusStart = jobsSource.indexOf("router.get('/:id/rate-status'");
    const paymentsStart = jobsSource.indexOf('// F018 Stripe Payments', rateStatusStart);
    const rateLinkSource = jobsSource.slice(rateLinkStart, rateStatusStart);
    const rateStatusSource = jobsSource.slice(rateStatusStart, paymentsStart);

    expect(rateLinkStart).toBeGreaterThan(-1);
    expect(rateStatusStart).toBeGreaterThan(rateLinkStart);
    expect(rateLinkSource).toContain("requirePermission('messages.send')");
    expect(rateStatusSource).toContain("requirePermission('jobs.view')");
    expect(rateLinkSource).toContain('req.companyFilter?.company_id');
    expect(rateStatusSource).toContain('req.companyFilter?.company_id');
    expect(rateLinkSource).not.toContain('req.companyId');
    expect(rateStatusSource).not.toContain('req.companyId');
    expect(rateLinkSource).not.toContain('req.user.company_id');
    expect(rateStatusSource).not.toContain('req.user.company_id');
    expect(rateLinkSource).toContain('res.json({ ok: true, data })');
    expect(rateStatusSource).toContain('res.json({ ok: true, data })');
    expect(rateLinkSource).not.toContain('request_id');
    expect(rateStatusSource).not.toContain('request_id');

    // This untouched mount owns authenticate (401) + company access; the harness
    // intentionally drives only the route-level 403 permissions.
    expect(serverSource).toContain(
        "app.use('/api/jobs', authenticate, requireCompanyAccess, localJobsRouter);"
    );
    expect(serverSource).not.toContain('RATE-ME-CRM-002');
});
