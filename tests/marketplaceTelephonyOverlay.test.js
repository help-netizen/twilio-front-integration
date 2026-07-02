'use strict';

/**
 * ONBTEL-001 Part B (ONBTEL-T11) — marketplaceService telephony-twilio overlay (§2.2).
 *
 * The `telephony-twilio` marketplace app (seed mig 145) has provisioning_mode='none',
 * metadata.derived_connection=true and NEVER gets a marketplace_installations row: its
 * connected state is derived from company_telephony via telephonyTenantService (the same
 * pattern as the google-email overlay). Covers TC-B-30…TC-B-39 (Docs/test-cases/ONBTEL-001.md §4):
 *
 *   - DEFAULT company (Boston Masters) → synthetic connected installation, installed_at null;
 *   - subaccount connected → status 'connected', installed_at = connected_at;
 *   - not connected → installation null (Available tile);
 *   - a company_telephony row with a NULL subaccount SID (autonomous-mode upsert) → null,
 *     exercised through the REAL telephonyTenantService.getTelephonyState over the mocked db;
 *   - the subaccount SID is NEVER serialized anywhere in the listApps response;
 *   - installApp('telephony-twilio') → 409 DERIVED_CONNECTION_APP thrown BEFORE
 *     createInstallation; the flag is data-driven (a fictional flagged app also rejects,
 *     an unflagged app installs normally);
 *   - isAppConnected symmetry with google-email (no install-row lookups);
 *   - neighbor apps (vapi-ai / stripe-payments / google-email) pass through untouched;
 *   - getTelephonyState errors bubble out of listApps (→ route 500), no special resilience.
 *
 * Strategy (test-cases §4): exact precedent tests/googleEmailMarketplace.test.js — mock
 * marketplaceQueries + the remaining top-level requires, run the REAL marketplaceService.
 * telephonyTenantService is the REAL module with getTelephonyState spied per-test (the spy
 * calls through for the DEFAULT-company and NULL-SID cases, so the real derivation runs).
 *
 * Run:
 *   npx jest --runTestsByPath tests/marketplaceTelephonyOverlay.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

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
    markInstallationConnected: jest.fn(),
    markProvisioningFailed: jest.fn(),
    markDisconnected: jest.fn(),
    writeEvent: jest.fn(),
}));
jest.mock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
jest.mock('../backend/src/services/emailMailboxService', () => ({ getMailboxStatus: jest.fn() }));
jest.mock('../backend/src/services/integrationsService', () => ({ createIntegration: jest.fn() }));
jest.mock('../backend/src/services/marketplaceProvisioningService', () => ({
    pushCredentials: jest.fn(), sanitizeErrorMessage: (m) => m,
}));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/marketplaceQueries');
const emailMailboxService = require('../backend/src/services/emailMailboxService');
const integrationsService = require('../backend/src/services/integrationsService');
const telephonyTenantService = require('../backend/src/services/telephonyTenantService');
const marketplaceService = require('../backend/src/services/marketplaceService');
const { MarketplaceServiceError } = marketplaceService;

const DEFAULT = telephonyTenantService.DEFAULT_COMPANY_ID; // 00000000-…-0001 (Boston Masters)
const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const SUB_SID = 'ACsub111000000000000000000000000';

const mockClient = { query: jest.fn(), release: jest.fn() };

// The published telephony-twilio row exactly as seeded by migration 145.
function telephonyRow(overrides = {}) {
    return {
        id: 'app-tt',
        app_key: 'telephony-twilio',
        name: 'Telephony — Twilio',
        provider_name: 'Albusto',
        category: 'telephony',
        app_type: 'internal',
        short_description: 'Business phone numbers, calls and texts for your company — powered by Twilio.',
        requested_scopes: [],
        provisioning_mode: 'none',
        status: 'published',
        metadata: {
            setup_path: '/settings/integrations/telephony-twilio',
            derived_connection: true,
            access_summary: ['Buy and manage phone numbers', 'Route inbound calls and SMS'],
        },
        installation_id: null,
        installation_status: null,
        ...overrides,
    };
}

function vapiRow() {
    return {
        id: 'app-vapi', app_key: 'vapi-ai', name: 'VAPI AI Agent', provider_name: 'Vapi',
        category: 'telephony', app_type: 'internal', provisioning_mode: 'none', status: 'published',
        requested_scopes: [], metadata: {},
        installation_id: 'inst-vapi', installation_status: 'connected',
        installed_at: '2026-01-01T00:00:00Z', disconnected_at: null, provisioning_error: null, last_used_at: null,
    };
}

function stripeRow() {
    return {
        id: 'app-stripe', app_key: 'stripe-payments', name: 'Stripe Payments', provider_name: 'Stripe',
        category: 'payments', app_type: 'internal', provisioning_mode: 'none', status: 'published',
        requested_scopes: [], metadata: {},
        installation_id: null, installation_status: null,
    };
}

function googleEmailRow() {
    return {
        id: 'app-ge', app_key: 'google-email', name: 'Google Email', provider_name: 'Albusto',
        category: 'communication', app_type: 'internal', provisioning_mode: 'none', status: 'published',
        requested_scopes: [], metadata: { setup_path: '/settings/integrations/google-email' },
        installation_id: null, installation_status: null,
    };
}

const SUBACCOUNT_STATE = {
    connected: true, provider: 'twilio', mode: 'subaccount', status: 'connected',
    subaccount_sid: SUB_SID, connected_at: '2026-07-01T09:00:00.000Z',
};

let stateSpy;

beforeEach(() => {
    jest.resetAllMocks();
    db.pool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rows: [] });
    queries.ensureMarketplaceSchema.mockResolvedValue(undefined);
    // Fresh spy each test; without an explicit mock it CALLS THROUGH to the real derivation.
    stateSpy = jest.spyOn(telephonyTenantService, 'getTelephonyState');
});

afterEach(() => {
    stateSpy.mockRestore();
});

// ─── listApps overlay (TC-B-30…TC-B-34) ───────────────────────────────────────

describe('listApps — telephony-twilio derived installation overlay', () => {
    test('TC-B-30: DEFAULT company (master) → synthetic connected installation, zero behavior change for Boston Masters', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([telephonyRow()]);

        // Real getTelephonyState: the DEFAULT company short-circuits to master-connected
        // without ever touching the database.
        const apps = await marketplaceService.listApps(DEFAULT);
        const tt = apps.find(a => a.app_key === 'telephony-twilio');

        expect(stateSpy).toHaveBeenCalledWith(DEFAULT);
        expect(db.query).not.toHaveBeenCalled();
        expect(tt.installation).toEqual({
            id: null,
            status: 'connected',
            installed_at: null,
            disconnected_at: null,
            provisioning_error: null,
            last_used_at: null,
            external_installation_id: null,
        });
    });

    test('TC-B-31: connected subaccount → status connected, installed_at = connected_at, no ids leaked', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([telephonyRow()]);
        stateSpy.mockResolvedValue(SUBACCOUNT_STATE);

        const apps = await marketplaceService.listApps(COMPANY_A);
        const tt = apps.find(a => a.app_key === 'telephony-twilio');

        expect(tt.installation).toEqual({
            id: null,
            status: 'connected',
            installed_at: '2026-07-01T09:00:00.000Z', // = connected_at
            disconnected_at: null,
            provisioning_error: null,
            last_used_at: null,
            external_installation_id: null,
        });
    });

    test('TC-B-32: not connected → installation null (Available tile)', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([telephonyRow()]);
        stateSpy.mockResolvedValue({ connected: false });

        const apps = await marketplaceService.listApps(COMPANY_A);
        expect(apps.find(a => a.app_key === 'telephony-twilio').installation).toBeNull();
    });

    test('TC-B-33 (E-B11): company_telephony row with NULL subaccount SID (autonomous upsert) → installation null', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([telephonyRow()]);
        // Real getTelephonyState over the mocked db: a row exists but the SID is NULL —
        // the real derivation must read it as NOT connected.
        db.query.mockResolvedValue({
            rows: [{ provider: 'twilio', twilio_subaccount_sid: null, status: null, connected_at: null, suspended_at: null }],
        });

        const apps = await marketplaceService.listApps(COMPANY_A);

        expect(apps.find(a => a.app_key === 'telephony-twilio').installation).toBeNull();
        const [stateSql, stateParams] = db.query.mock.calls[0];
        expect(stateSql).toContain('FROM company_telephony WHERE company_id = $1');
        expect(stateParams).toEqual([COMPANY_A]);
    });

    test('TC-B-34 (§8): the ENTIRE listApps response never serializes the subaccount SID', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([telephonyRow()]);
        stateSpy.mockResolvedValue(SUBACCOUNT_STATE);

        const apps = await marketplaceService.listApps(COMPANY_A);

        expect(JSON.stringify(apps)).not.toContain('ACsub111');
    });
});

// ─── installApp reject (TC-B-35, TC-B-36) ─────────────────────────────────────

describe('installApp — derived_connection apps are never installable', () => {
    test('TC-B-35 (E-B12): telephony-twilio → 409 DERIVED_CONNECTION_APP thrown BEFORE any installation row', async () => {
        queries.getPublishedAppByKey.mockResolvedValue(telephonyRow());
        queries.findActiveInstallation.mockResolvedValue(null);

        let thrown;
        try {
            await marketplaceService.installApp(COMPANY_A, 'user-1', 'telephony-twilio', { requestId: 'req-1' });
        } catch (err) {
            thrown = err;
        }

        expect(thrown).toBeInstanceOf(MarketplaceServiceError);
        expect(thrown).toMatchObject({
            code: 'DERIVED_CONNECTION_APP',
            httpStatus: 409,
            message: 'This app is configured from its setup page.',
        });
        // Rejected BEFORE anything was created.
        expect(queries.createInstallation).not.toHaveBeenCalled();
        expect(integrationsService.createIntegration).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
        // The transaction is rolled back and the client released.
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();
    });

    test('TC-B-36а: the flag is data-driven — a fictional app with metadata.derived_connection:true also rejects', async () => {
        queries.getPublishedAppByKey.mockResolvedValue({
            id: 'app-future', app_key: 'future-derived-app', name: 'Future Derived',
            requested_scopes: [], provisioning_mode: 'none', status: 'published',
            metadata: { derived_connection: true },
        });
        queries.findActiveInstallation.mockResolvedValue(null);

        await expect(marketplaceService.installApp(COMPANY_A, 'user-1', 'future-derived-app'))
            .rejects.toMatchObject({ code: 'DERIVED_CONNECTION_APP', httpStatus: 409 });
        expect(queries.createInstallation).not.toHaveBeenCalled();
    });

    test('TC-B-36б: an app WITHOUT the flag (vapi-ai) still installs normally', async () => {
        queries.getPublishedAppByKey.mockResolvedValue({
            id: 'app-vapi', app_key: 'vapi-ai', name: 'VAPI AI Agent', provider_name: 'Vapi',
            category: 'telephony', requested_scopes: [], provisioning_mode: 'none', metadata: {},
        });
        queries.findActiveInstallation.mockResolvedValue(null);
        queries.createInstallation.mockResolvedValue({ id: 301, status: 'provisioning_failed' });
        queries.markInstallationConnected.mockResolvedValue({ id: 301, status: 'connected', installed_at: '2026-07-02T00:00:00Z' });

        const result = await marketplaceService.installApp(COMPANY_A, 'user-1', 'vapi-ai', { requestId: 'req-2' });

        expect(queries.createInstallation).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('connected');
        expect(result.app_key).toBe('vapi-ai');
    });
});

// ─── isAppConnected symmetry (TC-B-37) ────────────────────────────────────────

describe("isAppConnected('telephony-twilio')", () => {
    test('TC-B-37: true/false straight from the derived state — install rows never consulted', async () => {
        stateSpy.mockResolvedValueOnce(SUBACCOUNT_STATE);
        await expect(marketplaceService.isAppConnected(COMPANY_A, 'telephony-twilio')).resolves.toBe(true);

        stateSpy.mockResolvedValueOnce({ connected: false });
        await expect(marketplaceService.isAppConnected(COMPANY_A, 'telephony-twilio')).resolves.toBe(false);

        // Symmetry with google-email: the marketplace install row is irrelevant.
        expect(queries.getPublishedAppByKey).not.toHaveBeenCalled();
        expect(queries.findActiveInstallation).not.toHaveBeenCalled();
        expect(emailMailboxService.getMailboxStatus).not.toHaveBeenCalled();
    });
});

// ─── Neighbor apps untouched (TC-B-38) + error bubbling (TC-B-39) ─────────────

describe('listApps — overlay touches ONLY telephony-twilio', () => {
    test('TC-B-38: vapi-ai / stripe-payments pass through verbatim; google-email overlay still works', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([
            telephonyRow(), vapiRow(), stripeRow(), googleEmailRow(),
        ]);
        stateSpy.mockResolvedValue(SUBACCOUNT_STATE);
        emailMailboxService.getMailboxStatus.mockResolvedValue({
            provider: 'gmail', status: 'connected', email_address: 'ops@x.com',
            created_at: '2026-02-02T00:00:00Z', last_synced_at: '2026-03-03T00:00:00Z',
        });

        const apps = await marketplaceService.listApps(COMPANY_A);
        const byKey = Object.fromEntries(apps.map(a => [a.app_key, a]));

        // vapi-ai: exactly what mapAppRow built from its REAL install row.
        expect(byKey['vapi-ai'].installation).toEqual({
            id: 'inst-vapi',
            status: 'connected',
            installed_at: '2026-01-01T00:00:00Z',
            disconnected_at: null,
            provisioning_error: null,
            last_used_at: null,
        });
        expect(byKey['vapi-ai'].installation.external_installation_id).toBeUndefined();

        // stripe-payments: no install row → null, untouched by any overlay.
        expect(byKey['stripe-payments'].installation).toBeNull();

        // google-email: its own overlay still derives from the mailbox as before.
        expect(byKey['google-email'].installation).toEqual(expect.objectContaining({
            status: 'connected',
            external_installation_id: 'ops@x.com',
        }));

        // telephony-twilio: the new derived overlay.
        expect(byKey['telephony-twilio'].installation).toEqual(expect.objectContaining({
            status: 'connected',
            installed_at: '2026-07-01T09:00:00.000Z',
        }));
    });

    test('TC-B-39 (E-B20): getTelephonyState throws → the error bubbles out of listApps (route answers 500)', async () => {
        queries.listPublishedAppsWithInstallation.mockResolvedValue([telephonyRow()]);
        stateSpy.mockRejectedValue(new Error('twilio state lookup failed'));

        await expect(marketplaceService.listApps(COMPANY_A)).rejects.toThrow('twilio state lookup failed');
    });
});
