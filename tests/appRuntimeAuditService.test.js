'use strict';

const mockQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const auditService = require('../backend/src/services/appRuntimeAuditService');

const CONTEXT = {
    agent_user_id: '10000000-0000-4000-8000-000000000001',
    company_id: '20000000-0000-4000-8000-000000000001',
    app_id: '91',
    installation_id: '101',
    run_id: '30000000-0000-4000-8000-000000000001',
    version_id: '40000000-0000-4000-8000-000000000001',
};

function record(toolName) {
    return auditService.recordToolCall(CONTEXT, {
        toolName,
        outcome: 'denied',
        errorCode: 'TOOL_NOT_FOUND',
        httpStatus: 404,
        callOrdinal: 1,
        requestId: 'req-audit-safe-target',
    });
}

describe('APP-GAP-FIX-001 safe runtime audit identity', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.mockResolvedValue({ rows: [{ id: 1 }] });
    });

    test('F7 hashes an unknown tool name and marks it without persisting raw secret/PII', async () => {
        const malicious = 'Bearer-secret.customer@example.com.+16175550101';
        await record(malicious);
        const params = mockQuery.mock.calls[0][1];
        const targetId = params[1];
        const details = JSON.parse(params[3]);
        expect(targetId).toMatch(/^unknown:[0-9a-f]{24}$/);
        expect(details.unknown_tool).toBe(true);
        expect(JSON.stringify(params)).not.toContain(malicious);
        expect(JSON.stringify(params)).not.toContain('customer@example.com');
        expect(JSON.stringify(params)).not.toContain('+16175550101');
    });

    test('known catalog tool keeps its stable safe identifier', async () => {
        await record('svc.list_jobs');
        const params = mockQuery.mock.calls[0][1];
        expect(params[1]).toBe('svc.list_jobs');
        expect(JSON.parse(params[3]).unknown_tool).toBe(false);
    });

    test('execution admission audit uses only DB-bound identifiers and the pinned hash', async () => {
        const context = { ...CONTEXT, artifact_sha256: 'a'.repeat(64) };
        await auditService.recordRunAuthorization(context, {
            outcome: 'succeeded', errorCode: null, httpStatus: 200, requestId: 'req-authz',
        });
        const params = mockQuery.mock.calls[0][1];
        expect(params[1]).toBe(CONTEXT.run_id);
        expect(JSON.parse(params[3])).toEqual({
            version_id: CONTEXT.version_id,
            source_sha256: 'a'.repeat(64),
            outcome: 'succeeded',
            error_code: null,
            response_class: '2xx',
        });
    });
});
