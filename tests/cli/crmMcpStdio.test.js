const path = require('path');
const { spawn } = require('child_process');

describe('crmMcpStdio CLI', () => {
    test('responds to tools/list over newline-delimited stdio JSON-RPC', async () => {
        const script = path.resolve(__dirname, '../../backend/src/cli/crmMcpStdio.js');
        const child = spawn(process.execPath, [script], {
            env: {
                ...process.env,
                SALES_MCP_STDIO_COMPANY_ID: 'company-1',
                SALES_MCP_STDIO_USER_ID: 'user-1',
                SALES_MCP_STDIO_USER_EMAIL: 'stdio@test.local',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });

        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
        child.stdin.end();

        const exitCode = await new Promise(resolve => child.on('close', resolve));
        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        const response = JSON.parse(stdout.trim());
        expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 });
        expect(response.result.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'crm.search_accounts' }),
        ]));
    });
});
