const fs = require('fs');
const path = require('path');

const seed = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/050_seed_role_configs.sql'),
    'utf8'
);
const { ALL_PERMISSION_KEYS } = require('../backend/src/services/permissionCatalog');

function seededPermissions(roleKey) {
    const blocks = [...seed.matchAll(
        /CROSS JOIN \(VALUES([\s\S]*?)\) AS p\(key\)\s+WHERE rc\.role_key = '([^']+)'/g
    )];
    const block = blocks.find(match => match[2] === roleKey);
    if (!block) throw new Error(`Missing permission seed for ${roleKey}`);
    return new Set([...block[1].matchAll(/\('([^']+)'\)/g)].map(match => match[1]));
}

describe('RBAC-WAVE2-001 role-holder seed proof', () => {
    const roles = ['tenant_admin', 'manager', 'dispatcher', 'provider'];
    const permissions = Object.fromEntries(roles.map(role => [role, seededPermissions(role)]));

    test.each([
        ['contacts.view', ['tenant_admin', 'manager', 'dispatcher']],
        ['leads.view', ['tenant_admin', 'manager', 'dispatcher']],
        ['tasks.view', roles],
        ['pulse.view', roles],
        ['price_book.view', roles],
        ['price_book.manage', ['tenant_admin', 'manager']],
        ['reports.calls.view', ['tenant_admin', 'manager', 'dispatcher']],
        ['phone_calls.use', roles],
    ])('%s is cataloged and held only by the expected fixed roles', (permission, allowedRoles) => {
        expect(ALL_PERMISSION_KEYS).toContain(permission);
        for (const role of roles) {
            expect(permissions[role].has(permission)).toBe(allowedRoles.includes(role));
        }
    });
});
