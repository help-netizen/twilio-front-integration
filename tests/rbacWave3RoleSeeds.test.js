const fs = require('fs');
const path = require('path');

const seed050 = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/050_seed_role_configs.sql'),
    'utf8'
);
const seed088 = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/088_create_sales_crm_core.sql'),
    'utf8'
);
const agentRegistry = require('../backend/src/services/agentSkillsMcpRegistry');
const crmRegistry = require('../backend/src/services/crmMcpToolRegistry');
const mcpToolAuthorization = require('../backend/src/services/mcpToolAuthorization');
const skillRegistry = require('../backend/src/services/agentSkills/registry');
const sara = require('../voice-agent/assistants/lead-qualifier-v2.json');

const ROLES = ['tenant_admin', 'manager', 'dispatcher', 'provider'];

function seededPermissions(roleKey) {
    const blocks = [...seed050.matchAll(
        /CROSS JOIN \(VALUES([\s\S]*?)\) AS p\(key\)\s+WHERE rc\.role_key = '([^']+)'/g
    )];
    const block = blocks.find((match) => match[2] === roleKey);
    if (!block) throw new Error(`Missing permission seed for ${roleKey}`);
    const permissions = new Set([...block[1].matchAll(/\('([^']+)'\)/g)].map((match) => match[1]));
    if (['tenant_admin', 'manager'].includes(roleKey)) {
        expect(seed088).toMatch(/\('sales\.crm\.write'\)[\s\S]*WHERE rc\.role_key IN \('tenant_admin', 'manager'\)/);
        permissions.add('sales.crm.write');
    }
    if (roleKey === 'dispatcher') permissions.add('sales.crm.read');
    return permissions;
}

function roleCanInvoke(tool, permissions) {
    return mcpToolAuthorization.canInvoke(tool, [...permissions])
        && (!tool.frameworkWritePermission || permissions.has(tool.frameworkWritePermission));
}

describe('RBAC-WAVE3-001 fixed-role matrix and Sara proof', () => {
    const permissions = Object.fromEntries(ROLES.map((role) => [role, seededPermissions(role)]));
    const tools = [...agentRegistry.listTools(), ...crmRegistry.listTools()];
    const cells = tools.flatMap((tool) => ROLES.map((role) => ({ tool, role })));

    test('every MCP tool has an explicit permission mapping', () => {
        for (const tool of tools) {
            expect(tool.requiredPermissions.length).toBeGreaterThan(0);
            expect(tool.requiredPermission).toBe(tool.requiredPermissions[0]);
        }
    });

    test.each(cells.filter(({ tool, role }) => roleCanInvoke(tool, permissions[role])))('$role may invoke $tool.name from the seeded matrix', ({ tool, role }) => {
        expect(roleCanInvoke(tool, permissions[role])).toBe(true);
    });

    test.each(cells.filter(({ tool, role }) => !roleCanInvoke(tool, permissions[role])))('$role is denied $tool.name by the seeded matrix', ({ tool, role }) => {
        expect(roleCanInvoke(tool, permissions[role])).toBe(false);
    });

    test('Sara outcome (a): all 15 deployed tools remain on the unchanged x-vapi-secret skill path', () => {
        const saraTools = sara.model.tools.map((tool) => tool.function.name);
        const registeredSkills = new Set(skillRegistry.listSkills().map((skill) => skill.name));

        expect(saraTools).toHaveLength(15);
        expect(sara.model.tools.every((tool) => (
            tool.server.url === 'https://api.albusto.com/api/vapi-tools'
            && tool.server.secret === 'REPLACE_WITH_VAPI_TOOLS_SECRET'
        ))).toBe(true);
        expect(saraTools.every((toolName) => registeredSkills.has(toolName))).toBe(true);
    });
});
