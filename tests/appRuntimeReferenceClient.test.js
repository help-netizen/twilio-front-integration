'use strict';

const fs = require('fs');
const path = require('path');
const client = require('../scripts/app-runtime-reference-client');

function response(data, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => ok ? { ok: true, data } : { ok: false, code: data },
    };
}

describe('APP-GW-001 reference client', () => {
    test('calls list Jobs, selected Job detail, and list Tasks without tenant selectors', async () => {
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response({ results: [{ id: 11 }], total: 1 }))
            .mockResolvedValueOnce(response({ tasks: [{ id: 21 }] }))
            .mockResolvedValueOnce(response({ id: 11 }));
        const result = await client.run({
            APP_RUNTIME_GATEWAY_BASE_URL: 'https://api.albusto.test',
            APP_RUNTIME_RUN_TOKEN: 'run-token',
        }, fetchImpl);

        expect(result).toEqual({
            jobs: { results: [{ id: 11 }], total: 1 },
            job: { id: 11 },
            tasks: { tasks: [{ id: 21 }] },
        });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(fetchImpl.mock.calls.map(([url]) => url.pathname)).toEqual([
            '/internal/app-runtime/v1/tools/svc.list_jobs',
            '/internal/app-runtime/v1/tools/svc.list_tasks',
            '/internal/app-runtime/v1/tools/svc.get_job',
        ]);
        for (const [, options] of fetchImpl.mock.calls) {
            expect(options.headers.Authorization).toBe('Bearer run-token');
            expect(options.body).not.toMatch(/company|tenant|workspace|organi[sz]ation/i);
        }
    });

    test('permits only the exact three fixed gateway tools and rejects unsafe base URLs', async () => {
        await expect(client.callTool({
            baseUrl: 'https://api.albusto.test', token: 'x', toolName: 'svc.list_calls',
            fetchImpl: jest.fn(),
        })).rejects.toThrow('Unsupported reference-client tool');
        expect(() => client.gatewayOrigin('file:///etc/passwd')).toThrow('valid HTTP(S) URL');
        expect(() => client.gatewayOrigin('https://user:pass@evil.test')).toThrow('valid HTTP(S) URL');
    });

    test('contains no runner, eval, child process, or dynamic network path', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../scripts/app-runtime-reference-client.js'),
            'utf8'
        );
        expect(source).not.toMatch(/\beval\b|new Function|child_process|spawn|exec\s*\(/);
        expect(source).not.toMatch(/company_id|tenant_id|workspace_id|organization_id/);
        expect([...source.matchAll(/svc\.[a-z_]+/g)].map((match) => match[0]))
            .toEqual(expect.arrayContaining(['svc.list_jobs', 'svc.get_job', 'svc.list_tasks']));
    });
});
