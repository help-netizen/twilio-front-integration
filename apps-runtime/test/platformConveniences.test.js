'use strict';

const { validateAndDryRun } = require('../src/builderDryRun');
const {
    LOG_TRUNCATION_MARKER,
    MAX_LOG_CHARACTERS,
    MAX_LOG_LINES,
    sourceSha256,
} = require('../src/runner');
const { GATEWAY_BASE_URL, TEST_TOKEN, runApplication } = require('./helpers');

function execute(source, options = {}) {
    return validateAndDryRun({
        source,
        expectedSourceSha256: sourceSha256(source),
        ...options,
    });
}

describe('APP-PLATFORM-001 runner conveniences', () => {
    test('1 ctx.company and ctx.settings are deeply frozen and company exposes no id', async () => {
        const source = `export async function run(ctx) {
            return {
                company: ctx.company,
                company_frozen: Object.isFrozen(ctx.company),
                settings_frozen: Object.isFrozen(ctx.settings),
                nested_frozen: Object.isFrozen(ctx.settings.display),
                context_frozen: Object.isFrozen(ctx),
                company_id_is_undefined: ctx.company.id === undefined
            };
        }`;
        let usage = null;
        const result = await runApplication({
            source,
            input: { today: '2026-08-03', trigger: 'manual' },
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            company: {
                name: 'Acme Repairs',
                timezone: 'America/Chicago',
                id: 'must-not-cross-the-isolate-boundary',
            },
            settings: { display: { compact: true } },
            onUsage: value => { usage = value; },
        });

        expect(result).toEqual({
            company: { name: 'Acme Repairs', timezone: 'America/Chicago' },
            company_frozen: true,
            settings_frozen: true,
            nested_frozen: true,
            context_frozen: true,
            company_id_is_undefined: true,
        });
        expect(usage).toMatchObject({ error_code: null, logs: [] });
    });

    test('4 ctx.log is a non-throwing string sink with character/line caps in dry-run report', async () => {
        const source = `export async function run(ctx) {
            ctx.log('x'.repeat(${MAX_LOG_CHARACTERS + 20}));
            ctx.log({ ignored: true });
            for (let index = 0; index < ${MAX_LOG_LINES + 2}; index += 1) {
                ctx.log('line-' + index);
            }
            return { view_version: 1, title: 'Safe', blocks: [] };
        }`;
        const execution = await execute(source);

        expect(execution.logs).toEqual(execution.usage.logs);
        expect(execution.logs).toHaveLength(MAX_LOG_LINES);
        expect(Array.from(execution.logs[0])).toHaveLength(MAX_LOG_CHARACTERS);
        expect(execution.logs[MAX_LOG_LINES - 1]).toBe(LOG_TRUNCATION_MARKER);
        expect(JSON.stringify(execution.result)).not.toContain('line-');
        expect(execution.result).not.toHaveProperty('logs');
    });
});
