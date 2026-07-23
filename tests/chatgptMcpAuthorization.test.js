'use strict';

jest.mock('../backend/src/services/chatgptMcpReadService', () => ({ execute: jest.fn(async () => ({ ok: true })) }));
jest.mock('../backend/src/services/chatgptMcpIdentityService', () => ({ recordInvocation: jest.fn(async () => {}) }));

const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const executor = require('../backend/src/services/agentSkillsMcpExecutor');
const readService = require('../backend/src/services/chatgptMcpReadService');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const authorization = require('../backend/src/services/mcpToolAuthorization');
const permissions = require('../backend/src/services/chatgptMcpPermissions');

function requestContext(granted = permissions.S1_GRANTS) {
    return {
        companyFilter: { company_id: 'company-a' },
        user: {
            kind: 'agent',
            oauthAuthorizerId: 'human-a',
            crmUser: { id: 'agent-a' },
        },
        authz: {
            permissions: [...granted],
            oauthScopes: [permissions.READ_SCOPE],
            company: { timezone: 'America/New_York' },
        },
        chatgptMcpBinding: { id: 'binding-a', authorizerId: 'human-a' },
        requestId: 'request-a',
    };
}

beforeEach(() => jest.clearAllMocks());

describe('CHATGPT-CRM-MCP deny-by-default authorization', () => {
    test('all 18 S1 reads require business permission plus their exact AI-only key', () => {
        expect(permissions.READ_TOOL_NAMES).toHaveLength(18);
        for (const name of permissions.READ_TOOL_NAMES) {
            const tool = registry.getTool(name);
            expect(tool).toBeDefined();
            expect(tool.kind).toBe('read');
            expect(tool.inputSchema.additionalProperties).toBe(false);
            expect(tool.requiredPermissions).toEqual(expect.arrayContaining([
                `mcp.tool.${name}`,
                ...permissions.READ_TOOL_PERMISSIONS[name],
            ]));
            expect(tool.requiredOAuthScopes).toEqual([permissions.READ_SCOPE]);
        }
    });

    test('S1 business grants are view-only and task assignee discovery works without mutation grants', async () => {
        expect(permissions.READ_TOOL_PERMISSIONS['svc.list_task_assignees']).toEqual(['tasks.view']);
        expect(permissions.BUSINESS_READ_PERMISSIONS.every((permission) => permission.endsWith('.view')))
            .toBe(true);
        expect(permissions.S1_GRANTS).not.toEqual(expect.arrayContaining(['tasks.create', 'tasks.manage']));

        const granted = ['tasks.view', 'mcp.tool.svc.list_task_assignees'];
        await expect(executor.execute(requestContext(granted), 'svc.list_task_assignees', { limit: 25 }))
            .resolves.toEqual({ ok: true });
        expect(readService.execute).toHaveBeenCalledWith(
            'listTaskAssignees',
            'company-a',
            { limit: 25 }
        );
    });

    test('missing exact grant hides discovery and denies direct invocation before dispatch', async () => {
        const name = 'svc.get_job';
        const granted = permissions.S1_GRANTS.filter((permission) => permission !== `mcp.tool.${name}`);
        const visible = authorization.filterTools(
            registry.listTools({ includeDispatcher: true }),
            granted,
            [permissions.READ_SCOPE]
        ).map((tool) => tool.name);
        expect(visible).not.toContain(name);
        await expect(executor.execute(requestContext(granted), name, { job_id: 1 }))
            .rejects.toMatchObject({ mcpCode: 'access_denied' });
        expect(readService.execute).not.toHaveBeenCalled();
    });

    test('R-matrix: missing business permission hides and denies an otherwise exact-granted tool', async () => {
        const name = 'svc.get_job';
        const granted = permissions.S1_GRANTS.filter((permission) => permission !== 'jobs.view');
        const visible = authorization.filterTools(
            registry.listTools({ includeDispatcher: true }),
            granted,
            [permissions.READ_SCOPE]
        ).map((tool) => tool.name);
        expect(visible).not.toContain(name);
        await expect(executor.execute(requestContext(granted), name, { job_id: 1 }))
            .rejects.toMatchObject({ mcpCode: 'access_denied' });
        expect(readService.execute).not.toHaveBeenCalled();
    });

    test.each(permissions.READ_TOOL_NAMES)(
        'R-matrix %s: missing OAuth read scope denies before dispatch',
        async (name) => {
            const req = requestContext();
            req.authz.oauthScopes = [];
            const visible = authorization.filterTools(
                registry.listTools({ includeDispatcher: true, dispatcherOnly: true }),
                req.authz.permissions,
                req.authz.oauthScopes
            ).map((tool) => tool.name);
            expect(visible).not.toContain(name);
            await expect(executor.execute(req, name, validArgs(name)))
                .rejects.toMatchObject({ mcpCode: 'access_denied' });
            expect(identityService.recordInvocation).toHaveBeenCalledWith(
                expect.any(Object),
                expect.objectContaining({ toolName: name, status: 'denied' })
            );
        }
    );

    test.each(['tenant_admin', 'manager', 'dispatcher', 'provider', 'custom'])(
        'R-matrix: direct human role %s cannot invoke dispatcher tools even with grants',
        async (roleKey) => {
            const req = requestContext();
            req.user.kind = 'user';
            req.authz.membership = { role_key: roleKey };
            delete req.chatgptMcpBinding;
            await expect(executor.execute(req, 'svc.get_job', { job_id: 1 }))
                .rejects.toMatchObject({ mcpCode: 'access_denied' });
            expect(readService.execute).not.toHaveBeenCalled();
        }
    );

    test('SAB-MCP-UNMAPPED: an unmapped descriptor is denied', () => {
        const unmapped = { name: 'svc.unmapped', requiredPermissions: [] };
        expect(authorization.canInvoke(unmapped, permissions.S1_GRANTS)).toBe(false);
        try {
            authorization.requireToolAccess(unmapped, permissions.S1_GRANTS);
            throw new Error('expected authorization failure');
        } catch (err) {
            expect(err.mcpCode).toBe('access_denied');
        }
    });

    test('strict S1 schemas reject unknown keys while tenant selectors are stripped', async () => {
        await expect(executor.execute(requestContext(), 'svc.get_job', { job_id: 1, unexpected: true }))
            .rejects.toMatchObject({ mcpCode: 'invalid_request' });
        expect(readService.execute).not.toHaveBeenCalled();

        await expect(executor.execute(requestContext(), 'svc.get_job', {
            job_id: 1, companyId: 'company-b', company_id: 'company-b',
        })).resolves.toEqual({ ok: true });
        expect(readService.execute).toHaveBeenCalledWith('getJob', 'company-a', { job_id: 1 });
    });

    test('SAB-MCP-DEFERRED-PAYMENTS: v1 has no payment scope, grant, or tool', () => {
        expect(permissions.S1_GRANTS.some((value) => /payment/i.test(value))).toBe(false);
        expect(registry.listTools({ includeDispatcher: true }).some((tool) => /payment|collect/i.test(tool.name))).toBe(false);
        for (const name of [
            'svc.collect_invoice_saved_method',
            'svc.create_invoice_payment_link',
            'svc.send_invoice_payment_link',
        ]) {
            expect(registry.getTool(name)).toBeNull();
        }
    });
});

function validArgs(name) {
    const args = {
        'svc.get_job': { job_id: 1 },
        'svc.get_job_transitions': { job_id: 1 },
        'svc.get_lead': { lead_uuid: 'LEAD-A' },
        'svc.get_lead_transitions': { lead_uuid: 'LEAD-A' },
        'svc.get_contact': { contact_id: 1 },
        'svc.get_contact_history': { contact_id: 1 },
        'svc.get_schedule_item': { entity_type: 'job', entity_id: 1 },
        'svc.list_entity_tasks': { parent_type: 'job', parent_id: '1' },
        'svc.get_estimate': { estimate_id: 1 },
        'svc.get_invoice': { invoice_id: 1 },
    };
    return args[name] || {};
}
