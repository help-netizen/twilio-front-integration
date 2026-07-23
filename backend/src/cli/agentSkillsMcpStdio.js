#!/usr/bin/env node
'use strict';

/**
 * cli/agentSkillsMcpStdio — optional stdio JSON-RPC transport for the
 * service-CRM (`svc.*`) MCP surface. AGENT-SKILLS-001, AR-3 / spec §8.
 * MIRRORS `cli/crmMcpStdio.js`, using `SVC_MCP_STDIO_*` env (env-bound company,
 * writes off unless enabled) and the `svc.*` protocol service.
 *
 * The sales stdio CLI (`crmMcpStdio.js`) is UNTOUCHED — additive only.
 */

const readline = require('readline');

const protocol = require('../services/agentSkillsMcpProtocolService');
const publicAuth = require('../services/agentSkillsMcpPublicAuth');

async function main() {
    let context;
    try {
        context = await publicAuth.requireStdioContext();
    } catch (err) {
        process.stderr.write(`[svc-mcp-stdio] ${err.message}\n`);
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

main().catch((err) => {
    process.stderr.write(`[svc-mcp-stdio] ${err.message}\n`);
    process.exit(1);
});
