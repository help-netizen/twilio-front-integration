#!/usr/bin/env node
/**
 * ALB-106a — create the platform super admin account.
 *
 * Creates a Keycloak user (temp password, forced change on first login) and a
 * crm_users row with platform_role='super_admin' and NO tenant memberships.
 *
 * Usage:
 *   DATABASE_URL=... KEYCLOAK_REALM_URL=... KEYCLOAK_ADMIN_USER=... \
 *   KEYCLOAK_ADMIN_PASSWORD=... node backend/scripts/create-platform-admin.js \
 *     --email admin@albusto.com --name "Albusto Platform Admin"
 */

const { Client } = require('pg');
const crypto = require('crypto');

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
}

const EMAIL = arg('email');
const NAME = arg('name', 'Platform Admin');
if (!EMAIL) { console.error('Usage: --email <email> [--name "Full Name"]'); process.exit(1); }

const KC_BASE = process.env.KEYCLOAK_REALM_URL?.replace(/\/realms\/.*$/, '');
const REALM = process.env.KEYCLOAK_REALM || 'crm-prod';

async function kcToken() {
    const res = await fetch(`${KC_BASE}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'password', client_id: 'admin-cli',
            username: process.env.KEYCLOAK_ADMIN_USER || 'admin',
            password: process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin',
        }),
    });
    if (!res.ok) throw new Error(`KC auth failed: ${res.status}`);
    return (await res.json()).access_token;
}

(async () => {
    const tempPassword = crypto.randomBytes(9).toString('base64url') + 'A1!';
    const token = await kcToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 1. Keycloak user (idempotent)
    let kcUser = (await (await fetch(
        `${KC_BASE}/admin/realms/${REALM}/users?email=${encodeURIComponent(EMAIL)}&exact=true`,
        { headers: auth }
    )).json())[0];

    if (!kcUser) {
        const createRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/users`, {
            method: 'POST', headers: auth,
            body: JSON.stringify({
                username: EMAIL, email: EMAIL, enabled: true, emailVerified: true,
                firstName: NAME.split(' ')[0], lastName: NAME.split(' ').slice(1).join(' '),
                credentials: [{ type: 'password', value: tempPassword, temporary: true }],
                requiredActions: ['UPDATE_PASSWORD'],
            }),
        });
        if (!createRes.ok) throw new Error(`KC create failed: ${createRes.status} ${await createRes.text()}`);
        kcUser = (await (await fetch(
            `${KC_BASE}/admin/realms/${REALM}/users?email=${encodeURIComponent(EMAIL)}&exact=true`,
            { headers: auth }
        )).json())[0];
        console.log(`Keycloak user created: ${kcUser.id}`);
        console.log(`TEMP PASSWORD (change on first login): ${tempPassword}`);
    } else {
        console.log(`Keycloak user already exists: ${kcUser.id} (password unchanged)`);
    }

    // 2. crm_users with platform_role, no memberships
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const { rows } = await db.query(
        `INSERT INTO crm_users (keycloak_sub, email, full_name, role, platform_role, status)
         VALUES ($1, $2, $3, 'company_member', 'super_admin', 'active')
         ON CONFLICT (keycloak_sub) DO UPDATE SET platform_role = 'super_admin', updated_at = now()
         RETURNING id, email, platform_role`,
        [kcUser.id, EMAIL, NAME]
    );
    console.log('crm_users:', rows[0]);

    const { rows: mem } = await db.query(
        `SELECT COUNT(*) AS n FROM company_memberships WHERE user_id = $1`, [rows[0].id]
    );
    if (parseInt(mem[0].n, 10) > 0) {
        console.warn(`⚠ user has ${mem[0].n} tenant membership(s) — platform admin must have none (PF007).`);
    }
    await db.end();
    console.log('Done.');
})().catch(err => { console.error(err.message); process.exit(1); });
