'use strict';

const { validateApplicationSource } = require('../src/builderValidator');
const { validateAndDryRun } = require('../src/builderDryRun');
const { sourceSha256 } = require('../src/runner');

function dryRun(source) {
    return validateAndDryRun({ source, expectedSourceSha256: sourceSha256(source) });
}

describe('APP-BUILD-001 static validation and isolated dry run', () => {
    test.each([
        [
            'forbidden identifier',
            'export async function run(ctx) { return process.env; }',
            'FORBIDDEN_IDENTIFIER',
        ],
        [
            'missing run',
            'export async function build(ctx) { return ctx.input; }',
            'ENTRY_POINT_INVALID',
        ],
        [
            'unknown tool',
            "export async function run(ctx) { return ctx.callTool('svc.list_calls', {}); }",
            'UNKNOWN_TOOL',
        ],
        [
            'invalid syntax',
            'export async function run(ctx) { return {;',
            'SOURCE_PARSE_ERROR',
        ],
    ])('rejects %s before dry execution', async (_label, source, code) => {
        await expect(validateApplicationSource(source)).rejects.toMatchObject({ code });
    });

    test('rejects source larger than 64 KiB', async () => {
        const source = `export async function run(ctx) { return ${JSON.stringify('x'.repeat(66 * 1024))}; }`;
        await expect(validateApplicationSource(source)).rejects.toMatchObject({
            code: 'SOURCE_TOO_LARGE',
        });
    });

    test('an infinite loop is rejected by the Phase 2 isolate CPU limit', async () => {
        await expect(dryRun(
            'export async function run(ctx) { while (ctx) {} }'
        )).rejects.toMatchObject({ code: 'APP_RUNTIME_CPU_LIMIT' });
    });

    test('a working app returns a dry-run report and exact catalog tools', async () => {
        const source = `
            export async function run(ctx) {
                const jobs = await ctx.callTool('svc.list_jobs', { limit: 1 });
                return { count: jobs.results.length, today: ctx.input.today };
            }
        `;
        const { validation: report } = await dryRun(source);
        expect(report).toMatchObject({
            entry_point: 'run',
            tools: ['svc.list_jobs'],
            returned_type: 'object',
        });
        expect(report.source_bytes).toBeGreaterThan(0);
    });

    test('caller-supplied Phase 4 fixture maps still take precedence over generated data', async () => {
        const source = `
            export async function run(ctx) {
                const tasks = await ctx.callTool('svc.list_tasks', { limit: 10 });
                return tasks.tasks.length;
            }
        `;
        const execution = await validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            seed: 'must-not-be-used',
            fixtures: {
                'svc.list_tasks': { tasks: [{ id: 1 }], pagination: {} },
            },
        });
        expect(execution.result).toBe(1);
        expect(execution.fixturesSummary).toMatchObject({ companies: 0, tasks: 1 });
    });
});
