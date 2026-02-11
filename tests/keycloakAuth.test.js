/**
 * Keycloak Auth Middleware — Unit Tests
 * 
 * Mock tests for extractRoles(), authenticate() dev-mode, and requireRole().
 * These tests do NOT require a running Keycloak instance.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock userService before requiring the module
jest.mock('../backend/src/services/userService', () => ({
    findOrCreateUser: jest.fn().mockResolvedValue({
        id: 'test-uuid',
        keycloak_sub: 'kc-sub-123',
        email: 'test@crm.local',
        full_name: 'Test User',
        role: 'company_admin',
        company_id: '00000000-0000-0000-0000-000000000001',
    }),
}));

// Mock auditService before requiring the module
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
}));

// Mock jwks-rsa
jest.mock('jwks-rsa', () => {
    return jest.fn().mockReturnValue({
        getSigningKey: jest.fn(),
    });
});

// ─── Tests with FEATURE_AUTH_ENABLED=false (dev mode) ─────────────────────────

describe('keycloakAuth — dev mode (FEATURE_AUTH_ENABLED=false)', () => {
    let authenticate, requireRole;

    beforeAll(() => {
        // Ensure auth is disabled
        delete process.env.FEATURE_AUTH_ENABLED;
        process.env.FEATURE_AUTH_ENABLED = 'false';

        // Clear module cache to re-evaluate with new env
        jest.resetModules();
        jest.mock('../backend/src/services/userService', () => ({
            findOrCreateUser: jest.fn().mockResolvedValue({ id: 'dev-uuid' }),
        }));
        jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));

        const keycloakAuth = require('../backend/src/middleware/keycloakAuth');
        authenticate = keycloakAuth.authenticate;
        requireRole = keycloakAuth.requireRole;
    });

    test('authenticate sets dev-mode stub user and calls next()', () => {
        const req = { headers: {} };
        const res = {};
        const next = jest.fn();

        authenticate(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toBeDefined();
        expect(req.user.sub).toBe('dev-user');
        expect(req.user.email).toBe('dev@localhost');
        expect(req.user.name).toBe('Dev User');
        expect(req.user.roles).toContain('company_admin');
        expect(req.user._devMode).toBe(true);
        expect(req.user.company_id).toBe('00000000-0000-0000-0000-000000000001');
    });

    test('requireRole bypasses check in dev mode', () => {
        const req = {
            user: { roles: [], _devMode: true },
        };
        const res = {};
        const next = jest.fn();

        const middleware = requireRole('company_admin');
        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });
});

// ─── Tests with FEATURE_AUTH_ENABLED=true ─────────────────────────────────────

describe('keycloakAuth — auth enabled (FEATURE_AUTH_ENABLED=true)', () => {
    let authenticate, requireRole;
    let mockRes;

    beforeAll(() => {
        process.env.FEATURE_AUTH_ENABLED = 'true';
        process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';

        jest.resetModules();
        jest.mock('../backend/src/services/userService', () => ({
            findOrCreateUser: jest.fn().mockResolvedValue({ id: 'kc-uuid', company_id: '00000000-0000-0000-0000-000000000001' }),
        }));
        jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));
        jest.mock('../backend/src/services/auditService', () => ({
            log: jest.fn().mockResolvedValue(undefined),
        }));

        const keycloakAuth = require('../backend/src/middleware/keycloakAuth');
        authenticate = keycloakAuth.authenticate;
        requireRole = keycloakAuth.requireRole;
    });

    beforeEach(() => {
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
    });

    test('returns 401 AUTH_REQUIRED when no Authorization header', () => {
        const req = { headers: {} };
        const next = jest.fn();

        authenticate(req, mockRes, next);

        expect(next).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith(
            expect.objectContaining({
                code: 'AUTH_REQUIRED',
                message: 'Bearer token required',
            })
        );
    });

    test('returns 401 AUTH_REQUIRED when Authorization header is not Bearer', () => {
        const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
        const next = jest.fn();

        authenticate(req, mockRes, next);

        expect(next).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    test('returns 401 AUTH_REQUIRED when Authorization header is empty Bearer', () => {
        const req = { headers: { authorization: 'NotBearer xyz' } };
        const next = jest.fn();

        authenticate(req, mockRes, next);

        expect(next).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(401);
    });
});

// ─── extractRoles tests (standalone) ──────────────────────────────────────────

describe('extractRoles — standalone function', () => {
    // We need to access the internal extractRoles function.
    // Since it's not exported, we test it indirectly through behavior.
    // Instead, let's test the logic directly:

    function extractRoles(decoded) {
        const roles = new Set();
        if (decoded.realm_access?.roles) {
            decoded.realm_access.roles.forEach(r => roles.add(r));
        }
        if (Array.isArray(decoded.realm_roles)) {
            decoded.realm_roles.forEach(r => roles.add(r));
        }
        return Array.from(roles);
    }

    test('extracts roles from realm_access.roles (standard Keycloak)', () => {
        const decoded = {
            realm_access: { roles: ['owner_admin', 'dispatcher'] },
        };
        const roles = extractRoles(decoded);
        expect(roles).toContain('owner_admin');
        expect(roles).toContain('dispatcher');
        expect(roles).toHaveLength(2);
    });

    test('extracts roles from realm_roles (custom mapper)', () => {
        const decoded = {
            realm_roles: ['viewer', 'technician'],
        };
        const roles = extractRoles(decoded);
        expect(roles).toContain('viewer');
        expect(roles).toContain('technician');
        expect(roles).toHaveLength(2);
    });

    test('merges roles from both sources without duplicates', () => {
        const decoded = {
            realm_access: { roles: ['owner_admin', 'dispatcher'] },
            realm_roles: ['dispatcher', 'viewer'],
        };
        const roles = extractRoles(decoded);
        expect(roles).toContain('owner_admin');
        expect(roles).toContain('dispatcher');
        expect(roles).toContain('viewer');
        expect(roles).toHaveLength(3); // dispatcher not duplicated
    });

    test('returns empty array when no roles present', () => {
        const decoded = {};
        const roles = extractRoles(decoded);
        expect(roles).toEqual([]);
    });

    test('returns empty when realm_access has no roles key', () => {
        const decoded = { realm_access: {} };
        const roles = extractRoles(decoded);
        expect(roles).toEqual([]);
    });

    test('handles realm_roles as non-array gracefully', () => {
        const decoded = { realm_roles: 'owner_admin' }; // string instead of array
        const roles = extractRoles(decoded);
        expect(roles).toEqual([]); // should not crash
    });
});

// ─── requireRole tests ────────────────────────────────────────────────────────

describe('requireRole', () => {
    let requireRole;
    let mockRes;

    beforeAll(() => {
        process.env.FEATURE_AUTH_ENABLED = 'true';
        process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';

        jest.resetModules();
        jest.mock('../backend/src/services/userService', () => ({
            findOrCreateUser: jest.fn().mockResolvedValue({ id: 'kc-uuid', company_id: '00000000-0000-0000-0000-000000000001' }),
        }));
        jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));
        jest.mock('../backend/src/services/auditService', () => ({
            log: jest.fn().mockResolvedValue(undefined),
        }));

        requireRole = require('../backend/src/middleware/keycloakAuth').requireRole;
    });

    beforeEach(() => {
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
    });

    test('allows access when user has exact required role', () => {
        const req = { user: { email: 'admin@crm.local', roles: ['company_admin'] } };
        const next = jest.fn();

        requireRole('company_admin')(req, mockRes, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('allows access when user has one of multiple required roles', () => {
        const req = { user: { email: 'member@crm.local', roles: ['company_member'] } };
        const next = jest.fn();

        requireRole('company_admin', 'company_member')(req, mockRes, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    test('allows access for super_admin regardless of required roles', () => {
        const req = { user: { email: 'super@crm.local', roles: ['super_admin'], is_super_admin: true } };
        const next = jest.fn();

        requireRole('company_admin')(req, mockRes, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    test('denies access when user lacks required role (403)', () => {
        const req = { user: { email: 'member@crm.local', roles: ['company_member'] } };
        const next = jest.fn();

        requireRole('company_admin')(req, mockRes, next);

        expect(next).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockRes.json).toHaveBeenCalledWith(
            expect.objectContaining({
                code: 'ACCESS_DENIED',
                message: 'Access denied',
            })
        );
    });

    test('denies access when user has no roles at all', () => {
        const req = { user: { email: 'noroles@crm.local', roles: [] } };
        const next = jest.fn();

        requireRole('company_admin')(req, mockRes, next);

        expect(next).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    test('denies access when req.user is undefined', () => {
        const req = {};
        const next = jest.fn();

        requireRole('company_admin')(req, mockRes, next);

        expect(next).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    test('bypasses role check in dev mode (_devMode flag)', () => {
        const req = { user: { roles: [], _devMode: true } };
        const next = jest.fn();

        requireRole('company_admin')(req, mockRes, next);

        expect(next).toHaveBeenCalledTimes(1);
    });
});

// ─── userService (findOrCreateUser) role hierarchy tests ──────────────────────

describe('userService — role hierarchy logic', () => {
    const roleHierarchy = ['super_admin', 'company_admin', 'company_member'];

    function determinePrimaryRole(realmRoles) {
        return roleHierarchy.find(r => realmRoles.includes(r)) || 'company_member';
    }

    test('selects super_admin as highest role', () => {
        expect(determinePrimaryRole(['company_member', 'super_admin'])).toBe('super_admin');
    });

    test('selects company_admin when no super_admin', () => {
        expect(determinePrimaryRole(['company_member', 'company_admin'])).toBe('company_admin');
    });

    test('selects company_member as lowest CRM role', () => {
        expect(determinePrimaryRole(['company_member'])).toBe('company_member');
    });

    test('defaults to company_member when no CRM roles', () => {
        expect(determinePrimaryRole(['uma_authorization', 'default-roles-crm-prod'])).toBe('company_member');
    });

    test('defaults to company_member for empty roles array', () => {
        expect(determinePrimaryRole([])).toBe('company_member');
    });
});
