'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
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
    countOtherActiveInstallationsOnCredential: jest.fn(),
    markInstallationConnected: jest.fn(),
    markProvisioningFailed: jest.fn(),
    markDisconnected: jest.fn(),
    writeEvent: jest.fn(),
}));
jest.mock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
jest.mock('../backend/src/services/emailMailboxService', () => ({ getMailboxStatus: jest.fn() }));
jest.mock('../backend/src/services/integrationsService', () => ({ createIntegration: jest.fn() }));
jest.mock('../backend/src/services/marketplaceProvisioningService', () => ({
    pushCredentials: jest.fn(), sanitizeErrorMessage: (message) => message,
}));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/marketplaceQueries');
const emailQueries = require('../backend/src/db/emailQueries');
const emailMailboxService = require('../backend/src/services/emailMailboxService');
const integrationsService = require('../backend/src/services/integrationsService');
const telephonyTenantService = require('../backend/src/services/telephonyTenantService');
const marketplaceService = require('../backend/src/services/marketplaceService');

const ROOT = path.join(__dirname, '..');
const COMPANY = '00000000-0000-0000-0000-000000000001';
const INST = {
    id: 555,
    company_id: COMPANY,
    app_id: 'app-nsa',
    app_key: 'nsa-leads',
    status: 'connected',
    api_integration_id: 1,
    provisioning_mode: 'manual',
};
const mockClient = { query: jest.fn(), release: jest.fn() };

function setupRuntimeMocks() {
    db.pool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rows: [] });
    queries.ensureMarketplaceSchema.mockResolvedValue(undefined);
    queries.getInstallationById.mockResolvedValue({ ...INST });
    queries.countOtherActiveInstallationsOnCredential.mockResolvedValue(0);
    queries.revokeCredentialById.mockResolvedValue(null);
    queries.markDisconnected.mockImplementation(async ({ installationId, status }) => ({
        id: installationId,
        status,
        disconnected_at: '2026-07-13T00:00:00.000Z',
    }));
    queries.writeEvent.mockResolvedValue({});
}

function leadAppRow(appKey, name, id) {
    return {
        id,
        app_key: appKey,
        name,
        provider_name: appKey === 'lead-generator' ? 'Blanc Labs' : 'Albusto',
        category: 'lead_generation',
        app_type: 'internal',
        requested_scopes: ['leads:create'],
        provisioning_mode: 'manual',
        status: 'published',
        metadata: { access_summary: ['Create leads'] },
        installation_id: `installation-${id}`,
        installation_status: 'connected',
        installed_at: '2026-07-13T00:00:00.000Z',
        disconnected_at: null,
        provisioning_error: null,
        last_used_at: null,
    };
}

function manualLeadApp() {
    return {
        id: 'app-rely',
        app_key: 'rely-leads',
        name: 'Rely Leads',
        provider_name: 'Albusto',
        category: 'lead_generation',
        requested_scopes: ['leads:create'],
        provisioning_mode: 'manual',
        status: 'published',
        metadata: { access_summary: ['Create leads'] },
    };
}

function readFilesRecursively(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    return entries.flatMap(entry => {
        const fullPath = path.join(directory, entry.name);
        return entry.isDirectory() ? readFilesRecursively(fullPath) : [fullPath];
    });
}

let telephonyStateSpy;

beforeEach(() => {
    jest.resetAllMocks();
    setupRuntimeMocks();
    telephonyStateSpy = jest.spyOn(telephonyTenantService, 'getTelephonyState');
});

afterEach(() => {
    telephonyStateSpy.mockRestore();
});

describe('MARKETPLACE-LEADGEN-SPLIT-001 shared-credential disconnect guard', () => {
    test('TC-G1-01 · one shared installation disconnect skips credential revocation', async () => {
        queries.countOtherActiveInstallationsOnCredential.mockResolvedValue(4);

        const result = await marketplaceService.disconnectInstallation(
            COMPANY,
            'user-1',
            555,
            { requestId: 'req-1' }
        );

        expect(queries.countOtherActiveInstallationsOnCredential)
            .toHaveBeenCalledTimes(1);
        expect(queries.countOtherActiveInstallationsOnCredential)
            .toHaveBeenCalledWith(COMPANY, 1, 555, mockClient);
        expect(queries.revokeCredentialById).not.toHaveBeenCalled();
        expect(queries.writeEvent).toHaveBeenCalledTimes(1);
        expect(queries.writeEvent).toHaveBeenCalledWith({
            companyId: COMPANY,
            installationId: 555,
            appId: 'app-nsa',
            apiIntegrationId: 1,
            actorId: 'user-1',
            eventType: 'disconnected',
            requestId: 'req-1',
            payload: { credential_revoked: false, credential_shared: true },
        }, mockClient);
        expect(queries.markDisconnected).toHaveBeenCalledWith({
            companyId: COMPANY,
            installationId: 555,
            actorId: 'user-1',
            status: 'disconnected',
        }, mockClient);
        expect(queries.getInstallationById.mock.invocationCallOrder[0])
            .toBeLessThan(queries.countOtherActiveInstallationsOnCredential.mock.invocationCallOrder[0]);
        expect(queries.countOtherActiveInstallationsOnCredential.mock.invocationCallOrder[0])
            .toBeLessThan(queries.markDisconnected.mock.invocationCallOrder[0]);
        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();
        expect(result).toEqual({
            id: 555,
            status: 'disconnected',
            disconnected_at: '2026-07-13T00:00:00.000Z',
        });
    });

    test('TC-G2-01 · last active installation revokes exactly as before', async () => {
        queries.revokeCredentialById.mockResolvedValue({
            id: 1,
            key_id: 'ak_live',
            revoked_at: '2026-07-13T00:00:00.000Z',
        });

        const result = await marketplaceService.disconnectInstallation(COMPANY, 'user-1', 555, {});

        expect(queries.revokeCredentialById).toHaveBeenCalledTimes(1);
        expect(queries.revokeCredentialById).toHaveBeenCalledWith(1, COMPANY, mockClient);
        expect(queries.writeEvent).toHaveBeenCalledTimes(2);
        expect(queries.writeEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
            eventType: 'credential_revoked',
            apiIntegrationId: 1,
            payload: { reason: 'disconnect' },
        }), mockClient);
        expect(queries.writeEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
            eventType: 'disconnected',
            payload: { credential_revoked: true, credential_shared: false },
        }), mockClient);
        expect(queries.markDisconnected).toHaveBeenCalledWith(expect.objectContaining({
            status: 'disconnected',
        }), mockClient);
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(result.status).toBe('disconnected');
    });

    test('TC-G4-01 · manual lead apps reject retry before any revoke or guard call', async () => {
        queries.getInstallationById.mockResolvedValue({
            id: 601,
            status: 'provisioning_failed',
            provisioning_mode: 'manual',
            app_key: 'rely-leads',
            api_integration_id: 1,
        });

        await expect(marketplaceService.retryProvisioning(COMPANY, 'user-1', 601, {}))
            .rejects.toMatchObject({ code: 'INSTALLATION_NOT_RETRYABLE', httpStatus: 409 });
        expect(queries.revokeCredentialById).not.toHaveBeenCalled();
        expect(queries.countOtherActiveInstallationsOnCredential).not.toHaveBeenCalled();
    });

    test('TC-G6-01 · null credential disconnect records both payload flags false', async () => {
        queries.getInstallationById.mockResolvedValue({ ...INST, api_integration_id: null });

        const result = await marketplaceService.disconnectInstallation(COMPANY, 'user-1', 555, {});

        expect(queries.writeEvent).toHaveBeenCalledTimes(1);
        expect(queries.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'disconnected',
            payload: { credential_revoked: false, credential_shared: false },
        }), mockClient);
        expect(queries.markDisconnected).toHaveBeenCalledWith(expect.objectContaining({
            status: 'disconnected',
        }), mockClient);
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(result.status).toBe('disconnected');
    });

    test('TC-G7-01 · non-shared revoke miss keeps the legacy revoked status', async () => {
        queries.getInstallationById.mockResolvedValue({ ...INST, api_integration_id: 7 });

        const result = await marketplaceService.disconnectInstallation(COMPANY, 'user-1', 555, {});

        expect(queries.revokeCredentialById).toHaveBeenCalledWith(7, COMPANY, mockClient);
        expect(queries.writeEvent).toHaveBeenCalledTimes(1);
        expect(queries.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'disconnected',
            payload: { credential_revoked: false, credential_shared: false },
        }), mockClient);
        expect(queries.markDisconnected).toHaveBeenCalledWith(expect.objectContaining({
            status: 'revoked',
        }), mockClient);
        expect(result.status).toBe('revoked');
    });

    test('TC-G8-01 · concurrent visibility can preserve a credential but never revokes it wrongly', async () => {
        const installations = {
            555: { ...INST },
            556: { ...INST, id: 556, app_id: 'app-rely', app_key: 'rely-leads' },
        };
        queries.getInstallationById.mockImplementation(async (_companyId, id) => installations[id]);
        queries.countOtherActiveInstallationsOnCredential.mockResolvedValue(1);

        await marketplaceService.disconnectInstallation(COMPANY, 'user-1', 555, {});
        await marketplaceService.disconnectInstallation(COMPANY, 'user-1', 556, {});

        expect(queries.revokeCredentialById).not.toHaveBeenCalled();
        expect(queries.markDisconnected).toHaveBeenCalledTimes(2);
        expect(queries.markDisconnected.mock.calls.map(([args]) => args.status))
            .toEqual(['disconnected', 'disconnected']);
        expect(queries.writeEvent.mock.calls.map(([args]) => args.payload))
            .toEqual([
                { credential_revoked: false, credential_shared: true },
                { credential_revoked: false, credential_shared: true },
            ]);
    });

    test('TC-G9-01 · 404, 409, and helper errors all roll back without lifecycle writes', async () => {
        queries.getInstallationById.mockResolvedValue(null);
        await expect(marketplaceService.disconnectInstallation(COMPANY, 'user-1', 555, {}))
            .rejects.toMatchObject({ code: 'INSTALLATION_NOT_FOUND', httpStatus: 404 });
        expect(queries.countOtherActiveInstallationsOnCredential).not.toHaveBeenCalled();
        expect(queries.revokeCredentialById).not.toHaveBeenCalled();
        expect(queries.markDisconnected).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();

        jest.clearAllMocks();
        setupRuntimeMocks();
        queries.getInstallationById.mockResolvedValue({ ...INST, status: 'disconnected' });
        await expect(marketplaceService.disconnectInstallation(COMPANY, 'user-1', 555, {}))
            .rejects.toMatchObject({ code: 'INSTALLATION_NOT_ACTIVE', httpStatus: 409 });
        expect(queries.countOtherActiveInstallationsOnCredential).not.toHaveBeenCalled();
        expect(queries.revokeCredentialById).not.toHaveBeenCalled();
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();

        jest.clearAllMocks();
        setupRuntimeMocks();
        const countError = new Error('count failed');
        queries.countOtherActiveInstallationsOnCredential.mockRejectedValue(countError);
        await expect(marketplaceService.disconnectInstallation(COMPANY, 'user-1', 555, {}))
            .rejects.toBe(countError);
        expect(queries.revokeCredentialById).not.toHaveBeenCalled();
        expect(queries.markDisconnected).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();
    });
});

describe('MARKETPLACE-LEADGEN-SPLIT-001 generic catalog behavior', () => {
    test('TC-C1-02 · all five lead apps use generic catalog mapping without overlays', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([
            leadAppRow('lead-generator', 'Website Leads', 'website'),
            leadAppRow('pro-referral-leads', 'Pro Referral Leads', 'pro'),
            leadAppRow('rely-leads', 'Rely Leads', 'rely'),
            leadAppRow('nsa-leads', 'NSA Leads', 'nsa'),
            leadAppRow('lhg-leads', 'LHG Leads', 'lhg'),
        ]);

        const apps = await marketplaceService.listApps(COMPANY);

        expect(apps.map(app => [app.app_key, app.name])).toEqual([
            ['lead-generator', 'Website Leads'],
            ['pro-referral-leads', 'Pro Referral Leads'],
            ['rely-leads', 'Rely Leads'],
            ['nsa-leads', 'NSA Leads'],
            ['lhg-leads', 'LHG Leads'],
        ]);
        expect(apps.every(app => JSON.stringify(app.requested_scopes) === '["leads:create"]')).toBe(true);
        expect(apps.every(app => JSON.stringify(app.access_summary) === '["Create leads"]')).toBe(true);
        expect(apps.every(app => app.installation?.status === 'connected')).toBe(true);
        expect(emailMailboxService.getMailboxStatus).not.toHaveBeenCalled();
        expect(telephonyStateSpy).not.toHaveBeenCalled();
    });

    test('TC-C4-02 · another company self-service install mints its own lead credential', async () => {
        const app = manualLeadApp();
        queries.getPublishedAppByKey.mockResolvedValue(app);
        queries.findActiveInstallation.mockResolvedValue(null);
        queries.createInstallation.mockResolvedValue({ id: 501, status: 'provisioning_failed' });
        integrationsService.createIntegration.mockResolvedValue({ id: 9001, key_id: 'ak_rely_new' });
        queries.updateInstallationCredential.mockResolvedValue({ id: 501, api_integration_id: 9001 });
        queries.markInstallationConnected.mockResolvedValue({
            id: 501,
            status: 'connected',
            installed_at: '2026-07-13T00:00:00Z',
        });

        const result = await marketplaceService.installApp(
            'company-b',
            'user-b',
            'rely-leads',
            { requestId: 'req-b' }
        );

        expect(emailQueries.getMailboxByCompany).not.toHaveBeenCalled();
        expect(integrationsService.createIntegration).toHaveBeenCalledTimes(1);
        expect(integrationsService.createIntegration).toHaveBeenCalledWith(
            'Marketplace: Rely Leads',
            ['leads:create'],
            null,
            'company-b',
            {
                client: mockClient,
                marketplaceAppId: 'app-rely',
                marketplaceInstallationId: 501,
            }
        );
        expect(queries.updateInstallationCredential)
            .toHaveBeenCalledWith('company-b', 501, 9001, mockClient);
        expect(queries.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'connect_requested',
            payload: {
                app_key: 'rely-leads',
                scopes: ['leads:create'],
                provisioning_mode: 'manual',
            },
        }), mockClient);
        expect(result).toEqual(expect.objectContaining({
            status: 'connected',
            app_key: 'rely-leads',
            key_id: 'ak_rely_new',
        }));
    });

    test('TC-C5-01 · re-enable creates a new row and credential without touching the shared one', async () => {
        queries.getPublishedAppByKey.mockResolvedValue(manualLeadApp());
        queries.findActiveInstallation.mockResolvedValue(null);
        queries.createInstallation.mockResolvedValue({ id: 502, status: 'provisioning_failed' });
        integrationsService.createIntegration.mockResolvedValue({ id: 9002, key_id: 'ak_rely_v2' });
        queries.updateInstallationCredential.mockResolvedValue({ id: 502, api_integration_id: 9002 });
        queries.markInstallationConnected.mockResolvedValue({ id: 502, status: 'connected' });

        const result = await marketplaceService.installApp(
            COMPANY,
            'user-1',
            'rely-leads',
            { requestId: 'req-reenable' }
        );

        expect(queries.createInstallation).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY,
            appId: 'app-rely',
        }), mockClient);
        expect(queries.updateInstallationCredential)
            .toHaveBeenCalledWith(COMPANY, 502, 9002, mockClient);
        expect(queries.revokeCredentialById).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
            id: 502,
            status: 'connected',
            key_id: 'ak_rely_v2',
        }));
    });
});

describe('MARKETPLACE-LEADGEN-SPLIT-001 structural contracts', () => {
    test('TC-G4-02 · four revoke sites remain and only disconnect has the sharing guard', () => {
        const source = fs.readFileSync(
            path.join(ROOT, 'backend', 'src', 'services', 'marketplaceService.js'),
            'utf8'
        );
        const installStart = source.indexOf('async function installApp');
        const disconnectStart = source.indexOf('async function disconnectInstallation');
        const retryStart = source.indexOf('async function retryProvisioning');
        const exportsStart = source.indexOf('module.exports');
        const installSlice = source.slice(installStart, disconnectStart);
        const disconnectSlice = source.slice(disconnectStart, retryStart);
        const retrySlice = source.slice(retryStart, exportsStart);

        expect(source.match(/revokeCredentialById\(/g)).toHaveLength(4);
        expect(disconnectSlice).toContain('countOtherActiveInstallationsOnCredential');
        expect(disconnectSlice).toMatch(/otherActive\s*===\s*0/);
        expect(installSlice).not.toContain('otherActive');
        expect(retrySlice).not.toContain('otherActive');
    });

    test('TC-C6-01 · ingestion and frontend remain independent of per-source app keys', () => {
        const seamPattern = /marketplace_(apps|installations)|marketplace[A-Z]|lead-generator|pro-referral-leads|rely-leads|nsa-leads|lhg-leads/;
        for (const relativePath of [
            'backend/src/routes/integrations-leads.js',
            'backend/src/middleware/integrationsAuth.js',
            'backend/src/middleware/integrationScopes.js',
        ]) {
            expect(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')).not.toMatch(seamPattern);
        }

        const frontendSource = readFilesRecursively(path.join(ROOT, 'frontend', 'src'))
            .map(filename => fs.readFileSync(filename, 'utf8'))
            .join('\n');
        expect(frontendSource).not.toMatch(/pro-referral-leads|rely-leads|nsa-leads|lhg-leads/);
    });

    test('TC-M2-02 · migration files are transaction-safe, silent, and rollback-documented', () => {
        const migrationDir = path.join(ROOT, 'backend', 'db', 'migrations');
        const forward = fs.readFileSync(
            path.join(migrationDir, '169_split_lead_generator_marketplace_apps.sql'),
            'utf8'
        );
        const rollback = fs.readFileSync(
            path.join(migrationDir, 'rollback_169_split_lead_generator_marketplace_apps.sql'),
            'utf8'
        );
        const forwardWithoutComments = forward
            .split('\n')
            .filter(line => !line.trimStart().startsWith('--'))
            .join('\n');

        expect(forward).not.toMatch(/RAISE\s+NOTICE/i);
        expect(forward).not.toMatch(/CONCURRENTLY/i);
        expect(forward).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
        expect(forwardWithoutComments).not.toContain('Blanc');
        expect(forward).toContain("'LHG Leads'");
        expect(forward).toContain('seeded_by":"MARKETPLACE-LEADGEN-SPLIT-001');
        expect(forward).toMatch(/NOT EXISTS/i);
        expect(forward).toMatch(/CROSS JOIN LATERAL/i);
        expect(forward).not.toMatch(/enforc/i);

        expect(rollback).toMatch(/^--.*ensureMarketplaceSchema/im);
        expect(rollback).toMatch(/^--.*ON DELETE SET NULL/im);
        expect(rollback).toMatch(/^--.*original lead-generator installation.*api_integrations.*untouched/im);
        expect(rollback).not.toMatch(/RAISE\s+NOTICE/i);
        expect(rollback).not.toMatch(/CONCURRENTLY/i);
    });
});
