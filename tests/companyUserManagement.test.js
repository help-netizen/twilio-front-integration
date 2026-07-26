'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/userService', () => ({
    createUserWithMembership: jest.fn(),
    listUsers: jest.fn(),
    getUserDetail: jest.fn(),
    getManagedUser: jest.fn(),
    companyEmailIsInUse: jest.fn(),
    updateMembershipAndProfile: jest.fn(),
    countCompanyAdmins: jest.fn(),
    updateMembershipStatus: jest.fn(),
}));
jest.mock('../backend/src/services/keycloakService', () => ({
    generateTempPassword: jest.fn(() => 'unused-temp-password'),
    inspectUserIdentity: jest.fn(),
    realmLoginIsInUse: jest.fn(),
    updateUserIdentity: jest.fn(),
    restoreUserIdentity: jest.fn(),
    sendUpdatePasswordEmail: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(),
}));

const userService = require('../backend/src/services/userService');
const keycloakService = require('../backend/src/services/keycloakService');
const auditService = require('../backend/src/services/auditService');
const { requirePermission } = require('../backend/src/middleware/authorization');
const { requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const usersRouter = require('../backend/src/routes/users');

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TARGET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const KEYCLOAK_SUB = 'keycloak-target-id';

const target = {
    id: TARGET_ID,
    keycloak_sub: KEYCLOAK_SUB,
    email: 'member@example.test',
    full_name: 'Member One',
    phone: '+1 617 555 0100',
    membership_count: 1,
};

const keycloakUser = {
    id: KEYCLOAK_SUB,
    username: target.email,
    email: target.email,
    firstName: 'Member',
    lastName: 'One',
    enabled: true,
    emailVerified: true,
    attributes: { company_id: [COMPANY_A] },
    requiredActions: [],
};

function makeApp({
    roleKey = 'tenant_admin',
    permissions = ['tenant.users.manage'],
    companyId = COMPANY_A,
} = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = {
            email: 'admin@example.test',
            crmUser: { id: ACTOR_ID },
        };
        req.authz = {
            scope: 'tenant',
            platform_role: 'none',
            company: { id: companyId, status: 'active' },
            membership: { role_key: roleKey, status: 'active' },
            permissions,
        };
        req.traceId = 'trace-company-user-management';
        next();
    });
    app.use(
        '/api/users',
        requirePermission('tenant.users.manage'),
        requireCompanyAccess,
        usersRouter
    );
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    userService.getManagedUser.mockResolvedValue({ ...target });
    userService.companyEmailIsInUse.mockResolvedValue(false);
    userService.updateMembershipAndProfile.mockResolvedValue({
        providerBridgeChanged: false,
        user: {
            email: 'renamed@example.test',
            full_name: 'Renamed Member',
            phone: '+1 617 555 0199',
        },
    });
    keycloakService.inspectUserIdentity.mockResolvedValue({
        user: { ...keycloakUser },
        federatedIdentities: [],
    });
    keycloakService.realmLoginIsInUse.mockResolvedValue(false);
    keycloakService.updateUserIdentity.mockResolvedValue(undefined);
    keycloakService.restoreUserIdentity.mockResolvedValue(undefined);
    keycloakService.sendUpdatePasswordEmail.mockResolvedValue(undefined);
    auditService.log.mockResolvedValue(undefined);
});

describe('OB-36 company-admin role gate', () => {
    test.each(['manager', 'dispatcher', 'provider'])(
        'R-matrix: %s gets 403 for member edit even with tenant.users.manage',
        async (roleKey) => {
            const response = await request(makeApp({ roleKey }))
                .patch(`/api/users/${TARGET_ID}`)
                .send({ profile: { phone: '+1 617 555 0101' } });

            expect(response.status).toBe(403);
            expect(response.body.code).toBe('TENANT_ADMIN_ONLY');
            expect(userService.getManagedUser).not.toHaveBeenCalled();
            expect(keycloakService.updateUserIdentity).not.toHaveBeenCalled();
        }
    );

    test.each(['manager', 'dispatcher', 'provider'])(
        'R-matrix: %s gets 403 for password-reset email even with tenant.users.manage',
        async (roleKey) => {
            const response = await request(makeApp({ roleKey }))
                .post(`/api/users/${TARGET_ID}/reset-password`);

            expect(response.status).toBe(403);
            expect(response.body.code).toBe('TENANT_ADMIN_ONLY');
            expect(keycloakService.sendUpdatePasswordEmail).not.toHaveBeenCalled();
        }
    );

    test('the existing catalog permission remains an additional deny gate', async () => {
        const response = await request(makeApp({ permissions: [] }))
            .patch(`/api/users/${TARGET_ID}`)
            .send({ profile: { phone: '+1 617 555 0101' } });

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(userService.getManagedUser).not.toHaveBeenCalled();
    });
});

describe('PATCH /api/users/:id identity and profile contract', () => {
    test('T-own: updates Keycloak login/name, resets verification, then updates scoped CRM fields', async () => {
        const response = await request(makeApp())
            .patch(`/api/users/${TARGET_ID}`)
            .send({
                full_name: ' Renamed Member ',
                email: 'RENAMED@example.test',
                profile: { phone: '+1 617 555 0199' },
            });

        expect(response.status).toBe(200);
        expect(keycloakService.updateUserIdentity).toHaveBeenCalledWith(
            KEYCLOAK_SUB,
            keycloakUser,
            {
                email: 'renamed@example.test',
                full_name: 'Renamed Member',
                reset_email_verification: true,
            }
        );
        expect(userService.updateMembershipAndProfile).toHaveBeenCalledWith(
            TARGET_ID,
            COMPANY_A,
            {
                profile: { phone: '+1 617 555 0199' },
                full_name: 'Renamed Member',
                email: 'renamed@example.test',
                expected_email: target.email,
            }
        );
        expect(response.body).toMatchObject({
            ok: true,
            user: {
                id: TARGET_ID,
                email: 'renamed@example.test',
                full_name: 'Renamed Member',
                phone: '+1 617 555 0199',
            },
            identity_change: {
                email_changed: true,
                email_verification_reset: true,
                linked_identity_providers: [],
            },
        });
        expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
            actor_id: ACTOR_ID,
            target_id: TARGET_ID,
            company_id: COMPANY_A,
            details: expect.objectContaining({
                email_updated: true,
                email_verification_reset: true,
            }),
        }));
    });

    test('T-foreign: a member outside companyFilter returns 404 with no provider or DB write', async () => {
        userService.getManagedUser.mockResolvedValue(null);

        const response = await request(makeApp({ companyId: COMPANY_B }))
            .patch(`/api/users/${TARGET_ID}`)
            .send({ email: 'other@example.test' });

        expect(response.status).toBe(404);
        expect(keycloakService.inspectUserIdentity).not.toHaveBeenCalled();
        expect(keycloakService.updateUserIdentity).not.toHaveBeenCalled();
        expect(userService.updateMembershipAndProfile).not.toHaveBeenCalled();
    });

    test('rejects a company-local email conflict before calling Keycloak', async () => {
        userService.companyEmailIsInUse.mockResolvedValue(true);

        const response = await request(makeApp())
            .patch(`/api/users/${TARGET_ID}`)
            .send({ email: 'duplicate@example.test' });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('EMAIL_IN_USE');
        expect(keycloakService.inspectUserIdentity).not.toHaveBeenCalled();
        expect(keycloakService.updateUserIdentity).not.toHaveBeenCalled();
    });

    test('rejects a realm login conflict before mutating either system', async () => {
        keycloakService.realmLoginIsInUse.mockResolvedValue(true);

        const response = await request(makeApp())
            .patch(`/api/users/${TARGET_ID}`)
            .send({ email: 'realm-duplicate@example.test' });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('EMAIL_IN_USE');
        expect(keycloakService.updateUserIdentity).not.toHaveBeenCalled();
        expect(userService.updateMembershipAndProfile).not.toHaveBeenCalled();
    });

    test('maps a racing Keycloak uniqueness conflict to EMAIL_IN_USE', async () => {
        const conflict = new Error('Keycloak conflict');
        conflict.code = 'KEYCLOAK_IDENTITY_CONFLICT';
        keycloakService.updateUserIdentity.mockRejectedValue(conflict);

        const response = await request(makeApp())
            .patch(`/api/users/${TARGET_ID}`)
            .send({ email: 'racing-conflict@example.test' });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('EMAIL_IN_USE');
        expect(userService.updateMembershipAndProfile).not.toHaveBeenCalled();
    });

    test('surfaces Google/IdP risk and verification reset before changing a linked login', async () => {
        keycloakService.inspectUserIdentity.mockResolvedValue({
            user: { ...keycloakUser },
            federatedIdentities: [{ identityProvider: 'google', userId: 'google-user' }],
        });

        const response = await request(makeApp())
            .patch(`/api/users/${TARGET_ID}`)
            .send({ email: 'new-google-login@example.test' });

        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
            code: 'IDENTITY_CHANGE_CONFIRMATION_REQUIRED',
            identity_change: {
                linked_identity_providers: ['google'],
                email_verification_will_reset: true,
            },
        });
        expect(keycloakService.updateUserIdentity).not.toHaveBeenCalled();
        expect(userService.updateMembershipAndProfile).not.toHaveBeenCalled();
    });

    test('explicit confirmation permits a linked-IdP email change', async () => {
        keycloakService.inspectUserIdentity.mockResolvedValue({
            user: { ...keycloakUser },
            federatedIdentities: [{ identityProvider: 'google', userId: 'google-user' }],
        });

        const response = await request(makeApp())
            .patch(`/api/users/${TARGET_ID}`)
            .send({
                email: 'new-google-login@example.test',
                confirm_identity_change: true,
            });

        expect(response.status).toBe(200);
        expect(keycloakService.updateUserIdentity).toHaveBeenCalled();
        expect(response.body.identity_change).toEqual({
            email_changed: true,
            email_verification_reset: true,
            linked_identity_providers: ['google'],
        });
    });

    test('compensates the Keycloak update when the scoped PostgreSQL update fails', async () => {
        const dbError = new Error('database write failed');
        userService.updateMembershipAndProfile.mockRejectedValue(dbError);

        const response = await request(makeApp())
            .patch(`/api/users/${TARGET_ID}`)
            .send({ email: 'rollback@example.test' });

        expect(response.status).toBe(500);
        expect(keycloakService.restoreUserIdentity).toHaveBeenCalledWith(
            KEYCLOAK_SUB,
            keycloakUser
        );
        expect(auditService.log).not.toHaveBeenCalled();
    });

    test('rejects global identity changes for a user shared with another company', async () => {
        userService.getManagedUser.mockResolvedValue({ ...target, membership_count: 2 });

        const response = await request(makeApp())
            .patch(`/api/users/${TARGET_ID}`)
            .send({ full_name: 'Cross Tenant Rename' });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('SHARED_IDENTITY_REQUIRES_PLATFORM_ADMIN');
        expect(keycloakService.inspectUserIdentity).not.toHaveBeenCalled();
    });
});

describe('POST /api/users/:id/reset-password', () => {
    test('emails UPDATE_PASSWORD and returns no password or reset token', async () => {
        const response = await request(makeApp())
            .post(`/api/users/${TARGET_ID}/reset-password`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, sent: true });
        expect(response.body).not.toHaveProperty('temporary_password');
        expect(response.body).not.toHaveProperty('token');
        expect(keycloakService.sendUpdatePasswordEmail).toHaveBeenCalledWith(KEYCLOAK_SUB);
        expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
            actor_id: ACTOR_ID,
            target_id: TARGET_ID,
            company_id: COMPANY_A,
            details: { mode: 'email' },
        }));
    });

    test('T-foreign: returns 404 and sends no email for another company member', async () => {
        userService.getManagedUser.mockResolvedValue(null);

        const response = await request(makeApp({ companyId: COMPANY_B }))
            .post(`/api/users/${TARGET_ID}/reset-password`);

        expect(response.status).toBe(404);
        expect(keycloakService.sendUpdatePasswordEmail).not.toHaveBeenCalled();
        expect(auditService.log).not.toHaveBeenCalled();
    });
});
