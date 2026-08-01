'use strict';

const fs = require('fs/promises');
const path = require('path');
const { runApplication } = require('./runner');

async function main(argv = process.argv.slice(2), env = process.env) {
    const [sourcePath, inputJson = '{}'] = argv;
    if (!sourcePath) throw new Error('Usage: npm start -- <application.js> [input-json]');
    const source = await fs.readFile(path.resolve(sourcePath), 'utf8');
    let input;
    try {
        input = JSON.parse(inputJson);
    } catch (_error) {
        throw new Error('input-json must be valid JSON');
    }
    const result = await runApplication({
        source,
        input,
        gatewayBaseUrl: env.APP_RUNTIME_GATEWAY_BASE_URL,
        runToken: env.APP_RUNTIME_RUN_TOKEN,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.code || 'APP_RUNTIME_CLI_ERROR'}: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main };
