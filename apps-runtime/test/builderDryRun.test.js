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

    test('plain object enumeration is allowed while object reshaping is not', () => {
        // Banning the identifier Object outright made every author rewrite a
        // key count as a hand-rolled loop, for no security gain: the isolate is
        // the wall. What stays out is the part that reshapes objects.
        const { validateSourcePolicy } = require('../src/builderSourcePolicy');
        const wrap = body => `export async function run(ctx){ ${body} }`;

        for (const body of [
            'const o = {a: 1}; return Object.keys(o).length;',
            'const o = {a: 1}; return Object.values(o).length;',
            'const o = {a: 1}; return Object.entries(o).length;',
            'return Object.fromEntries([["a", 1]]);',
        ]) {
            expect(() => validateSourcePolicy(wrap(body))).not.toThrow();
        }

        for (const body of [
            'return Object.assign({}, {a: 1});',
            'const o = {}; Object.defineProperty(o, "x", {value: 1}); return 1;',
            'return Object.getPrototypeOf({});',
            'return Reflect.get({a: 1}, "a");',
        ]) {
            expect(() => validateSourcePolicy(wrap(body))).toThrow(/Reflective object access/);
        }
    });

    test('Phase D dry-run memory starts empty, validates the declaration, and reports data_ops', async () => {
        const source = `
            export async function run(ctx) {
                const before = await ctx.data.list('purchases', { limit: 10, offset: 0 });
                await ctx.data.upsert('purchases', [{ estimate_id: 41, part_number: 'P-41' }]);
                const after = await ctx.data.list('purchases', { limit: 10, offset: 0 });
                return { before: before.rows.length, after: after.rows.length };
            }
        `;
        const declaration = [{
            name: 'purchases',
            key_fields: ['estimate_id', 'part_number'],
            columns: [
                { key: 'estimate_id', type: 'number' },
                { key: 'part_number', type: 'text' },
            ],
        }];
        const execute = () => validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            data_collections: declaration,
        });
        const first = await execute();
        const second = await execute();
        expect(first.result).toEqual({ before: 0, after: 1 });
        expect(second.result).toEqual({ before: 0, after: 1 });
        expect(first.dataOps).toEqual({
            list: { calls: 2, rows: 1 },
            upsert: { calls: 1, rows: 1 },
            delete: { calls: 0, rows: 0 },
        });
        expect(first.usage).toMatchObject({ data_calls: 3, error_code: null });

        await expect(validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            data_collections: [{ ...declaration[0], key_fields: ['missing'] }],
        })).rejects.toMatchObject({ code: 'DATA_COLLECTIONS_INVALID' });
    });
});
