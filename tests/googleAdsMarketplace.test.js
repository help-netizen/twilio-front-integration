'use strict';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn(),
    listPublishedAppsWithInstallation: jest.fn(),
    getPublishedAppByKey: jest.fn(),
    findActiveInstallation: jest.fn(),
    createInstallation: jest.fn(),
}));
jest.mock('../backend/src/db/emailQueries', () => ({
    getMailboxByCompany: jest.fn(),
}));
jest.mock('../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: jest.fn(),
}));
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getTelephonyState: jest.fn(),
}));
jest.mock('../backend/src/db/stripePaymentsQueries', () => ({
    getAccountByCompany: jest.fn(),
}));
jest.mock('../backend/src/services/integrationsService', () => ({
    createIntegration: jest.fn(),
}));
jest.mock('../backend/src/services/marketplaceProvisioningService', () => ({
    pushCredentials: jest.fn(),
    sanitizeErrorMessage: message => message,
}));

const mockGetMarketplaceConnectionState = jest.fn();
jest.mock('../backend/src/services/googleAdsConnectionService', () => ({
    getMarketplaceConnectionState: (...args) => (
        mockGetMarketplaceConnectionState(...args)
    ),
}));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/marketplaceQueries');
const marketplaceService = require('../backend/src/services/marketplaceService');

const COMPANY = '11111111-1111-1111-1111-111111111111';

function googleAdsRow(overrides = {}) {
    return {
        id: 'app-google-ads',
        app_key: 'google-ads',
        name: 'Google Ads',
        provider_name: 'Google',
        category: 'analytics',
        app_type: 'internal',
        provisioning_mode: 'none',
        status: 'published',
        requested_scopes: ['analytics:read'],
        metadata: {
            derived_connection: true,
            setup_path: '/settings/integrations/google-ads',
        },
        installation_id: 'stale-installation',
        installation_status: 'connected',
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Google Ads derived marketplace connection', () => {
    test('connected row produces a non-secret synthetic installation', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([
            googleAdsRow(),
        ]);
        mockGetMarketplaceConnectionState.mockResolvedValue({
            status: 'connected',
            created_at: '2026-07-27T10:00:00.000Z',
            last_synced_at: '2026-07-27T12:00:00.000Z',
            customer_id: 'must-not-be-present',
            refresh_token_encrypted: 'must-not-be-present',
        });

        const apps = await marketplaceService.listApps(COMPANY);
        const googleAds = apps.find(app => app.app_key === 'google-ads');

        expect(googleAds.installation).toEqual({
            id: null,
            status: 'connected',
            installed_at: '2026-07-27T10:00:00.000Z',
            disconnected_at: null,
            provisioning_error: null,
            last_used_at: '2026-07-27T12:00:00.000Z',
            external_installation_id: null,
        });
        expect(JSON.stringify(googleAds)).not.toMatch(
            /must-not-be-present|customer_id|refresh_token/
        );
    });

    test('reconnect_required overrides a stale install row as disconnected', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([
            googleAdsRow(),
        ]);
        mockGetMarketplaceConnectionState.mockResolvedValue({
            status: 'reconnect_required',
            created_at: '2026-07-27T10:00:00.000Z',
            last_synced_at: null,
        });

        const googleAds = (await marketplaceService.listApps(COMPANY))
            .find(app => app.app_key === 'google-ads');
        expect(googleAds.installation.status).toBe('disconnected');
        expect(googleAds.installation.installed_at).toBeNull();
    });

    test('isAppConnected derives only from the Google Ads connection', async () => {
        mockGetMarketplaceConnectionState
            .mockResolvedValueOnce({ status: 'connected' })
            .mockResolvedValueOnce({ status: 'disconnected' })
            .mockResolvedValueOnce(null);

        await expect(marketplaceService.isAppConnected(COMPANY, 'google-ads'))
            .resolves.toBe(true);
        await expect(marketplaceService.isAppConnected(COMPANY, 'google-ads'))
            .resolves.toBe(false);
        await expect(marketplaceService.isAppConnected(COMPANY, 'google-ads'))
            .resolves.toBe(false);
        expect(queries.getPublishedAppByKey).not.toHaveBeenCalled();
        expect(queries.findActiveInstallation).not.toHaveBeenCalled();
    });

    test('generic install rejects derived connection before creating an installation', async () => {
        const client = {
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        };
        db.pool.connect.mockResolvedValue(client);
        queries.getPublishedAppByKey.mockResolvedValue(googleAdsRow());
        queries.findActiveInstallation.mockResolvedValue(null);

        await expect(marketplaceService.installApp(
            COMPANY,
            'actor-a',
            'google-ads'
        )).rejects.toMatchObject({
            code: 'DERIVED_CONNECTION_APP',
            httpStatus: 409,
        });
        expect(queries.createInstallation).not.toHaveBeenCalled();
    });
});
