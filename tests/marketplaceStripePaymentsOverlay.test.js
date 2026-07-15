'use strict';

const mockListPublishedAppsWithInstallation = jest.fn();
const mockGetPublishedAppByKey = jest.fn();
const mockFindActiveInstallation = jest.fn();

jest.mock('../backend/src/db/marketplaceQueries', () => ({
    listPublishedAppsWithInstallation: (...args) => mockListPublishedAppsWithInstallation(...args),
    getPublishedAppByKey: (...args) => mockGetPublishedAppByKey(...args),
    findActiveInstallation: (...args) => mockFindActiveInstallation(...args),
}));

const mockGetAccountByCompany = jest.fn();
jest.mock('../backend/src/db/stripePaymentsQueries', () => ({
    getAccountByCompany: (...args) => mockGetAccountByCompany(...args),
}));

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
jest.mock('../backend/src/services/integrationsService', () => ({ createIntegration: jest.fn() }));
jest.mock('../backend/src/services/marketplaceProvisioningService', () => ({
    pushCredentials: jest.fn(), sanitizeErrorMessage: message => message,
}));
jest.mock('../backend/src/services/emailMailboxService', () => ({ getMailboxStatus: jest.fn() }));
jest.mock('../backend/src/services/telephonyTenantService', () => ({ getTelephonyState: jest.fn() }));

const marketplaceService = require('../backend/src/services/marketplaceService');

const COMPANY_ID = '00000000-0000-0000-0000-00000000000a';

function stripeRow(overrides = {}) {
    return {
        id: 'app-stripe',
        app_key: 'stripe-payments',
        name: 'Stripe Payments',
        provider_name: 'Stripe',
        category: 'payments',
        app_type: 'internal',
        provisioning_mode: 'none',
        status: 'published',
        requested_scopes: [],
        metadata: {},
        installation_id: null,
        installation_status: null,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe("isAppConnected('stripe-payments')", () => {
    test('derives connection from the Stripe account and fails quiet', async () => {
        mockGetAccountByCompany.mockResolvedValueOnce({ status: 'onboarding_incomplete' });
        await expect(marketplaceService.isAppConnected(COMPANY_ID, 'stripe-payments')).resolves.toBe(true);

        mockGetAccountByCompany.mockResolvedValueOnce({ status: 'disconnected' });
        await expect(marketplaceService.isAppConnected(COMPANY_ID, 'stripe-payments')).resolves.toBe(false);

        mockGetAccountByCompany.mockResolvedValueOnce(null);
        await expect(marketplaceService.isAppConnected(COMPANY_ID, 'stripe-payments')).resolves.toBe(false);

        mockGetAccountByCompany.mockRejectedValueOnce(new Error('stripe query failed'));
        await expect(marketplaceService.isAppConnected(COMPANY_ID, 'stripe-payments')).resolves.toBe(false);

        expect(mockGetAccountByCompany).toHaveBeenCalledTimes(4);
        expect(mockGetAccountByCompany).toHaveBeenCalledWith(COMPANY_ID);
        expect(mockGetPublishedAppByKey).not.toHaveBeenCalled();
        expect(mockFindActiveInstallation).not.toHaveBeenCalled();
    });
});

describe('listApps — stripe-payments derived installation overlay', () => {
    beforeEach(() => {
        mockListPublishedAppsWithInstallation.mockResolvedValue([stripeRow({
            installation_id: 'stale-connected-installation',
            installation_status: 'connected',
            installed_at: '2025-01-01T00:00:00.000Z',
        })]);
    });

    test('linked account overrides a stale installation with the synthetic connected shape', async () => {
        mockGetAccountByCompany.mockResolvedValue({
            status: 'onboarding_incomplete',
            stripe_account_id: 'acct_must_not_be_exposed',
            created_at: '2026-07-01T09:00:00.000Z',
            updated_at: '2026-07-02T10:00:00.000Z',
        });

        const apps = await marketplaceService.listApps(COMPANY_ID);
        const stripe = apps.find(app => app.app_key === 'stripe-payments');

        expect(stripe.installation).toEqual({
            id: null,
            status: 'connected',
            installed_at: '2026-07-01T09:00:00.000Z',
            disconnected_at: null,
            provisioning_error: null,
            last_used_at: '2026-07-02T10:00:00.000Z',
            external_installation_id: null,
        });
        expect(JSON.stringify(stripe)).not.toContain('acct_must_not_be_exposed');
    });

    test.each([
        ['disconnected account', { status: 'disconnected' }],
        ['no account', null],
    ])('%s overrides a stale connected installation with null', async (_label, account) => {
        mockGetAccountByCompany.mockResolvedValue(account);

        const apps = await marketplaceService.listApps(COMPANY_ID);

        expect(apps.find(app => app.app_key === 'stripe-payments').installation).toBeNull();
    });

    test('query errors fail quiet and override a stale connected installation with null', async () => {
        mockGetAccountByCompany.mockRejectedValue(new Error('stripe query failed'));

        const apps = await marketplaceService.listApps(COMPANY_ID);

        expect(apps.find(app => app.app_key === 'stripe-payments').installation).toBeNull();
    });
});
