#!/usr/bin/env node
/**
 * Check the crm-web client scope & audience configuration
 * and add necessary realm-management permissions for user management
 */
const KC_URL = 'https://abc-keycloak.fly.dev';
const REALM = 'crm-prod';
const ADMIN_PASS = 'Kc-Admin-2026!';

async function main() {
    const tokenRes = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'password', client_id: 'admin-cli',
            username: 'admin', password: ADMIN_PASS,
        }),
    });
    const { access_token } = await tokenRes.json();
    const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    // 1. Get crm-web client
    const clientsRes = await fetch(`${KC_URL}/admin/realms/${REALM}/clients?clientId=crm-web`, { headers });
    const clients = await clientsRes.json();
    const crmWebClient = clients[0];
    console.log('crm-web client:');
    console.log(`  id: ${crmWebClient.id}`);
    console.log(`  fullScopeAllowed: ${crmWebClient.fullScopeAllowed}`);
    console.log(`  publicClient: ${crmWebClient.publicClient}`);

    // 2. Check scope mappings for crm-web
    const scopeRes = await fetch(`${KC_URL}/admin/realms/${REALM}/clients/${crmWebClient.id}/scope-mappings`, { headers });
    const scope = await scopeRes.json();
    console.log('\nScope mappings:', JSON.stringify(scope, null, 2));

    // 3. Get realm-management client
    const rmClientsRes = await fetch(`${KC_URL}/admin/realms/${REALM}/clients?clientId=realm-management`, { headers });
    const rmClients = await rmClientsRes.json();
    const rmClient = rmClients[0];
    console.log(`\nrealm-management client id: ${rmClient.id}`);

    // 4. Get all realm-management roles to understand what's available
    const rmRolesRes = await fetch(`${KC_URL}/admin/realms/${REALM}/clients/${rmClient.id}/roles`, { headers });
    const rmRoles = await rmRolesRes.json();
    console.log('\nAvailable realm-management roles:', rmRoles.map(r => r.name).join(', '));

    // 5. Check effective scope for crm-web → realm-management
    const effectiveRes = await fetch(
        `${KC_URL}/admin/realms/${REALM}/clients/${crmWebClient.id}/scope-mappings/clients/${rmClient.id}`,
        { headers }
    );
    const effective = await effectiveRes.json();
    console.log('\ncrm-web scope → realm-management client roles:', effective.map(r => r.name).join(', ') || 'NONE');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
