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

const mockSettingsGetPublishedAppByKey = jest.fn();
const mockSettingsFindActiveInstallation = jest.fn();
const mockSettingsSetInstallationSettings = jest.fn();
const mockSettingsRadiusGetSettings = jest.fn();
const mockSettingsCountListZips = jest.fn();
const mockSettingsListRadii = jest.fn();

jest.mock('../backend/src/db/territoryRadiusQueries', () => ({
    getSettings: mockSettingsRadiusGetSettings,
    countListZips: mockSettingsCountListZips,
    listRadii: mockSettingsListRadii,
}));
jest.mock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
jest.mock('../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: jest.fn(),
}));
jest.mock('../backend/src/services/integrationsService', () => ({
    createIntegration: jest.fn(),
}));
jest.mock('../backend/src/services/marketplaceProvisioningService', () => ({
    pushCredentials: jest.fn(),
    sanitizeErrorMessage: (message) => message,
}));
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getTelephonyState: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

const RELY_SETTINGS_APP = {
    id: 'app-rely',
    app_key: 'rely-leads',
    status: 'published',
};
const RATE_ME_SETTINGS_APP = {
    id: 'app-rate',
    app_key: 'rate-me',
    status: 'published',
};
const RELY_SEEDED_METADATA = {
    seeded_by: 'MARKETPLACE-LEADGEN-SPLIT-001',
    shared_credential: true,
};
const RELY_SETTINGS_INSTALLATION = {
    id: 7,
    company_id: COMPANY_X,
    app_id: RELY_SETTINGS_APP.id,
    status: 'connected',
    metadata: RELY_SEEDED_METADATA,
};
const RATE_ME_SETTINGS_INSTALLATION = {
    id: 8,
    company_id: COMPANY_X,
    app_id: RATE_ME_SETTINGS_APP.id,
    status: 'connected',
    metadata: {
        seeded_by: 'RATE-ME-CRM-001',
        settings: { google_review_url: 'https://g.page/r/abc/review' },
    },
};
const EXPECTED_RELY_UNIT_TYPES = [
    'Washer', 'Dryer', 'Refrigerator', 'Freezer', 'Dishwasher', 'Range',
    'Oven', 'Cooktop', 'Microwave', 'Ice Maker', 'Garbage Disposal', 'Vent Hood',
];
const EXPECTED_RELY_BRANDS = [
    'Whirlpool', 'GE', 'Samsung', 'LG', 'Maytag', 'Kenmore', 'KitchenAid',
    'Frigidaire', 'Bosch', 'Electrolux', 'Amana', 'Sub-Zero', 'Viking',
    'Thermador', 'Speed Queen',
];
const DEFAULT_RELY_SETTINGS = {
    zone: { mode: 'company', custom_zips: [] },
    unit_types: [],
    brands: [],
};

describe('RATE-ME-CRM-001 settings dispatch and authed surface', () => {
    let marketplaceSettingsService;
    let marketplaceRouter;
    let settingsQueries;
    let currentRelyInstallation;
    let currentRateMeInstallation;
    let lastStoredInstallation;

    function setupConnectedSettingsInstallations() {
        currentRelyInstallation = {
            ...RELY_SETTINGS_INSTALLATION,
            metadata: { ...RELY_SETTINGS_INSTALLATION.metadata },
        };
        currentRateMeInstallation = {
            ...RATE_ME_SETTINGS_INSTALLATION,
            metadata: {
                ...RATE_ME_SETTINGS_INSTALLATION.metadata,
                settings: { ...RATE_ME_SETTINGS_INSTALLATION.metadata.settings },
            },
        };
        mockSettingsGetPublishedAppByKey.mockImplementation(async (appKey) => {
            if (appKey === 'rely-leads') return RELY_SETTINGS_APP;
            if (appKey === 'rate-me') return RATE_ME_SETTINGS_APP;
            return null;
        });
        mockSettingsFindActiveInstallation.mockImplementation(async (companyId, appId) => {
            if (companyId !== COMPANY_X && companyId !== COMPANY_Y) return null;
            if (appId === RELY_SETTINGS_APP.id) return currentRelyInstallation;
            if (appId === RATE_ME_SETTINGS_APP.id) return currentRateMeInstallation;
            return null;
        });
        mockSettingsSetInstallationSettings.mockImplementation(
            async (companyId, installationId, settings) => {
                const current = installationId === currentRelyInstallation?.id
                    ? currentRelyInstallation
                    : currentRateMeInstallation;
                lastStoredInstallation = {
                    ...current,
                    id: installationId,
                    company_id: companyId,
                    metadata: { ...current.metadata, settings },
                };
                if (current === currentRelyInstallation) {
                    currentRelyInstallation = lastStoredInstallation;
                } else {
                    currentRateMeInstallation = lastStoredInstallation;
                }
                return lastStoredInstallation;
            }
        );
    }

    async function expectSettingsError(promise, code, httpStatus) {
        try {
            await promise;
            throw new Error(`Expected ${code}`);
        } catch (error) {
            expect(error).toBeInstanceOf(marketplaceSettingsService.MarketplaceServiceError);
            expect(error).toMatchObject({ code, httpStatus });
            return error;
        }
    }

    function buildMarketplaceApp() {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.companyFilter = { company_id: COMPANY_Y };
            req.user = { crmUser: { id: 'crm-b' } };
            req.requestId = 'req-b';
            next();
        });
        app.use(marketplaceRouter);
        return app;
    }

    beforeEach(() => {
        settingsQueries = require('../backend/src/db/marketplaceQueries');
        settingsQueries.getPublishedAppByKey = mockSettingsGetPublishedAppByKey;
        settingsQueries.findActiveInstallation = mockSettingsFindActiveInstallation;
        settingsQueries.setInstallationSettings = mockSettingsSetInstallationSettings;

        setupConnectedSettingsInstallations();
        mockSettingsRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
        mockSettingsCountListZips.mockResolvedValue(12);
        mockSettingsListRadii.mockResolvedValue([{ id: 1 }]);
        lastStoredInstallation = null;

        marketplaceSettingsService = require('../backend/src/services/marketplaceService');
        marketplaceRouter = require('../backend/src/routes/marketplace');
    });

    test('TC-S1-01 · rely GET remains byte-identical through per-app dispatch', async () => {
        const result = await marketplaceSettingsService.getAppSettings(
            COMPANY_X,
            'rely-leads'
        );

        expect(result).toEqual({
            app_key: 'rely-leads',
            installation_id: 7,
            settings: DEFAULT_RELY_SETTINGS,
            catalogs: {
                unit_types: EXPECTED_RELY_UNIT_TYPES,
                brands: EXPECTED_RELY_BRANDS,
            },
            territory: { active_mode: 'list', has_data: true },
        });
        expect(marketplaceSettingsService.validateRelySettingsInput)
            .toEqual(expect.any(Function));
        expect(mockSettingsSetInstallationSettings).not.toHaveBeenCalled();
        expect(mockWriteEvent).not.toHaveBeenCalled();
    });

    test('TC-S2-01 · rely PUT and settings event payload remain byte-identical', async () => {
        const result = await marketplaceSettingsService.updateAppSettings(
            COMPANY_X,
            'crm-user-1',
            'rely-leads',
            { zone: { mode: 'custom', custom_zips: ['02301'] } },
            { requestId: 'req-audit' }
        );

        expect(result).toEqual({
            app_key: 'rely-leads',
            installation_id: 7,
            settings: {
                zone: { mode: 'custom', custom_zips: ['02301'] },
                unit_types: [],
                brands: [],
            },
            catalogs: {
                unit_types: EXPECTED_RELY_UNIT_TYPES,
                brands: EXPECTED_RELY_BRANDS,
            },
            territory: { active_mode: 'list', has_data: true },
        });
        expect(lastStoredInstallation.metadata.settings).toMatchObject({
            zone: { mode: 'custom', custom_zips: ['02301'] },
            unit_types: [],
            brands: [],
            updated_by: 'crm-user-1',
        });
        expect(new Date(lastStoredInstallation.metadata.settings.updated_at).toISOString())
            .toBe(lastStoredInstallation.metadata.settings.updated_at);
        expect(mockWriteEvent).toHaveBeenCalledWith({
            companyId: COMPANY_X,
            installationId: 7,
            appId: RELY_SETTINGS_APP.id,
            actorId: 'crm-user-1',
            eventType: 'settings_updated',
            requestId: 'req-audit',
            payload: {
                app_key: 'rely-leads',
                zone_mode: 'custom',
                custom_zip_count: 1,
                unit_type_count: 0,
                brand_count: 0,
            },
        });
    });

    test('TC-S3-01 · settings whitelist and ordered 404 scaffold trio are preserved', async () => {
        expect(marketplaceSettingsService.SETTINGS_ENABLED_APP_KEYS)
            .toEqual(new Set(['rely-leads', 'rate-me', 'outbound-parts-caller']));

        await expectSettingsError(
            marketplaceSettingsService.getAppSettings(COMPANY_X, 'garbage-key'),
            'SETTINGS_NOT_SUPPORTED',
            404
        );
        expect(mockSettingsGetPublishedAppByKey).not.toHaveBeenCalled();

        mockSettingsGetPublishedAppByKey.mockResolvedValueOnce(null);
        await expectSettingsError(
            marketplaceSettingsService.getAppSettings(COMPANY_X, 'rate-me'),
            'APP_NOT_FOUND',
            404
        );

        mockSettingsFindActiveInstallation.mockResolvedValue(null);
        await expectSettingsError(
            marketplaceSettingsService.getAppSettings(COMPANY_X, 'rate-me'),
            'APP_NOT_INSTALLED',
            404
        );
        await expectSettingsError(
            marketplaceSettingsService.updateAppSettings(
                COMPANY_X,
                'crm-1',
                'rate-me',
                { google_review_url: 'not a url' }
            ),
            'APP_NOT_INSTALLED',
            404
        );

        mockSettingsFindActiveInstallation.mockResolvedValue({
            ...RATE_ME_SETTINGS_INSTALLATION,
            status: 'provisioning_failed',
        });
        await expectSettingsError(
            marketplaceSettingsService.getAppSettings(COMPANY_X, 'rate-me'),
            'APP_NOT_INSTALLED',
            404
        );
        expect(mockSettingsSetInstallationSettings).not.toHaveBeenCalled();
        expect(mockWriteEvent).not.toHaveBeenCalled();
    });

    test('TC-S4-01 · rate-me GET embeds domain state and the public host only', async () => {
        const result = await marketplaceSettingsService.getAppSettings(
            COMPANY_X,
            'rate-me'
        );

        expect(Object.keys(result).sort()).toEqual([
            'app_key',
            'domain',
            'installation_id',
            'public_host',
            'settings',
        ]);
        expect(result).toEqual({
            app_key: 'rate-me',
            installation_id: 8,
            settings: {
                google_review_url: 'https://g.page/r/abc/review',
                booking_url: null,
            },
            domain: PENDING_DOMAIN,
            public_host: 'rate.albusto.com',
        });
        expect(result).not.toHaveProperty('catalogs');
        expect(result).not.toHaveProperty('territory');
        expect(mockGetDomainByCompany).toHaveBeenCalledWith(COMPANY_X);

        mockGetDomainByCompany.mockResolvedValueOnce(null);
        await expect(marketplaceSettingsService.getAppSettings(COMPANY_X, 'rate-me'))
            .resolves.toMatchObject({ domain: null });
    });

    test('TC-S5-01 · google_review_url accepts any HTTPS host and rejects PD-1 violations', async () => {
        const validRows = [
            ['https://g.page/r/abc/review', 'https://g.page/r/abc/review'],
            ['https://maps.app.goo.gl/xyz', 'https://maps.app.goo.gl/xyz'],
            [
                'https://search.google.com/local/writereview?placeid=1',
                'https://search.google.com/local/writereview?placeid=1',
            ],
            ['  https://reviews.example.net/a  ', 'https://reviews.example.net/a'],
            ['  ', null],
            ['', null],
            [null, null],
        ];
        for (const [input, expected] of validRows) {
            expect(marketplaceSettingsService.validateRateMeSettingsInput({
                google_review_url: input,
            })).toEqual({ google_review_url: expected, booking_url: null });
            await expect(marketplaceSettingsService.updateAppSettings(
                COMPANY_X,
                'crm-1',
                'rate-me',
                { google_review_url: input }
            )).resolves.toMatchObject({
                settings: { google_review_url: expected },
            });
        }

        const invalidRows = [
            'http://g.page/x',
            'javascript:alert(1)',
            'not a url',
            `https://example.com/${'a'.repeat(481)}`,
            42,
        ];
        mockSettingsSetInstallationSettings.mockClear();
        mockWriteEvent.mockClear();
        for (const input of invalidRows) {
            expect(() => marketplaceSettingsService.validateRateMeSettingsInput({
                google_review_url: input,
            })).toThrow(expect.objectContaining({
                code: 'INVALID_GOOGLE_REVIEW_URL',
                httpStatus: 400,
            }));
            await expectSettingsError(
                marketplaceSettingsService.updateAppSettings(
                    COMPANY_X,
                    'crm-1',
                    'rate-me',
                    { google_review_url: input }
                ),
                'INVALID_GOOGLE_REVIEW_URL',
                400
            );
        }
        expect(mockSettingsSetInstallationSettings).not.toHaveBeenCalled();
        expect(mockWriteEvent).not.toHaveBeenCalled();
    });

    test('TC-S6-01 · rate-me PUT replaces complete settings and preserves seeded metadata', async () => {
        currentRateMeInstallation = {
            ...RATE_ME_SETTINGS_INSTALLATION,
            metadata: {
                seeded_by: 'X',
                settings: { google_review_url: 'https://old.example/review' },
            },
        };

        await marketplaceSettingsService.updateAppSettings(
            COMPANY_X,
            'crm-1',
            'rate-me',
            { google_review_url: 'https://g.page/new' }
        );

        expect(mockSettingsSetInstallationSettings).toHaveBeenCalledTimes(1);
        const [companyId, installationId, stored] =
            mockSettingsSetInstallationSettings.mock.calls[0];
        expect(companyId).toBe(COMPANY_X);
        expect(installationId).toBe(8);
        expect(Object.keys(stored).sort()).toEqual([
            'booking_url',
            'google_review_url',
            'updated_at',
            'updated_by',
        ]);
        expect(stored).toMatchObject({
            google_review_url: 'https://g.page/new',
            updated_by: 'crm-1',
        });
        expect(new Date(stored.updated_at).toISOString()).toBe(stored.updated_at);
        expect(lastStoredInstallation.metadata.seeded_by).toBe('X');
    });

    test('TC-S7-01 · rate-me event records only URL presence, never the URL value', async () => {
        await marketplaceSettingsService.updateAppSettings(
            COMPANY_X,
            'crm-1',
            'rate-me',
            { google_review_url: 'https://g.page/r/abc/review' }
        );
        await marketplaceSettingsService.updateAppSettings(
            COMPANY_X,
            'crm-1',
            'rate-me',
            { google_review_url: null }
        );

        expect(mockWriteEvent).toHaveBeenCalledTimes(2);
        expect(mockWriteEvent.mock.calls[0][0]).toMatchObject({
            eventType: 'settings_updated',
            payload: {
                app_key: 'rate-me',
                has_google_review_url: true,
            },
        });
        expect(mockWriteEvent.mock.calls[1][0]).toMatchObject({
            eventType: 'settings_updated',
            payload: {
                app_key: 'rate-me',
                has_google_review_url: false,
            },
        });
        expect(JSON.stringify(mockWriteEvent.mock.calls.map(([event]) => event.payload)))
            .not.toContain('g.page');
    });

    describe('RATE-ME-CRM-002 T4 booking_url settings (RM2-T4)', () => {
        test('TC-RM2-BU-01 · PUT validates, stores, and returns both URL keys', async () => {
            const input = {
                google_review_url: 'https://g.page/r/abc/review',
                booking_url: 'https://book.co/x',
            };

            expect(marketplaceSettingsService.validateRateMeSettingsInput(input))
                .toEqual(input);

            const result = await marketplaceSettingsService.updateAppSettings(
                COMPANY_X,
                'crm-1',
                'rate-me',
                input
            );

            expect(lastStoredInstallation.metadata.settings).toMatchObject(input);
            expect(result.settings).toEqual(input);
        });

        test('TC-RM2-BU-02 · booking_url mirrors HTTPS, length, and type validation', () => {
            const googleReviewUrl = 'https://g.page/r/abc/review';
            const url500 = 'https://example.com/'.padEnd(500, 'a');
            const validRows = [
                [undefined, null],
                [null, null],
                ['', null],
                ['  ', null],
                ['  https://book.co/x  ', 'https://book.co/x'],
                [url500, url500],
            ];

            for (const [input, expected] of validRows) {
                expect(marketplaceSettingsService.validateRateMeSettingsInput({
                    google_review_url: googleReviewUrl,
                    booking_url: input,
                })).toEqual({
                    google_review_url: googleReviewUrl,
                    booking_url: expected,
                });
            }

            const invalidRows = [
                'http://book.co/x',
                'javascript:alert(1)',
                'not a url',
                `${url500}a`,
                42,
            ];
            for (const input of invalidRows) {
                expect(() => marketplaceSettingsService.validateRateMeSettingsInput({
                    google_review_url: googleReviewUrl,
                    booking_url: input,
                })).toThrow(expect.objectContaining({
                    message: 'Booking URL must be a valid HTTPS URL no longer than 500 characters.',
                    code: 'INVALID_BOOKING_URL',
                    httpStatus: 400,
                }));
            }
        });

        test('TC-RM2-BU-03 · replace-on-PUT keeps the sibling URL', async () => {
            await marketplaceSettingsService.updateAppSettings(
                COMPANY_X,
                'crm-1',
                'rate-me',
                {
                    google_review_url: 'https://g/x',
                    booking_url: 'https://b/y',
                }
            );
            expect(currentRateMeInstallation.metadata.settings).toMatchObject({
                google_review_url: 'https://g/x',
                booking_url: 'https://b/y',
            });

            await marketplaceSettingsService.updateAppSettings(
                COMPANY_X,
                'crm-1',
                'rate-me',
                {
                    google_review_url: 'https://g/x',
                    booking_url: null,
                }
            );
            expect(currentRateMeInstallation.metadata.settings).toMatchObject({
                google_review_url: 'https://g/x',
                booking_url: null,
            });

            await marketplaceSettingsService.updateAppSettings(
                COMPANY_X,
                'crm-1',
                'rate-me',
                {
                    google_review_url: 'https://g/new',
                    booking_url: 'https://b/preserved',
                }
            );
            expect(currentRateMeInstallation.metadata.settings).toMatchObject({
                google_review_url: 'https://g/new',
                booking_url: 'https://b/preserved',
            });
        });

        test('TC-RM2-BU-04 · GET returns google_review_url and booking_url', async () => {
            currentRateMeInstallation.metadata.settings = {
                google_review_url: 'https://g.page/r/abc/review',
                booking_url: 'https://book.co/x',
            };

            const result = await marketplaceSettingsService.getAppSettings(
                COMPANY_X,
                'rate-me'
            );

            expect(result).toEqual({
                app_key: 'rate-me',
                installation_id: 8,
                settings: {
                    google_review_url: 'https://g.page/r/abc/review',
                    booking_url: 'https://book.co/x',
                },
                domain: PENDING_DOMAIN,
                public_host: 'rate.albusto.com',
            });
        });

        test('TC-RM2-BU-05 · event records URL presence booleans only', async () => {
            await marketplaceSettingsService.updateAppSettings(
                COMPANY_X,
                'crm-1',
                'rate-me',
                {
                    google_review_url: 'https://g.page/r/abc/review',
                    booking_url: 'https://book.co/x',
                }
            );
            await marketplaceSettingsService.updateAppSettings(
                COMPANY_X,
                'crm-1',
                'rate-me',
                { google_review_url: null, booking_url: null }
            );

            const payloads = mockWriteEvent.mock.calls.map(([event]) => event.payload);
            expect(payloads).toEqual([
                {
                    app_key: 'rate-me',
                    has_google_review_url: true,
                    has_booking_url: true,
                },
                {
                    app_key: 'rate-me',
                    has_google_review_url: false,
                    has_booking_url: false,
                },
            ]);
            expect(JSON.stringify(payloads)).not.toContain('g.page');
            expect(JSON.stringify(payloads)).not.toContain('book.co');
        });
    });

    test('TC-S10-01 · reinstall resets settings while the company domain survives', async () => {
        currentRateMeInstallation = {
            ...RATE_ME_SETTINGS_INSTALLATION,
            id: 9,
            metadata: {},
        };
        mockGetDomainByCompany.mockResolvedValue({
            ...PENDING_DOMAIN,
            status: 'active',
            verified_at: VERIFIED_AT,
            activated_at: ACTIVATED_AT,
        });

        const result = await marketplaceSettingsService.getAppSettings(COMPANY_X, 'rate-me');

        expect(result.installation_id).toBe(9);
        expect(result.settings.google_review_url).toBeNull();
        expect(result.settings.booking_url).toBeNull();
        expect(result.domain).toEqual({
            ...PENDING_DOMAIN,
            status: 'active',
            verified_at: VERIFIED_AT,
            activated_at: ACTIVATED_AT,
        });
    });

    test('TC-S8-01 · all six authed endpoints derive only COMPANY_B from companyFilter', async () => {
        mockSettingsFindActiveInstallation.mockResolvedValue(null);
        mockGetConnectedRateMeMeta.mockResolvedValue(null);
        const app = buildMarketplaceApp();
        const poisoned = `company_id=${encodeURIComponent(COMPANY_X)}`;
        const disconnectedResponses = [
            await request(app).get(`/apps/rate-me/settings?${poisoned}`),
            await request(app)
                .put(`/apps/rate-me/settings?${poisoned}`)
                .send({ company_id: COMPANY_X, google_review_url: null }),
            await request(app)
                .put(`/apps/rate-me/domain?${poisoned}`)
                .send({ company_id: COMPANY_X, domain: 'rate.foreign.example' }),
            await request(app)
                .post(`/apps/rate-me/domain/verify?${poisoned}`)
                .send({ company_id: COMPANY_X }),
            await request(app)
                .delete(`/apps/rate-me/domain?${poisoned}`)
                .send({ company_id: COMPANY_X }),
            await request(app)
                .post(`/apps/rate-me/tokens?${poisoned}`)
                .send({ company_id: COMPANY_X, tech_id: 'zb-77' }),
        ];

        for (const response of disconnectedResponses) {
            expect(response.status).toBe(404);
            expect(response.body).toMatchObject({
                success: false,
                code: 'APP_NOT_INSTALLED',
                request_id: 'req-b',
            });
            expect(response.body.message).not.toContain(COMPANY_X);
        }
        expect(mockSettingsFindActiveInstallation).toHaveBeenCalledTimes(2);
        for (const call of mockSettingsFindActiveInstallation.mock.calls) {
            expect(call).toEqual([COMPANY_Y, RATE_ME_SETTINGS_APP.id]);
        }
        expect(mockGetConnectedRateMeMeta).toHaveBeenCalledTimes(4);
        for (const call of mockGetConnectedRateMeMeta.mock.calls) {
            expect(call).toEqual([COMPANY_Y]);
        }

        const failedDomain = {
            ...PENDING_DOMAIN,
            status: 'failed',
            last_error: 'DNS is not ready.',
        };
        const verifySpy = jest.spyOn(service, 'verifyDomain').mockResolvedValue(failedDomain);
        const removeSpy = jest.spyOn(service, 'removeDomain').mockResolvedValue(failedDomain);

        const verifyResponse = await request(app)
            .post(`/apps/rate-me/domain/verify?${poisoned}`)
            .send({ company_id: COMPANY_X });
        expect(verifyResponse.status).toBe(200);
        expect(verifyResponse.body).toEqual({
            success: true,
            domain: failedDomain,
            request_id: 'req-b',
        });
        expect(verifySpy).toHaveBeenCalledWith(COMPANY_Y, 'crm-b');

        const deleteResponse = await request(app)
            .delete(`/apps/rate-me/domain?${poisoned}`)
            .send({ company_id: COMPANY_X });
        expect(deleteResponse.status).toBe(200);
        expect(deleteResponse.body).toEqual({ success: true, request_id: 'req-b' });
        expect(removeSpy).toHaveBeenCalledWith(COMPANY_Y, 'crm-b');
    });

    test('TC-T1-02 · mint route returns 201 and unwraps RateMeServiceError', async () => {
        const minted = {
            token: 'minted-token',
            url: 'https://rate.albusto.com/r/minted-token',
        };
        const mintSpy = jest.spyOn(service, 'mintToken').mockResolvedValueOnce(minted);
        const app = buildMarketplaceApp();

        const response = await request(app)
            .post(`/apps/rate-me/tokens?company_id=${encodeURIComponent(COMPANY_X)}`)
            .send({
                company_id: COMPANY_X,
                job_id: 41,
                tech_id: 'zb-77',
                tech_name: 'Alex Petrov',
            });
        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            success: true,
            token: minted,
            request_id: 'req-b',
        });
        expect(mintSpy).toHaveBeenCalledWith(COMPANY_Y, {
            jobId: 41,
            techId: 'zb-77',
            techName: 'Alex Petrov',
        });

        mintSpy.mockRejectedValueOnce(new service.RateMeServiceError(
            'Job not found.',
            'JOB_NOT_FOUND',
            400
        ));
        const errorResponse = await request(app)
            .post('/apps/rate-me/tokens')
            .send({ job_id: 999, tech_id: 'zb-77' });
        expect(errorResponse.status).toBe(400);
        expect(errorResponse.body).toEqual({
            success: false,
            code: 'JOB_NOT_FOUND',
            message: 'Job not found.',
            request_id: 'req-b',
        });
    });
});
