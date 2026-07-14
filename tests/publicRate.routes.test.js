'use strict';

/**
 * RATE-ME-CRM-001 T3 — public rating routes + first-mounted host gate.
 *
 * The real router, service, and gate run together. Only query/storage/transaction
 * seams are mocked so host binding and body-identity isolation stay end-to-end.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const COMPANY_X = '00000000-0000-0000-0000-00000000a501';
const COMPANY_Y = '00000000-0000-0000-0000-00000000b502';
const COMPANY_D = '00000000-0000-0000-0000-00000000d504';
const TOKEN_X = 'Xtok_'.padEnd(32, 'x');
const TOKEN_Y = 'Ytok_'.padEnd(32, 'y');
const TOKEN_EXPIRED = 'Etok_'.padEnd(32, 'e');
const TOKEN_DISCONNECTED = 'Dtok_'.padEnd(32, 'd');
const TOKEN_UNKNOWN = 'Utok_'.padEnd(32, 'u');
const GOOGLE_URL = 'https://g.page/r/abc/review';

const UNIFORM_NOT_FOUND = {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Invalid link' },
};
const GATE_NOT_FOUND = {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Not found' },
};

let mockTokenRows;
let mockDomainRows;
let mockMetaByCompany;
let mockStoredRatings;
let mockObservedRateHosts;
let mockIpCounter = 0;

const mockGetTokenContext = jest.fn();
const mockGetConnectedRateMeMeta = jest.fn();
const mockGetServableDomain = jest.fn();
const mockInsertRating = jest.fn();
const mockStampTokenUsed = jest.fn();
const mockGetDomainByCompany = jest.fn();
const mockUpsertDomainForCompany = jest.fn();
const mockSetDomainStatus = jest.fn();
const mockDeleteDomain = jest.fn();
const mockGetPresignedUrl = jest.fn();
const mockWriteEvent = jest.fn();
const mockDbQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockGetClient = jest.fn();

jest.mock('../backend/src/db/rateMeQueries', () => ({
    getTokenContext: (...args) => mockGetTokenContext(...args),
    getConnectedRateMeMeta: (...args) => mockGetConnectedRateMeMeta(...args),
    getServableDomain: (...args) => mockGetServableDomain(...args),
    insertRating: (...args) => mockInsertRating(...args),
    stampTokenUsed: (...args) => mockStampTokenUsed(...args),
    getDomainByCompany: (...args) => mockGetDomainByCompany(...args),
    upsertDomainForCompany: (...args) => mockUpsertDomainForCompany(...args),
    setDomainStatus: (...args) => mockSetDomainStatus(...args),
    deleteDomain: (...args) => mockDeleteDomain(...args),
}));

jest.mock('../backend/src/services/storageService', () => ({
    getPresignedUrl: (...args) => mockGetPresignedUrl(...args),
}));

jest.mock('../backend/src/db/marketplaceQueries', () => ({
    writeEvent: (...args) => mockWriteEvent(...args),
}));

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
    getClient: (...args) => mockGetClient(...args),
    pool: { connect: jest.fn() },
}));

function tokenRow(overrides = {}) {
    return {
        id: 501,
        token: TOKEN_X,
        company_id: COMPANY_X,
        company_name: 'Boston Masters',
        logo_storage_key: 'logos/company-x.png',
        technician_name: 'Alex Petrov',
        already_rated: false,
        not_expired: true,
        expires_at: null,
        used_at: null,
        job_id: 41,
        tech_id: 'zb-77',
        ...overrides,
    };
}

function connectedMeta(companyId, googleReviewUrl = GOOGLE_URL) {
    return {
        installation_id: `installation-${companyId}`,
        app_id: 'rate-me-app',
        metadata: {
            settings: { google_review_url: googleReviewUrl },
        },
    };
}

function resetFixtureState() {
    mockTokenRows = [
        tokenRow(),
        tokenRow({
            id: 502,
            token: TOKEN_Y,
            company_id: COMPANY_Y,
            company_name: 'Company Y',
            logo_storage_key: null,
            technician_name: 'Taylor Y',
            job_id: 42,
            tech_id: 'zb-88',
        }),
        tokenRow({
            id: 503,
            token: TOKEN_EXPIRED,
            not_expired: false,
            expires_at: '2020-01-01T00:00:00.000Z',
        }),
        tokenRow({
            id: 504,
            token: TOKEN_DISCONNECTED,
            company_id: COMPANY_D,
            company_name: 'Disconnected Company',
            logo_storage_key: null,
        }),
    ];
    mockDomainRows = new Map();
    mockMetaByCompany = new Map([
        [COMPANY_X, connectedMeta(COMPANY_X)],
        [COMPANY_Y, connectedMeta(COMPANY_Y)],
    ]);
    mockStoredRatings = [];
    mockObservedRateHosts = [];

    mockGetTokenContext.mockImplementation(async (token, hostCompanyId = null) => (
        mockTokenRows.find((row) => (
            row.token === token &&
            row.not_expired &&
            (hostCompanyId == null || row.company_id === hostCompanyId)
        ))
    ));
    mockGetConnectedRateMeMeta.mockImplementation(async (companyId) => (
        mockMetaByCompany.get(companyId) || null
    ));
    mockGetServableDomain.mockImplementation(async (domain) => {
        const row = mockDomainRows.get(domain);
        return row && ['verified', 'active'].includes(row.status) ? row : undefined;
    });
    mockInsertRating.mockImplementation(async (rating) => {
        if (mockStoredRatings.some((row) => row.rateTokenId === rating.rateTokenId)) {
            return undefined;
        }
        mockStoredRatings.push({ ...rating });
        return { id: 900 + mockStoredRatings.length };
    });
    mockStampTokenUsed.mockResolvedValue({ id: 501, used_at: new Date().toISOString() });
    mockGetDomainByCompany.mockImplementation(async (companyId) => (
        [...mockDomainRows.values()].find((row) => row.company_id === companyId) || null
    ));
    mockUpsertDomainForCompany.mockImplementation(async (companyId, domain) => {
        const row = { company_id: companyId, domain, status: 'pending' };
        mockDomainRows.set(domain, row);
        return row;
    });
    mockSetDomainStatus.mockImplementation(async (companyId, status) => {
        const row = [...mockDomainRows.values()].find((item) => item.company_id === companyId);
        if (!row) return undefined;
        row.status = status;
        return row;
    });
    mockDeleteDomain.mockImplementation(async (companyId) => {
        const entry = [...mockDomainRows.entries()].find(([, row]) => row.company_id === companyId);
        if (!entry) return undefined;
        mockDomainRows.delete(entry[0]);
        return entry[1];
    });
    mockGetPresignedUrl.mockResolvedValue('https://s3.example/presigned');
    mockWriteEvent.mockResolvedValue({});
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockClientQuery.mockImplementation(async (sql, params = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (/SELECT job_id, tech_id\s+FROM rate_tokens/i.test(sql)) {
            const row = mockTokenRows.find((item) => (
                item.id === params[0] && item.company_id === params[1]
            ));
            return { rows: row ? [{ job_id: row.job_id, tech_id: row.tech_id }] : [] };
        }
        throw new Error(`Unexpected transaction SQL: ${sql}`);
    });
    mockClientRelease.mockImplementation(() => {});
    mockGetClient.mockResolvedValue({
        query: mockClientQuery,
        release: mockClientRelease,
    });
}

function nextXff() {
    mockIpCounter += 1;
    return `198.51.100.${(mockIpCounter % 250) + 1}`;
}

function withClientIp(testRequest, ip = nextXff()) {
    return testRequest.set('X-Forwarded-For', ip);
}

function buildPublicApp() {
    const rateHostGate = require('../backend/src/middleware/rateHostGate');
    const publicRateRouter = require('../backend/src/routes/public-rate');
    const app = express();

    app.use(rateHostGate);
    app.use((req, _res, next) => {
        mockObservedRateHosts.push(req.rateHost);
        next();
    });
    app.post(
        '/api/billing/webhook',
        express.raw({ type: '*/*' }),
        (_req, res) => res.status(200).send('webhook-sentinel')
    );
    app.use(express.json());
    app.use('/api/public', publicRateRouter);
    app.get('/api/marketplace/apps', (_req, res) => (
        res.status(200).send('marketplace-sentinel')
    ));
    app.use((_req, res) => res.status(200).send('spa-sentinel'));

    return { app, publicRateRouter };
}

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    resetFixtureState();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('public rate routes', () => {
    test('TC-T7-01 · repeated GETs are stateless and never consume the token', async () => {
        const { app } = buildPublicApp();
        const first = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'rate.albusto.com');
        const second = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'rate.albusto.com');

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
        expect(mockInsertRating).not.toHaveBeenCalled();
        expect(mockStampTokenUsed).not.toHaveBeenCalled();
    });

    test('TC-P1-01 · GET returns exactly the five public context keys', async () => {
        const { app } = buildPublicApp();
        const response = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'rate.albusto.com');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            ok: true,
            data: {
                company_name: 'Boston Masters',
                company_logo_url: 'https://s3.example/presigned',
                technician_name: 'Alex Petrov',
                already_rated: false,
                five_star_redirect: true,
            },
        });
        expect(Object.keys(response.body.data).sort()).toEqual([
            'already_rated',
            'company_logo_url',
            'company_name',
            'five_star_redirect',
            'technician_name',
        ]);
        expect(JSON.stringify(response.body)).not.toContain(COMPANY_X);
        expect(JSON.stringify(response.body)).not.toContain(GOOGLE_URL);
        expect(mockGetTokenContext).toHaveBeenCalledTimes(1);
        expect(mockGetConnectedRateMeMeta).toHaveBeenCalledTimes(1);
        expect(mockGetPresignedUrl).toHaveBeenCalledTimes(1);
    });

    test('TC-P2-01 · unknown well-formed token returns the uniform 404', async () => {
        const { app } = buildPublicApp();
        const response = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_UNKNOWN}`))
            .set('Host', 'rate.albusto.com');

        expect(response.status).toBe(404);
        expect(response.body).toEqual(UNIFORM_NOT_FOUND);
    });

    test('TC-P3-01 · malformed token guard runs before any query', async () => {
        const { app } = buildPublicApp();
        const malformed = ['abc', 'a'.repeat(65), 'A'.repeat(21), `${'A'.repeat(22)}$`];

        for (const token of malformed) {
            const response = await withClientIp(
                request(app).get(`/api/public/rate/${encodeURIComponent(token)}`)
            ).set('Host', 'rate.albusto.com');
            expect(response.status).toBe(404);
            expect(response.body).toEqual(UNIFORM_NOT_FOUND);
        }
        const encodedTraversal = await withClientIp(
            request(app).get('/api/public/rate/..%2F..%2Fetc')
        ).set('Host', 'rate.albusto.com');
        expect(encodedTraversal.status).toBe(404);
        expect(encodedTraversal.body).toEqual(UNIFORM_NOT_FOUND);
        expect(mockGetTokenContext).not.toHaveBeenCalled();
    });

    test('TC-P3-02 · exported RATE_TOKEN_RE accepts only 22–64 base64url characters', () => {
        const { publicRateRouter } = buildPublicApp();
        const { RATE_TOKEN_RE } = publicRateRouter;

        for (const value of ['a'.repeat(22), TOKEN_X, 'Z'.repeat(64)]) {
            expect(RATE_TOKEN_RE.test(value)).toBe(true);
        }
        for (const value of [
            'a'.repeat(21),
            'a'.repeat(65),
            `${'a'.repeat(21)}+`,
            `${'a'.repeat(21)}/`,
            `${'a'.repeat(21)}=`,
            `${'a'.repeat(21)} `,
            '',
        ]) {
            expect(RATE_TOKEN_RE.test(value)).toBe(false);
        }
    });

    test('TC-P4-01 · expired token is indistinguishable from unknown on GET and POST', async () => {
        const { app } = buildPublicApp();
        const getResponse = await withClientIp(
            request(app).get(`/api/public/rate/${TOKEN_EXPIRED}`)
        ).set('Host', 'rate.albusto.com');
        const postResponse = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_EXPIRED}/rating`).send({ stars: 5 })
        ).set('Host', 'rate.albusto.com');

        expect(getResponse.status).toBe(404);
        expect(postResponse.status).toBe(404);
        expect(getResponse.body).toEqual(UNIFORM_NOT_FOUND);
        expect(postResponse.body).toEqual(UNIFORM_NOT_FOUND);
    });

    test('TC-P6-01 · malformed/unknown/expired/foreign/disconnected 404s are byte-identical', async () => {
        mockDomainRows.set('rate.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'rate.bostonmasters.com',
            status: 'active',
        });
        const { app } = buildPublicApp();
        const requests = [
            withClientIp(request(app).get('/api/public/rate/abc')).set('Host', 'rate.albusto.com'),
            withClientIp(request(app).get(`/api/public/rate/${TOKEN_UNKNOWN}`)).set('Host', 'rate.albusto.com'),
            withClientIp(request(app).get(`/api/public/rate/${TOKEN_EXPIRED}`)).set('Host', 'rate.albusto.com'),
            withClientIp(request(app).get(`/api/public/rate/${TOKEN_Y}`)).set('Host', 'rate.bostonmasters.com'),
            withClientIp(request(app).get(`/api/public/rate/${TOKEN_DISCONNECTED}`)).set('Host', 'rate.albusto.com'),
        ];
        const responses = [];
        for (const pending of requests) responses.push(await pending);

        for (const response of responses) {
            expect(response.status).toBe(404);
            expect(response.body).toEqual(UNIFORM_NOT_FOUND);
            expect(response.headers['content-type']).toMatch(/^application\/json/);
        }
        expect(new Set(responses.map((response) => response.headers['content-type'])).size).toBe(1);
        expect(mockGetTokenContext).toHaveBeenCalledWith(TOKEN_Y, COMPANY_X);
    });

    test('TC-P7-01 · GET after rating retains the DTO and reports already_rated', async () => {
        mockTokenRows[0].already_rated = true;
        const { app } = buildPublicApp();
        const response = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'rate.albusto.com');

        expect(response.status).toBe(200);
        expect(response.body.data.already_rated).toBe(true);
        expect(Object.keys(response.body.data)).toHaveLength(5);
    });

    test('TC-P8-01 · GET exposes only the boolean five-star redirect flag', async () => {
        const { app } = buildPublicApp();
        const configured = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'rate.albusto.com');
        mockMetaByCompany.set(COMPANY_X, connectedMeta(COMPANY_X, null));
        const cleared = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'rate.albusto.com');

        expect(configured.body.data.five_star_redirect).toBe(true);
        expect(cleared.body.data.five_star_redirect).toBe(false);
        expect(JSON.stringify(configured.body)).not.toContain(GOOGLE_URL);
    });

    test('TC-P10-01 · first 5-star rating records before returning the redirect', async () => {
        const { app } = buildPublicApp();
        const response = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_X}/rating`).send({ stars: 5 })
        ).set('Host', 'rate.albusto.com');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            ok: true,
            data: { recorded: true, next: 'google_redirect', redirect_url: GOOGLE_URL },
        });
        expect(mockInsertRating).toHaveBeenCalledWith({
            companyId: COMPANY_X,
            rateTokenId: 501,
            jobId: 41,
            techId: 'zb-77',
            stars: 5,
            feedback: null,
        }, expect.any(Object));
        expect(mockStampTokenUsed).toHaveBeenCalledWith(501, expect.any(Object));
        expect(console.log).toHaveBeenCalledWith('[RateMe] rating', {
            company_id: COMPANY_X,
            rate_token_id: 501,
            stars: 5,
            has_feedback: false,
            replay: false,
        });
    });

    test('TC-P11-01 · 5-star rating without a link records and returns thanks', async () => {
        mockMetaByCompany.set(COMPANY_X, connectedMeta(COMPANY_X, null));
        const { app } = buildPublicApp();
        const response = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_X}/rating`).send({ stars: 5 })
        ).set('Host', 'rate.albusto.com');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            ok: true,
            data: { recorded: true, next: 'thanks' },
        });
        expect(response.body.data).not.toHaveProperty('redirect_url');
    });

    test('TC-P12-01 · 1–4-star feedback is trimmed and never redirects', async () => {
        const { app } = buildPublicApp();
        const response = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_X}/rating`)
                .send({ stars: 3, feedback: '  late arrival  ' })
        ).set('Host', 'rate.albusto.com');

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ recorded: true, next: 'thanks' });
        expect(response.body.data).not.toHaveProperty('redirect_url');
        expect(mockInsertRating).toHaveBeenCalledWith(
            expect.objectContaining({ stars: 3, feedback: 'late arrival' }),
            expect.any(Object)
        );
    });

    test('TC-P13-01 · stars and feedback validation happen before DB lookup', async () => {
        const { app } = buildPublicApp();
        const invalidBodies = [
            {},
            { stars: 0 },
            { stars: 6 },
            { stars: 4.5 },
            { stars: '5' },
            { stars: null },
            { stars: 3, feedback: 42 },
            { stars: 3, feedback: {} },
        ];

        for (const body of invalidBodies) {
            const response = await withClientIp(
                request(app).post(`/api/public/rate/${TOKEN_X}/rating`).send(body)
            ).set('Host', 'rate.albusto.com');
            expect(response.status).toBe(400);
            const expectedCode = body.stars === 3 ? 'INVALID_FEEDBACK' : 'INVALID_STARS';
            expect(response.body.error.code).toBe(expectedCode);
        }
        expect(mockGetTokenContext).not.toHaveBeenCalled();
        expect(mockInsertRating).not.toHaveBeenCalled();
    });

    test('TC-P14-01 · poisoned rating body cannot override token identity', async () => {
        const { app } = buildPublicApp();
        const response = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_X}/rating`).send({
                stars: 5,
                company_id: '99999999-9999-9999-9999-999999999999',
                tech_id: 'zb-99',
                job_id: 1,
                token: TOKEN_Y,
                rate_token_id: 777,
            })
        ).set('Host', 'rate.albusto.com');

        expect(response.status).toBe(200);
        expect(mockInsertRating).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_X,
            rateTokenId: 501,
            jobId: 41,
            techId: 'zb-77',
        }), expect.any(Object));
    });

    test('TC-P15-01 · replay is 200-idempotent and never overwrites', async () => {
        mockTokenRows[0].already_rated = true;
        const { app } = buildPublicApp();
        const response = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_X}/rating`)
                .send({ stars: 1, feedback: 'changed my mind' })
        ).set('Host', 'rate.albusto.com');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            ok: true,
            data: { recorded: false, already_recorded: true, next: 'thanks' },
        });
        expect(response.body.data).not.toHaveProperty('redirect_url');
        expect(mockInsertRating).not.toHaveBeenCalled();
        expect(console.log).toHaveBeenCalledWith('[RateMe] rating', expect.objectContaining({
            replay: true,
        }));
    });

    test('TC-P19-01 · token guard precedes body validation; body validation precedes lookup', async () => {
        const { app } = buildPublicApp();
        const malformed = await withClientIp(
            request(app).post('/api/public/rate/abc/rating').send({ stars: 99 })
        ).set('Host', 'rate.albusto.com');
        const unknown = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_UNKNOWN}/rating`).send({ stars: 99 })
        ).set('Host', 'rate.albusto.com');

        expect(malformed.status).toBe(404);
        expect(malformed.body).toEqual(UNIFORM_NOT_FOUND);
        expect(unknown.status).toBe(400);
        expect(unknown.body.error.code).toBe('INVALID_STARS');
        expect(mockGetTokenContext).not.toHaveBeenCalled();
    });

    test('TC-M3-01 · host × token isolation matrix matches the specification', async () => {
        mockDomainRows.set('rate.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'rate.bostonmasters.com',
            status: 'verified',
        });
        mockDomainRows.set('pending.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'pending.bostonmasters.com',
            status: 'pending',
        });
        const { app } = buildPublicApp();
        const tokens = [
            { value: TOKEN_X, className: 'x' },
            { value: TOKEN_Y, className: 'y' },
            { value: 'abc', className: 'malformed' },
            { value: TOKEN_UNKNOWN, className: 'unknown' },
            { value: TOKEN_EXPIRED, className: 'expired' },
            { value: TOKEN_DISCONNECTED, className: 'disconnected' },
        ];
        const hosts = [
            { value: 'rate.albusto.com', className: 'shared', allowed: ['x', 'y'] },
            { value: 'rate.bostonmasters.com', className: 'custom', allowed: ['x'] },
            { value: 'pending.bostonmasters.com', className: 'pending', allowed: [] },
            { value: 'evil.example.com', className: 'unknown-host', allowed: [] },
            { value: 'app.albusto.com', className: 'pass-through', allowed: ['x', 'y'] },
        ];

        for (const host of hosts) {
            for (const token of tokens) {
                const response = await withClientIp(
                    request(app).get(`/api/public/rate/${token.value}`)
                ).set('Host', host.value);
                const shouldPass = host.allowed.includes(token.className);
                expect(response.status).toBe(shouldPass ? 200 : 404);
                if (!shouldPass && !['pending', 'unknown-host'].includes(host.className)) {
                    expect(response.body).toEqual(UNIFORM_NOT_FOUND);
                }
                if (!shouldPass && ['pending', 'unknown-host'].includes(host.className)) {
                    expect(response.body).toEqual(GATE_NOT_FOUND);
                }
            }
        }

        const sharedY = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_Y}/rating`).send({ stars: 4 })
        ).set('Host', 'rate.albusto.com');
        const customForeign = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_Y}/rating`).send({ stars: 4 })
        ).set('Host', 'rate.bostonmasters.com');
        expect(sharedY.status).toBe(200);
        expect(customForeign.status).toBe(404);
        expect(customForeign.body).toEqual(UNIFORM_NOT_FOUND);
    });
});

describe('rate limits', () => {
    test('TC-P17-01 · GET 60/min and POST 10/min are keyed by first XFF hop', async () => {
        const { app } = buildPublicApp();
        const getIp = '203.0.113.10';
        for (let index = 0; index < 60; index += 1) {
            const response = await request(app)
                .get(`/api/public/rate/${TOKEN_X}`)
                .set('Host', 'rate.albusto.com')
                .set('X-Forwarded-For', `${getIp}, 10.0.0.1`);
            expect(response.status).toBe(200);
        }
        const limitedGet = await request(app)
            .get(`/api/public/rate/${TOKEN_X}`)
            .set('Host', 'rate.albusto.com')
            .set('X-Forwarded-For', `${getIp}, 10.0.0.2`);
        expect(limitedGet.status).toBe(429);
        expect(limitedGet.body).toEqual({
            ok: false,
            error: { code: 'RATE_LIMITED', message: 'Too many requests' },
        });
        expect(Object.keys(limitedGet.headers).some((key) => key.startsWith('ratelimit'))).toBe(true);

        const independentGet = await request(app)
            .get(`/api/public/rate/${TOKEN_X}`)
            .set('Host', 'rate.albusto.com')
            .set('X-Forwarded-For', '203.0.113.11');
        expect(independentGet.status).toBe(200);

        const postIp = '203.0.113.20';
        for (let index = 0; index < 10; index += 1) {
            const response = await request(app)
                .post(`/api/public/rate/${TOKEN_X}/rating`)
                .set('Host', 'rate.albusto.com')
                .set('X-Forwarded-For', postIp)
                .send({ stars: 4 });
            expect(response.status).toBe(200);
        }
        const limitedPost = await request(app)
            .post(`/api/public/rate/${TOKEN_X}/rating`)
            .set('Host', 'rate.albusto.com')
            .set('X-Forwarded-For', postIp)
            .send({ stars: 4 });
        expect(limitedPost.status).toBe(429);
        expect(limitedPost.body.error.code).toBe('RATE_LIMITED');

        const direct = await request(app)
            .get(`/api/public/rate/${TOKEN_X}`)
            .set('Host', 'rate.albusto.com');
        expect(direct.status).toBe(200);

        const source = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'src', 'routes', 'public-rate.js'),
            'utf8'
        );
        expect(source).toMatch(/windowMs:\s*60_000/);
        expect(source).toMatch(/max:\s*60/);
        expect(source).toMatch(/max:\s*10/);
        expect(source).toContain('ipKeyGenerator');
    });
});

describe('rate host gate', () => {
    test('TC-H1-01 · Albusto and pass-through hosts reach CRM with zero domain lookups', async () => {
        const { app } = buildPublicApp();
        const cases = [
            ['app.albusto.com', '/pulse', 'spa-sentinel'],
            ['api.albusto.com', '/api/marketplace/apps', 'marketplace-sentinel'],
            ['albusto.com', '/pulse', 'spa-sentinel'],
            ['www.albusto.com', '/pulse', 'spa-sentinel'],
            ['localhost:3000', '/pulse', 'spa-sentinel'],
            ['127.0.0.1', '/pulse', 'spa-sentinel'],
            ['[::1]', '/pulse', 'spa-sentinel'],
            ['legacy.fly.dev', '/pulse', 'spa-sentinel'],
        ];

        for (const [host, pathname, sentinel] of cases) {
            const response = await request(app).get(pathname).set('Host', host);
            expect(response.status).toBe(200);
            expect(response.text).toBe(sentinel);
        }
        expect(mockGetServableDomain).not.toHaveBeenCalled();
    });

    test('TC-H2-01 · shared-host allowlist passes and stamps shared mode', async () => {
        const { app } = buildPublicApp();
        const cases = [
            request(app).get(`/r/${TOKEN_X}`).set('Host', 'rate.albusto.com'),
            withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`)).set('Host', 'rate.albusto.com'),
            withClientIp(request(app).post(`/api/public/rate/${TOKEN_X}/rating`).send({ stars: 4 })).set('Host', 'rate.albusto.com'),
            request(app).get('/assets/app.js').set('Host', 'rate.albusto.com'),
            request(app).get('/icons/icon-192.png').set('Host', 'rate.albusto.com'),
            request(app).get('/vite.svg').set('Host', 'rate.albusto.com'),
        ];
        for (const pending of cases) expect((await pending).status).toBe(200);
        expect(mockObservedRateHosts).toHaveLength(cases.length);
        for (const rateHost of mockObservedRateHosts) {
            expect(rateHost).toEqual({ mode: 'shared' });
        }
    });

    test('TC-H3-01 · shared host blocks CRM/API paths without Keycloak redirects', async () => {
        const { app } = buildPublicApp();
        const paths = [
            '/', '/pulse', '/login', '/settings', '/api/marketplace/apps',
            '/api/crm/contacts', '/api/calls', '/events', '/webhooks/twilio',
            '/health', '/twiml', '/r',
        ];

        for (const pathname of paths) {
            const response = await request(app).get(pathname).set('Host', 'rate.albusto.com');
            expect(response.status).toBe(404);
            if (pathname.startsWith('/api/')) expect(response.body).toEqual(GATE_NOT_FOUND);
            else expect(response.text).toBe('Not found');
            expect(response.headers.location).toBeUndefined();
            expect(response.text).not.toContain('auth.albusto.com');
            expect(response.text).not.toContain('marketplace-sentinel');
            expect(response.text).not.toContain('spa-sentinel');
        }
    });

    test('TC-H4-01 · manifest and root apple icon are blocked; /icons remains allowed', async () => {
        const { app } = buildPublicApp();
        const manifest = await request(app).get('/manifest.webmanifest').set('Host', 'rate.albusto.com');
        const rootIcon = await request(app).get('/apple-touch-icon.png').set('Host', 'rate.albusto.com');
        const allowedIcon = await request(app).get('/icons/apple-touch-icon.png').set('Host', 'rate.albusto.com');

        expect(manifest.status).toBe(404);
        expect(rootIcon.status).toBe(404);
        expect(allowedIcon.status).toBe(200);
        expect(allowedIcon.text).toBe('spa-sentinel');
    });

    test('TC-H5-01 · verified and active custom domains bind company X end-to-end', async () => {
        mockDomainRows.set('verified.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'verified.bostonmasters.com',
            status: 'verified',
        });
        mockDomainRows.set('active.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'active.bostonmasters.com',
            status: 'active',
        });
        const { app } = buildPublicApp();
        const verified = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'verified.bostonmasters.com');
        const active = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'active.bostonmasters.com');
        const post = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_X}/rating`).send({ stars: 4 })
        ).set('Host', 'verified.bostonmasters.com');

        expect(verified.status).toBe(200);
        expect(active.status).toBe(200);
        expect(post.status).toBe(200);
        expect(mockObservedRateHosts).toContainEqual({ mode: 'custom', companyId: COMPANY_X });
        expect(mockGetTokenContext).toHaveBeenCalledWith(TOKEN_X, COMPANY_X);
    });

    test('TC-H6-01 · company-Y token is uniformly hidden on company-X custom host', async () => {
        mockDomainRows.set('rate.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'rate.bostonmasters.com',
            status: 'active',
        });
        const { app } = buildPublicApp();
        const getResponse = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_Y}`))
            .set('Host', 'rate.bostonmasters.com');
        const postResponse = await withClientIp(
            request(app).post(`/api/public/rate/${TOKEN_Y}/rating`).send({ stars: 4 })
        ).set('Host', 'rate.bostonmasters.com');

        expect(getResponse.status).toBe(404);
        expect(postResponse.status).toBe(404);
        expect(getResponse.body).toEqual(UNIFORM_NOT_FOUND);
        expect(postResponse.body).toEqual(UNIFORM_NOT_FOUND);
        expect(mockGetTokenContext).toHaveBeenCalledWith(TOKEN_Y, COMPANY_X);
    });

    test('TC-H7-01 · pending, failed, and removed domains block every path', async () => {
        mockDomainRows.set('pending.example.com', {
            company_id: COMPANY_X,
            domain: 'pending.example.com',
            status: 'pending',
        });
        mockDomainRows.set('failed.example.com', {
            company_id: COMPANY_X,
            domain: 'failed.example.com',
            status: 'failed',
        });
        const { app } = buildPublicApp();

        for (const host of ['pending.example.com', 'failed.example.com', 'removed.example.com']) {
            const page = await request(app).get(`/r/${TOKEN_X}`).set('Host', host);
            const api = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`)).set('Host', host);
            expect(page.status).toBe(404);
            expect(page.text).toBe('Not found');
            expect(api.status).toBe(404);
            expect(api.body).toEqual(GATE_NOT_FOUND);
        }
    });

    test('TC-H8-01 · unknown custom-host candidate is fully blocked after lookup', async () => {
        const { app } = buildPublicApp();
        const response = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'evil.example.com');

        expect(response.status).toBe(404);
        expect(response.body).toEqual(GATE_NOT_FOUND);
        expect(mockGetServableDomain).toHaveBeenCalledWith('evil.example.com');
    });

    test('TC-H9-01 · custom lookup errors fail closed without affecting Albusto traffic', async () => {
        mockGetServableDomain.mockRejectedValue(new Error('db down'));
        const { app } = buildPublicApp();
        const unknown = await request(app).get(`/r/${TOKEN_X}`).set('Host', 'rate.unknown-host.com');
        const albusto = await request(app).get('/pulse').set('Host', 'app.albusto.com');

        expect(unknown.status).toBe(503);
        expect(albusto.status).toBe(200);
        expect(albusto.text).toBe('spa-sentinel');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(1);
    });

    test('TC-H10-01 · gate precedes raw webhooks and server has exactly two flagged mounts', async () => {
        const { app } = buildPublicApp();
        const blocked = await request(app)
            .post('/api/billing/webhook')
            .set('Host', 'rate.albusto.com')
            .send('x');
        const passed = await request(app)
            .post('/api/billing/webhook')
            .set('Host', 'app.albusto.com')
            .send('x');

        expect(blocked.status).toBe(404);
        expect(blocked.body).toEqual(GATE_NOT_FOUND);
        expect(blocked.text).not.toContain('webhook-sentinel');
        expect(passed.status).toBe(200);
        expect(passed.text).toBe('webhook-sentinel');

        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
        const cors = source.indexOf('// CORS middleware - allow frontend origin');
        const gate = source.indexOf("app.use(require('../backend/src/middleware/rateHostGate'))");
        const billing = source.indexOf("app.use('/api/billing/webhook'");
        const stripe = source.indexOf("app.use('/api/stripe-payments/webhook'");
        const email = source.indexOf("app.use('/api/email/push'");
        expect(cors).toBeLessThan(gate);
        expect(gate).toBeLessThan(billing);
        expect(billing).toBeLessThan(stripe);
        expect(stripe).toBeLessThan(email);
        expect((source.match(/RATE-ME-CRM-001/g) || [])).toHaveLength(2);
        expect(source).toMatch(/publicEstimatesRouter[\s\S]*publicRateRouter[\s\S]*publicAuthRouter/);
    });

    test('TC-H12-01 · app host keeps the SPA and token-only API smoke path', async () => {
        const { app } = buildPublicApp();
        const page = await request(app).get(`/r/${TOKEN_X}`).set('Host', 'app.albusto.com');
        const api = await withClientIp(request(app).get(`/api/public/rate/${TOKEN_X}`))
            .set('Host', 'app.albusto.com');

        expect(page.status).toBe(200);
        expect(page.text).toBe('spa-sentinel');
        expect(api.status).toBe(200);
        expect(mockGetTokenContext).toHaveBeenCalledWith(TOKEN_X, null);
    });
});

describe('rate domain ask route', () => {
    test('TC-D14-01 · verified ask activates exactly once and returns empty 200', async () => {
        mockDomainRows.set('rate.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'rate.bostonmasters.com',
            status: 'verified',
        });
        mockDomainRows.set('active.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'active.bostonmasters.com',
            status: 'active',
        });
        const { app } = buildPublicApp();

        for (let index = 0; index < 3; index += 1) {
            const response = await request(app)
                .get('/api/public/rate-domain-ask?domain=rate.bostonmasters.com')
                .set('Host', '127.0.0.1');
            expect(response.status).toBe(200);
            expect(response.text).toBe('');
        }
        const active = await request(app)
            .get('/api/public/rate-domain-ask?domain=active.bostonmasters.com')
            .set('Host', '127.0.0.1');
        expect(active.status).toBe(200);
        expect(active.text).toBe('');
        expect(mockSetDomainStatus).toHaveBeenCalledTimes(1);
        expect(mockSetDomainStatus).toHaveBeenCalledWith(COMPANY_X, 'active', {
            setActivatedAt: true,
        });
        expect(mockWriteEvent).toHaveBeenCalledTimes(1);
        expect(mockWriteEvent).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_X,
            actorId: null,
            eventType: 'domain_activated',
        }));
    });

    test('TC-D15-01 · ask deny matrix is empty 404 and never mutates', async () => {
        mockDomainRows.set('pending.example.com', {
            company_id: COMPANY_X,
            domain: 'pending.example.com',
            status: 'pending',
        });
        mockDomainRows.set('failed.example.com', {
            company_id: COMPANY_X,
            domain: 'failed.example.com',
            status: 'failed',
        });
        mockDomainRows.set('disconnected.example.com', {
            company_id: COMPANY_D,
            domain: 'disconnected.example.com',
            status: 'verified',
        });
        const { app } = buildPublicApp();
        const queries = [
            '?domain=pending.example.com',
            '?domain=failed.example.com',
            '?domain=removed.example.com',
            '?domain=disconnected.example.com',
            '',
            '?domain=garbage!',
        ];

        for (const query of queries) {
            const response = await request(app)
                .get(`/api/public/rate-domain-ask${query}`)
                .set('Host', '127.0.0.1');
            expect(response.status).toBe(404);
            expect(response.text).toBe('');
        }
        expect(mockSetDomainStatus).not.toHaveBeenCalled();
        expect(mockWriteEvent).not.toHaveBeenCalled();

        const source = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'src', 'db', 'rateMeQueries.js'),
            'utf8'
        );
        expect(source).toMatch(/status IN \('verified',\s*'active'\)/);
    });

    test('TC-D16-01 · XFF and non-loopback callers are denied by the exported predicate', async () => {
        mockDomainRows.set('rate.bostonmasters.com', {
            company_id: COMPANY_X,
            domain: 'rate.bostonmasters.com',
            status: 'verified',
        });
        const { app, publicRateRouter } = buildPublicApp();
        const proxied = await request(app)
            .get('/api/public/rate-domain-ask?domain=rate.bostonmasters.com')
            .set('Host', 'rate.albusto.com')
            .set('X-Forwarded-For', '8.8.8.8');

        expect(proxied.status).toBe(404);
        expect(proxied.text).toBe('');
        expect(mockGetServableDomain).not.toHaveBeenCalled();
        expect(publicRateRouter.isAskLoopback({
            headers: {},
            socket: { remoteAddress: '10.0.0.9' },
        })).toBe(false);
        for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
            expect(publicRateRouter.isAskLoopback({
                headers: {},
                socket: { remoteAddress },
            })).toBe(true);
        }
        expect(publicRateRouter.isAskLoopback({
            headers: { 'x-forwarded-for': '' },
            socket: { remoteAddress: '127.0.0.1' },
        })).toBe(false);
    });
});
