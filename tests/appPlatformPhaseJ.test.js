'use strict';

const { buildPrompt } = require('../backend/src/services/appBuilderService');
const {
    createAppExecutionService,
    executeOnRunner,
} = require('../backend/src/services/appExecutionService');
const {
    createAppInstallationSettingsService,
} = require('../backend/src/services/appInstallationSettingsService');
const {
    AppSettingsValidationError,
    declaredSettingValues,
    renderSettingsContract,
    validateSettingDestinations,
    validateSettingValues,
    validateSettings,
} = require('../backend/src/services/appSettingsValidator');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const FOREIGN_COMPANY_ID = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const RUN_ID = '30000000-0000-4000-8000-000000000001';
const ORIGINAL_RUNNER_BASE_URL = process.env.APP_RUNNER_BASE_URL;
const ORIGINAL_RUNNER_SERVICE_TOKEN = process.env.APP_RUNNER_SERVICE_TOKEN;
const DECLARATIONS = [
    { key: 'supplier_email', label: 'Supplier email', type: 'email', required: true },
    { key: 'threshold', label: 'Threshold', type: 'number' },
    { key: 'portal', label: 'Portal', type: 'url' },
    {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: ['standard', 'urgent'],
    },
];

beforeEach(() => {
    process.env.APP_RUNNER_BASE_URL = 'https://runner.albusto.test';
    process.env.APP_RUNNER_SERVICE_TOKEN = 'phase-j-runner-token';
});

afterAll(() => {
    if (ORIGINAL_RUNNER_BASE_URL === undefined) delete process.env.APP_RUNNER_BASE_URL;
    else process.env.APP_RUNNER_BASE_URL = ORIGINAL_RUNNER_BASE_URL;
    if (ORIGINAL_RUNNER_SERVICE_TOKEN === undefined) delete process.env.APP_RUNNER_SERVICE_TOKEN;
    else process.env.APP_RUNNER_SERVICE_TOKEN = ORIGINAL_RUNNER_SERVICE_TOKEN;
});

function runnerResponse(result) {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            ok: true,
            result,
            usage: {
                wall_ms: 1,
                gateway_calls: 0,
                data_calls: 0,
                egress_calls: 0,
                result_bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
                error_code: null,
                logs: [],
            },
        }),
    };
}

describe('APP-PLATFORM-001 Phase J contract', () => {
    test('2 input.trigger reaches the runner for manual, schedule, action, and event runs', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(runnerResponse({ ok: true }));
        const cases = [
            ['manual', {}],
            ['schedule', {}],
            ['action', { action: { id: 'mark_ordered', row_key: 'purchase-41' } }],
            ['event', { event: { type: 'invoice.sent', payload: { invoice_id: 41 } } }],
        ];
        for (const [trigger, detail] of cases) {
            await executeOnRunner({
                sourceCode: 'export async function run() { return { ok: true }; }',
                sourceSha256: 'a'.repeat(64),
                runToken: `token-${trigger}`,
                trigger,
                company: { name: 'Acme Repairs', timezone: 'America/Chicago' },
                settings: { threshold: 4 },
                ...detail,
            }, fetchImpl);
        }

        const bodies = fetchImpl.mock.calls.map(([, options]) => JSON.parse(options.body));
        expect(bodies.map(body => body.input.trigger)).toEqual([
            'manual', 'schedule', 'action', 'event',
        ]);
        expect(bodies[2].input.action).toEqual(cases[2][1].action);
        expect(bodies[3].input.event).toEqual(cases[3][1].event);
        expect(bodies[0].company).toEqual({
            name: 'Acme Repairs',
            timezone: 'America/Chicago',
        });
        expect(bodies[0].company).not.toHaveProperty('id');
    });

    test('3 declarations and installation values enforce the closed settings contract', async () => {
        expect(validateSettings(DECLARATIONS)).toEqual(DECLARATIONS);
        expect(() => validateSettings([
            { key: 'credential', label: 'Credential', type: 'secret' },
        ])).toThrow(AppSettingsValidationError);
        expect(() => validateSettings(Array.from({ length: 9 }, (_value, index) => ({
            key: `field_${index}`,
            label: `Field ${index}`,
            type: 'text',
        })))).toThrow(/no more than 8/);

        const valid = {
            supplier_email: 'orders@example.com',
            threshold: 4,
            portal: 'https://supplier.example',
            mode: 'urgent',
        };
        expect(validateSettingValues(DECLARATIONS, valid)).toEqual(valid);
        for (const invalid of [
            { ...valid, injected: 'attack' },
            { ...valid, threshold: '4' },
            { threshold: 4 },
            { ...valid, portal: 'https://127.0.0.1' },
        ]) {
            expect(() => validateSettingValues(DECLARATIONS, invalid))
                .toThrow(AppSettingsValidationError);
        }
        await expect(validateSettingDestinations(DECLARATIONS, valid, {
            lookup: jest.fn().mockResolvedValue([{ address: '10.0.0.8', family: 4 }]),
        })).rejects.toThrow(AppSettingsValidationError);

        const contract = renderSettingsContract();
        const prompt = buildPrompt({ history: [] });
        expect(prompt).toContain(contract);
        expect(prompt).toContain('ctx.company');
        expect(prompt).toContain('ctx.settings');
        expect(prompt).toContain('ctx.log(message)');
        expect(prompt).toContain('ctx.input.trigger');
    });

    test('4 live logs are stored with the run but never enter its view document', async () => {
        const viewDocument = { view_version: 1, title: 'Safe', blocks: [] };
        const client = {
            release: jest.fn(),
            query: jest.fn(async sql => {
                if (/SELECT id AS run_id, status/.test(sql)) {
                    return { rows: [{
                        run_id: RUN_ID,
                        status: 'completed',
                        started_at: '2026-08-03T12:00:00.000Z',
                        completed_at: '2026-08-03T12:00:00.010Z',
                        duration_ms: 10,
                        gateway_calls: 0,
                        data_calls: 0,
                        egress_calls: 0,
                        result_bytes: Buffer.byteLength(JSON.stringify(viewDocument), 'utf8'),
                        error_code: null,
                        error_message: null,
                    }] };
                }
                if (/INSERT INTO audit_log/.test(sql)) return { rows: [{ id: '1' }] };
                if (/UPDATE marketplace_installations installation/.test(sql)) {
                    return { rows: [{ latest_run_id: RUN_ID }] };
                }
                return { rows: [] };
            }),
        };
        const service = createAppExecutionService({
            database: { getClient: jest.fn().mockResolvedValue(client) },
        });
        const result = await service.persistSuccessfulResult({
            companyId: COMPANY_ID,
            installationId: '91',
            runId: RUN_ID,
            viewDocument,
            logs: ['loaded 4 orders'],
        });

        const viewInsert = client.query.mock.calls.find(([sql]) => (
            /INSERT INTO app_run_results/.test(sql)
        ));
        const logInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO audit_log/.test(sql));
        expect(JSON.parse(viewInsert[1][3])).toEqual(viewDocument);
        expect(JSON.stringify(viewInsert)).not.toContain('loaded 4 orders');
        expect(JSON.parse(logInsert[1][3])).toEqual({ logs: ['loaded 4 orders'] });
        expect(result).not.toHaveProperty('logs');
        expect(result.view_document).toEqual(viewDocument);
    });

    test.each([
        ['tenant admin', 'tenant_admin', false, true],
        ['app author', 'dispatcher', true, true],
        ['ordinary viewer', 'dispatcher', false, false],
    ])('4 run history exposes logs to %s only', async (
        _label,
        roleKey,
        isAuthor,
        shouldSeeLogs
    ) => {
        const client = {
            release: jest.fn(),
            query: jest.fn(async sql => {
                if (/FROM marketplace_installations installation/.test(sql)) {
                    return { rows: [{
                        installation_id: '91',
                        company_id: COMPANY_ID,
                        app_id: '81',
                        latest_run_id: RUN_ID,
                        declared_actions: [],
                        declared_settings: [],
                        app_settings: {},
                        source_code: 'export async function run() {}',
                        source_sha256: 'a'.repeat(64),
                        version_id: '40000000-0000-4000-8000-000000000001',
                        company_name: 'Acme Repairs',
                        company_timezone: 'America/New_York',
                        allowed_tools: ['svc.list_jobs'],
                    }] };
                }
                if (/SELECT EXISTS/.test(sql) && /FROM app_studio_apps/.test(sql)) {
                    return { rows: [{ is_author: isAuthor }] };
                }
                if (/FROM app_runs run/.test(sql)) {
                    return { rows: [{
                        run_id: RUN_ID,
                        status: 'completed',
                        started_at: '2026-08-03T12:00:00.000Z',
                        completed_at: '2026-08-03T12:00:00.010Z',
                        duration_ms: 10,
                        gateway_calls: 0,
                        data_calls: 0,
                        egress_calls: 0,
                        result_bytes: 54,
                        error_code: null,
                        error_message: null,
                        has_result: true,
                    }] };
                }
                if (/FROM audit_log entry/.test(sql)) {
                    return { rows: [{ app_run_id: RUN_ID, logs: ['author detail'] }] };
                }
                return { rows: [] };
            }),
        };
        const service = createAppExecutionService({
            database: { getClient: jest.fn().mockResolvedValue(client) },
            authorization: {
                resolveCompanyUserAuthz: jest.fn().mockResolvedValue({
                    role_key: roleKey,
                    permissions: ['jobs.view'],
                }),
            },
        });

        const runs = await service.listRuns({
            companyId: COMPANY_ID,
            installationId: '91',
            actorId: ACTOR_ID,
        });
        if (shouldSeeLogs) expect(runs[0].logs).toEqual(['author detail']);
        else expect(runs[0]).not.toHaveProperty('logs');
        expect(client.query.mock.calls.some(([sql]) => /FROM audit_log entry/.test(sql)))
            .toBe(shouldSeeLogs);
    });

    test('5 settings GET/PUT are viewer-gated, tenant-scoped, and preserve a foreign tenant', async () => {
        let stored = {
            supplier_email: 'orders@example.com',
            injected: 'legacy-attack',
        };
        const client = {
            release: jest.fn(),
            query: jest.fn(async (sql, params = []) => {
                if (/FROM marketplace_installations installation/.test(sql)) {
                    if (params[0] !== COMPANY_ID || params[1] !== '91') return { rows: [] };
                    return { rows: [{
                        installation_id: '91',
                        company_id: COMPANY_ID,
                        app_id: '81',
                        app_settings: stored,
                        declared_settings: DECLARATIONS,
                        allowed_tools: ['svc.list_jobs'],
                    }] };
                }
                if (/UPDATE marketplace_installations installation/.test(sql)) {
                    if (params[0] !== COMPANY_ID || params[1] !== '91') return { rows: [] };
                    stored = JSON.parse(params[2]);
                    return { rows: [{ id: '91' }] };
                }
                return { rows: [] };
            }),
        };
        const execution = { requireViewerAccess: jest.fn().mockResolvedValue({
            role_key: 'tenant_admin',
        }) };
        const service = createAppInstallationSettingsService({
            database: { getClient: jest.fn().mockResolvedValue(client) },
            execution,
            validateDestinations: jest.fn().mockResolvedValue(undefined),
        });

        await expect(service.getSettings({
            companyId: COMPANY_ID,
            installationId: '91',
            actorId: ACTOR_ID,
        })).resolves.toMatchObject({
            declarations: DECLARATIONS,
            settings: { supplier_email: 'orders@example.com' },
        });
        expect(execution.requireViewerAccess).toHaveBeenCalledTimes(1);

        const replacement = {
            supplier_email: 'new@example.com',
            threshold: 9,
            portal: 'https://supplier.example',
            mode: 'standard',
        };
        await expect(service.updateSettings({
            companyId: COMPANY_ID,
            installationId: '91',
            actorId: ACTOR_ID,
            settings: replacement,
        })).resolves.toMatchObject({ settings: replacement });
        expect(stored).toEqual(replacement);
        const ownSnapshot = JSON.stringify(stored);
        await expect(service.updateSettings({
            companyId: FOREIGN_COMPANY_ID,
            installationId: '91',
            actorId: ACTOR_ID,
            settings: replacement,
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(JSON.stringify(stored)).toBe(ownSnapshot);
    });

    test('6 sabotage control: an undeclared stored key cannot reach ctx.settings', () => {
        expect(declaredSettingValues(
            [{ key: 'safe_key', label: 'Safe key', type: 'text' }],
            { safe_key: 'allowed', exfiltrate: 'must-not-cross' }
        )).toEqual({ safe_key: 'allowed' });
    });
});
