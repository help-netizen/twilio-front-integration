'use strict';

const mockQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }));
const mockRelease = jest.fn();
const mockClient = { query: mockQuery, release: mockRelease };

jest.mock('../backend/src/db/connection', () => ({
    pool: { connect: jest.fn(async () => mockClient) },
    query: jest.fn(),
}));
jest.mock('../backend/src/services/chatgptMcpReadService', () => ({
    execute: jest.fn(),
}));
jest.mock('../backend/src/services/chatgptMcpIdentityService', () => ({
    resolveLiveBinding: jest.fn(),
    requireLiveBinding: jest.fn(),
    recordInvocation: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/chatgptMcpWriteService', () => ({
    execute: jest.fn(),
    argumentHash: jest.fn(() => 'args-hash'),
}));
jest.mock('../backend/src/db/tasksQueries', () => ({
    jobParentVisible: jest.fn(async () => true),
}));
jest.mock('../backend/src/services/contactsService', () => ({
    getById: jest.fn(async () => ({ id: 7 })),
}));

const db = require('../backend/src/db/connection');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const writeService = require('../backend/src/services/chatgptMcpWriteService');
const permissions = require('../backend/src/services/chatgptMcpPermissions');
const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const executor = require('../backend/src/services/agentSkillsMcpExecutor');
const protocol = require('../backend/src/services/agentSkillsMcpProtocolService');
const leadsService = require('../backend/src/services/leadsService');
const tasksQueries = require('../backend/src/db/tasksQueries');
const contactsService = require('../backend/src/services/contactsService');

const GRANTS = [...permissions.S1_GRANTS, ...permissions.S2_WRITE_GRANTS];
const OWNER_PERMISSIONS = [...new Set([
    ...Object.values(permissions.READ_TOOL_PERMISSIONS).flat(),
    ...Object.values(permissions.WRITE_TOOL_PERMISSIONS).flat(),
])];
const LIVE_OWNER = {
    owner_user_id: 'human-a',
    owner_role_key: 'tenant_admin',
    owner_permissions: OWNER_PERMISSIONS,
    owner_scopes: { job_visibility: 'all' },
    writes_enabled: true,
    sends_enabled: false,
};

function requestContext(overrides = {}) {
    return {
        companyFilter: { company_id: 'company-a' },
        user: {
            kind: 'agent',
            oauthAuthorizerId: 'human-a',
            crmUser: { id: 'agent-a' },
        },
        authz: {
            permissions: GRANTS,
            oauthScopes: [permissions.READ_SCOPE, permissions.WRITE_SCOPE],
            company: { timezone: 'America/New_York' },
        },
        chatgptMcpBinding: {
            id: 'binding-a',
            authorizerId: 'human-a',
            ownerUserId: 'human-a',
        },
        requestId: 'request-a',
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    identityService.resolveLiveBinding.mockResolvedValue({ ...LIVE_OWNER });
    identityService.requireLiveBinding.mockResolvedValue({ ...LIVE_OWNER });
    writeService.execute.mockResolvedValue({ lead_uuid: 'LEAD-A' });
});

describe('CHATGPT-CRM-MCP S2a write executor', () => {
    test('rechecks the binding and dispatches with the same transaction client immediately before write', async () => {
        const result = await executor.execute(
            requestContext(),
            'svc.create_lead',
            {
                first_name: 'Ada',
                last_name: 'Lovelace',
                phone: '+16175550101',
                company_id: 'company-b',
            },
            { confirmed: true, confirmation_id: 'confirm-1' }
        );

        expect(result).toEqual({ lead_uuid: 'LEAD-A' });
        expect(db.pool.connect).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
        expect(identityService.requireLiveBinding).toHaveBeenCalledWith({
            bindingId: 'binding-a',
            companyId: 'company-a',
            agentUserId: 'agent-a',
            authorizerId: 'human-a',
            ownerUserId: 'human-a',
        }, mockClient);
        expect(identityService.requireLiveBinding.mock.invocationCallOrder[0])
            .toBeLessThan(writeService.execute.mock.invocationCallOrder[0]);
        expect(writeService.execute).toHaveBeenCalledWith(
            'createLead',
            'svc.create_lead',
            expect.objectContaining({
                companyId: 'company-a',
                actorId: 'agent-a',
                ownerUserId: 'human-a',
                ownerRoleKey: 'tenant_admin',
            }),
            {
                first_name: 'Ada',
                last_name: 'Lovelace',
                phone: '+16175550101',
            },
            mockClient
        );
        expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    test('recheck failure rolls back and the handler never runs', async () => {
        identityService.requireLiveBinding.mockRejectedValueOnce(
            Object.assign(new Error('revoked'), { code: 'MCP_BINDING_INVALID', httpStatus: 403 })
        );
        await expect(executor.execute(
            requestContext(),
            'svc.create_job',
            { customer_name: 'Grace Hopper', customer_phone: '+16175550102' },
            { confirmed: true, confirmation_id: 'confirm-2' }
        )).rejects.toMatchObject({ code: 'MCP_BINDING_INVALID', httpStatus: 403 });

        expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
        expect(writeService.execute).not.toHaveBeenCalled();
    });

    test('stale request grants cannot bypass disabled live consent', async () => {
        identityService.requireLiveBinding.mockResolvedValueOnce({
            ...LIVE_OWNER,
            writes_enabled: false,
        });
        await expect(executor.execute(
            requestContext(),
            'svc.update_lead',
            { lead_uuid: 'LEAD-A', comments: 'Call tomorrow' },
            { confirmed: true, confirmation_id: 'confirm-3' }
        )).rejects.toMatchObject({ mcpCode: 'access_denied' });

        expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
        expect(writeService.execute).not.toHaveBeenCalled();
    });

    test('scoped Job write checks visibility with the human owner ID inside the transaction', async () => {
        const providerLive = {
            ...LIVE_OWNER,
            owner_role_key: 'provider',
            owner_permissions: ['jobs.edit', 'jobs.close'],
            owner_scopes: { job_visibility: 'assigned_only' },
        };
        identityService.resolveLiveBinding.mockResolvedValueOnce(providerLive);
        identityService.requireLiveBinding.mockResolvedValueOnce(providerLive);
        writeService.execute.mockResolvedValueOnce({ job_id: 5 });

        await expect(executor.execute(
            requestContext(),
            'svc.transition_job',
            { job_id: 5, action: 'complete' },
            { confirmed: true, confirmation_id: 'scope-job' }
        )).resolves.toEqual({ job_id: 5 });

        expect(tasksQueries.jobParentVisible).toHaveBeenCalledWith(
            'company-a',
            5,
            { assignedOnly: true, userId: 'human-a' },
            mockClient,
            { lock: true }
        );
        expect(tasksQueries.jobParentVisible.mock.invocationCallOrder[0])
            .toBeLessThan(writeService.execute.mock.invocationCallOrder[0]);
    });

    test('foreign/out-of-scope Job write rolls back before the handler', async () => {
        const providerLive = {
            ...LIVE_OWNER,
            owner_permissions: ['jobs.edit'],
            owner_scopes: { job_visibility: 'assigned_only' },
        };
        identityService.resolveLiveBinding.mockResolvedValueOnce(providerLive);
        identityService.requireLiveBinding.mockResolvedValueOnce(providerLive);
        tasksQueries.jobParentVisible.mockResolvedValueOnce(false);

        await expect(executor.execute(
            requestContext(),
            'svc.update_job',
            { job_id: 5, description: 'Denied' },
            { confirmed: true, confirmation_id: 'scope-deny' }
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
        expect(writeService.execute).not.toHaveBeenCalled();
    });

    test('Contact-host note uses owner contact reachability, never the AI user ID', async () => {
        const providerLive = {
            ...LIVE_OWNER,
            owner_permissions: ['contacts.edit'],
            owner_scopes: { job_visibility: 'assigned_only' },
        };
        identityService.resolveLiveBinding.mockResolvedValueOnce(providerLive);
        identityService.requireLiveBinding.mockResolvedValueOnce(providerLive);
        await executor.execute(
            requestContext(),
            'svc.add_note',
            { parent_type: 'contact', parent_id: '7', text: 'Owner-scoped' },
            { confirmed: true, confirmation_id: 'scope-contact' }
        );
        expect(contactsService.getById).toHaveBeenCalledWith(
            '7',
            'company-a',
            { assignedOnly: true, userId: 'human-a' },
            mockClient
        );
    });

    test('an audit sink outage does not turn a committed write into a retryable failure', async () => {
        identityService.recordInvocation.mockRejectedValueOnce(new Error('audit unavailable'));
        await expect(executor.execute(
            requestContext(),
            'svc.create_lead',
            { first_name: 'Audit', last_name: 'Safe', phone: '+16175550103' },
            { confirmed: true, confirmation_id: 'confirm-audit' }
        )).resolves.toEqual({ lead_uuid: 'LEAD-A' });
        expect(writeService.execute).toHaveBeenCalledTimes(1);
    });

    test.each([
        [null, 'confirmation_required'],
        [{ confirmed: true }, 'confirmation_required'],
    ])('confirmation class W is mandatory before a transaction starts', async (confirmation, code) => {
        await expect(executor.execute(
            requestContext(),
            'svc.add_note',
            { parent_type: 'job', parent_id: '5', text: 'Customer approved.' },
            confirmation
        )).rejects.toMatchObject({ mcpCode: code });
        expect(db.pool.connect).not.toHaveBeenCalled();
    });

    test('albusto.mcp.write scope is mandatory before a transaction starts', async () => {
        const req = requestContext();
        req.authz.oauthScopes = [permissions.READ_SCOPE];
        await expect(executor.execute(
            req,
            'svc.transition_job',
            { job_id: 5, action: 'complete' },
            { confirmed: true, confirmation_id: 'confirm-4' }
        )).rejects.toMatchObject({ mcpCode: 'access_denied' });
        expect(db.pool.connect).not.toHaveBeenCalled();
    });

    test('protocol advertises non-destructive W confirmation for all 12 write tools', async () => {
        const response = await protocol.handleJsonRpc(requestContext(), {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
        });
        expect(response.result.tools).toHaveLength(31);
        const writes = response.result.tools.filter((tool) => tool.annotations.kind === 'write');
        expect(writes).toHaveLength(12);
        expect(writes.every((tool) => (
            tool.annotations.requiresConfirmation === true
            && tool.annotations.confirmationClass === 'W'
            && tool.annotations.destructiveHint === false
            && tool.annotations.readOnlyHint === false
        ))).toBe(true);
    });

    test('all write schemas reject status, target-state, company, and attachment fields', () => {
        for (const name of permissions.WRITE_TOOL_NAMES) {
            const properties = registry.getTool(name).inputSchema.properties;
            for (const forbidden of [
                'company_id',
                'companyId',
                'status',
                'target_state',
                'attachments',
                'files',
            ]) {
                expect(properties).not.toHaveProperty(forbidden);
            }
        }
    });

    test('legacy lead write seams now fail closed without an explicit companyId', async () => {
        await expect(leadsService.createLead({ FirstName: 'No tenant' }))
            .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', httpStatus: 403 });
        await expect(leadsService.updateLead('LEAD-X', { Comments: 'No tenant' }))
            .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', httpStatus: 403 });
        expect(db.query).not.toHaveBeenCalled();
    });
});
