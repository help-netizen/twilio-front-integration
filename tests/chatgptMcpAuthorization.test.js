'use strict';

jest.mock('../backend/src/services/chatgptMcpReadService', () => ({ execute: jest.fn(async () => ({ ok: true })) }));
jest.mock('../backend/src/services/chatgptMcpIdentityService', () => ({
    resolveLiveBinding: jest.fn(),
    recordInvocation: jest.fn(async () => {}),
}));

const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const executor = require('../backend/src/services/agentSkillsMcpExecutor');
const readService = require('../backend/src/services/chatgptMcpReadService');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const authorization = require('../backend/src/services/mcpToolAuthorization');
const permissions = require('../backend/src/services/chatgptMcpPermissions');
const protocol = require('../backend/src/services/agentSkillsMcpProtocolService');
const ALL_BUSINESS_PERMISSIONS = [...new Set([
    ...Object.values(permissions.READ_TOOL_PERMISSIONS).flat(),
    ...Object.values(permissions.WRITE_TOOL_PERMISSIONS).flat(),
    ...Object.values(permissions.SEND_TOOL_PERMISSIONS).flat(),
])];
const LIVE_OWNER = Object.freeze({
    owner_user_id: 'human-a',
    owner_role_key: 'tenant_admin',
    owner_permissions: ALL_BUSINESS_PERMISSIONS,
    owner_scopes: { job_visibility: 'all' },
    writes_enabled: true,
    sends_enabled: true,
});

const EXPECTED_DISPATCHER_TITLES = Object.freeze({
    'svc.list_jobs': 'List jobs',
    'svc.get_job': 'Open a job',
    'svc.get_job_transitions': 'See a job\'s available status changes',
    'svc.list_leads': 'List leads',
    'svc.get_lead': 'Open a lead',
    'svc.get_lead_transitions': 'See a lead\'s available status changes',
    'svc.search_contacts': 'Search contacts',
    'svc.get_contact': 'Look up a contact',
    'svc.get_contact_history': 'See a contact\'s history',
    'svc.list_schedule': 'View the schedule',
    'svc.get_schedule_item': 'Open a schedule item',
    'svc.list_tasks': 'List tasks',
    'svc.list_entity_tasks': 'List tasks on a job or lead',
    'svc.list_task_assignees': 'List who can be assigned tasks',
    'svc.list_estimates': 'List estimates',
    'svc.get_estimate': 'Open an estimate',
    'svc.list_invoices': 'List invoices',
    'svc.get_invoice': 'Open an invoice',
    'svc.list_calls': 'View recent calls',
    'svc.create_lead': 'Create a lead',
    'svc.update_lead': 'Edit a lead',
    'svc.transition_lead': 'Change a lead\'s status',
    'svc.create_job': 'Create a job',
    'svc.update_job': 'Edit a job',
    'svc.transition_job': 'Change a job\'s status',
    'svc.add_note': 'Add a note',
    'svc.create_estimate': 'Create an estimate',
    'svc.update_estimate': 'Edit an estimate',
    'svc.create_invoice': 'Create an invoice',
    'svc.update_invoice': 'Edit an invoice',
    'svc.convert_estimate_to_invoice': 'Turn an estimate into an invoice',
    'svc.send_estimate': 'Email or text an estimate to the customer',
    'svc.send_invoice': 'Email or text an invoice to the customer',
});

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
        chatgptMcpBinding: {
            id: 'binding-a',
            authorizerId: 'human-a',
            ownerUserId: 'human-a',
        },
        requestId: 'request-a',
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    identityService.resolveLiveBinding.mockResolvedValue({ ...LIVE_OWNER });
});

describe('CHATGPT-CRM-MCP deny-by-default authorization', () => {
    test('all 33 dispatcher tools expose the exact human-readable protocol title, with no extras', () => {
        const tools = registry.listTools({
            includeDispatcher: true,
            dispatcherOnly: true,
        });
        const expectedNames = Object.keys(EXPECTED_DISPATCHER_TITLES).sort();

        expect(expectedNames).toHaveLength(33);
        expect(tools).toHaveLength(33);
        expect(tools.map((tool) => tool.name).sort()).toEqual(expectedNames);

        for (const tool of tools) {
            const expectedTitle = EXPECTED_DISPATCHER_TITLES[tool.name];
            expect(tool.title).toBe(expectedTitle);
            expect(expectedTitle).not.toMatch(/^svc\./i);
            expect(protocol.toProtocolTool(tool)).toHaveProperty('title', expectedTitle);
        }
    });

    test('all 19 S1 reads require business permission plus their exact AI-only key', () => {
        expect(permissions.READ_TOOL_NAMES).toHaveLength(19);
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

    test('all 12 consent-gated S2 writes remain a 31-tool visible tier inside the 33-tool registry', () => {
        expect(permissions.WRITE_BUNDLE_VERSION).toBe(3);
        expect(permissions.WRITE_TOOL_NAMES).toHaveLength(12);
        expect(permissions.S1_GRANTS).not.toEqual(
            expect.arrayContaining(permissions.S2_WRITE_GRANTS)
        );
        for (const name of permissions.WRITE_TOOL_NAMES) {
            const tool = registry.getTool(name);
            expect(tool).toBeDefined();
            expect(tool.kind).toBe('write');
            expect(tool.requiresConfirmation).toBe(true);
            expect(tool.confirmationClass).toBe('W');
            expect(tool.destructiveHint).toBe(false);
            expect(tool.inputSchema.additionalProperties).toBe(false);
            expect(tool.requiredPermissions).toEqual(expect.arrayContaining([
                `mcp.tool.${name}`,
                ...permissions.WRITE_TOOL_PERMISSIONS[name],
            ]));
            expect(tool.requiredOAuthScopes).toEqual([permissions.WRITE_SCOPE]);
            expect(tool.frameworkWritePermission).toBeNull();
        }
        expect(registry.listTools({ includeDispatcher: true, dispatcherOnly: true }))
            .toHaveLength(33);
    });

    test('both S3 sends require their independent business grant, exact grant, and send scope', () => {
        expect(permissions.SEND_BUNDLE_VERSION).toBe(4);
        expect(permissions.SEND_TOOL_NAMES).toHaveLength(2);
        expect(permissions.S2_WRITE_GRANTS).not.toEqual(
            expect.arrayContaining(permissions.S3_SEND_GRANTS)
        );
        for (const name of permissions.SEND_TOOL_NAMES) {
            const tool = registry.getTool(name);
            expect(tool.requiredPermissions).toEqual(expect.arrayContaining([
                `mcp.tool.${name}`,
                ...permissions.SEND_TOOL_PERMISSIONS[name],
            ]));
            expect(tool.requiredOAuthScopes).toEqual([permissions.SEND_SCOPE]);
            expect(tool.requiresConfirmation).toBe(true);
            expect(tool.confirmationClass).toBe('W');
        }
    });

    test('avatar discovery uses live owner rights, tier booleans, and OAuth scope', () => {
        const dispatcherTools = registry.listTools({
            includeDispatcher: true,
            dispatcherOnly: true,
        });
        expect(authorization.filterAvatarTools(
            dispatcherTools,
            { ...LIVE_OWNER, writes_enabled: false, sends_enabled: false },
            [permissions.READ_SCOPE, permissions.WRITE_SCOPE]
        )).toHaveLength(19);
        expect(authorization.filterAvatarTools(
            dispatcherTools,
            { ...LIVE_OWNER, writes_enabled: true, sends_enabled: false },
            [permissions.READ_SCOPE]
        )).toHaveLength(19);
        expect(authorization.filterAvatarTools(
            dispatcherTools,
            { ...LIVE_OWNER, writes_enabled: true, sends_enabled: false },
            [permissions.READ_SCOPE, permissions.WRITE_SCOPE]
        )).toHaveLength(31);
    });

    test('S1 business grants are view-only and task assignee discovery works without mutation grants', async () => {
        expect(permissions.READ_TOOL_PERMISSIONS['svc.list_task_assignees']).toEqual(['tasks.view']);
        expect(permissions.BUSINESS_READ_PERMISSIONS.every((permission) => permission.endsWith('.view')))
            .toBe(true);
        expect(permissions.S1_GRANTS).not.toEqual(expect.arrayContaining(['tasks.create', 'tasks.manage']));

        const granted = ['tasks.view', 'mcp.tool.svc.list_task_assignees'];
        identityService.resolveLiveBinding.mockResolvedValueOnce({
            ...LIVE_OWNER,
            owner_permissions: ['tasks.view'],
        });
        await expect(executor.execute(requestContext(granted), 'svc.list_task_assignees', { limit: 25 }))
            .resolves.toEqual({ ok: true });
        expect(readService.execute).toHaveBeenCalledWith(
            'listTaskAssignees',
            expect.objectContaining({
                companyId: 'company-a',
                ownerUserId: 'human-a',
                ownerPermissions: ['tasks.view'],
            }),
            { limit: 25 }
        );
    });

    test('svc.list_calls is a strict pulse.view read with no tenant selector in its schema', () => {
        const tool = registry.getTool('svc.list_calls');
        expect(permissions.BUNDLE_VERSION).toBe(2);
        expect(permissions.READ_TOOL_PERMISSIONS['svc.list_calls']).toEqual(['pulse.view']);
        expect(tool).toMatchObject({
            kind: 'read',
            requiredPermissions: expect.arrayContaining([
                'pulse.view',
                'mcp.tool.svc.list_calls',
            ]),
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: [],
            },
        });
        expect(tool.inputSchema.properties).toEqual({
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            direction: { type: 'string', enum: ['inbound', 'outbound'] },
            contact_id: { type: 'integer', minimum: 1 },
            date_from: { type: 'string', format: 'date' },
            date_to: { type: 'string', format: 'date' },
        });
        expect(tool.inputSchema.properties).not.toHaveProperty('company_id');
        expect(tool.inputSchema.properties).not.toHaveProperty('companyId');
    });

    test('static AI grants are not an authority for avatar discovery or invocation', async () => {
        const name = 'svc.get_job';
        const visible = authorization.filterAvatarTools(
            registry.listTools({ includeDispatcher: true }),
            LIVE_OWNER,
            [permissions.READ_SCOPE]
        ).map((tool) => tool.name);
        expect(visible).toContain(name);
        await expect(executor.execute(requestContext([]), name, { job_id: 1 }))
            .resolves.toEqual({ ok: true });
        expect(readService.execute).toHaveBeenCalled();
    });

    test('R-matrix: missing live owner business permission hides and denies the tool', async () => {
        const name = 'svc.get_job';
        const deniedOwner = {
            ...LIVE_OWNER,
            owner_permissions: LIVE_OWNER.owner_permissions.filter((key) => key !== 'jobs.view'),
        };
        identityService.resolveLiveBinding.mockResolvedValue(deniedOwner);
        const visible = authorization.filterAvatarTools(
            registry.listTools({ includeDispatcher: true }),
            deniedOwner,
            [permissions.READ_SCOPE]
        ).map((tool) => tool.name);
        expect(visible).not.toContain(name);
        await expect(executor.execute(requestContext(), name, { job_id: 1 }))
            .rejects.toMatchObject({ mcpCode: 'access_denied' });
        expect(readService.execute).not.toHaveBeenCalled();
    });

    test.each(permissions.READ_TOOL_NAMES)(
        'R-matrix %s: missing OAuth read scope denies before dispatch',
        async (name) => {
            const req = requestContext();
            req.authz.oauthScopes = [];
            const visible = authorization.filterAvatarTools(
                registry.listTools({ includeDispatcher: true, dispatcherOnly: true }),
                LIVE_OWNER,
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
        expect(readService.execute).toHaveBeenCalledWith(
            'getJob',
            expect.objectContaining({ companyId: 'company-a', ownerUserId: 'human-a' }),
            { job_id: 1 }
        );
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
