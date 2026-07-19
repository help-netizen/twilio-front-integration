'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    getAppConnectionSnapshot: jest.fn(),
}));
jest.mock('../backend/src/db/slotEngineSettingsQueries', () => ({
    getByCompany: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');
const slotEngineSettingsQueries = require('../backend/src/db/slotEngineSettingsQueries');
const actualMarketplaceQueries = jest.requireActual('../backend/src/db/marketplaceQueries');
const { getCapabilityCatalog } = require('../backend/src/services/assistant/capabilityCatalog');
const { getServiceConfig } = require('../backend/src/services/assistant/serviceConfig');

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const ASSISTANT_DIR = path.join(__dirname, '..', 'backend', 'src', 'services', 'assistant');
const ASSISTANT_SERVICE = path.join(
    __dirname, '..', 'backend', 'src', 'services', 'assistantService.js'
);
const ASSISTANT_ROUTE = path.join(
    __dirname, '..', 'backend', 'src', 'routes', 'assistant.js'
);

function appRow(appKey, installationStatus = null, installationSettings = null) {
    return {
        app_key: appKey,
        name: `App ${appKey}`,
        category: 'test',
        installation_status: installationStatus,
        installation_settings: installationSettings,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
    marketplaceQueries.getAppConnectionSnapshot.mockResolvedValue([]);
    slotEngineSettingsQueries.getByCompany.mockResolvedValue(null);
});

describe('ASSISTANT-BOT-001 structural isolation', () => {
    test('assistant modules import only the approved catalog/status read surface', () => {
        const allowedImports = new Set([
            '../../db/connection',
            '../../db/marketplaceQueries',
            '../../db/slotEngineSettingsQueries',
        ]);
        const files = fs.readdirSync(ASSISTANT_DIR)
            .filter(filename => filename.endsWith('.js'));

        expect(files).toEqual(expect.arrayContaining([
            'capabilityCatalog.js',
            'serviceConfig.js',
        ]));

        for (const filename of files) {
            const source = fs.readFileSync(path.join(ASSISTANT_DIR, filename), 'utf8');
            const requireCalls = source.match(/\brequire\s*\(/g) || [];
            const imports = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
                .map(match => match[1]);

            expect(imports).toHaveLength(requireCalls.length);
            for (const imported of imports) expect(allowedImports.has(imported)).toBe(true);
            expect(source).not.toMatch(/agentSkills/i);
            expect(source).not.toMatch(/(?:leads|jobs|contacts|calls|payments)Queries/i);
            expect(source).not.toMatch(/timeline(?:Queries|Service)?/i);
        }

        const serviceSource = fs.readFileSync(
            path.join(ASSISTANT_DIR, 'serviceConfig.js'),
            'utf8'
        );
        const marketplaceCalls = [...serviceSource.matchAll(/marketplaceQueries\.([A-Za-z0-9_]+)/g)]
            .map(match => match[1]);
        const slotCalls = [...serviceSource.matchAll(/slotEngineSettingsQueries\.([A-Za-z0-9_]+)/g)]
            .map(match => match[1]);
        expect([...new Set(marketplaceCalls)]).toEqual(['getAppConnectionSnapshot']);
        expect([...new Set(slotCalls)]).toEqual(['getByCompany']);
    });

    test('root assistant executor imports only context providers and operational DB', () => {
        const source = fs.readFileSync(ASSISTANT_SERVICE, 'utf8');
        const requireCalls = source.match(/\brequire\s*\(/g) || [];
        const imports = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
            .map(match => match[1]);

        expect(imports).toHaveLength(requireCalls.length);
        expect(imports).toEqual([
            './assistant/capabilityCatalog',
            './assistant/serviceConfig',
            '../db/connection',
        ]);
        expect(source).not.toMatch(/agentSkills/i);
        expect(source).not.toMatch(/(?:leads|jobs|contacts|calls|payments)Queries/i);
        expect(source).not.toMatch(/require\([^)]*timeline(?:Queries|Service)?/i);
        expect(source).not.toMatch(/require\([^)]*Queries/i);
    });

    test('assistant route imports only its service, operational DB, RBAC, and runtime primitives', () => {
        const source = fs.readFileSync(ASSISTANT_ROUTE, 'utf8');
        const imports = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
            .map(match => match[1]);

        expect(imports).toEqual([
            'express',
            'node:crypto',
            '../services/assistantService',
            '../db/connection',
            '../middleware/authorization',
        ]);
        expect(source).not.toMatch(/agentSkills/i);
        expect(source).not.toMatch(/require\([^)]*Queries/i);
    });

    test('boot replay restores assistant metadata after the split app seed', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'src', 'db', 'marketplaceQueries.js'),
            'utf8'
        );
        const split = "await query(readMigration('170_split_lead_generator_marketplace_apps.sql'));";
        const assistant = "await query(readMigration('173_seed_assistant_app_descriptions.sql'));";

        expect(source.match(/readMigration\('173_seed_assistant_app_descriptions\.sql'\)/g))
            .toHaveLength(1);
        expect(source.indexOf(split)).toBeGreaterThan(-1);
        expect(source.indexOf(assistant)).toBeGreaterThan(source.indexOf(split));
    });

    test('marketplace connection snapshot is one company-scoped pure SELECT', async () => {
        const rows = [appRow('rely-leads', 'connected', { enabled: true })];
        db.query.mockResolvedValue({ rows });

        await expect(actualMarketplaceQueries.getAppConnectionSnapshot(COMPANY_ID))
            .resolves.toEqual(rows);

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/^SELECT/i);
        expect(sql).toContain('mi.company_id = $1');
        expect(sql).toContain("a.status = 'published'");
        expect(sql).toContain("i.metadata->'settings' AS installation_settings");
        expect(sql).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE|DROP)\b/i);
        expect(params).toEqual([COMPANY_ID]);
    });
});

describe('getCapabilityCatalog', () => {
    test('projects only the bot-facing published catalog fields', async () => {
        db.query.mockResolvedValue({ rows: [{
            app_key: 'stripe-payments',
            name: 'Stripe Payments',
            category: 'payments',
            short_description: 'Accept card payments.',
            assistant: {
                what_it_does: 'Connects Stripe for customer payments.',
                prerequisites: ['A Stripe account'],
                setup_steps: ['Open Integrations', 'Connect Stripe'],
                outcome: 'Customers can pay online.',
                recommend_when: ['The company wants card payments'],
                gotchas: ['Complete Stripe onboarding'],
                secret_token: 'must-not-leak',
            },
            metadata: { private: true },
            installation_status: 'connected',
        }] });

        await expect(getCapabilityCatalog('stripe-payments')).resolves.toEqual([{
            app_key: 'stripe-payments',
            name: 'Stripe Payments',
            category: 'payments',
            short_description: 'Accept card payments.',
            what_it_does: 'Connects Stripe for customer payments.',
            prerequisites: ['A Stripe account'],
            setup_steps: ['Open Integrations', 'Connect Stripe'],
            outcome: 'Customers can pay online.',
            recommend_when: ['The company wants card payments'],
            gotchas: ['Complete Stripe onboarding'],
        }]);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain("status = 'published'");
        expect(sql).toContain("metadata->'assistant' AS assistant");
        expect(sql).not.toContain('marketplace_installations');
        expect(params).toEqual(['stripe-payments']);
    });

    test('missing or malformed assistant metadata degrades without throwing', async () => {
        db.query.mockResolvedValue({ rows: [
            {
                app_key: 'legacy-app',
                name: 'Legacy App',
                category: 'internal',
                short_description: 'Legacy app summary.',
                assistant: null,
            },
            {
                app_key: 'malformed-app',
                name: 'Malformed App',
                category: 'internal',
                short_description: 'Malformed app summary.',
                assistant: '{not-json',
            },
        ] });

        const catalog = await getCapabilityCatalog();

        expect(catalog).toEqual([
            {
                app_key: 'legacy-app',
                name: 'Legacy App',
                category: 'internal',
                short_description: 'Legacy app summary.',
                what_it_does: 'Legacy app summary.',
                prerequisites: [],
                setup_steps: [],
                outcome: null,
                recommend_when: [],
                gotchas: [],
            },
            {
                app_key: 'malformed-app',
                name: 'Malformed App',
                category: 'internal',
                short_description: 'Malformed app summary.',
                what_it_does: 'Malformed app summary.',
                prerequisites: [],
                setup_steps: [],
                outcome: null,
                recommend_when: [],
                gotchas: [],
            },
        ]);
        expect(db.query.mock.calls[0][1]).toEqual([null]);
    });
});

describe('getServiceConfig', () => {
    test('returns only per-app allowlisted settings and drops sabotage data', async () => {
        marketplaceQueries.getAppConnectionSnapshot.mockResolvedValue([
            appRow('rely-leads', 'connected', {
                zone: {
                    mode: 'custom',
                    custom_zips: ['02108', '02109'],
                    secret_token: 'zone-secret',
                },
                unit_types: ['Dishwasher', { secret_token: 'nested-unit-secret' }],
                brands: ['GE', 42],
                secret_token: 'rely-secret',
                customer_list: ['Customer One'],
                updated_by: 'private-user-id',
            }),
            appRow('smart-slot-engine', 'connected', { secret_token: 'installation-secret' }),
            appRow('slot-engine', 'connected', { secret_token: 'alias-installation-secret' }),
            appRow('mail-secretary', 'connected', {
                provider: 'gmail',
                enabled: false,
                secret_token: 'mail-secret',
                customer_list: ['Mail Customer'],
            }),
            appRow('vapi-ai', 'connected', {
                assistant_configured: true,
                secret_token: 'vapi-secret',
            }),
            appRow('stripe-payments', 'connected', {
                live_mode: true,
                connected_ready: true,
                secret_token: 'stripe-secret',
            }),
            appRow('telephony-twilio', 'connected', {
                autonomous_mode: true,
                has_numbers: true,
                secret_token: 'telephony-secret',
            }),
            appRow('unknown-app', 'connected', {
                enabled: true,
                secret_token: 'unknown-secret',
            }),
        ]);
        slotEngineSettingsQueries.getByCompany.mockResolvedValue({
            horizon_days: 5,
            max_distance_miles: 25,
            recommendations_shown: 4,
            overlap_minutes: 15,
            min_buffer_minutes: 30,
            secret_token: 'slot-secret',
            customer_list: ['Slot Customer'],
            updated_by: 'slot-private-user',
        });

        const result = await getServiceConfig(COMPANY_ID);

        expect(marketplaceQueries.getAppConnectionSnapshot).toHaveBeenCalledWith(COMPANY_ID);
        expect(slotEngineSettingsQueries.getByCompany).toHaveBeenCalledTimes(1);
        expect(slotEngineSettingsQueries.getByCompany).toHaveBeenCalledWith(COMPANY_ID);
        expect(result.find(app => app.app_key === 'rely-leads').settings).toEqual({
            zone_mode: 'custom',
            zip_count: 2,
            unit_types: ['Dishwasher'],
            brands: ['GE'],
        });
        for (const appKey of ['smart-slot-engine', 'slot-engine']) {
            expect(result.find(app => app.app_key === appKey).settings).toEqual({
                horizon_days: 5,
                max_distance_miles: 25,
                recommendations_shown: 4,
                overlap_minutes: 15,
                min_buffer_minutes: 30,
            });
        }
        expect(result.find(app => app.app_key === 'mail-secretary').settings).toEqual({
            provider: 'gmail',
            enabled: false,
        });
        expect(result.find(app => app.app_key === 'vapi-ai').settings).toEqual({
            assistant_configured: true,
        });
        for (const appKey of ['stripe-payments', 'telephony-twilio', 'unknown-app']) {
            expect(result.find(app => app.app_key === appKey).settings).toEqual({});
        }

        const serialized = JSON.stringify(result);
        for (const forbidden of [
            'secret_token',
            'customer_list',
            'updated_by',
            'Customer One',
            'private-user-id',
            'live_mode',
            'autonomous_mode',
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    test.each([
        ['connected', 'connected', true],
        ['provisioning', 'provisioning', false],
        ['provisioning_failed', 'error', false],
        ['error', 'error', false],
        ['disconnected', 'not_connected', false],
        ['revoked', 'not_connected', false],
        [null, 'not_connected', false],
        ['unexpected', 'not_connected', false],
    ])('maps installation status %p to %s', async (input, status, configured) => {
        marketplaceQueries.getAppConnectionSnapshot.mockResolvedValue([
            appRow('mail-secretary', input, { provider: 'gmail', enabled: true }),
        ]);

        await expect(getServiceConfig(COMPANY_ID)).resolves.toEqual([{
            app_key: 'mail-secretary',
            name: 'App mail-secretary',
            category: 'test',
            status,
            configured,
            settings: configured ? { provider: 'gmail', enabled: true } : {},
        }]);
        expect(slotEngineSettingsQueries.getByCompany).not.toHaveBeenCalled();
    });

    test('does not read slot settings when the slot app is not connected', async () => {
        marketplaceQueries.getAppConnectionSnapshot.mockResolvedValue([
            appRow('smart-slot-engine', 'provisioning_failed', {
                secret_token: 'must-not-leak',
            }),
        ]);

        await expect(getServiceConfig(COMPANY_ID)).resolves.toEqual([{
            app_key: 'smart-slot-engine',
            name: 'App smart-slot-engine',
            category: 'test',
            status: 'error',
            configured: false,
            settings: {},
        }]);
        expect(slotEngineSettingsQueries.getByCompany).not.toHaveBeenCalled();
    });
});
