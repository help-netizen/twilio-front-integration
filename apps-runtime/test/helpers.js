'use strict';

const fs = require('fs');
const path = require('path');

const TEST_TOKEN = 'run-token-secret-value-that-must-stay-on-host';
const GATEWAY_BASE_URL = 'https://crm.albusto.test';

function app(body, parameters = 'ctx') {
    return `export async function run(${parameters}) {\n${body}\n}`;
}

function response(data, { ok = true, status = 200, code, message } = {}) {
    return {
        ok,
        status,
        json: async () => ok
            ? { ok: true, data, request_id: 'app-gw-test' }
            : {
                ok: false,
                code: code || 'APP_RUNTIME_GATEWAY_ERROR',
                message: message || 'Gateway call failed.',
                request_id: 'app-gw-test',
            },
    };
}

function referenceSource() {
    return fs.readFileSync(
        path.join(__dirname, '../reference-apps/morning-digest/app.js'),
        'utf8'
    );
}

module.exports = {
    TEST_TOKEN,
    GATEWAY_BASE_URL,
    app,
    response,
    referenceSource,
};
