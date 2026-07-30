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

    // ROLE-TASKS-SCOPE-001: Tasks is not an access-gated section. The tasks.* keys are
    // intentionally NOT in the settings catalog (no per-role toggle), but they remain
    // real seeded grants that drive content-scoping: everyone can open Tasks (view +
    // create), and only the office roles hold tasks.manage → see every task; a provider
    // without it sees only tasks assigned to or authored by them.
    describe('tasks.* is content-scoped, not a settings toggle', () => {
        test.each(['tasks.view', 'tasks.create', 'tasks.manage'])(
            '%s is absent from the settings catalog', (key) => {
                expect(ALL_PERMISSION_KEYS).not.toContain(key);
            });

        test.each(roles)('%s can reach Tasks (seeded tasks.view + tasks.create)', (role) => {
            expect(permissions[role].has('tasks.view')).toBe(true);
            expect(permissions[role].has('tasks.create')).toBe(true);
        });

        test.each([
            ['tenant_admin', true],
            ['manager', true],
            ['dispatcher', true],
            ['provider', false],
        ])('%s tasks.manage (see-all) = %s', (role, expected) => {
            expect(permissions[role].has('tasks.manage')).toBe(expected);
        });
    });
});
