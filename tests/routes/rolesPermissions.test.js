/**
 * RBAC-ROLES-EDITOR-001 — rolesPermissions route tests.
 *
 * DB is mocked like the other route tests. The query layer (roleQueries,
 * membershipQueries) runs for real against the mocked db.query; userService and
 * auditService are mocked so member listing + audit are deterministic.
 *
 * Covers: 403 without tenant.roles.manage; GET returns catalog + roles;
 * PUT on tenant_admin rejected (400); PUT valid toggle calls setRolePermission;
 * cross-tenant override membership → 404; override set + clear.
 */

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../backend/src/services/userService', () => ({ listUsers: jest.fn() }));

const { requirePermission } = require('../../backend/src/middleware/authorization');
const rolesRouter = require('../../backend/src/routes/rolesPermissions');
const roleQueries = require('../../backend/src/db/roleQueries');
const membershipQueries = require('../../backend/src/db/membershipQueries');
const userService = require('../../backend/src/services/userService');
const auditService = require('../../backend/src/services/auditService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const OTHER_COMPANY = '00000000-0000-0000-0000-0000000000ff';

// Mount the router exactly like production: behind requirePermission so the 403
// path is exercised. `permissions` controls what the simulated user holds.
function makeApp({ permissions = ['tenant.roles.manage'], company = COMPANY } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'admin@x.com', crmUser: { id: 'crm-1' } };
        req.authz = { scope: 'tenant', permissions };
        req.companyFilter = { company_id: company };
        next();
    });
    app.use('/api/settings/roles', requirePermission('tenant.roles.manage'), rolesRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('RBAC-ROLES-EDITOR-001: gating', () => {
    test('403 without tenant.roles.manage', async () => {
        const res = await request(makeApp({ permissions: ['jobs.view'] })).get('/api/settings/roles');
        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('GET / — role matrix', () => {
    test('returns catalog + mandatoryAdminPermissions + roles with permission maps', async () => {
        // ensureRoleConfigs → listRoleConfigs (non-empty, so no seeding)
        mockQuery.mockResolvedValueOnce({
            rows: [
                { id: 'rc-admin', role_key: 'tenant_admin', display_name: 'Tenant Admin', is_locked: true },
                { id: 'rc-mgr', role_key: 'manager', display_name: 'Manager', is_locked: false },
            ],
        });
        // getRolePermissions(rc-admin)
        mockQuery.mockResolvedValueOnce({
            rows: [{ permission_key: 'jobs.view', is_allowed: true }, { permission_key: 'jobs.edit', is_allowed: true }],
        });
        // getRolePermissions(rc-mgr)
        mockQuery.mockResolvedValueOnce({
            rows: [{ permission_key: 'jobs.view', is_allowed: true }, { permission_key: 'jobs.edit', is_allowed: false }],
        });

        const res = await request(makeApp()).get('/api/settings/roles');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Array.isArray(res.body.data.catalog)).toBe(true);
        expect(res.body.data.catalog.length).toBeGreaterThan(0);
        expect(res.body.data.mandatoryAdminPermissions).toContain('tenant.roles.manage');
        expect(res.body.data.roles).toHaveLength(2);
        const mgr = res.body.data.roles.find(r => r.role_key === 'manager');
        expect(mgr.permissions['jobs.view']).toBe(true);
        expect(mgr.permissions['jobs.edit']).toBe(false);
    });

    test('lazy-seeds when the company has no role configs', async () => {
        // listRoleConfigs (empty) → triggers seedRoleConfigs
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // seedRoleConfigs runs 4 INSERTs (return nothing relevant)
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // listRoleConfigs again (now seeded)
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'rc-admin', role_key: 'tenant_admin', display_name: 'Tenant Admin', is_locked: true }],
        });
        // getRolePermissions(rc-admin)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await request(makeApp()).get('/api/settings/roles');
        expect(res.status).toBe(200);
        expect(res.body.data.roles).toHaveLength(1);
    });
});

describe('PUT /:roleKey/permissions', () => {
    test('rejects tenant_admin with 400 and no DB writes', async () => {
        const res = await request(makeApp())
            .put('/api/settings/roles/tenant_admin/permissions')
            .send({ permission_key: 'jobs.view', is_allowed: false });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('ROLE_LOCKED');
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('rejects an unknown permission key with 400', async () => {
        const res = await request(makeApp())
            .put('/api/settings/roles/manager/permissions')
            .send({ permission_key: 'not.a.real.permission', is_allowed: true });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_PERMISSION');
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('404 when the role config does not exist', async () => {
        // getRoleConfig → none
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await request(makeApp())
            .put('/api/settings/roles/manager/permissions')
            .send({ permission_key: 'jobs.view', is_allowed: true });
        expect(res.status).toBe(404);
    });

    test('400 when the resolved role config is locked', async () => {
        // getRoleConfig → a locked config (defensive: locked custom role)
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'rc-x', company_id: COMPANY, role_key: 'manager', is_locked: true }],
        });
        const res = await request(makeApp())
            .put('/api/settings/roles/manager/permissions')
            .send({ permission_key: 'jobs.view', is_allowed: true });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('ROLE_LOCKED');
    });

    test('valid toggle upserts the permission, audits, and returns the updated map', async () => {
        // getRoleConfig → manager config
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'rc-mgr', company_id: COMPANY, role_key: 'manager', is_locked: false }],
        });
        // setRolePermission (upsert) RETURNING
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'perm-1', permission_key: 'jobs.edit', is_allowed: true }],
        });
        // getRolePermissions (full map after update)
        mockQuery.mockResolvedValueOnce({
            rows: [{ permission_key: 'jobs.view', is_allowed: true }, { permission_key: 'jobs.edit', is_allowed: true }],
        });

        const res = await request(makeApp())
            .put('/api/settings/roles/manager/permissions')
            .send({ permission_key: 'jobs.edit', is_allowed: true });

        expect(res.status).toBe(200);
        expect(res.body.data.permissions['jobs.edit']).toBe(true);

        // The upsert SQL ran with the right args.
        const upsertCall = mockQuery.mock.calls[1];
        expect(upsertCall[0]).toMatch(/INSERT INTO company_role_permissions/i);
        expect(upsertCall[0]).toMatch(/ON CONFLICT/i);
        expect(upsertCall[1]).toEqual(['rc-mgr', 'jobs.edit', true]);

        expect(auditService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'role_permission_changed', actor_id: 'crm-1', company_id: COMPANY })
        );
    });

    test('400 when is_allowed is not a boolean', async () => {
        const res = await request(makeApp())
            .put('/api/settings/roles/manager/permissions')
            .send({ permission_key: 'jobs.view', is_allowed: 'yes' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_VALUE');
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('GET /members', () => {
    test('returns members with their override maps, tenant-scoped', async () => {
        userService.listUsers.mockResolvedValueOnce({
            users: [
                {
                    id: 'u-1', membership_id: 'm-1', full_name: 'Ann Admin', email: 'ann@x.com',
                    role_key: 'manager', legacy_role: 'company_member', membership_status: 'active',
                },
            ],
        });
        // getPermissionOverrides(m-1)
        mockQuery.mockResolvedValueOnce({ rows: [{ permission_key: 'payments.refund', override_mode: 'deny' }] });

        const res = await request(makeApp()).get('/api/settings/roles/members');
        expect(res.status).toBe(200);
        expect(userService.listUsers).toHaveBeenCalledWith(COMPANY, expect.any(Object));
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toMatchObject({
            membership_id: 'm-1', user_id: 'u-1', name: 'Ann Admin', role_key: 'manager', role_name: 'Manager',
        });
        expect(res.body.data[0].overrides['payments.refund']).toBe('deny');
    });
});

describe('PUT /members/:membershipId/overrides', () => {
    test('cross-tenant membership → 404, no override write', async () => {
        // getMembershipById → membership in a DIFFERENT company
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm-9', company_id: OTHER_COMPANY }] });

        const res = await request(makeApp())
            .put('/api/settings/roles/members/m-9/overrides')
            .send({ permission_key: 'jobs.view', override_mode: 'allow' });

        expect(res.status).toBe(404);
        // Only the lookup ran — no INSERT/DELETE.
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('missing membership → 404', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // getMembershipById → none
        const res = await request(makeApp())
            .put('/api/settings/roles/members/m-x/overrides')
            .send({ permission_key: 'jobs.view', override_mode: 'allow' });
        expect(res.status).toBe(404);
    });

    test('invalid override_mode → 400', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm-1', company_id: COMPANY }] });
        const res = await request(makeApp())
            .put('/api/settings/roles/members/m-1/overrides')
            .send({ permission_key: 'jobs.view', override_mode: 'maybe' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_VALUE');
    });

    test('sets an override (allow), audits, returns the override map', async () => {
        // getMembershipById → in-tenant
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm-1', company_id: COMPANY }] });
        // setPermissionOverride upsert RETURNING
        mockQuery.mockResolvedValueOnce({ rows: [{ permission_key: 'payments.refund', override_mode: 'allow' }] });
        // getPermissionOverrides after write
        mockQuery.mockResolvedValueOnce({ rows: [{ permission_key: 'payments.refund', override_mode: 'allow' }] });

        const res = await request(makeApp())
            .put('/api/settings/roles/members/m-1/overrides')
            .send({ permission_key: 'payments.refund', override_mode: 'allow' });

        expect(res.status).toBe(200);
        expect(res.body.data.overrides['payments.refund']).toBe('allow');
        const upsertCall = mockQuery.mock.calls[1];
        expect(upsertCall[0]).toMatch(/INSERT INTO company_membership_permission_overrides/i);
        expect(upsertCall[1]).toEqual(['m-1', 'payments.refund', 'allow']);
        expect(auditService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'member_permission_override_changed', company_id: COMPANY })
        );
    });

    test('clears an override (null) via DELETE', async () => {
        // getMembershipById → in-tenant
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm-1', company_id: COMPANY }] });
        // setPermissionOverride → DELETE branch
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // getPermissionOverrides after clear (now empty)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await request(makeApp())
            .put('/api/settings/roles/members/m-1/overrides')
            .send({ permission_key: 'payments.refund', override_mode: null });

        expect(res.status).toBe(200);
        expect(res.body.data.overrides).toEqual({});
        const delCall = mockQuery.mock.calls[1];
        expect(delCall[0]).toMatch(/DELETE FROM company_membership_permission_overrides/i);
        expect(delCall[1]).toEqual(['m-1', 'payments.refund']);
    });
});
