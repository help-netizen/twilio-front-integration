const fetch = require('node-fetch') || global.fetch;

// Derive KC base from KEYCLOAK_REALM_URL (e.g. "https://host/realms/crm-prod" → "https://host")
const KC_BASE = process.env.KEYCLOAK_REALM_URL?.replace(/\/realms\/.*$/, '')
    || process.env.KEYCLOAK_URL
    || 'http://localhost:8080';
const REALM = process.env.KEYCLOAK_REALM
    || process.env.KEYCLOAK_REALM_URL?.match(/\/realms\/([^/]+)/)?.[1]
    || 'crm-prod';

// Fetch admin token using admin/admin from master realm
async function getAdminToken() {
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('client_id', 'admin-cli');
    params.append('username', 'admin');
    params.append('password', 'admin');

    const res = await fetch(`${KC_BASE}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
    });

    if (!res.ok) {
        throw new Error(`Failed to get Keycloak admin token: ${res.statusText}`);
    }

    const data = await res.json();
    return data.access_token;
}

/**
 * Ensure user exists in Keycloak. If not, create them.
 * Also execute required actions (e.g. UPDATE_PASSWORD email).
 */
async function ensureUserExistsAndExecuteAction({ email, firstName, lastName, companyId }) {
    const token = await getAdminToken();
    
    // 1. Check if user exists
    const searchRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/users?email=${encodeURIComponent(email)}&exact=true`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const users = await searchRes.json();
    
    let userId;

    if (users && users.length > 0) {
        userId = users[0].id;
        console.log(`[Keycloak] User ${email} already exists (${userId})`);
    } else {
        // 2. Create user
        const createRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/users`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
                username: email,
                email: email,
                firstName: firstName || '',
                lastName: lastName || '',
                enabled: true,
                emailVerified: true,
                attributes: companyId ? { company_id: [companyId] } : {}
            })
        });

        if (!createRes.ok && createRes.status !== 409) {
            const errBody = await createRes.text();
            throw new Error(`Failed to create Keycloak user: ${errBody}`);
        }

        // Get the ID of the newly created user
        const newSearchRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/users?email=${encodeURIComponent(email)}&exact=true`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const newUsers = await newSearchRes.json();
        userId = newUsers[0].id;
        console.log(`[Keycloak] User ${email} created (${userId})`);
    }

    // If user existed, we still want to ensure their company_id is set
    if (companyId) {
        const userObj = users && users.length > 0 ? users[0] : null;
        if (userObj) {
            userObj.attributes = userObj.attributes || {};
            if (!userObj.attributes.company_id || userObj.attributes.company_id[0] !== companyId) {
                userObj.attributes.company_id = [companyId];
                await fetch(`${KC_BASE}/admin/realms/${REALM}/users/${userId}`, {
                    method: 'PUT',
                    headers: { 
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify(userObj)
                });
                console.log(`[Keycloak] Updated company_id mapping for existing user ${email}`);
            }
        }
    }

    // 3. Set temporary password so they can log in
    await fetch(`${KC_BASE}/admin/realms/${REALM}/users/${userId}/reset-password`, {
        method: 'PUT',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({
            type: 'password',
            value: 'admin123', // Hardcoded bootstrap password
            temporary: true    // Forces them to change it
        })
    });

    return { id: userId, email };
}

/**
 * Assign a realm role to a user.
 */
async function assignGlobalRole(userId, roleName) {
    const token = await getAdminToken();

    // 1. Get role ID
    const roleRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/roles/${roleName}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!roleRes.ok) {
        console.warn(`[Keycloak] Role ${roleName} not found, skipping assignment`);
        return;
    }
    
    const roleObj = await roleRes.json();

    // 2. Assign to user
    const assignRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/users/${userId}/role-mappings/realm`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify([
            {
                id: roleObj.id,
                name: roleObj.name
            }
        ])
    });

    if (!assignRes.ok) {
        const errBody = await assignRes.text();
        throw new Error(`Failed to assign role ${roleName}: ${errBody}`);
    }

    console.log(`[Keycloak] Role ${roleName} assigned to user ${userId}`);
}

/**
 * Reset a user's password in Keycloak.
 * @param {string} keycloakUserId - The Keycloak user ID (keycloak_sub from crm_users)
 * @param {string} newPassword - The new password to set
 * @param {boolean} temporary - If true, user must change on next login
 */
async function resetUserPassword(keycloakUserId, newPassword, temporary = true) {
    const token = await getAdminToken();
    const res = await fetch(`${KC_BASE}/admin/realms/${REALM}/users/${keycloakUserId}/reset-password`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: 'password',
            value: newPassword,
            temporary
        })
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to reset password: ${res.status} ${body}`);
    }
}

/**
 * Generate a random temporary password (12 chars, no ambiguous characters).
 */
function generateTempPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 12; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

module.exports = {
    ensureUserExistsAndExecuteAction,
    assignGlobalRole,
    resetUserPassword,
    generateTempPassword,
    getAdminToken
};
