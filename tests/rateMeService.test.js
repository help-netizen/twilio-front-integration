'use strict';

const fs = require('fs');
const path = require('path');

const mockDbQuery = jest.fn();
const mockGetClient = jest.fn();
const mockInsertToken = jest.fn();
const mockGetTokenContext = jest.fn();
const mockInsertRating = jest.fn();
const mockStampTokenUsed = jest.fn();
const mockGetConnectedRateMeMeta = jest.fn();
const mockGetDomainByCompany = jest.fn();
const mockGetServableDomain = jest.fn();
const mockUpsertDomainForCompany = jest.fn();
const mockSetDomainStatus = jest.fn();
const mockDeleteDomain = jest.fn();
const mockWriteEvent = jest.fn();
const mockGetPresignedUrl = jest.fn();
const mockResolveCname = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: mockDbQuery,
    getClient: mockGetClient,
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/db/rateMeQueries', () => ({
    insertToken: mockInsertToken,
    getTokenContext: mockGetTokenContext,
    insertRating: mockInsertRating,
    stampTokenUsed: mockStampTokenUsed,
    getConnectedRateMeMeta: mockGetConnectedRateMeMeta,
    getDomainByCompany: mockGetDomainByCompany,
    getServableDomain: mockGetServableDomain,
    upsertDomainForCompany: mockUpsertDomainForCompany,
    setDomainStatus: mockSetDomainStatus,
    deleteDomain: mockDeleteDomain,
}));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    writeEvent: mockWriteEvent,
}));
jest.mock('../backend/src/services/storageService', () => ({
    getPresignedUrl: mockGetPresignedUrl,
}));
jest.mock('dns', () => ({
    promises: {
        Resolver: class {
            constructor() {
                this.resolveCname = mockResolveCname;
            }
        },
    },
}));

const COMPANY_X = '00000000-0000-0000-0000-000000000001';
const TOKEN_X = 'Xtok_'.padEnd(32, 'x');
const META = {
    metadata: { settings: { google_review_url: 'https://g.page/r/abc/review' } },
    installation_id: 7,
    app_id: 'app-rate',
};
const CONTEXT = {
    id: 501,
    company_id: COMPANY_X,
    job_id: 41,
    tech_id: 'zb-77',
    company_name: 'Boston Masters',
    logo_storage_key: 'logos/x.png',
    technician_name: 'Alex Petrov',
    already_rated: false,
};

let service;
let client;

function freshService() {
    jest.resetModules();
    return require('../backend/src/services/rateMeService');
}

function setupDefaults() {
    client = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
    };
    mockGetClient.mockResolvedValue(client);
    mockGetConnectedRateMeMeta.mockResolvedValue(META);
    mockGetTokenContext.mockResolvedValue({ ...CONTEXT });
    mockInsertToken.mockResolvedValue({ id: 501 });
    mockInsertRating.mockResolvedValue({ id: 900 });
    mockStampTokenUsed.mockResolvedValue({ id: 501 });
    mockWriteEvent.mockResolvedValue({});
    mockGetPresignedUrl.mockResolvedValue('https://s3.example/presigned');
    mockResolveCname.mockResolvedValue(['rate.albusto.com']);
}

async function expectServiceError(promise, code, httpStatus) {
    try {
        await promise;
        throw new Error(`Expected ${code}`);
    } catch (error) {
        expect(error).toBeInstanceOf(service.RateMeServiceError);
        expect(error).toMatchObject({ code, httpStatus });
        return error;
    }
}

beforeEach(() => {
    jest.resetAllMocks();
    setupDefaults();
    service = freshService();
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('RATE-ME-CRM-001 token and public-context service', () => {
    test('TC-T1-01 · mint happy path snapshots the assigned technician and logs only a prefix', async () => {
        mockDbQuery.mockResolvedValue({
            rows: [{ assigned_techs: [{ id: 'zb-77', name: 'Alex Petrov' }] }],
        });

        const result = await service.mintToken(COMPANY_X, {
            jobId: 41,
            techId: 'zb-77',
        });

        expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(result.url).toBe(`https://rate.albusto.com/r/${result.token}`);
        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('company_id = $2'),
            [41, COMPANY_X]
        );
        expect(mockInsertToken).toHaveBeenCalledWith({
            companyId: COMPANY_X,
            token: result.token,
            jobId: 41,
            techId: 'zb-77',
            techName: 'Alex Petrov',
        });
        expect(console.log).toHaveBeenCalledTimes(1);
        const logPayload = console.log.mock.calls[0][1];
        expect(console.log.mock.calls[0][0]).toBe('[RateMe] mint');
        expect(logPayload).toEqual({
            company_id: COMPANY_X,
            job_id: 41,
            tech_id: 'zb-77',
            token_prefix: result.token.slice(0, 8),
        });
        expect(JSON.stringify(console.log.mock.calls)).not.toContain(result.token);
    });

    test('TC-T2-01 · mint without a job uses the supplied name or null', async () => {
        const named = await service.mintToken(COMPANY_X, {
            techId: 'zb-77',
            techName: 'Alex',
        });
        const unnamed = await service.mintToken(COMPANY_X, { techId: 'zb-77' });

        expect(named).toEqual({
            token: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
            url: `https://rate.albusto.com/r/${named.token}`,
        });
        expect(unnamed.url).toBe(`https://rate.albusto.com/r/${unnamed.token}`);
        expect(mockInsertToken.mock.calls[0][0]).toMatchObject({
            jobId: null,
            techName: 'Alex',
        });
        expect(mockInsertToken.mock.calls[1][0]).toMatchObject({
            jobId: null,
            techName: null,
        });
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('TC-T3-01 · mint rejects foreign and missing jobs in company scope', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });

        await expectServiceError(
            service.mintToken(COMPANY_X, { jobId: 41, techId: 'zb-77' }),
            'JOB_NOT_FOUND',
            400
        );
        await expectServiceError(
            service.mintToken(COMPANY_X, { jobId: 999, techId: 'zb-77' }),
            'JOB_NOT_FOUND',
            400
        );
        expect(mockDbQuery).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('company_id = $2'),
            [41, COMPANY_X]
        );
        expect(mockDbQuery).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('company_id = $2'),
            [999, COMPANY_X]
        );
        expect(mockInsertToken).not.toHaveBeenCalled();
    });

    test('TC-T4-01 · mint is gated on a connected installation', async () => {
        mockGetConnectedRateMeMeta.mockResolvedValue(null);

        await expectServiceError(
            service.mintToken(COMPANY_X, { jobId: 41, techId: 'zb-77' }),
            'APP_NOT_INSTALLED',
            404
        );
        expect(mockDbQuery).not.toHaveBeenCalled();
        expect(mockInsertToken).not.toHaveBeenCalled();
    });

    test('TC-T5-01 · mint validates technician and job inputs and ignores extra fields', async () => {
        for (const techId of [undefined, '', 42]) {
            await expectServiceError(
                service.mintToken(COMPANY_X, { techId }),
                'INVALID_TECH_ID',
                400
            );
        }
        for (const jobId of ['abc', -1, 1.5]) {
            await expectServiceError(
                service.mintToken(COMPANY_X, { techId: 'zb-77', jobId }),
                'JOB_NOT_FOUND',
                400
            );
        }

        await expect(service.mintToken(COMPANY_X, {
            techId: 'zb-77',
            company_id: 'poison',
            stars: 5,
        })).resolves.toMatchObject({ token: expect.any(String), url: expect.any(String) });
        expect(mockInsertToken).toHaveBeenCalledTimes(1);
    });

    test('TC-T6-01 · mint uses 192-bit base64url tokens and retries at most three collisions', async () => {
        const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
        mockInsertToken
            .mockRejectedValueOnce(duplicate)
            .mockRejectedValueOnce(duplicate)
            .mockResolvedValueOnce({ id: 501 });

        const result = await service.mintToken(COMPANY_X, { techId: 'zb-77' });
        const tokens = mockInsertToken.mock.calls.map(([value]) => value.token);
        expect(result.token).toBe(tokens[2]);
        expect(new Set(tokens).size).toBe(3);
        expect(tokens.every((token) => /^[A-Za-z0-9_-]{32}$/.test(token))).toBe(true);

        mockInsertToken.mockReset();
        mockInsertToken.mockRejectedValue(duplicate);
        await expectServiceError(
            service.mintToken(COMPANY_X, { techId: 'zb-77' }),
            'INTERNAL_ERROR',
            500
        );
        expect(mockInsertToken).toHaveBeenCalledTimes(4);

        const source = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'src', 'services', 'rateMeService.js'),
            'utf8'
        );
        expect(source).toContain('randomBytes(24)');
        expect(source).toContain("toString('base64url')");
        expect(source).not.toContain('randomBytes(8)');
    });

    test('TC-P5-01 · disconnected tokens resolve to null and work again after reconnect', async () => {
        mockGetConnectedRateMeMeta.mockResolvedValueOnce(null);
        await expect(service.getPublicContext(TOKEN_X, null)).resolves.toBeNull();
        expect(mockGetPresignedUrl).not.toHaveBeenCalled();

        mockGetConnectedRateMeMeta.mockResolvedValueOnce(META);
        await expect(service.getPublicContext(TOKEN_X, null)).resolves.toEqual({
            company_name: 'Boston Masters',
            company_logo_url: 'https://s3.example/presigned',
            technician_name: 'Alex Petrov',
            already_rated: false,
            five_star_redirect: true,
        });
        expect(mockGetTokenContext).toHaveBeenCalledTimes(2);
    });

    test('TC-P9-01 · logo presigning is best-effort and skipped for a null key', async () => {
        mockGetPresignedUrl.mockRejectedValueOnce(new Error('S3 unavailable'));
        await expect(service.getPublicContext(TOKEN_X, null)).resolves.toMatchObject({
            company_logo_url: null,
            company_name: 'Boston Masters',
            technician_name: 'Alex Petrov',
        });

        mockGetPresignedUrl.mockClear();
        mockGetTokenContext.mockResolvedValueOnce({
            ...CONTEXT,
            logo_storage_key: null,
        });
        await expect(service.getPublicContext(TOKEN_X, null)).resolves.toMatchObject({
            company_logo_url: null,
        });
        expect(mockGetPresignedUrl).not.toHaveBeenCalled();
    });

    test('TC-P12-02 · feedback is trimmed, null-normalized, and silently capped at 2000', async () => {
        const rows = [
            ['   ', null],
            ['', null],
            ['x'.repeat(2001), 'x'.repeat(2000)],
            ['y'.repeat(2000), 'y'.repeat(2000)],
        ];

        for (const [feedback, expected] of rows) {
            mockInsertRating.mockClear();
            await service.submitRating(TOKEN_X, { stars: 3, feedback }, null);
            expect(mockInsertRating.mock.calls[0][0].feedback).toBe(expected);
        }
    });

    test('TC-P16-01 · concurrent insert conflict returns replay without redirect', async () => {
        mockInsertRating
            .mockResolvedValueOnce({ id: 900 })
            .mockResolvedValueOnce(undefined);

        const [winner, loser] = await Promise.all([
            service.submitRating(TOKEN_X, { stars: 5 }, null),
            service.submitRating(TOKEN_X, { stars: 5 }, null),
        ]);

        expect(winner).toEqual({
            recorded: true,
            next: 'google_redirect',
            redirect_url: 'https://g.page/r/abc/review',
        });
        expect(loser).toEqual({
            recorded: false,
            already_recorded: true,
            next: 'thanks',
        });
        expect(mockStampTokenUsed).toHaveBeenCalledTimes(1);
        expect(client.query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(2);
        expect(client.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2);
        expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
    });

    test('TC-P18-01 · storage failure rolls back and never produces a redirect', async () => {
        mockInsertRating.mockRejectedValue(new Error('rating insert failed'));

        const promise = service.submitRating(TOKEN_X, { stars: 5 }, null);
        await expect(promise).rejects.toThrow('rating insert failed');
        expect(client.query).toHaveBeenCalledWith('BEGIN');
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.query).not.toHaveBeenCalledWith('COMMIT');
        expect(mockStampTokenUsed).not.toHaveBeenCalled();
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('TC-H11-01 · host cache memoizes positives/negatives, clears on mutations, and caps at 1000', async () => {
        mockGetServableDomain.mockResolvedValue({
            company_id: COMPANY_X,
            domain: 'rate.a.com',
            status: 'verified',
        });
        for (let i = 0; i < 5; i += 1) await service.resolveDomainCompany('rate.a.com');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(1);

        service = freshService();
        mockGetServableDomain.mockClear();
        mockGetServableDomain.mockResolvedValue(null);
        for (let i = 0; i < 5; i += 1) await service.resolveDomainCompany('rate.a.com');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(1);

        service = freshService();
        mockGetServableDomain.mockClear();
        mockGetServableDomain.mockResolvedValue({
            company_id: COMPANY_X,
            domain: 'rate.a.com',
            status: 'verified',
        });
        mockUpsertDomainForCompany.mockResolvedValue({
            domain: 'rate.b.com',
            status: 'pending',
        });
        await service.resolveDomainCompany('rate.a.com');
        await service.setCustomDomain(COMPANY_X, 'crm-1', 'rate.b.com');
        await service.resolveDomainCompany('rate.a.com');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(2);

        service = freshService();
        mockGetServableDomain.mockClear();
        mockGetServableDomain.mockResolvedValue({
            company_id: COMPANY_X,
            domain: 'rate.a.com',
            status: 'verified',
        });
        mockDeleteDomain.mockResolvedValue({ domain: 'rate.a.com', status: 'verified' });
        await service.resolveDomainCompany('rate.a.com');
        await service.removeDomain(COMPANY_X, 'crm-1');
        await service.resolveDomainCompany('rate.a.com');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(2);

        service = freshService();
        mockGetServableDomain.mockClear();
        mockGetServableDomain.mockResolvedValue({
            company_id: COMPANY_X,
            domain: 'rate.a.com',
            status: 'verified',
        });
        mockGetDomainByCompany.mockResolvedValue({ domain: 'rate.a.com', status: 'pending' });
        mockSetDomainStatus.mockResolvedValue({ domain: 'rate.a.com', status: 'verified' });
        await service.resolveDomainCompany('rate.a.com');
        await service.verifyDomain(COMPANY_X, 'crm-1');
        await service.resolveDomainCompany('rate.a.com');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(2);

        service = freshService();
        mockGetServableDomain.mockClear();
        mockGetServableDomain.mockResolvedValue(null);
        for (let i = 0; i < 1001; i += 1) {
            await service.resolveDomainCompany(`h${i}.rate.example.com`);
        }
        await service.resolveDomainCompany('h0.rate.example.com');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(1002);
    });
});
