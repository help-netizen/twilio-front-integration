'use strict';

const dryRunner = require('../backend/src/services/appBuilderDryRunService');

const ORIGINAL_RUNNER_NODE = process.env.APP_BUILDER_RUNNER_NODE;

afterEach(() => {
    if (ORIGINAL_RUNNER_NODE === undefined) delete process.env.APP_BUILDER_RUNNER_NODE;
    else process.env.APP_BUILDER_RUNNER_NODE = ORIGINAL_RUNNER_NODE;
});

describe('APP-BUILD-001 CRM-to-runner seam', () => {
    test('uses only the explicitly configured Node 24 executable on non-24 CRM nodes', () => {
        process.env.APP_BUILDER_RUNNER_NODE = '/opt/albusto/node24/bin/node';
        expect(dryRunner.runnerExecutable()).toBe('/opt/albusto/node24/bin/node');
    });

    test('parses the bounded JSON protocol and preserves the validation stage', () => {
        expect(dryRunner.parseResult(JSON.stringify({
            ok: true,
            report: { entry_point: 'run', tools: [], returned_type: 'object' },
        }))).toEqual({ entry_point: 'run', tools: [], returned_type: 'object' });
        expect(() => dryRunner.parseResult(JSON.stringify({
            ok: false,
            stage: 'static_validation',
            code: 'FORBIDDEN_IDENTIFIER',
            message: 'Rejected.',
        }))).toThrow(expect.objectContaining({
            code: 'FORBIDDEN_IDENTIFIER',
            stage: 'static_validation',
        }));
    });

    test('does not expose a shell-selected CLI path', () => {
        expect(dryRunner.CLI_PATH).toMatch(/apps-runtime\/src\/builderDryRunCli\.js$/);
        expect(dryRunner.CLI_PATH).not.toMatch(/[;&|`]/);
    });
});
