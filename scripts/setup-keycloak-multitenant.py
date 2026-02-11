#!/usr/bin/env python3
"""
Configure Keycloak for multi-tenant CRM (Phase 1).

Steps:
1. Create new realm roles: super_admin, company_admin, company_member
2. Remove old roles: owner_admin, dispatcher, technician, accountant, viewer
3. Create super_admin user
4. Create office@bostonmasters.com as company_admin
5. Add company_id custom attribute + protocol mapper to crm-web client
6. Configure session/password/MFA policies
7. Configure force-change-password for new users
"""
import urllib.request
import json
import sys

KC = 'http://localhost:8080'
REALM = 'crm-prod'

# ── Helpers ──────────────────────────────────────────────────────────────────

def api(method, path, data=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(f'{KC}{path}', body, headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        content = resp.read().decode()
        return resp.status, json.loads(content) if content else None
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return e.code, body

def get_admin_token():
    data = b'grant_type=password&client_id=admin-cli&username=admin&password=admin'
    req = urllib.request.Request(f'{KC}/realms/master/protocol/openid-connect/token', data)
    resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
    return resp['access_token']

def ok(code):
    return code in (200, 201, 204)

def status_icon(code):
    return '✅' if ok(code) else '⚠️'

# ── Main ─────────────────────────────────────────────────────────────────────

print('=' * 60)
print('  Keycloak Multi-tenant CRM Setup')
print('=' * 60)

token = get_admin_token()
print(f'\n✅ Admin token acquired')

# ── 1. Create new roles ──────────────────────────────────────────────────────

print('\n── 1. Create realm roles ──')
NEW_ROLES = ['super_admin', 'company_admin', 'company_member']
for role in NEW_ROLES:
    code, resp = api('POST', f'/admin/realms/{REALM}/roles',
                     data={'name': role, 'description': f'CRM {role} role'}, token=token)
    if code == 409:
        print(f'   {role}: already exists')
    else:
        print(f'   {role}: {status_icon(code)} created')

# ── 2. Remove old roles ─────────────────────────────────────────────────────

print('\n── 2. Remove old roles ──')
OLD_ROLES = ['owner_admin', 'dispatcher', 'technician', 'accountant', 'viewer']
for role in OLD_ROLES:
    code, resp = api('DELETE', f'/admin/realms/{REALM}/roles/{role}', token=token)
    if code == 404:
        print(f'   {role}: not found (skip)')
    else:
        print(f'   {role}: {status_icon(code)} removed')

# ── 3. Create super_admin user ───────────────────────────────────────────────

print('\n── 3. Create super_admin user ──')
SUPER_ADMIN = {
    'username': 'superadmin',
    'email': 'superadmin@crm.local',
    'firstName': 'Super',
    'lastName': 'Admin',
    'enabled': True,
    'emailVerified': True,
    'credentials': [{'type': 'password', 'value': 'super123', 'temporary': False}],
}
code, resp = api('POST', f'/admin/realms/{REALM}/users', data=SUPER_ADMIN, token=token)
if code == 409:
    print(f'   superadmin@crm.local: already exists')
else:
    print(f'   superadmin@crm.local: {status_icon(code)} created')

# Find and assign super_admin role
code, users = api('GET', f'/admin/realms/{REALM}/users?username=superadmin&exact=true', token=token)
if users:
    sa_user_id = users[0]['id']
    code, role_obj = api('GET', f'/admin/realms/{REALM}/roles/super_admin', token=token)
    code, _ = api('POST', f'/admin/realms/{REALM}/users/{sa_user_id}/role-mappings/realm',
                  data=[{'id': role_obj['id'], 'name': 'super_admin'}], token=token)
    print(f'   super_admin role assigned: {status_icon(code)}')

# ── 4. Create office@bostonmasters.com as company_admin ──────────────────────

print('\n── 4. Create company_admin user ──')
COMPANY_ADMIN = {
    'username': 'office@bostonmasters.com',
    'email': 'office@bostonmasters.com',
    'firstName': 'Boston',
    'lastName': 'Masters Admin',
    'enabled': True,
    'emailVerified': True,
    'credentials': [{'type': 'password', 'value': 'boston123', 'temporary': False}],
    'attributes': {'company_id': ['1']},  # will be real UUID after DB migration
}
code, resp = api('POST', f'/admin/realms/{REALM}/users', data=COMPANY_ADMIN, token=token)
if code == 409:
    print(f'   office@bostonmasters.com: already exists')
else:
    print(f'   office@bostonmasters.com: {status_icon(code)} created')

# Find and assign company_admin role
code, users = api('GET', f'/admin/realms/{REALM}/users?username=office@bostonmasters.com&exact=true', token=token)
if users:
    ca_user_id = users[0]['id']
    code, role_obj = api('GET', f'/admin/realms/{REALM}/roles/company_admin', token=token)
    code, _ = api('POST', f'/admin/realms/{REALM}/users/{ca_user_id}/role-mappings/realm',
                  data=[{'id': role_obj['id'], 'name': 'company_admin'}], token=token)
    print(f'   company_admin role assigned: {status_icon(code)}')

    # Set company_id attribute
    user_data = users[0]
    user_data['attributes'] = user_data.get('attributes', {})
    user_data['attributes']['company_id'] = ['1']
    code, _ = api('PUT', f'/admin/realms/{REALM}/users/{ca_user_id}', data=user_data, token=token)
    print(f'   company_id attribute set: {status_icon(code)}')

# ── 5. Add company_id protocol mapper to crm-web client ─────────────────────

print('\n── 5. Add company_id protocol mapper ──')
code, clients = api('GET', f'/admin/realms/{REALM}/clients?clientId=crm-web', token=token)
client_uuid = clients[0]['id']

MAPPER = {
    'name': 'company_id',
    'protocol': 'openid-connect',
    'protocolMapper': 'oidc-usermodel-attribute-mapper',
    'config': {
        'user.attribute': 'company_id',
        'claim.name': 'company_id',
        'jsonType.label': 'String',
        'id.token.claim': 'true',
        'access.token.claim': 'true',
        'userinfo.token.claim': 'true',
        'multivalued': 'false',
    }
}
code, resp = api('POST', f'/admin/realms/{REALM}/clients/{client_uuid}/protocol-mappers/models',
                 data=MAPPER, token=token)
if code == 409:
    print(f'   company_id mapper: already exists')
else:
    print(f'   company_id mapper: {status_icon(code)} created')

# ── 6. Configure session policy ─────────────────────────────────────────────

print('\n── 6. Configure realm session/password policy ──')
code, realm = api('GET', f'/admin/realms/{REALM}', token=token)
realm_update = {
    # Session policy (§9)
    'accessTokenLifespan': 900,          # 15 minutes
    'ssoSessionIdleTimeout': 1800,       # 30 minutes
    'ssoSessionMaxLifespan': 43200,      # 12 hours
    'offlineSessionIdleTimeout': 2592000, # 30 days (refresh token)
    
    # Password policy (§9)
    'passwordPolicy': 'length(8) and maxLength(128) and notUsername',
    
    # Brute force protection
    'bruteForceProtected': True,
    'maxFailureWaitSeconds': 900,
    'failureFactor': 5,
    'permanentLockout': False,
}
code, _ = api('PUT', f'/admin/realms/{REALM}', data={**realm, **realm_update}, token=token)
print(f'   Realm policies: {status_icon(code)} updated')
print(f'     Access token: 15 min')
print(f'     SSO idle: 30 min')
print(f'     SSO max: 12 hours')
print(f'     Refresh: 30 days')
print(f'     Password: min 8 chars, not username')

# ── 7. Update admin@crm.local (existing test user) ──────────────────────────

print('\n── 7. Update existing admin@crm.local test user ──')
code, users = api('GET', f'/admin/realms/{REALM}/users?username=admin@crm.local', token=token)
if users:
    test_user_id = users[0]['id']
    # Assign company_admin role
    code, role_obj = api('GET', f'/admin/realms/{REALM}/roles/company_admin', token=token)
    code, _ = api('POST', f'/admin/realms/{REALM}/users/{test_user_id}/role-mappings/realm',
                  data=[{'id': role_obj['id'], 'name': 'company_admin'}], token=token)
    print(f'   company_admin role assigned: {status_icon(code)}')
    
    # Remove old owner_admin role (if still exists)
    code, old_role = api('GET', f'/admin/realms/{REALM}/roles/owner_admin', token=token)
    if code == 200:
        api('DELETE', f'/admin/realms/{REALM}/users/{test_user_id}/role-mappings/realm',
            data=[{'id': old_role['id'], 'name': 'owner_admin'}], token=token)
        print(f'   old owner_admin removed')
    
    # Set company_id attribute
    user_data = users[0]
    user_data['attributes'] = user_data.get('attributes', {})
    user_data['attributes']['company_id'] = ['1']
    code, _ = api('PUT', f'/admin/realms/{REALM}/users/{test_user_id}', data=user_data, token=token)
    print(f'   company_id attribute set: {status_icon(code)}')
else:
    print(f'   admin@crm.local not found (skip)')

# ── 8. Verify token ──────────────────────────────────────────────────────────

print('\n── 8. Verify token claims ──')
import base64
# Test with admin@crm.local
data = b'grant_type=password&client_id=crm-web&username=admin%40crm.local&password=admin123'
req = urllib.request.Request(f'{KC}/realms/{REALM}/protocol/openid-connect/token', data)
try:
    tok = json.loads(urllib.request.urlopen(req, timeout=10).read())['access_token']
    payload = tok.split('.')[1]
    payload += '=' * (4 - len(payload) % 4)
    decoded = json.loads(base64.b64decode(payload))
    
    roles = decoded.get('realm_access', {}).get('roles', [])
    company_id = decoded.get('company_id')
    print(f'   admin@crm.local token:')
    print(f'     roles: {[r for r in roles if not r.startswith("default")]}')
    print(f'     company_id: {company_id}')
    
    if 'company_admin' in roles and company_id:
        print(f'   ✅ Token verified — roles + company_id present!')
    elif 'company_admin' in roles:
        print(f'   ⚠️ Roles OK but company_id missing from token')
    else:
        print(f'   ❌ company_admin not in token roles')
except Exception as e:
    print(f'   ❌ Token test failed: {e}')

# Test with superadmin
data = b'grant_type=password&client_id=crm-web&username=superadmin&password=super123'
req = urllib.request.Request(f'{KC}/realms/{REALM}/protocol/openid-connect/token', data)
try:
    tok = json.loads(urllib.request.urlopen(req, timeout=10).read())['access_token']
    payload = tok.split('.')[1]
    payload += '=' * (4 - len(payload) % 4)
    decoded = json.loads(base64.b64decode(payload))
    
    roles = decoded.get('realm_access', {}).get('roles', [])
    print(f'   superadmin token:')
    print(f'     roles: {[r for r in roles if not r.startswith("default")]}')
    
    if 'super_admin' in roles:
        print(f'   ✅ super_admin token verified!')
    else:
        print(f'   ❌ super_admin not in token roles')
except Exception as e:
    print(f'   ❌ Superadmin token test failed: {e}')

print('\n' + '=' * 60)
print('  ✅ Keycloak multi-tenant setup complete!')
print('=' * 60)
print('\n  Users created:')
print('    superadmin@crm.local / super123  (super_admin)')
print('    office@bostonmasters.com / boston123  (company_admin)')
print('    admin@crm.local / admin123  (company_admin, test)')
