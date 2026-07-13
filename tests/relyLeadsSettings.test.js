'use strict';

const fs = require('fs');
const path = require('path');

const mockRadiusGetSettings = jest.fn();
const mockCountListZips = jest.fn();
const mockListRadii = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn(),
    reconcileRevokedInstallations: jest.fn(),
    listPublishedAppsWithInstallation: jest.fn(),
    getPublishedAppByKey: jest.fn(),
    findActiveInstallation: jest.fn(),
    getConnectedRelySettings: jest.fn(),
    listInstallations: jest.fn(),
    getInstallationById: jest.fn(),
    createInstallation: jest.fn(),
    updateInstallationCredential: jest.fn(),
    setInstallationSettings: jest.fn(),
    revokeCredentialById: jest.fn(),
    countOtherActiveInstallationsOnCredential: jest.fn(),
    markInstallationConnected: jest.fn(),
    markProvisioningFailed: jest.fn(),
    markDisconnected: jest.fn(),
    writeEvent: jest.fn(),
}));
jest.mock('../backend/src/db/territoryRadiusQueries', () => ({
    getSettings: mockRadiusGetSettings,
    countListZips: mockCountListZips,
    listRadii: mockListRadii,
}));
jest.mock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
jest.mock('../backend/src/services/emailMailboxService', () => ({ getMailboxStatus: jest.fn() }));
jest.mock('../backend/src/services/integrationsService', () => ({ createIntegration: jest.fn() }));
jest.mock('../backend/src/services/marketplaceProvisioningService', () => ({
    pushCredentials: jest.fn(), sanitizeErrorMessage: (message) => message,
}));

const express = require('express');
const request = require('supertest');
const queries = require('../backend/src/db/marketplaceQueries');
const marketplaceService = require('../backend/src/services/marketplaceService');
const marketplaceRouter = require('../backend/src/routes/marketplace');
const { evaluateRelyLead } = require('../backend/src/services/relyLeadFilterService');

const ROOT = path.join(__dirname, '..');
const COMPANY = '00000000-0000-0000-0000-000000000001';
const COMPANY_B = '00000000-0000-0000-0000-000000000002';
const APP = { id: 'app-rely', app_key: 'rely-leads', status: 'published' };
const SEEDED_METADATA = {
    seeded_by: 'MARKETPLACE-LEADGEN-SPLIT-001',
    shared_credential: true,
};
const INSTALLATION = {
    id: 7,
    company_id: COMPANY,
    app_id: APP.id,
    status: 'connected',
    metadata: SEEDED_METADATA,
};
const EXPECTED_UNIT_TYPES = [
    'Washer', 'Dryer', 'Refrigerator', 'Freezer', 'Dishwasher', 'Range',
    'Oven', 'Cooktop', 'Microwave', 'Ice Maker', 'Garbage Disposal', 'Vent Hood',
];
const EXPECTED_BRANDS = [
    'Whirlpool', 'GE', 'Samsung', 'LG', 'Maytag', 'Kenmore', 'KitchenAid',
    'Frigidaire', 'Bosch', 'Electrolux', 'Amana', 'Sub-Zero', 'Viking',
    'Thermador', 'Speed Queen',
];
const DEFAULT_SETTINGS = {
    zone: { mode: 'company', custom_zips: [] },
    unit_types: [],
    brands: [],
};

function setupConnectedInstallation(overrides = {}) {
    queries.getPublishedAppByKey.mockResolvedValue(APP);
    queries.findActiveInstallation.mockResolvedValue({ ...INSTALLATION, ...overrides });
}

function setupSuccessfulWrite() {
    queries.setInstallationSettings.mockImplementation(async (companyId, id, settings) => ({
        id,
        company_id: companyId,
        app_id: APP.id,
        status: 'connected',
        metadata: { ...SEEDED_METADATA, settings },
    }));
    queries.writeEvent.mockResolvedValue({});
}

async function expectServiceError(promise, code, httpStatus) {
    try {
        await promise;
        throw new Error(`Expected ${code}`);
    } catch (error) {
        expect(error).toBeInstanceOf(marketplaceService.MarketplaceServiceError);
        expect(error).toMatchObject({ code, httpStatus });
        return error;
    }
}

beforeEach(() => {
    jest.resetAllMocks();
    setupConnectedInstallation();
    setupSuccessfulWrite();
    mockRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
    mockCountListZips.mockResolvedValue(12);
    mockListRadii.mockResolvedValue([{ id: 1 }]);
});

describe('RELY-LEADS-SETTINGS-001 settings service and API', () => {
    test('TC-S1-01 · GET returns defaults, verbatim catalogs, and active territory', async () => {
        const result = await marketplaceService.getAppSettings(COMPANY, 'rely-leads');

        expect(result).toEqual({
            app_key: 'rely-leads',
            installation_id: 7,
            settings: DEFAULT_SETTINGS,
            catalogs: {
                unit_types: EXPECTED_UNIT_TYPES,
                brands: EXPECTED_BRANDS,
            },
            territory: { active_mode: 'list', has_data: true },
        });
        expect(mockRadiusGetSettings).toHaveBeenCalledWith(COMPANY);
        expect(mockCountListZips).toHaveBeenCalledWith(COMPANY);
        expect(mockListRadii).not.toHaveBeenCalled();
        expect(queries.setInstallationSettings).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
    });

    test('TC-S1-02 · GET defaults missing territory rows and uses the mode-correct data read', async () => {
        mockRadiusGetSettings.mockResolvedValueOnce(undefined);
        mockCountListZips.mockResolvedValueOnce(0);

        await expect(marketplaceService.getAppSettings(COMPANY, 'rely-leads'))
            .resolves.toMatchObject({ territory: { active_mode: 'list', has_data: false } });
        expect(mockCountListZips).toHaveBeenCalledTimes(1);
        expect(mockListRadii).not.toHaveBeenCalled();

        jest.clearAllMocks();
        setupConnectedInstallation();
        mockRadiusGetSettings.mockResolvedValue({ active_mode: 'radius' });
        mockListRadii.mockResolvedValue([]);

        await expect(marketplaceService.getAppSettings(COMPANY, 'rely-leads'))
            .resolves.toMatchObject({ territory: { active_mode: 'radius', has_data: false } });
        expect(mockListRadii).toHaveBeenCalledTimes(1);
        expect(mockCountListZips).not.toHaveBeenCalled();
    });

    test('TC-S2-01 · stored settings self-heal at read without rewriting the row', async () => {
        setupConnectedInstallation({
            metadata: {
                ...SEEDED_METADATA,
                settings: {
                    zone: { mode: 'teleport' },
                    unit_types: ['Dishwasher', 'Toaster'],
                    brands: 'x',
                },
            },
        });

        const result = await marketplaceService.getAppSettings(COMPANY, 'rely-leads');

        expect(result.settings).toEqual({
            zone: { mode: 'company', custom_zips: [] },
            unit_types: ['Dishwasher'],
            brands: [],
        });
        expect(queries.setInstallationSettings).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
    });

    test('TC-S3-01 · PUT canonicalizes ZIPs/catalogs, ignores client audit fields, and audits counts', async () => {
        const result = await marketplaceService.updateAppSettings(
            COMPANY,
            'crm-user-1',
            'rely-leads',
            {
                zone: {
                    mode: 'custom',
                    custom_zips: '02301, 02302; 2043\n02744, 02301',
                },
                unit_types: ['dishwasher'],
                updated_at: 'client-value',
                updated_by: 'keycloak-sub',
            },
            { requestId: 'req-t' }
        );

        expect(result.settings).toEqual({
            zone: { mode: 'custom', custom_zips: ['02301', '02302', '02043', '02744'] },
            unit_types: ['Dishwasher'],
            brands: [],
        });
        expect(queries.setInstallationSettings).toHaveBeenCalledTimes(1);
        const [companyId, installationId, stored] = queries.setInstallationSettings.mock.calls[0];
        expect(companyId).toBe(COMPANY);
        expect(installationId).toBe(7);
        expect(stored).toMatchObject({
            zone: { mode: 'custom', custom_zips: ['02301', '02302', '02043', '02744'] },
            unit_types: ['Dishwasher'],
            brands: [],
            updated_by: 'crm-user-1',
        });
        expect(new Date(stored.updated_at).toISOString()).toBe(stored.updated_at);
        expect(stored.updated_at).not.toBe('client-value');
        expect(queries.writeEvent).toHaveBeenCalledTimes(1);
        const event = queries.writeEvent.mock.calls[0][0];
        expect(event).toEqual({
            companyId: COMPANY,
            installationId: 7,
            appId: APP.id,
            actorId: 'crm-user-1',
            eventType: 'settings_updated',
            requestId: 'req-t',
            payload: {
                app_key: 'rely-leads',
                zone_mode: 'custom',
                custom_zip_count: 4,
                unit_type_count: 1,
                brand_count: 0,
            },
        });
        expect(JSON.stringify(event.payload)).not.toContain('02301');

        jest.clearAllMocks();
        setupConnectedInstallation();
        setupSuccessfulWrite();
        mockRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
        mockCountListZips.mockResolvedValue(0);
        await marketplaceService.updateAppSettings(
            COMPANY,
            'crm-user-1',
            'rely-leads',
            { zone: { mode: 'company' }, unit_types: [] }
        );
        expect(queries.setInstallationSettings.mock.calls[0][2].brands).toEqual([]);
    });

    test('TC-S3-02 · PUT sends one complete settings object through the top-level merge seam', async () => {
        await marketplaceService.updateAppSettings(
            COMPANY,
            'crm-user-1',
            'rely-leads',
            {
                zone: { mode: 'custom', custom_zips: ['02301'] },
                unit_types: ['Washer'],
                brands: ['GE'],
            }
        );

        const stored = queries.setInstallationSettings.mock.calls[0][2];
        expect(Object.keys(stored).sort()).toEqual([
            'brands', 'unit_types', 'updated_at', 'updated_by', 'zone',
        ]);
        expect(stored).toMatchObject({
            zone: { mode: 'custom', custom_zips: ['02301'] },
            unit_types: ['Washer'],
            brands: ['GE'],
        });

        const querySource = fs.readFileSync(
            path.join(ROOT, 'backend', 'src', 'db', 'marketplaceQueries.js'),
            'utf8'
        );
        const writeStart = querySource.indexOf('async function setInstallationSettings');
        const writeEnd = querySource.indexOf('async function revokeCredentialById');
        const writeSlice = querySource.slice(writeStart, writeEnd);
        expect(writeSlice).toContain(
            "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('settings', $3::jsonb)"
        );
        expect(writeSlice).not.toContain('jsonb_set');

        const serviceSource = fs.readFileSync(
            path.join(ROOT, 'backend', 'src', 'services', 'marketplaceService.js'),
            'utf8'
        );
        const updateStart = serviceSource.indexOf('async function updateAppSettings');
        const installStart = serviceSource.indexOf('async function createCredentialForInstallation');
        const updateSlice = serviceSource.slice(updateStart, installStart);
        expect(updateSlice).toContain('marketplaceQueries.setInstallationSettings');
        expect(updateSlice).not.toContain('db.query');
        expect(updateSlice).not.toContain('jsonb_set');
    });

    test('TC-S4-01 · PUT rejects invalid and oversized ZIP inputs without writes or events', async () => {
        const invalid = await expectServiceError(
            marketplaceService.updateAppSettings(
                COMPANY,
                'crm-user-1',
                'rely-leads',
                { zone: { mode: 'custom', custom_zips: '02301, ABCDE' } }
            ),
            'INVALID_ZIPS',
            400
        );
        expect(invalid.message).toContain('ABCDE');

        await expectServiceError(
            marketplaceService.updateAppSettings(
                COMPANY,
                'crm-user-1',
                'rely-leads',
                {
                    zone: {
                        mode: 'custom',
                        custom_zips: Array.from({ length: 501 }, (_, index) => String(10000 + index)),
                    },
                }
            ),
            'ZIP_LIST_TOO_LARGE',
            400
        );

        const badTokens = Array.from(
            { length: 12 },
            (_, index) => `BAD-${String.fromCharCode(65 + index)}`
        );
        const capped = await expectServiceError(
            marketplaceService.updateAppSettings(
                COMPANY,
                'crm-user-1',
                'rely-leads',
                { zone: { mode: 'custom', custom_zips: badTokens.join(' ') } }
            ),
            'INVALID_ZIPS',
            400
        );
        expect(badTokens.slice(0, 10).every((token) => capped.message.includes(token))).toBe(true);
        expect(badTokens.slice(10).every((token) => !capped.message.includes(token))).toBe(true);
        expect(queries.setInstallationSettings).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
    });

    test('TC-S4-02 · PUT enforces shape, mode, and catalog taxonomy and canonicalizes valid casing', async () => {
        const rows = [
            [{ zone: 'custom' }, 'INVALID_SETTINGS'],
            [{ unit_types: 'Dishwasher' }, 'INVALID_SETTINGS'],
            [{ zone: { mode: 'radius' } }, 'INVALID_ZONE_MODE'],
            [{ unit_types: ['Toaster'] }, 'INVALID_UNIT_TYPES'],
            [{ brands: ['Sony'] }, 'INVALID_BRANDS'],
        ];
        for (const [body, code] of rows) {
            await expectServiceError(
                marketplaceService.updateAppSettings(
                    COMPANY,
                    'crm-user-1',
                    'rely-leads',
                    body
                ),
                code,
                400
            );
        }
        expect(queries.setInstallationSettings).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();

        await marketplaceService.updateAppSettings(
            COMPANY,
            'crm-user-1',
            'rely-leads',
            { brands: ['sub-zero', 'SPEED QUEEN'] }
        );
        expect(queries.setInstallationSettings.mock.calls[0][2].brands)
            .toEqual(['Sub-Zero', 'Speed Queen']);
    });

    test('TC-S5-01 · 404 taxonomy is ordered before validation and never writes or audits', async () => {
        jest.clearAllMocks();
        for (const appKey of [
            'nsa-leads', 'pro-referral-leads', 'lhg-leads', 'lead-generator', 'garbage-key',
        ]) {
            await expectServiceError(
                marketplaceService.getAppSettings(COMPANY, appKey),
                'SETTINGS_NOT_SUPPORTED',
                404
            );
        }
        expect(queries.getPublishedAppByKey).not.toHaveBeenCalled();

        queries.getPublishedAppByKey.mockResolvedValueOnce(null);
        await expectServiceError(
            marketplaceService.getAppSettings(COMPANY, 'rely-leads'),
            'APP_NOT_FOUND',
            404
        );

        queries.getPublishedAppByKey.mockResolvedValue(APP);
        queries.findActiveInstallation.mockResolvedValue(null);
        await expectServiceError(
            marketplaceService.getAppSettings(COMPANY, 'rely-leads'),
            'APP_NOT_INSTALLED',
            404
        );
        await expectServiceError(
            marketplaceService.updateAppSettings(
                COMPANY,
                'crm-user-1',
                'rely-leads',
                { unit_types: ['Toaster'] }
            ),
            'APP_NOT_INSTALLED',
            404
        );
        expect(queries.setInstallationSettings).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
    });

    test('TC-S5-02 · provisioning_failed is not settings-eligible for either verb', async () => {
        setupConnectedInstallation({ id: 8, status: 'provisioning_failed', metadata: {} });

        await expectServiceError(
            marketplaceService.getAppSettings(COMPANY, 'rely-leads'),
            'APP_NOT_INSTALLED',
            404
        );
        await expectServiceError(
            marketplaceService.updateAppSettings(COMPANY, null, 'rely-leads', {}),
            'APP_NOT_INSTALLED',
            404
        );
        expect(mockRadiusGetSettings).not.toHaveBeenCalled();
        expect(mockCountListZips).not.toHaveBeenCalled();
        expect(mockListRadii).not.toHaveBeenCalled();
        expect(queries.setInstallationSettings).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
    });

    test('TC-S6-01 · router derives tenancy only from req.companyFilter and ignores poisoned inputs', async () => {
        jest.clearAllMocks();
        queries.getPublishedAppByKey.mockResolvedValue(APP);
        queries.findActiveInstallation.mockResolvedValue(null);

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.companyFilter = { company_id: COMPANY_B };
            req.user = { crmUser: { id: 'crm-b' } };
            req.requestId = 'req-b';
            next();
        });
        app.use(marketplaceRouter);

        const getResponse = await request(app)
            .get(`/apps/rely-leads/settings?company_id=${COMPANY}`);
        expect(getResponse.status).toBe(404);
        expect(getResponse.body).toMatchObject({
            success: false,
            code: 'APP_NOT_INSTALLED',
            request_id: 'req-b',
        });
        expect(getResponse.body.message).not.toContain(COMPANY);

        const putResponse = await request(app)
            .put('/apps/rely-leads/settings')
            .send({
                company_id: COMPANY,
                installation_id: 1,
                zone: { mode: 'company', custom_zips: [] },
            });
        expect(putResponse.status).toBe(404);
        expect(putResponse.body).toMatchObject({
            success: false,
            code: 'APP_NOT_INSTALLED',
            request_id: 'req-b',
        });
        expect(putResponse.body.message).not.toContain(COMPANY);
        expect(queries.findActiveInstallation).toHaveBeenCalledTimes(2);
        for (const call of queries.findActiveInstallation.mock.calls) {
            expect(call).toEqual([COMPANY_B, APP.id]);
        }

        queries.findActiveInstallation.mockResolvedValue({
            id: 22,
            company_id: COMPANY_B,
            app_id: APP.id,
            status: 'connected',
            metadata: {
                settings: {
                    zone: { mode: 'custom', custom_zips: ['02744'] },
                    unit_types: [],
                    brands: [],
                },
            },
        });
        mockRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
        mockCountListZips.mockResolvedValue(1);
        const ownResponse = await request(app).get('/apps/rely-leads/settings');
        expect(ownResponse.status).toBe(200);
        expect(ownResponse.body).toMatchObject({
            success: true,
            installation_id: 22,
            settings: { zone: { mode: 'custom', custom_zips: ['02744'] } },
            request_id: 'req-b',
        });
        expect(queries.findActiveInstallation).toHaveBeenLastCalledWith(COMPANY_B, APP.id);
    });

    test('TC-S7-01 · custom mode with an empty ZIP list is valid and stored as-is', async () => {
        const result = await marketplaceService.updateAppSettings(
            COMPANY,
            'crm-user-1',
            'rely-leads',
            {
                zone: { mode: 'custom', custom_zips: [] },
                unit_types: [],
                brands: [],
            }
        );

        expect(result.settings.zone).toEqual({ mode: 'custom', custom_zips: [] });
        expect(queries.setInstallationSettings.mock.calls[0][2].zone)
            .toEqual({ mode: 'custom', custom_zips: [] });
        expect(queries.writeEvent.mock.calls[0][0].payload).toMatchObject({
            zone_mode: 'custom',
            custom_zip_count: 0,
        });
    });

    test('TC-D2-01 · only successful PUT emits one counts-only settings event', async () => {
        await marketplaceService.getAppSettings(COMPANY, 'rely-leads');
        expect(queries.writeEvent).not.toHaveBeenCalled();

        await marketplaceService.updateAppSettings(
            COMPANY,
            'crm-user-1',
            'rely-leads',
            { zone: { mode: 'custom', custom_zips: ['02301'] } },
            { requestId: 'req-audit' }
        );
        expect(queries.writeEvent).toHaveBeenCalledTimes(1);
        expect(queries.writeEvent.mock.calls[0][0]).toMatchObject({
            eventType: 'settings_updated',
            payload: {
                app_key: 'rely-leads',
                zone_mode: 'custom',
                custom_zip_count: 1,
                unit_type_count: 0,
                brand_count: 0,
            },
        });

        jest.clearAllMocks();
        setupConnectedInstallation();
        await expectServiceError(
            marketplaceService.updateAppSettings(
                COMPANY,
                'crm-user-1',
                'rely-leads',
                { brands: ['Sony'] }
            ),
            'INVALID_BRANDS',
            400
        );
        expect(queries.writeEvent).not.toHaveBeenCalled();

        queries.getPublishedAppByKey.mockResolvedValue(APP);
        queries.findActiveInstallation.mockResolvedValue(null);
        await expectServiceError(
            marketplaceService.updateAppSettings(COMPANY, 'crm-user-1', 'rely-leads', {}),
            'APP_NOT_INSTALLED',
            404
        );
        expect(queries.writeEvent).not.toHaveBeenCalled();

        queries.getConnectedRelySettings.mockResolvedValue({
            metadata: {
                settings: {
                    zone: { mode: 'custom', custom_zips: ['02301'] },
                    unit_types: [],
                    brands: [],
                },
            },
        });
        const verdict = await evaluateRelyLead({ PostalCode: '02888' }, COMPANY);
        expect(verdict).toMatchObject({ accepted: false, reason: 'out_of_area' });
        expect(queries.writeEvent).not.toHaveBeenCalled();
    });
});
