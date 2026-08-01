'use strict';

const {
    MAX_SOURCE_BYTES,
    validateSourcePolicy,
} = require('../apps-runtime/src/builderSourcePolicy');
const { GATEWAY_TOOLS } = require('../apps-runtime/src/config');
const appRuntimeCatalog = require('../backend/src/services/appRuntimeToolCatalog');

describe('APP-BUILD-001 dependency-free source policy', () => {
    test('validator catalog exactly matches the authoritative Phase 1 projection', () => {
        expect(GATEWAY_TOOLS).toEqual(appRuntimeCatalog.TOOL_NAMES);
    });

    test.each(['require', 'process', 'fetch', 'eval', 'Function', 'WebAssembly'])(
        'rejects forbidden identifier %s',
        identifier => {
            expect(() => validateSourcePolicy(
                `export async function run(ctx) { return ${identifier}; }`
            )).toThrow(expect.objectContaining({ code: 'FORBIDDEN_IDENTIFIER' }));
        }
    );

    test('identifiers in strings and comments are not treated as executable capabilities', () => {
        expect(validateSourcePolicy(`
            // process and fetch are unavailable
            export async function run(ctx) { return "require eval Function WebAssembly"; }
        `)).toMatchObject({ entryPoint: 'run', tools: [] });
    });

    test.each([
        ['no export', 'async function run(ctx) { return ctx.input; }'],
        ['extra run', 'export async function run(ctx) { const run = 1; return run; }'],
        ['wrong parameter', 'export async function run(input) { return input; }'],
        ['extra export', 'export const value = 1; export async function run(ctx) { return value; }'],
    ])('rejects invalid one-run contract: %s', (_label, source) => {
        expect(() => validateSourcePolicy(source)).toThrow(expect.objectContaining({
            code: 'ENTRY_POINT_INVALID',
        }));
    });

    test('rejects dynamic import and source over the byte ceiling', () => {
        expect(() => validateSourcePolicy(
            "export async function run(ctx) { return import('bad'); }"
        )).toThrow(expect.objectContaining({ code: 'IMPORT_FORBIDDEN' }));
        expect(() => validateSourcePolicy(
            `export async function run(ctx) { return ${JSON.stringify('x'.repeat(MAX_SOURCE_BYTES))}; }`
        )).toThrow(expect.objectContaining({ code: 'SOURCE_TOO_LARGE' }));
    });

    test('extracts only literal catalog calls and rejects unknown or aliased calls', () => {
        expect(validateSourcePolicy(`
            export async function run(ctx) {
                await ctx.callTool('svc.list_jobs', {});
                await ctx.callTool('svc.list_tasks', {});
                return true;
            }
        `).tools).toEqual(['svc.list_jobs', 'svc.list_tasks']);
        expect(() => validateSourcePolicy(
            "export async function run(ctx) { return ctx.callTool('svc.list_calls', {}); }"
        )).toThrow(expect.objectContaining({ code: 'UNKNOWN_TOOL' }));
        expect(() => validateSourcePolicy(
            'export async function run(ctx) { const callTool = ctx.callTool; return callTool(ctx.input.name, {}); }'
        )).toThrow(expect.objectContaining({ code: 'CALL_TOOL_INVALID' }));
    });
});
