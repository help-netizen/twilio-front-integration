'use strict';

const { validateAndDryRun } = require('./builderDryRun');
const { sourceSha256 } = require('./runner');

// A 64 KiB source can approach 128 KiB after JSON escaping.
const MAX_ENVELOPE_BYTES = 256 * 1024;

async function readInput() {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > MAX_ENVELOPE_BYTES) throw new Error('Builder dry-run input is too large.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

(async () => {
    try {
        const input = await readInput();
        const { result: report } = await validateAndDryRun({
            source: input?.source,
            expectedSourceSha256: input?.expectedSourceSha256
                || sourceSha256(input?.source || ''),
            input: input?.input,
            fixtures: input?.fixtures,
        });
        process.stdout.write(`${JSON.stringify({ ok: true, report })}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({
            ok: false,
            stage: error?.stage || 'dry_run',
            code: error?.code || 'APP_RUNTIME_EXECUTION_FAILED',
            message: String(error?.message || 'Application dry run failed.').slice(0, 500),
        })}\n`);
        process.exitCode = 1;
    }
})();
