'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const forward = fs.readFileSync(
    path.join(MIGRATIONS, '238_note_attachment_unit_label_scan.sql'),
    'utf8'
);
const rollback = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_238_note_attachment_unit_label_scan.sql'),
    'utf8'
);

afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
});

describe('UNIT-LABEL-SCAN-001 marketplace seed', () => {
    test('untracked attachments have null scan metadata until an enabled worker claims them', () => {
        expect(forward).toMatch(/ADD COLUMN IF NOT EXISTS unit_label_scan_state TEXT,/);
        expect(forward).toMatch(/ADD COLUMN IF NOT EXISTS unit_label_scan_attempts SMALLINT,/);
        expect(forward).not.toMatch(/unit_label_scan_state TEXT NOT NULL/);
        expect(forward).not.toMatch(/unit_label_scan_state TEXT[^,]*DEFAULT/);
        expect(forward).not.toMatch(/unit_label_scan_attempts SMALLINT[^,]*DEFAULT/);
    });

    test('publishes a pure-gate Unit Label Scanner card with complete assistant metadata', () => {
        expect(forward).toMatch(/'unit-label-scanner'/);
        expect(forward).toMatch(/'Unit Label Scanner'/);
        expect(forward).toMatch(/'Albusto'/);
        expect(forward).toMatch(/'ai'/);
        expect(forward).toMatch(/'internal'/);
        expect(forward).toMatch(/'none'/);
        expect(forward).toMatch(/'published'/);
        expect(forward).toMatch(/Read appliance nameplates from note photos/);
        expect(forward).toMatch(/"requires_credential_input": false/);
        expect(forward).toMatch(/"pricing"/);
        expect(forward).not.toMatch(/"setup_path"/);
        expect(forward).not.toMatch(/Blanc/);

        for (const key of [
            'what_it_does',
            'prerequisites',
            'setup_steps',
            'outcome',
            'recommend_when',
            'gotchas',
        ]) {
            expect(forward).toContain(`"${key}"`);
        }
    });

    test('upsert refreshes every catalog field and remains migration-replay safe', () => {
        for (const column of [
            'name',
            'provider_name',
            'category',
            'app_type',
            'short_description',
            'long_description',
            'requested_scopes',
            'provisioning_mode',
            'status',
            'support_email',
            'metadata',
        ]) {
            expect(forward).toMatch(new RegExp(`${column} = EXCLUDED\\.${column}`));
        }
        expect(forward).toMatch(/updated_at = NOW\(\)/);
    });

    test('seeds only ABC Homes and never resurrects any historical disconnect', () => {
        expect(forward).toMatch(
            /WHERE company\.id = '00000000-0000-0000-0000-000000000001'::uuid/
        );
        expect(forward).toMatch(/"seeded_by":"UNIT-LABEL-SCAN-001"/);
        const installationSeed = forward.slice(forward.indexOf('INSERT INTO marketplace_installations'));
        expect(installationSeed).toMatch(/NOT EXISTS/);
        expect(installationSeed).toMatch(/existing\.company_id = company\.id/);
        expect(installationSeed).toMatch(/existing\.app_id = app\.id/);
        expect(installationSeed).not.toMatch(/existing\.status IN/);
    });

    test('rollback removes installations before the app and then removes scan columns', () => {
        const installations = rollback.indexOf('DELETE FROM marketplace_installations');
        const app = rollback.indexOf('DELETE FROM marketplace_apps');
        const columns = rollback.indexOf('ALTER TABLE note_attachments');
        expect(installations).toBeGreaterThanOrEqual(0);
        expect(app).toBeGreaterThan(installations);
        expect(columns).toBeGreaterThan(app);
    });
});

describe('UNIT-LABEL-SCAN-001 generic marketplace connection seam', () => {
    test('exported key resolves true only through a connected company installation', async () => {
        const getPublishedAppByKey = jest.fn();
        const findActiveInstallation = jest.fn();
        jest.doMock('../backend/src/db/marketplaceQueries', () => ({
            getPublishedAppByKey,
            findActiveInstallation,
        }));
        jest.doMock('../backend/src/db/connection', () => ({
            query: jest.fn(),
            pool: { connect: jest.fn() },
        }));
        jest.doMock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
        jest.doMock('../backend/src/services/emailMailboxService', () => ({ getMailboxStatus: jest.fn() }));
        jest.doMock('../backend/src/services/integrationsService', () => ({ createIntegration: jest.fn() }));
        jest.doMock('../backend/src/services/marketplaceProvisioningService', () => ({
            pushCredentials: jest.fn(),
            sanitizeErrorMessage: message => message,
        }));

        const marketplaceService = require('../backend/src/services/marketplaceService');
        const companyId = '00000000-0000-0000-0000-00000000000a';
        const appKey = marketplaceService.UNIT_LABEL_SCANNER_APP_KEY;
        expect(appKey).toBe('unit-label-scanner');

        getPublishedAppByKey.mockResolvedValue({ id: 'app-unit-label' });
        findActiveInstallation.mockResolvedValue({ status: 'connected' });
        await expect(marketplaceService.isAppConnected(companyId, appKey)).resolves.toBe(true);
        expect(getPublishedAppByKey).toHaveBeenCalledWith(appKey);
        expect(findActiveInstallation).toHaveBeenCalledWith(companyId, 'app-unit-label');

        findActiveInstallation.mockResolvedValue(null);
        await expect(marketplaceService.isAppConnected(companyId, appKey)).resolves.toBe(false);

        getPublishedAppByKey.mockResolvedValue(null);
        await expect(marketplaceService.isAppConnected(companyId, appKey)).resolves.toBe(false);

        getPublishedAppByKey.mockClear();
        findActiveInstallation.mockClear();
        getPublishedAppByKey.mockResolvedValue({ id: 'app-unit-label' });
        findActiveInstallation.mockResolvedValue({ status: 'connected' });
        const { defaultAppConnectionChecker } = require(
            '../backend/src/services/unitLabelScanService'
        );
        await expect(defaultAppConnectionChecker(companyId)).resolves.toBe(true);
        expect(getPublishedAppByKey).toHaveBeenCalledWith('unit-label-scanner');
    });
});
