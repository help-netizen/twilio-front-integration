'use strict';

process.env.KEYCLOAK_REALM_URL = 'https://keycloak.example.test/realms/test-realm';
process.env.KEYCLOAK_REALM = 'test-realm';
process.env.KEYCLOAK_ADMIN_USER = 'configured-admin';
process.env.KEYCLOAK_ADMIN_PASSWORD = 'configured-password';

jest.mock('node-fetch', () => jest.fn());

const fetch = require('node-fetch');
const keycloakService = require('../backend/src/services/keycloakService');

const USER_ID = 'kc-user-id';
const currentUser = {
    id: USER_ID,
    username: 'old@example.test',
    email: 'old@example.test',
    firstName: 'Old',
    lastName: 'Name',
    enabled: true,
    emailVerified: true,
    attributes: { company_id: ['company-a'] },
    requiredActions: ['CONFIGURE_TOTP'],
};

function tokenResponse() {
    return {
        ok: true,
        json: async () => ({ access_token: 'admin-token' }),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

test('inspectUserIdentity reads the Keycloak user and federated identity links', async () => {
    fetch
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...currentUser }) })
        .mockResolvedValueOnce({
            ok: true,
            json: async () => [{ identityProvider: 'google', userId: 'google-id' }],
        });

    const result = await keycloakService.inspectUserIdentity(USER_ID);

    expect(result).toEqual({
        user: currentUser,
        federatedIdentities: [{ identityProvider: 'google', userId: 'google-id' }],
    });
    expect(fetch.mock.calls[0][0]).toBe(
        'https://keycloak.example.test/realms/master/protocol/openid-connect/token'
    );
    const tokenBody = fetch.mock.calls[0][1].body;
    expect(tokenBody.get('username')).toBe('configured-admin');
    expect(tokenBody.get('password')).toBe('configured-password');
    expect(fetch.mock.calls[1][0]).toBe(
        `https://keycloak.example.test/admin/realms/test-realm/users/${USER_ID}`
    );
    expect(fetch.mock.calls[2][0]).toBe(
        `https://keycloak.example.test/admin/realms/test-realm/users/${USER_ID}/federated-identity`
    );
});

test('realmLoginIsInUse checks exact email and username while excluding the target identity', async () => {
    fetch
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce({
            ok: true,
            json: async () => [{ id: USER_ID }],
        })
        .mockResolvedValueOnce({
            ok: true,
            json: async () => [{ id: 'different-user-id' }],
        });

    await expect(
        keycloakService.realmLoginIsInUse('new+login@example.test', USER_ID)
    ).resolves.toBe(true);

    expect(fetch.mock.calls[1][0]).toBe(
        'https://keycloak.example.test/admin/realms/test-realm/users?email=new%2Blogin%40example.test&exact=true'
    );
    expect(fetch.mock.calls[2][0]).toBe(
        'https://keycloak.example.test/admin/realms/test-realm/users?username=new%2Blogin%40example.test&exact=true'
    );
});

test('updateUserIdentity changes the login, splits the name, and invalidates old email verification', async () => {
    fetch
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce({ ok: true });

    await keycloakService.updateUserIdentity(USER_ID, currentUser, {
        email: 'new@example.test',
        full_name: 'New Full Name',
        reset_email_verification: true,
    });

    expect(fetch.mock.calls[1][0]).toBe(
        `https://keycloak.example.test/admin/realms/test-realm/users/${USER_ID}`
    );
    expect(fetch.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
        username: 'new@example.test',
        email: 'new@example.test',
        firstName: 'New',
        lastName: 'Full Name',
        enabled: true,
        emailVerified: false,
        attributes: { company_id: ['company-a'] },
        requiredActions: ['CONFIGURE_TOTP', 'VERIFY_EMAIL'],
    });
});

test('updateUserIdentity surfaces a Keycloak 409 as a login-identity conflict', async () => {
    fetch
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce({ ok: false, status: 409 });

    await expect(keycloakService.updateUserIdentity(USER_ID, currentUser, {
        email: 'already-used@example.test',
        reset_email_verification: true,
    })).rejects.toMatchObject({
        code: 'KEYCLOAK_IDENTITY_CONFLICT',
        status: 409,
    });
});
