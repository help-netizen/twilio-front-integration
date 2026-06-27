'use strict';

/**
 * SEND-DOC-001 (TASK-SD-15) — marketplaceService google-email overlay (§4.3).
 *
 * The `google-email` marketplace app is seeded with provisioning_mode='none' and NO
 * marketplace_installations row; its connected-state is derived from the REAL Gmail
 * mailbox, never an install row. Covers TC-SD-043/044/045:
 *
 *   - isAppConnected('google-email')  ⇔  mailbox status === 'connected'   (install row irrelevant).
 *   - listApps overlays a SYNTHETIC connected installation (status='connected',
 *     external_installation_id = the mailbox email) when the mailbox is connected.
 *   - listApps resolves NOT connected for reconnect_required / disconnected / absent —
 *     AND a stale install-row with status='connected' does NOT make it appear connected.
 *   - other apps are returned exactly as mapAppRow built them (overlay touches only google-email).
 *
 * Strategy: mock marketplaceQueries (the app/installation rows) and emailMailboxService
 * (the mailbox truth); run the real marketplaceService over them. The remaining top-level
 * requires are stubbed so the module loads in isolation.
 *
 * Run:
 *   npx jest --runTestsByPath tests/googleEmailMarketplace.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

const mockListPublishedAppsWithInstallation = jest.fn();
const mockGetPublishedAppByKey = jest.fn();
const mockFindActiveInstallation = jest.fn();

jest.mock('../backend/src/db/marketplaceQueries', () => ({
    listPublishedAppsWithInstallation: (...a) => mockListPublishedAppsWithInstallation(...a),
    getPublishedAppByKey: (...a) => mockGetPublishedAppByKey(...a),
    findActiveInstallation: (...a) => mockFindActiveInstallation(...a),
}));

const mockGetMailboxStatus = jest.fn();
jest.mock('../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: (...a) => mockGetMailboxStatus(...a),
}));

// Remaining top-level requires — stubbed so marketplaceService loads in isolation.
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
jest.mock('../backend/src/services/integrationsService', () => ({ createIntegration: jest.fn() }));
jest.mock('../backend/src/services/marketplaceProvisioningService', () => ({
    pushCredentials: jest.fn(), sanitizeErrorMessage: (m) => m,
}));

const marketplaceService = require('../backend/src/services/marketplaceService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';

// A published google-email app row as listPublishedAppsWithInstallation would return it.
// `overrides` lets a test attach a (stale) install row.
function googleEmailRow(overrides = {}) {
    return {
        id: 'app-ge',
        app_key: 'google-email',
        name: 'Google Email',
        category: 'communication',
        app_type: 'internal',
        provisioning_mode: 'none',
        status: 'published',
        requested_scopes: [],
        metadata: { setup_path: '/settings/integrations/google-email' },
        installation_id: null,
        installation_status: null,
        ...overrides,
    };
}

function otherAppRow(overrides = {}) {
    return {
        id: 'app-zb',
        app_key: 'zenbooker',
        name: 'Zenbooker',
        category: 'scheduling',
        app_type: 'external',
        provisioning_mode: 'push_credentials',
        status: 'published',
        requested_scopes: ['jobs:read'],
        metadata: {},
        installation_id: 'inst-zb',
        installation_status: 'connected',
        installed_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── isAppConnected('google-email') ⇔ mailbox connected (TC-SD-045) ──────────
describe("isAppConnected('google-email')", () => {
    it('TC-SD-045: true iff mailbox connected — independent of any install row', async () => {
        mockGetMailboxStatus.mockResolvedValue({ provider: 'gmail', status: 'connected', email_address: 'ops@x.com' });
        await expect(marketplaceService.isAppConnected(COMPANY_A, 'google-email')).resolves.toBe(true);
        // never consults the marketplace install row for this app_key
        expect(mockGetPublishedAppByKey).not.toHaveBeenCalled();
        expect(mockFindActiveInstallation).not.toHaveBeenCalled();
    });

    it('TC-SD-045: false for reconnect_required / disconnected / absent / wrong-provider', async () => {
        for (const mailbox of [
            { provider: 'gmail', status: 'reconnect_required' },
            { provider: 'gmail', status: 'disconnected' },
            { provider: 'gmail', status: 'sync_error' },
            null,
            { provider: 'outlook', status: 'connected' }, // not gmail
        ]) {
            mockGetMailboxStatus.mockResolvedValue(mailbox);
            await expect(marketplaceService.isAppConnected(COMPANY_A, 'google-email')).resolves.toBe(false);
        }
    });

    it('other apps still resolve via the install row (mailbox NOT consulted)', async () => {
        mockGetPublishedAppByKey.mockResolvedValue({ id: 'app-zb' });
        mockFindActiveInstallation.mockResolvedValue({ status: 'connected' });
        await expect(marketplaceService.isAppConnected(COMPANY_A, 'zenbooker')).resolves.toBe(true);
        expect(mockGetMailboxStatus).not.toHaveBeenCalled();

        mockFindActiveInstallation.mockResolvedValue({ status: 'disconnected' });
        await expect(marketplaceService.isAppConnected(COMPANY_A, 'zenbooker')).resolves.toBe(false);
    });
});

// ─── listApps overlay — connected from the mailbox (TC-SD-043) ───────────────
describe('listApps — google-email overlay', () => {
    it('TC-SD-043: mailbox connected + NO install row → synthetic connected installation', async () => {
        mockListPublishedAppsWithInstallation.mockResolvedValue([googleEmailRow()]);
        mockGetMailboxStatus.mockResolvedValue({
            provider: 'gmail', status: 'connected', email_address: 'ops@x.com',
            created_at: '2026-02-02T00:00:00Z', last_synced_at: '2026-03-03T00:00:00Z',
        });

        const apps = await marketplaceService.listApps(COMPANY_A);
        const ge = apps.find(a => a.app_key === 'google-email');
        expect(ge.installation).toBeTruthy();
        expect(ge.installation.status).toBe('connected');
        expect(ge.installation.external_installation_id).toBe('ops@x.com');
    });

    it('TC-SD-044: reconnect_required / disconnected / absent / stale-install-row → NOT connected', async () => {
        // case 1: reconnect_required mailbox
        mockListPublishedAppsWithInstallation.mockResolvedValue([googleEmailRow()]);
        mockGetMailboxStatus.mockResolvedValue({ provider: 'gmail', status: 'reconnect_required', email_address: 'ops@x.com' });
        let ge = (await marketplaceService.listApps(COMPANY_A)).find(a => a.app_key === 'google-email');
        expect(ge.installation.status).toBe('disconnected');
        expect(ge.installation.external_installation_id).toBeNull();

        // case 2: no mailbox at all → overlay is null (not connected)
        mockGetMailboxStatus.mockResolvedValue(null);
        ge = (await marketplaceService.listApps(COMPANY_A)).find(a => a.app_key === 'google-email');
        expect(ge.installation).toBeNull();

        // case 3: a STALE marketplace_installations row says 'connected' but the mailbox is
        // disconnected — the overlay OVERRIDES the row → NOT connected (the row never wins).
        mockListPublishedAppsWithInstallation.mockResolvedValue([
            googleEmailRow({ installation_id: 'stale-inst', installation_status: 'connected', installed_at: '2025-01-01T00:00:00Z' }),
        ]);
        mockGetMailboxStatus.mockResolvedValue({ provider: 'gmail', status: 'disconnected', email_address: 'ops@x.com' });
        ge = (await marketplaceService.listApps(COMPANY_A)).find(a => a.app_key === 'google-email');
        expect(ge.installation.status).toBe('disconnected');
    });

    it('other apps are unaffected by the overlay (their install row is returned verbatim)', async () => {
        mockListPublishedAppsWithInstallation.mockResolvedValue([googleEmailRow(), otherAppRow()]);
        mockGetMailboxStatus.mockResolvedValue({ provider: 'gmail', status: 'connected', email_address: 'ops@x.com' });

        const apps = await marketplaceService.listApps(COMPANY_A);
        const other = apps.find(a => a.app_key === 'zenbooker');
        expect(other.installation).toEqual(expect.objectContaining({ id: 'inst-zb', status: 'connected' }));
        // mailbox is only consulted for the overlay, not folded into other apps
        expect(other.installation.external_installation_id).toBeUndefined();
    });
});
