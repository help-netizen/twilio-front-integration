'use strict';

const fs = require('fs');
const path = require('path');

const mockDbQuery = jest.fn();
const mockGetClient = jest.fn();
const mockInsertToken = jest.fn();
const mockGetTokenContext = jest.fn();
const mockGetExpiredTokenBranding = jest.fn();
const mockStampTokenOpened = jest.fn();
const mockStampGoogleClick = jest.fn();
const mockStampTokenSent = jest.fn();
const mockGetJobRateStatus = jest.fn();
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
    getExpiredTokenBranding: mockGetExpiredTokenBranding,
    stampTokenOpened: mockStampTokenOpened,
    stampGoogleClick: mockStampGoogleClick,
    stampTokenSent: mockStampTokenSent,
    getJobRateStatus: mockGetJobRateStatus,
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
const EXPIRED_TOKEN = 'Etok_'.padEnd(32, 'e');
const META = {
    metadata: {
        settings: {
            google_review_url: 'https://g.page/r/abc/review',
            booking_url: 'https://book.bostonmasters.com',
        },
    },
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
    contact_first_name: 'Sarah',
    customer_name: 'Sarah Chen',
    service_name: 'Refrigerator repair',
    start_date: '2024-07-12T14:00:00.000Z',
    company_timezone: 'America/New_York',
    company_phone: '+16175551234',
    company_email: 'hello@bostonmasters.com',
    already_rated: false,
    expires_at: null,
    used_at: null,
};
const EXPIRED_CONTEXT = {
    company_id: COMPANY_X,
    company_name: 'Boston Masters',
    logo_storage_key: 'logos/x.png',
    contact_phone: '+16175551234',
    contact_email: 'hello@bostonmasters.com',
};
const LIVE_KEYS = [
    'already_rated',
    'booking_url',
    'company_email',
    'company_logo_url',
    'company_name',
    'company_phone',
    'expired',
    'first_name',
    'five_star_redirect',
    'service_label',
    'technician_name',
    'visit_date',
];
const EXPIRED_KEYS = [
    'booking_url',
    'company_email',
    'company_logo_url',
    'company_name',
    'company_phone',
    'expired',
];

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
    mockGetExpiredTokenBranding.mockResolvedValue(undefined);
    mockStampTokenOpened.mockResolvedValue({ id: 501 });
    mockStampGoogleClick.mockResolvedValue({ id: 501 });
    mockStampTokenSent.mockResolvedValue({ id: 501 });
    mockGetJobRateStatus.mockResolvedValue({ has_token: false, rating: null });
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
            first_name: 'Sarah',
            service_label: 'Refrigerator repair',
            visit_date: 'Friday, Jul 12',
            company_phone: '+16175551234',
            company_email: 'hello@bostonmasters.com',
            booking_url: 'https://book.bostonmasters.com',
            five_star_redirect: true,
            already_rated: false,
            expired: false,
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

    test('TC-RM2-SV-01 · live context is exactly the 12-key PII-minimal whitelist', async () => {
        const result = await service.getPublicContext(TOKEN_X, null);

        expect(Object.keys(result).sort()).toEqual(LIVE_KEYS);
        expect(result).toEqual({
            company_name: 'Boston Masters',
            company_logo_url: 'https://s3.example/presigned',
            technician_name: 'Alex Petrov',
            first_name: 'Sarah',
            service_label: 'Refrigerator repair',
            visit_date: 'Friday, Jul 12',
            company_phone: '+16175551234',
            company_email: 'hello@bostonmasters.com',
            booking_url: 'https://book.bostonmasters.com',
            five_star_redirect: true,
            already_rated: false,
            expired: false,
        });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('Sarah Chen');
        expect(serialized).not.toContain('job_id');
        expect(serialized).not.toContain('expires_at');
        expect(serialized).not.toContain('2024-07-12T14:00:00.000Z');
        expect(serialized).not.toContain('https://g.page/r/abc/review');
        expect(mockStampTokenOpened).toHaveBeenCalledWith(CONTEXT.id);
    });

    test('TC-RM2-SV-02 · first name uses contact then customer-name fallback then null', async () => {
        const rows = [
            [{ ...CONTEXT, contact_first_name: null, customer_name: 'Sarah Chen' }, 'Sarah'],
            [{ ...CONTEXT, contact_first_name: null, customer_name: null }, null],
            [{ ...CONTEXT, contact_first_name: 'Maya', customer_name: 'Sarah Chen' }, 'Maya'],
        ];

        for (const [context, expected] of rows) {
            mockGetTokenContext.mockResolvedValueOnce(context);
            const result = await service.getPublicContext(TOKEN_X, null);
            expect(Object.keys(result).sort()).toEqual(LIVE_KEYS);
            expect(result.first_name).toBe(expected);
            expect(JSON.stringify(result)).not.toContain('Sarah Chen');
        }
    });

    test('TC-RM2-SV-03 · missing service and visit date stay null without dropping keys', async () => {
        mockGetTokenContext.mockResolvedValue({
            ...CONTEXT,
            job_id: null,
            service_name: null,
            start_date: null,
            customer_name: null,
            contact_first_name: null,
        });

        const result = await service.getPublicContext(TOKEN_X, null);

        expect(Object.keys(result).sort()).toEqual(LIVE_KEYS);
        expect(result).toMatchObject({
            first_name: null,
            service_label: null,
            visit_date: null,
        });
    });

    test('TC-RM2-SV-04 · formatVisitDate uses company timezone and safely rejects bad input', async () => {
        const startDate = '2024-07-12T04:30:00.000Z';

        expect(service.formatVisitDate(startDate, 'America/Los_Angeles'))
            .toBe('Thursday, Jul 11');
        expect(service.formatVisitDate(startDate, 'America/New_York'))
            .toBe('Friday, Jul 12');
        expect(service.formatVisitDate(startDate))
            .toBe('Friday, Jul 12');
        expect(service.formatVisitDate(startDate, 'Not/AZone')).toBeNull();
        expect(service.formatVisitDate('not-a-date', 'America/New_York')).toBeNull();
        expect(service.formatVisitDate(null, 'America/New_York')).toBeNull();

        mockGetTokenContext.mockResolvedValue({
            ...CONTEXT,
            start_date: startDate,
            company_timezone: 'Not/AZone',
        });
        const result = await service.getPublicContext(TOKEN_X, null);
        expect(Object.keys(result).sort()).toEqual(LIVE_KEYS);
        expect(result.visit_date).toBeNull();
    });

    test('TC-RM2-SV-05 · already-rated live context remains personalized and stamps opened', async () => {
        mockGetTokenContext.mockResolvedValue({ ...CONTEXT, already_rated: true });

        const result = await service.getPublicContext(TOKEN_X, null);

        expect(Object.keys(result).sort()).toEqual(LIVE_KEYS);
        expect(result).toMatchObject({
            already_rated: true,
            expired: false,
            first_name: 'Sarah',
            technician_name: 'Alex Petrov',
        });
        expect(mockStampTokenOpened).toHaveBeenCalledWith(CONTEXT.id);
    });

    test('TC-RM2-SV-06 · expired context is exactly the 6-key branded whitelist without stamp', async () => {
        mockGetTokenContext.mockResolvedValue(undefined);
        mockGetExpiredTokenBranding.mockResolvedValue({ ...EXPIRED_CONTEXT });

        const result = await service.getPublicContext(EXPIRED_TOKEN, null);

        expect(Object.keys(result).sort()).toEqual(EXPIRED_KEYS);
        expect(result).toEqual({
            company_name: 'Boston Masters',
            company_logo_url: 'https://s3.example/presigned',
            company_phone: '+16175551234',
            company_email: 'hello@bostonmasters.com',
            booking_url: 'https://book.bostonmasters.com',
            expired: true,
        });
        expect(mockStampTokenOpened).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('five_star_redirect');
        expect(JSON.stringify(result)).not.toContain('technician_name');
    });

    test('TC-RM2-SV-07 · disconnected and unknown tokens return null without leaking branding', async () => {
        mockGetConnectedRateMeMeta.mockResolvedValue(null);

        await expect(service.getPublicContext(TOKEN_X, null)).resolves.toBeNull();
        expect(mockGetExpiredTokenBranding).not.toHaveBeenCalled();

        mockGetTokenContext.mockResolvedValueOnce(undefined);
        mockGetExpiredTokenBranding.mockResolvedValueOnce(undefined);
        await expect(service.getPublicContext(TOKEN_X, null)).resolves.toBeNull();

        mockGetTokenContext.mockResolvedValueOnce(undefined);
        mockGetExpiredTokenBranding.mockResolvedValueOnce({ ...EXPIRED_CONTEXT });
        await expect(service.getPublicContext(EXPIRED_TOKEN, null)).resolves.toBeNull();

        expect(mockGetPresignedUrl).not.toHaveBeenCalled();
        expect(mockStampTokenOpened).not.toHaveBeenCalled();
    });

    test('TC-RM2-SV-08 · opened-at stamp is live-only and best-effort', async () => {
        await expect(service.getPublicContext(TOKEN_X, null)).resolves
            .toMatchObject({ expired: false });
        expect(mockStampTokenOpened).toHaveBeenCalledWith(CONTEXT.id);

        mockStampTokenOpened.mockRejectedValueOnce(new Error('stamp failed'));
        const liveResult = await service.getPublicContext(TOKEN_X, null);
        expect(Object.keys(liveResult).sort()).toEqual(LIVE_KEYS);

        mockStampTokenOpened.mockClear();
        mockGetTokenContext.mockResolvedValueOnce(undefined);
        mockGetExpiredTokenBranding.mockResolvedValueOnce({ ...EXPIRED_CONTEXT });
        await expect(service.getPublicContext(EXPIRED_TOKEN, null)).resolves
            .toMatchObject({ expired: true });
        expect(mockStampTokenOpened).not.toHaveBeenCalled();
    });

    test('TC-RM2-SV-09 · recordGoogleClick is host-bound and stamps only the token row id', async () => {
        await expect(service.recordGoogleClick(TOKEN_X, COMPANY_X)).resolves
            .toEqual({ ok: true });
        expect(mockGetTokenContext).toHaveBeenCalledWith(TOKEN_X, COMPANY_X);
        expect(mockStampGoogleClick).toHaveBeenCalledWith(CONTEXT.id);

        mockStampGoogleClick.mockClear();
        mockGetTokenContext.mockResolvedValueOnce(undefined);
        await expect(service.recordGoogleClick(TOKEN_X, COMPANY_X)).resolves.toBeNull();

        mockGetConnectedRateMeMeta.mockResolvedValueOnce(null);
        await expect(service.recordGoogleClick(TOKEN_X, COMPANY_X)).resolves.toBeNull();
        expect(mockStampGoogleClick).not.toHaveBeenCalled();
    });

    test('TC-RM2-SV-10 · bookingUrl returns only a non-empty string setting', () => {
        expect(service.bookingUrl({ settings: { booking_url: 'https://book.co/x' } }))
            .toBe('https://book.co/x');
        expect(service.bookingUrl({ settings: { booking_url: null } })).toBeNull();
        expect(service.bookingUrl({ settings: {} })).toBeNull();
        expect(service.bookingUrl({})).toBeNull();
        expect(service.bookingUrl(undefined)).toBeNull();
        expect(service.bookingUrl({ settings: { booking_url: 42 } })).toBeNull();
        expect(service.bookingUrl({ settings: { booking_url: '' } })).toBeNull();
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
