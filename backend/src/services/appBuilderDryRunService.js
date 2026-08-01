'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const CLI_PATH = path.resolve(
    __dirname,
    '../../../apps-runtime/src/builderDryRunCli.js'
);

class AppBuilderDryRunError extends Error {
    constructor(code, message, stage = 'dry_run') {
        super(message);
        this.name = 'AppBuilderDryRunError';
        this.code = code;
        this.stage = stage;
        this.httpStatus = 422;
    }
}

function timeoutMs() {
    const parsed = parseInt(process.env.APP_BUILDER_DRY_RUN_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function runnerExecutable() {
    const configured = String(process.env.APP_BUILDER_RUNNER_NODE || '').trim();
    if (configured) return configured;
    if (process.versions.node.split('.')[0] === '24') return process.execPath;
    throw new AppBuilderDryRunError(
        'RUNNER_NOT_CONFIGURED',
        'APP_BUILDER_RUNNER_NODE must point to the Node 24 apps-runtime executable.',
        'configuration'
    );
}

function parseResult(stdout) {
    let result;
    try {
        result = JSON.parse(String(stdout || '').trim());
    } catch (_error) {
        throw new AppBuilderDryRunError(
            'RUNNER_PROTOCOL_ERROR',
            'App runner returned an invalid dry-run response.',
            'runner_protocol'
        );
    }
    if (!result || result.ok !== true) {
        throw new AppBuilderDryRunError(
            typeof result?.code === 'string' ? result.code : 'DRY_RUN_FAILED',
            typeof result?.message === 'string' ? result.message : 'Application dry run failed.',
            typeof result?.stage === 'string' ? result.stage : 'dry_run'
        );
    }
    return result.report;
}

async function validateAndDryRun({ source }) {
    const executable = runnerExecutable();
    const envelope = JSON.stringify({ source });
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ['--no-node-snapshot', CLI_PATH], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            env: {
                PATH: process.env.PATH || '',
                NODE_ENV: 'production',
            },
        });
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let settled = false;

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(new AppBuilderDryRunError(
                'DRY_RUN_TIMEOUT',
                'Application dry run exceeded the host timeout.'
            ));
        }, timeoutMs());

        child.stdout.on('data', chunk => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                child.kill('SIGKILL');
                finish(new AppBuilderDryRunError(
                    'RUNNER_PROTOCOL_ERROR',
                    'App runner exceeded the dry-run response limit.',
                    'runner_protocol'
                ));
                return;
            }
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', chunk => {
            if (stderr.length < 4096) stderr += chunk.toString('utf8');
        });
        child.on('error', error => {
            finish(new AppBuilderDryRunError(
                'RUNNER_UNAVAILABLE',
                'App runner could not be started.',
                'configuration'
            ), error);
        });
        child.on('close', () => {
            try {
                finish(null, parseResult(stdout));
            } catch (error) {
                if (stderr) error.runnerStderr = stderr.slice(0, 500);
                finish(error);
            }
        });
        child.stdin.on('error', error => {
            finish(new AppBuilderDryRunError(
                'RUNNER_PROTOCOL_ERROR',
                'App runner input failed.',
                'runner_protocol'
            ), error);
        });
        child.stdin.end(envelope);
    });
}

module.exports = {
    CLI_PATH,
    AppBuilderDryRunError,
    runnerExecutable,
    parseResult,
    validateAndDryRun,
};
