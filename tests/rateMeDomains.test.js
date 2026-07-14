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
const COMPANY_Y = '00000000-0000-0000-0000-000000000002';
const TOKEN_X = 'Xtok_'.padEnd(32, 'x');
const META = {
    metadata: { settings: { google_review_url: 'https://g.page/r/abc/review' } },
    installation_id: 7,
    app_id: 'app-rate',
};
const PENDING_DOMAIN = {
    domain: 'rate.bostonmasters.com',
    status: 'pending',
    verified_at: null,
    activated_at: null,
    last_checked_at: null,
    last_error: null,
};
const VERIFIED_AT = '2026-07-13T12:00:00.000Z';
const ACTIVATED_AT = '2026-07-13T12:01:00.000Z';

let service;

function freshService() {
    jest.resetModules();
    return require('../backend/src/services/rateMeService');
}

function setupDefaults() {
    mockGetConnectedRateMeMeta.mockResolvedValue(META);
    mockGetDomainByCompany.mockResolvedValue({ ...PENDING_DOMAIN });
    mockGetServableDomain.mockResolvedValue(null);
    mockUpsertDomainForCompany.mockImplementation(async (companyId, domain) => ({
        ...PENDING_DOMAIN,
        domain,
    }));
    mockSetDomainStatus.mockImplementation(async (companyId, status, options = {}) => ({
        ...PENDING_DOMAIN,
        status,
        verified_at: options.setVerifiedAt ? VERIFIED_AT : PENDING_DOMAIN.verified_at,
        activated_at: options.setActivatedAt ? ACTIVATED_AT : PENDING_DOMAIN.activated_at,
        last_checked_at: options.setLastCheckedAt ? VERIFIED_AT : PENDING_DOMAIN.last_checked_at,
        last_error: options.updateLastError ? options.lastError : PENDING_DOMAIN.last_error,
    }));
    mockDeleteDomain.mockResolvedValue({ ...PENDING_DOMAIN });
    mockWriteEvent.mockResolvedValue({});
    mockResolveCname.mockResolvedValue(['rate.albusto.com']);
    mockInsertToken.mockResolvedValue({ id: 501 });
    mockGetTokenContext.mockResolvedValue({
        id: 501,
        company_id: COMPANY_X,
        company_name: 'Boston Masters',
        logo_storage_key: null,
        technician_name: 'Alex Petrov',
        already_rated: false,
    });
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

describe('RATE-ME-CRM-001 custom-domain service', () => {
    test('TC-D1-01 · setting a domain normalizes, stores, audits, and clears host cache', async () => {
        mockGetServableDomain.mockResolvedValue({
            company_id: COMPANY_X,
            domain: 'rate.bostonmasters.com',
            status: 'verified',
        });
        await service.resolveDomainCompany('rate.bostonmasters.com');

        const result = await service.setCustomDomain(
            COMPANY_X,
            'crm-1',
            'Rate.BostonMasters.com.'
        );
        await service.resolveDomainCompany('rate.bostonmasters.com');

        expect(result).toEqual(PENDING_DOMAIN);
        expect(mockUpsertDomainForCompany).toHaveBeenCalledWith(
            COMPANY_X,
            'rate.bostonmasters.com'
        );
        expect(mockWriteEvent).toHaveBeenCalledTimes(1);
        expect(mockWriteEvent).toHaveBeenCalledWith({
            companyId: COMPANY_X,
            installationId: 7,
            appId: 'app-rate',
            actorId: 'crm-1',
            eventType: 'domain_added',
            payload: { app_key: 'rate-me', domain: 'rate.bostonmasters.com' },
        });
        expect(mockGetServableDomain).toHaveBeenCalledTimes(2);
    });

    test('TC-D1-02 · normalizeDomain handles case, trailing dots, and IDN punycode', () => {
        expect(service.normalizeDomain('  Rate.BostonMasters.com.  '))
            .toBe('rate.bostonmasters.com');
        expect(service.normalizeDomain('rate.бостон.com')).toMatch(/^rate\.xn--.*\.com$/);
        expect(service.normalizeDomain('REVIEWS.ACME.CO')).toBe('reviews.acme.co');
    });

    test('TC-D2-01 · invalid hostnames reject without storing or auditing', async () => {
        const invalidDomains = [
            'not a host',
            'ha!.com',
            `${'a'.repeat(254)}.com`,
            'rate..double.com',
        ];

        for (const domain of invalidDomains) {
            await expectServiceError(
                service.setCustomDomain(COMPANY_X, 'crm-1', domain),
                'INVALID_DOMAIN',
                400
            );
        }
        expect(mockUpsertDomainForCompany).not.toHaveBeenCalled();
        expect(mockWriteEvent).not.toHaveBeenCalled();
    });

    test('TC-D3-01 · apex rejection embeds the tenant domain and documents the co.uk limitation', async () => {
        const error = await expectServiceError(
            service.setCustomDomain(COMPANY_X, 'crm-1', 'bostonmasters.com'),
            'APEX_DOMAIN_NOT_SUPPORTED',
            400
        );
        expect(error.message).toBe(
            "Use a subdomain like rate.bostonmasters.com — root domains can't carry a CNAME record."
        );

        await expect(service.setCustomDomain(COMPANY_X, 'crm-1', 'example.co.uk'))
            .resolves.toMatchObject({ domain: 'example.co.uk', status: 'pending' });
        expect(mockUpsertDomainForCompany).toHaveBeenCalledWith(COMPANY_X, 'example.co.uk');
    });

    test('TC-D4-01 · Albusto-family hostnames are reserved', async () => {
        for (const domain of ['rate.albusto.com', 'albusto.com', 'foo.albusto.com']) {
            await expectServiceError(
                service.setCustomDomain(COMPANY_X, 'crm-1', domain),
                'RESERVED_DOMAIN',
                400
            );
        }
        expect(mockUpsertDomainForCompany).not.toHaveBeenCalled();
        expect(mockWriteEvent).not.toHaveBeenCalled();
    });

    test('TC-D5-01 · a unique conflict is a non-disclosing HTTP 400 DOMAIN_TAKEN', async () => {
        mockUpsertDomainForCompany.mockRejectedValue(
            Object.assign(new Error(`held by ${COMPANY_Y}`), { code: '23505' })
        );

        const error = await expectServiceError(
            service.setCustomDomain(COMPANY_X, 'crm-1', 'rate.bostonmasters.com'),
            'DOMAIN_TAKEN',
            400
        );
        expect(error.message).toBe('This domain is already in use.');
        expect(error.message).not.toContain(COMPANY_Y);
        expect(mockWriteEvent).not.toHaveBeenCalled();
    });

    test('TC-D6-01 · replacing the owned domain returns the reset row and invalidates the old host', async () => {
        const resetRow = {
            domain: 'rate.b.com',
            status: 'pending',
            verified_at: null,
            activated_at: null,
            last_checked_at: null,
            last_error: null,
        };
        mockGetServableDomain
            .mockResolvedValueOnce({
                company_id: COMPANY_X,
                domain: 'rate.a.com',
                status: 'active',
            })
            .mockResolvedValueOnce(null);
        mockUpsertDomainForCompany.mockResolvedValue(resetRow);

        await service.resolveDomainCompany('rate.a.com');
        await expect(service.setCustomDomain(COMPANY_X, 'crm-1', 'rate.b.com'))
            .resolves.toEqual(resetRow);
        await expect(service.resolveDomainCompany('rate.a.com')).resolves.toBeNull();

        expect(mockUpsertDomainForCompany).toHaveBeenCalledWith(COMPANY_X, 'rate.b.com');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(2);
        expect(mockWriteEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'domain_added',
            payload: { app_key: 'rate-me', domain: 'rate.b.com' },
        }));
    });

    test('TC-D7-01 · pending and failed rows verify with normalized CNAME targets', async () => {
        const variants = [
            { status: 'pending', targets: ['rate.albusto.com'] },
            { status: 'failed', targets: ['rate.albusto.com'] },
            { status: 'pending', targets: ['RATE.ALBUSTO.COM.'] },
        ];

        for (const variant of variants) {
            mockGetDomainByCompany.mockResolvedValueOnce({
                ...PENDING_DOMAIN,
                status: variant.status,
            });
            mockResolveCname.mockResolvedValueOnce(variant.targets);
            mockSetDomainStatus.mockResolvedValueOnce({
                ...PENDING_DOMAIN,
                status: 'verified',
                verified_at: VERIFIED_AT,
                last_checked_at: VERIFIED_AT,
            });
            await expect(service.verifyDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
                status: 'verified',
                verified_at: VERIFIED_AT,
                last_checked_at: VERIFIED_AT,
                last_error: null,
            });
        }

        expect(mockSetDomainStatus).toHaveBeenCalledTimes(3);
        for (const call of mockSetDomainStatus.mock.calls) {
            expect(call).toEqual([
                COMPANY_X,
                'verified',
                {
                    setLastCheckedAt: true,
                    setVerifiedAt: true,
                    updateLastError: true,
                    lastError: null,
                },
            ]);
        }
        expect(mockWriteEvent).toHaveBeenCalledTimes(3);
        expect(mockWriteEvent).toHaveBeenCalledWith(expect.objectContaining({
            actorId: 'crm-1',
            eventType: 'domain_verified',
            payload: { app_key: 'rate-me', domain: 'rate.bostonmasters.com' },
        }));
    });

    test('TC-D8-01 · wrong CNAME targets fail with the exact humane copy', async () => {
        mockResolveCname.mockResolvedValue(['foo.vercel.app']);
        mockSetDomainStatus.mockResolvedValue({
            ...PENDING_DOMAIN,
            status: 'failed',
            last_checked_at: VERIFIED_AT,
            last_error: 'The CNAME points to foo.vercel.app — it needs to point to rate.albusto.com.',
        });

        const result = await service.verifyDomain(COMPANY_X, 'crm-1');
        expect(result.status).toBe('failed');
        expect(result.last_error).toBe(
            'The CNAME points to foo.vercel.app — it needs to point to rate.albusto.com.'
        );
        expect(mockSetDomainStatus).toHaveBeenCalledWith(COMPANY_X, 'failed', {
            setLastCheckedAt: true,
            updateLastError: true,
            lastError: 'The CNAME points to foo.vercel.app — it needs to point to rate.albusto.com.',
        });
        expect(mockWriteEvent).not.toHaveBeenCalled();
    });

    test('TC-D9-01 · ENOTFOUND and ENODATA fail with the exact DNS propagation copy', async () => {
        const expected = "We can't see the CNAME record yet — DNS changes can take up to an hour. Check the record and try again. If your DNS provider proxies traffic (e.g. Cloudflare's orange cloud), switch the record to DNS-only.";
        for (const code of ['ENOTFOUND', 'ENODATA']) {
            mockResolveCname.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
            mockSetDomainStatus.mockResolvedValueOnce({
                ...PENDING_DOMAIN,
                status: 'failed',
                last_error: expected,
            });
            await expect(service.verifyDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
                status: 'failed',
                last_error: expected,
            });
        }
        expect(mockSetDomainStatus).toHaveBeenNthCalledWith(1, COMPANY_X, 'failed', {
            setLastCheckedAt: true,
            updateLastError: true,
            lastError: expected,
        });
        expect(mockSetDomainStatus).toHaveBeenNthCalledWith(2, COMPANY_X, 'failed', {
            setLastCheckedAt: true,
            updateLastError: true,
            lastError: expected,
        });
    });

    test('TC-D10-01 · transport errors preserve status and use a five-second Promise.race', async () => {
        const retryCopy = "We couldn't check DNS just now — please try again in a minute.";
        const rows = [
            { status: 'pending', code: 'ETIMEOUT' },
            { status: 'failed', code: 'ECONNREFUSED' },
        ];
        for (const row of rows) {
            mockGetDomainByCompany.mockResolvedValueOnce({ ...PENDING_DOMAIN, status: row.status });
            mockResolveCname.mockRejectedValueOnce(Object.assign(new Error(row.code), {
                code: row.code,
            }));
            mockSetDomainStatus.mockResolvedValueOnce({
                ...PENDING_DOMAIN,
                status: row.status,
                last_checked_at: VERIFIED_AT,
                last_error: retryCopy,
            });
            await expect(service.verifyDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
                status: row.status,
                last_checked_at: VERIFIED_AT,
                last_error: retryCopy,
            });
        }
        expect(mockSetDomainStatus).toHaveBeenNthCalledWith(1, COMPANY_X, 'pending', {
            setLastCheckedAt: true,
            updateLastError: true,
            lastError: retryCopy,
        });
        expect(mockSetDomainStatus).toHaveBeenNthCalledWith(2, COMPANY_X, 'failed', {
            setLastCheckedAt: true,
            updateLastError: true,
            lastError: retryCopy,
        });

        const source = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'src', 'services', 'rateMeService.js'),
            'utf8'
        );
        expect(source).toContain('Promise.race');
        expect(source).toContain('5000');
    });

    test('TC-D11-01 · re-verification never demotes verified or active rows', async () => {
        mockGetDomainByCompany.mockResolvedValueOnce({ ...PENDING_DOMAIN, status: 'failed' });
        mockResolveCname.mockResolvedValueOnce(['rate.albusto.com']);
        mockSetDomainStatus.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'verified',
            verified_at: VERIFIED_AT,
        });
        await expect(service.verifyDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
            status: 'verified',
        });

        mockGetDomainByCompany.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'verified',
            verified_at: VERIFIED_AT,
        });
        mockResolveCname.mockResolvedValueOnce(['foo.vercel.app']);
        mockSetDomainStatus.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'verified',
            verified_at: VERIFIED_AT,
        });
        await expect(service.verifyDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
            status: 'verified',
            verified_at: VERIFIED_AT,
        });

        mockGetDomainByCompany.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'verified',
            verified_at: VERIFIED_AT,
        });
        mockResolveCname.mockRejectedValueOnce(Object.assign(new Error('missing'), {
            code: 'ENOTFOUND',
        }));
        mockSetDomainStatus.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'verified',
            verified_at: VERIFIED_AT,
        });
        await expect(service.verifyDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
            status: 'verified',
        });

        mockGetDomainByCompany.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'active',
            verified_at: VERIFIED_AT,
            activated_at: ACTIVATED_AT,
        });
        mockResolveCname.mockResolvedValueOnce(['rate.albusto.com']);
        mockSetDomainStatus.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'active',
            verified_at: VERIFIED_AT,
            activated_at: ACTIVATED_AT,
        });
        await expect(service.verifyDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
            status: 'active',
            activated_at: ACTIVATED_AT,
        });

        mockGetDomainByCompany.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'active',
            verified_at: VERIFIED_AT,
            activated_at: ACTIVATED_AT,
        });
        mockResolveCname.mockRejectedValueOnce(Object.assign(new Error('missing'), {
            code: 'ENOTFOUND',
        }));
        mockSetDomainStatus.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'active',
            verified_at: VERIFIED_AT,
            activated_at: ACTIVATED_AT,
        });
        await expect(service.verifyDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
            status: 'active',
            activated_at: ACTIVATED_AT,
        });

        expect(mockSetDomainStatus.mock.calls.map((call) => call[1]))
            .toEqual(['verified', 'verified', 'verified', 'active', 'active']);
        expect(mockSetDomainStatus.mock.calls[3][2]).toEqual({ setLastCheckedAt: true });
        expect(mockWriteEvent.mock.calls.filter(([event]) => (
            event.eventType === 'domain_verified'
        ))).toHaveLength(1);
    });

    test('TC-D12-01 · verify without a domain rejects before constructing a resolver', async () => {
        mockGetDomainByCompany.mockResolvedValue(null);

        await expectServiceError(
            service.verifyDomain(COMPANY_X, 'crm-1'),
            'DOMAIN_NOT_FOUND',
            404
        );
        expect(mockResolveCname).not.toHaveBeenCalled();
        expect(mockSetDomainStatus).not.toHaveBeenCalled();
    });

    test('TC-D13-01 · removal audits, clears caches, and rejects a missing row', async () => {
        mockGetServableDomain
            .mockResolvedValueOnce({
                company_id: COMPANY_X,
                domain: 'rate.bostonmasters.com',
                status: 'verified',
            })
            .mockResolvedValueOnce(null);
        mockDeleteDomain.mockResolvedValueOnce({
            ...PENDING_DOMAIN,
            status: 'verified',
        });

        await service.resolveDomainCompany('rate.bostonmasters.com');
        await expect(service.removeDomain(COMPANY_X, 'crm-1')).resolves.toMatchObject({
            domain: 'rate.bostonmasters.com',
        });
        await expect(service.resolveDomainCompany('rate.bostonmasters.com')).resolves.toBeNull();
        expect(mockWriteEvent).toHaveBeenCalledWith({
            companyId: COMPANY_X,
            installationId: 7,
            appId: 'app-rate',
            actorId: 'crm-1',
            eventType: 'domain_removed',
            payload: { app_key: 'rate-me', domain: 'rate.bostonmasters.com' },
        });
        expect(mockGetServableDomain).toHaveBeenCalledTimes(2);

        mockDeleteDomain.mockResolvedValueOnce(null);
        await expectServiceError(
            service.removeDomain(COMPANY_X, 'crm-1'),
            'DOMAIN_NOT_FOUND',
            404
        );
    });

    test('TC-D17-01 · ask decisions share the bounded 60-second mutation-cleared cache', async () => {
        mockGetServableDomain.mockResolvedValue({
            company_id: COMPANY_X,
            domain: 'rate.a.com',
            status: 'active',
        });
        for (let i = 0; i < 10; i += 1) {
            await expect(service.authorizeAskDomain('rate.a.com')).resolves.toBe(true);
        }
        expect(mockGetServableDomain).toHaveBeenCalledTimes(1);
        expect(mockGetConnectedRateMeMeta).toHaveBeenCalledTimes(1);

        mockDeleteDomain.mockResolvedValue({ domain: 'rate.a.com', status: 'active' });
        await service.removeDomain(COMPANY_X, 'crm-1');
        mockGetServableDomain.mockResolvedValueOnce(null);
        await expect(service.authorizeAskDomain('rate.a.com')).resolves.toBe(false);
        expect(mockGetServableDomain).toHaveBeenCalledTimes(2);

        service = freshService();
        mockGetServableDomain.mockClear();
        mockGetServableDomain.mockResolvedValue(null);
        for (let i = 0; i < 1001; i += 1) {
            await service.authorizeAskDomain(`h${i}.rate.example.com`);
        }
        await service.authorizeAskDomain('h0.rate.example.com');
        expect(mockGetServableDomain).toHaveBeenCalledTimes(1002);
    });

    test('TC-D18-01 · disconnect gates serving and all management while preserving the domain row', async () => {
        mockGetServableDomain.mockResolvedValue({
            company_id: COMPANY_X,
            domain: 'rate.bostonmasters.com',
            status: 'verified',
        });
        mockGetConnectedRateMeMeta.mockResolvedValue(null);

        await expect(service.authorizeAskDomain('rate.bostonmasters.com')).resolves.toBe(false);
        await expect(service.getPublicContext(TOKEN_X, null)).resolves.toBeNull();
        for (const operation of [
            () => service.setCustomDomain(COMPANY_X, 'crm-1', 'rate.bostonmasters.com'),
            () => service.verifyDomain(COMPANY_X, 'crm-1'),
            () => service.removeDomain(COMPANY_X, 'crm-1'),
            () => service.mintToken(COMPANY_X, { techId: 'zb-77' }),
        ]) {
            await expectServiceError(operation(), 'APP_NOT_INSTALLED', 404);
        }
        expect(mockDeleteDomain).not.toHaveBeenCalled();
        expect(mockUpsertDomainForCompany).not.toHaveBeenCalled();
        expect(mockSetDomainStatus).not.toHaveBeenCalled();

        service = freshService();
        mockGetConnectedRateMeMeta.mockResolvedValue(META);
        mockGetServableDomain.mockResolvedValue({
            company_id: COMPANY_X,
            domain: 'rate.bostonmasters.com',
            status: 'active',
        });
        await expect(service.authorizeAskDomain('rate.bostonmasters.com')).resolves.toBe(true);
        expect(mockSetDomainStatus).not.toHaveBeenCalled();
        expect(mockWriteEvent).not.toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'domain_verified',
        }));
    });
});
