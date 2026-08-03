'use strict';

const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const authorization = require('../backend/src/services/mcpToolAuthorization');
const permissions = require('../backend/src/services/chatgptMcpPermissions');

const ALL_BUSINESS = [...new Set([
    ...Object.values(permissions.READ_TOOL_PERMISSIONS).flat(),
    ...Object.values(permissions.WRITE_TOOL_PERMISSIONS).flat(),
    ...Object.values(permissions.SEND_TOOL_PERMISSIONS).flat(),
])];

const ROLE_PERMISSIONS = Object.freeze({
    tenant_admin: ALL_BUSINESS,
    manager: ALL_BUSINESS,
    dispatcher: [
        'pulse.view',
        'contacts.view',
        'contacts.edit',
        'leads.view',
        'leads.create',
        'leads.edit',
        'jobs.view',
        'jobs.create',
        'jobs.edit',
        'schedule.view',
        'tasks.view',
        'tasks.manage',
    ],
    provider: [
        'pulse.view',
        'jobs.view',
        'schedule.view',
        'tasks.view',
        'estimates.view',
        'estimates.create',
        'estimates.send',
        'invoices.view',
        'invoices.create',
        'invoices.send',
    ],
});

const ALL_SCOPES = [
    permissions.READ_SCOPE,
    permissions.WRITE_SCOPE,
    permissions.SEND_SCOPE,
];

function authority(role, overrides = {}) {
    return {
        owner_user_id: `owner-${role}`,
        owner_role_key: role,
        owner_permissions: ROLE_PERMISSIONS[role],
        owner_scopes: {
            job_visibility: role === 'provider' ? 'assigned_only' : 'all',
        },
        writes_enabled: true,
        sends_enabled: true,
        ...overrides,
    };
}

function selectedArgs(name) {
    if (name === 'svc.list_entity_tasks') {
        return { parent_type: 'job', parent_id: '1' };
    }
    if (name === 'svc.add_note') {
        return { parent_type: 'job', parent_id: '1', text: 'Note' };
    }
    return {};
}

describe('AVATARS-001 Phase B live owner authorization parity', () => {
    const tools = registry.listTools({
        includeDispatcher: true,
        dispatcherOnly: true,
    });

    test('parity inventory is exactly 34 tools × 4 canonical roles', () => {
        expect(tools).toHaveLength(34);
        expect(Object.keys(ROLE_PERMISSIONS)).toEqual([
            'tenant_admin',
            'manager',
            'dispatcher',
            'provider',
        ]);
    });

    test.each(Object.keys(ROLE_PERMISSIONS))(
        '%s tools/list and direct-call gate agree for every parity row',
        (role) => {
            const owner = authority(role);
            const visible = new Set(
                authorization.filterAvatarTools(tools, owner, ALL_SCOPES)
                    .map((tool) => tool.name)
            );
            for (const tool of tools) {
                const args = selectedArgs(tool.name);
                const canCall = authorization.canInvokeAvatar(
                    tool,
                    owner,
                    ALL_SCOPES,
                    args
                );
                expect(canCall).toBe(visible.has(tool.name));
                if (canCall) {
                    expect(() => authorization.requireAvatarToolAccess(
                        tool,
                        owner,
                        ALL_SCOPES,
                        args
                    )).not.toThrow();
                } else {
                    expect(() => authorization.requireAvatarToolAccess(
                        tool,
                        owner,
                        ALL_SCOPES,
                        args
                    )).toThrow(expect.objectContaining({ mcpCode: 'access_denied' }));
                }
            }
        }
    );

    test('polymorphic discovery is OR by host, while invocation checks the selected host', () => {
        const taskTool = registry.getTool('svc.list_entity_tasks');
        const noteTool = registry.getTool('svc.add_note');
        const owner = authority('provider');

        expect(authorization.canInvokeAvatar(taskTool, owner, ALL_SCOPES)).toBe(true);
        expect(authorization.canInvokeAvatar(
            taskTool,
            owner,
            ALL_SCOPES,
            { parent_type: 'job', parent_id: '1' }
        )).toBe(true);
        expect(authorization.canInvokeAvatar(
            taskTool,
            owner,
            ALL_SCOPES,
            { parent_type: 'lead', parent_id: 'L-1' }
        )).toBe(false);

        expect(authorization.canInvokeAvatar(noteTool, owner, ALL_SCOPES)).toBe(false);
        const contactsOnly = authority('provider', {
            owner_permissions: ['contacts.edit'],
        });
        expect(authorization.canInvokeAvatar(noteTool, contactsOnly, ALL_SCOPES)).toBe(true);
        expect(authorization.canInvokeAvatar(
            noteTool,
            contactsOnly,
            ALL_SCOPES,
            { parent_type: 'contact', parent_id: '1', text: 'ok' }
        )).toBe(true);
        expect(authorization.canInvokeAvatar(
            noteTool,
            contactsOnly,
            ALL_SCOPES,
            { parent_type: 'job', parent_id: '1', text: 'no' }
        )).toBe(false);
    });

    test('SAB-AVATAR-LIVE-RBAC: persisted AI grants cannot widen missing owner rights', () => {
        const tool = registry.getTool('svc.get_job');
        const owner = authority('provider', { owner_permissions: [] });
        expect(authorization.canInvokeAvatar(tool, owner, [permissions.READ_SCOPE]))
            .toBe(false);
        expect(authorization.canInvoke(tool, permissions.S1_GRANTS)).toBe(true);
    });

    test('SAB-AVATAR-SELF-CONSENT: disabled tiers hide and deny writes/sends independently', () => {
        const owner = authority('tenant_admin', {
            writes_enabled: false,
            sends_enabled: false,
        });
        const visible = authorization.filterAvatarTools(tools, owner, ALL_SCOPES)
            .map((tool) => tool.name);
        expect(visible).toHaveLength(20);
        expect(visible).not.toContain('svc.create_job');
        expect(visible).not.toContain('svc.send_invoice');
        expect(() => authorization.requireAvatarToolAccess(
            registry.getTool('svc.create_job'),
            owner,
            ALL_SCOPES
        )).toThrow(expect.objectContaining({ mcpCode: 'access_denied' }));
    });

    test('SAB-AVATAR-NO-RECONNECT-ALLOW: live write consent and RBAC do not require a new OAuth scope', () => {
        const tool = registry.getTool('svc.create_job');
        const owner = authority('tenant_admin', {
            owner_permissions: ['jobs.create'],
            writes_enabled: true,
        });
        const readOnlyScopes = [permissions.READ_SCOPE];

        expect(authorization.canInvokeAvatar(tool, owner, readOnlyScopes)).toBe(true);
        expect(() => authorization.requireAvatarToolAccess(
            tool,
            owner,
            readOnlyScopes
        )).not.toThrow();
    });

    test('SAB-AVATAR-NO-RECONNECT-TIER-STILL-GATES: live tier consent still denies writes and sends', () => {
        const writeTool = registry.getTool('svc.create_job');
        const sendTool = registry.getTool('svc.send_invoice');
        const writesDisabled = authority('tenant_admin', { writes_enabled: false });
        const sendsDisabled = authority('tenant_admin', { sends_enabled: false });

        expect(authorization.canInvokeAvatar(writeTool, writesDisabled, ALL_SCOPES)).toBe(false);
        expect(() => authorization.requireAvatarToolAccess(
            writeTool,
            writesDisabled,
            ALL_SCOPES
        )).toThrow(expect.objectContaining({ mcpCode: 'access_denied' }));
        expect(authorization.canInvokeAvatar(sendTool, sendsDisabled, ALL_SCOPES)).toBe(false);
        expect(() => authorization.requireAvatarToolAccess(
            sendTool,
            sendsDisabled,
            ALL_SCOPES
        )).toThrow(expect.objectContaining({ mcpCode: 'access_denied' }));
    });

    test('SAB-AVATAR-NO-RECONNECT-RBAC-STILL-GATES: live owner RBAC still denies writes', () => {
        const tool = registry.getTool('svc.create_job');
        const owner = authority('tenant_admin', {
            owner_permissions: [],
            writes_enabled: true,
        });

        expect(authorization.canInvokeAvatar(tool, owner, ALL_SCOPES)).toBe(false);
        expect(() => authorization.requireAvatarToolAccess(
            tool,
            owner,
            ALL_SCOPES
        )).toThrow(expect.objectContaining({ mcpCode: 'access_denied' }));
    });
});
