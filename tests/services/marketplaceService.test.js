const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};

jest.mock('../../backend/src/db/connection', () => ({
    pool: {
        connect: jest.fn(() => Promise.resolve(mockClient)),
    },
}));

jest.mock('../../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn(),
    reconcileRevokedInstallations: jest.fn(),
    listPublishedAppsWithInstallation: jest.fn(),
    getPublishedAppByKey: jest.fn(),
    findActiveInstallation: jest.fn(),
    listInstallations: jest.fn(),
    getInstallationById: jest.fn(),
    createInstallation: jest.fn(),
    updateInstallationCredential: jest.fn(),
    revokeCredentialById: jest.fn(),
    markInstallationConnected: jest.fn(),
    markProvisioningFailed: jest.fn(),
    markDisconnected: jest.fn(),
    writeEvent: jest.fn(),
}));

jest.mock('../../backend/src/db/emailQueries', () => ({
    getMailboxByCompany: jest.fn(),
}));

jest.mock('../../backend/src/services/integrationsService', () => ({
    createIntegration: jest.fn(),
}));

jest.mock('../../backend/src/services/marketplaceProvisioningService', () => ({
    sanitizeErrorMessage: jest.fn(message => String(message).slice(0, 500)),
    pushCredentials: jest.fn(),
}));

const queries = require('../../backend/src/db/marketplaceQueries');
const emailQueries = require('../../backend/src/db/emailQueries');
const integrationsService = require('../../backend/src/services/integrationsService');
const provisioningService = require('../../backend/src/services/marketplaceProvisioningService');
const marketplaceService = require('../../backend/src/services/marketplaceService');

describe('marketplaceService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.query.mockResolvedValue({ rows: [] });
        emailQueries.getMailboxByCompany.mockResolvedValue({
            id: 'mailbox-1',
            provider: 'gmail',
            status: 'connected',
        });
    });

    test('listApps maps catalog and installation state', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([{
            id: 1,
            app_key: 'call-qa-agent',
            name: 'Call QA Agent',
            provider_name: 'Blanc Labs',
            category: 'ai',
            app_type: 'internal',
            short_description: 'Scores calls',
            requested_scopes: ['calls:read'],
            provisioning_mode: 'manual',
            status: 'published',
            metadata: { access_summary: ['Call metadata'] },
            installation_id: 10,
            installation_status: 'connected',
            installed_at: '2026-05-04T12:00:00.000Z',
            last_used_at: '2026-05-04T12:30:00.000Z',
        }]);

        const apps = await marketplaceService.listApps('company-1');
        expect(apps).toHaveLength(1);
        expect(apps[0].access_summary).toEqual(['Call metadata']);
        expect(apps[0].installation.status).toBe('connected');
    });

    test('installApp rejects duplicate active install', async () => {
        queries.getPublishedAppByKey.mockResolvedValue({ id: 1, app_key: 'x', requested_scopes: [] });
        queries.findActiveInstallation.mockResolvedValue({ id: 9 });

        await expect(marketplaceService.installApp('company-1', 'user-1', 'x'))
            .rejects.toMatchObject({ code: 'APP_ALREADY_INSTALLED', httpStatus: 409 });
    });

    test('manual install creates credential and returns no secret', async () => {
        const app = {
            id: 1,
            app_key: 'lead-generator',
            name: 'Lead Generator',
            provider_name: 'Blanc Labs',
            category: 'lead_generation',
            requested_scopes: ['leads:create'],
            provisioning_mode: 'manual',
        };
        queries.getPublishedAppByKey.mockResolvedValue(app);
        queries.findActiveInstallation.mockResolvedValue(null);
        queries.createInstallation.mockResolvedValue({ id: 100, status: 'provisioning_failed' });
        integrationsService.createIntegration.mockResolvedValue({
            id: 200,
            key_id: 'blanc_test',
            secret: 'plain-secret',
        });
        queries.updateInstallationCredential.mockResolvedValue({ id: 100, api_integration_id: 200 });
        queries.markInstallationConnected.mockResolvedValue({ id: 100, status: 'connected' });

        const result = await marketplaceService.installApp('company-1', 'user-1', 'lead-generator', { requestId: 'req' });

        expect(integrationsService.createIntegration).toHaveBeenCalledWith(
            'Marketplace: Lead Generator',
            ['leads:create'],
            null,
            'company-1',
            expect.objectContaining({ marketplaceAppId: 1, marketplaceInstallationId: 100 })
        );
        expect(result.status).toBe('connected');
        expect(JSON.stringify(result)).not.toContain('plain-secret');
    });

    test('none provisioning install does not create credentials', async () => {
        const app = {
            id: 2,
            app_key: 'docs-only',
            name: 'Docs Only',
            provider_name: 'Blanc Labs',
            category: 'internal',
            requested_scopes: [],
            provisioning_mode: 'none',
        };
        queries.getPublishedAppByKey.mockResolvedValue(app);
        queries.findActiveInstallation.mockResolvedValue(null);
        queries.createInstallation.mockResolvedValue({ id: 101, status: 'provisioning_failed' });
        queries.markInstallationConnected.mockResolvedValue({ id: 101, status: 'connected' });

        const result = await marketplaceService.installApp('company-1', 'user-1', 'docs-only', { requestId: 'req' });

        expect(integrationsService.createIntegration).not.toHaveBeenCalled();
        expect(queries.updateInstallationCredential).not.toHaveBeenCalled();
        expect(result.status).toBe('connected');
        expect(result.key_id).toBeUndefined();
    });

    test('installApp rejects apps that require Gmail when mailbox is not connected', async () => {
        const app = {
            id: 3,
            app_key: 'mail-secretary',
            name: 'Mail Secretary',
            provider_name: 'Blanc Labs',
            category: 'ai',
            requested_scopes: ['email:read'],
            provisioning_mode: 'none',
            metadata: { requires_connected_gmail: true },
        };
        queries.getPublishedAppByKey.mockResolvedValue(app);
        queries.findActiveInstallation.mockResolvedValue(null);
        emailQueries.getMailboxByCompany.mockResolvedValue(null);

        await expect(marketplaceService.installApp('company-1', 'user-1', 'mail-secretary', { requestId: 'req' }))
            .rejects.toMatchObject({ code: 'GMAIL_REQUIRED', httpStatus: 409 });

        expect(queries.createInstallation).not.toHaveBeenCalled();
        expect(integrationsService.createIntegration).not.toHaveBeenCalled();
    });

    test('push provisioning failure revokes credential and records failure', async () => {
        const app = {
            id: 1,
            app_key: 'qa',
            name: 'QA',
            provider_name: 'Blanc Labs',
            category: 'ai',
            requested_scopes: ['calls:read'],
            provisioning_mode: 'push_credentials',
            provisioning_url: 'https://example.com/provision',
        };
        queries.getPublishedAppByKey.mockResolvedValue(app);
        queries.findActiveInstallation.mockResolvedValue(null);
        queries.createInstallation.mockResolvedValue({ id: 100, status: 'provisioning_failed' });
        integrationsService.createIntegration.mockResolvedValue({
            id: 200,
            key_id: 'blanc_test',
            secret: 'plain-secret',
        });
        queries.updateInstallationCredential.mockResolvedValue({ id: 100, api_integration_id: 200 });
        provisioningService.pushCredentials.mockRejectedValue(new Error('secret=plain-secret failed'));
        queries.revokeCredentialById.mockResolvedValue({ id: 200, key_id: 'blanc_test', revoked_at: 'now' });
        queries.markProvisioningFailed.mockResolvedValue({ id: 100, status: 'provisioning_failed' });

        await expect(marketplaceService.installApp('company-1', 'user-1', 'qa', { requestId: 'req' }))
            .rejects.toMatchObject({ code: 'PROVISIONING_FAILED', httpStatus: 502 });
        expect(queries.revokeCredentialById).toHaveBeenCalledWith(200, 'company-1', expect.any(Object));
        expect(queries.markProvisioningFailed).toHaveBeenCalledWith(
            expect.objectContaining({ companyId: 'company-1', installationId: 100 }),
            expect.any(Object)
        );
        expect(queries.writeEvent).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'credential_revoked', payload: { reason: 'provisioning_failed' } }),
            expect.any(Object)
        );
    });
});
