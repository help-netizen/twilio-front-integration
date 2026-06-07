#!/usr/bin/env node
'use strict';

const readline = require('readline');

const protocol = require('../services/crmMcpProtocolService');
const publicAuth = require('../services/crmMcpPublicAuth');

async function main() {
    let context;
    try {
        context = publicAuth.requireStdioContext();
    } catch (err) {
        process.stderr.write(`[crm-mcp-stdio] ${err.message}\n`);
        process.exit(1);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: false,
    });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const message = JSON.parse(line);
            const response = await protocol.handleJsonRpc(context, message);
            if (response !== null) {
                process.stdout.write(`${JSON.stringify(response)}\n`);
            }
        } catch (err) {
            process.stdout.write(`${JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: 'Parse error',
                    data: { code: 'parse_error' },
                },
            })}\n`);
        }
    }
}

main().catch(err => {
    process.stderr.write(`[crm-mcp-stdio] ${err.message}\n`);
    process.exit(1);
});
