'use strict';

const { validateApplicationSource } = require('../src/builderValidator');
const { validateAndDryRun } = require('../src/builderDryRun');
const { sourceSha256 } = require('../src/runner');
const { generateSandboxFixtures } = require('../src/sandboxFixtures');

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

    test('6 Phase I dry-run returns sandbox_echo, reports egress, and opens zero sockets', async () => {
        const source = `
            export async function run(ctx) {
                return ctx.http.request('supplier', {
                    method: 'POST',
                    path: '/orders',
                    body: { sku: 'P-41' },
                });
            }
        `;
        const fetchImpl = jest.fn(async () => {
            throw new Error('A dry-run attempted to open a socket.');
        });
        const execution = await validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            connections: [{
                name: 'supplier',
                base_url: 'https://api.supplier.test',
                auth: { kind: 'bearer' },
            }],
            fetchImpl,
        });
        expect(execution.result).toEqual({
            status: 200,
            body: {
                sandbox_echo: {
                    connection: 'supplier',
                    method: 'POST',
                    path: '/orders',
                },
            },
        });
        expect(execution.egressCalls).toEqual([{
            connection: 'supplier',
            method: 'POST',
            path: '/orders',
        }]);
        expect(execution.usage).toMatchObject({
            gateway_calls: 0,
            data_calls: 0,
            egress_calls: 1,
            error_code: null,
        });
        expect(fetchImpl).not.toHaveBeenCalled();

        const invalidSource = `export async function run(ctx) {
            try {
                return await ctx.http.request('supplier', {
                    method: 'GET', path: '/orders', body: { invalid: true }
                });
            } catch (error) {
                return { code: error.code, status: error.status };
            }
        }`;
        await expect(validateAndDryRun({
            source: invalidSource,
            expectedSourceSha256: sourceSha256(invalidSource),
            connections: [{
                name: 'supplier',
                base_url: 'https://api.supplier.test',
                auth: { kind: 'bearer' },
            }],
            fetchImpl,
        })).resolves.toMatchObject({
            result: { code: 'INVALID_REQUEST', status: 400 },
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('Phase E exposes a validated action as ctx.input.action in the isolate', async () => {
        const source = 'export async function run(ctx) { return ctx.input.action; }';
        const action = { id: 'mark_ordered', row_key: 'purchase-41' };
        await expect(validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: { today: '2026-08-02', action },
        })).resolves.toMatchObject({ result: action });

        await expect(validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: {
                today: '2026-08-02',
                action: { id: 'mark-ordered', row_key: 'purchase-41' },
            },
        })).rejects.toMatchObject({ code: 'DRY_RUN_INPUT_INVALID' });
    });

    test('Phase F exposes a catalog event as ctx.input.event and enforces type and 8 KiB', async () => {
        const source = 'export async function run(ctx) { return ctx.input.event; }';
        const event = {
            type: 'estimate.approved',
            payload: { estimate_id: 41, order_list_count: 3 },
        };
        await expect(validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: { today: '2026-08-02', event },
        })).resolves.toMatchObject({ result: event });

        await expect(validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: { today: '2026-08-02', event: { type: 'unknown.event', payload: {} } },
        })).rejects.toMatchObject({ code: 'DRY_RUN_INPUT_INVALID' });
        await expect(validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: {
                today: '2026-08-02',
                event: {
                    type: 'estimate.approved',
                    payload: { value: 'x'.repeat(8 * 1024) },
                },
            },
        })).rejects.toMatchObject({ code: 'DRY_RUN_INPUT_INVALID' });
    });

    test('Phase G keeps created Tasks in memory, deduplicates them, and reports created_tasks', async () => {
        const source = `
            export async function run(ctx) {
                const jobs = await ctx.callTool('svc.list_jobs', { limit: 1, offset: 0 });
                const args = {
                    parent_type: 'job',
                    parent_id: Number(jobs.results[0].id),
                    description: 'Review the dry-run finding.',
                    due_at: ctx.input.today,
                };
                const first = await ctx.callTool('svc.create_task', args);
                const second = await ctx.callTool('svc.create_task', args);
                const tasks = await ctx.callTool('svc.list_tasks', {
                    search: 'Review the dry-run finding.',
                    limit: 10,
                    offset: 0,
                });
                return { first, second, visible: tasks.tasks.length };
            }
        `;
        const fixtures = generateSandboxFixtures('phase-g-dry-run', '2026-08-03');
        const persistedTaskCount = fixtures.tasks.length;
        const execution = await validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: { today: '2026-08-03' },
            fixtures,
        });
        expect(execution.result).toEqual({
            first: { task_id: expect.any(Number), status: 'open' },
            second: {
                task_id: execution.result.first.task_id,
                status: 'open',
                deduplicated: true,
            },
            visible: 1,
        });
        expect(execution.createdTasks).toEqual([{
            task_id: execution.result.first.task_id,
            status: 'open',
            parent_type: 'job',
            parent_id: expect.any(Number),
            description: 'Review the dry-run finding.',
            due_at: '2026-08-03T04:00:00.000Z',
        }]);
        expect(execution.usage).toMatchObject({ gateway_calls: 4, error_code: null });
        expect(fixtures.tasks).toHaveLength(persistedTaskCount);
    });

    test('Phase G dry-run refuses the fourth write invocation with the live English reason', async () => {
        const source = `
            export async function run(ctx) {
                const jobs = await ctx.callTool('svc.list_jobs', { limit: 1, offset: 0 });
                let failure = null;
                for (let index = 0; index < 4; index += 1) {
                    try {
                        await ctx.callTool('svc.create_task', {
                            parent_type: 'job',
                            parent_id: Number(jobs.results[0].id),
                            description: 'Dry-run write ' + index,
                        });
                    } catch (error) {
                        failure = { code: error.code, message: error.message };
                    }
                }
                return { continued: true, failure };
            }
        `;
        await expect(validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
        })).resolves.toMatchObject({
            result: {
                continued: true,
                failure: {
                    code: 'WRITE_CALL_LIMIT',
                    message: 'Write call limit of 3 reached.',
                },
            },
        });
    });

    test('Phase H dry-run deduplicates Notes and reports their App source projection', async () => {
        const source = `
            export async function run(ctx) {
                const leads = await ctx.callTool('svc.list_leads', { limit: 1, offset: 0 });
                const args = {
                    parent_type: 'lead',
                    parent_id: Number(leads.results[0].id),
                    text: 'Follow up before scheduling.',
                };
                const first = await ctx.callTool('svc.add_note', args);
                const second = await ctx.callTool('svc.add_note', args);
                return { first, second };
            }
        `;
        const execution = await validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            seed: 'phase-h-note-dedup',
            anchor: '2026-08-03',
        });
        expect(execution.result).toEqual({
            first: { note_id: 'sandbox-app-note-1' },
            second: { note_id: 'sandbox-app-note-1', deduplicated: true },
        });
        expect(execution.createdNotes).toEqual([{
            note_id: 'sandbox-app-note-1',
            parent_type: 'lead',
            parent_id: expect.any(Number),
            text: 'Follow up before scheduling.',
            source: 'app',
        }]);
    });

    test('Phase H dry-run shares three write calls across two Tasks and two Notes', async () => {
        const source = `
            export async function run(ctx) {
                const jobs = await ctx.callTool('svc.list_jobs', { limit: 1, offset: 0 });
                const jobId = Number(jobs.results[0].id);
                await ctx.callTool('svc.create_task', {
                    parent_type: 'job', parent_id: jobId, description: 'First shared write.',
                });
                await ctx.callTool('svc.create_task', {
                    parent_type: 'job', parent_id: jobId, description: 'Second shared write.',
                });
                await ctx.callTool('svc.add_note', {
                    parent_type: 'job', parent_id: jobId, text: 'Third shared write.',
                });
                try {
                    await ctx.callTool('svc.add_note', {
                        parent_type: 'job', parent_id: jobId, text: 'Fourth shared write.',
                    });
                } catch (error) {
                    return { code: error.code, message: error.message };
                }
                return null;
            }
        `;
        await expect(validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
        })).resolves.toMatchObject({
            result: {
                code: 'WRITE_CALL_LIMIT',
                message: 'Write call limit of 3 reached.',
            },
            createdTasks: [{}, {}],
            createdNotes: [{}],
        });
    });
});
