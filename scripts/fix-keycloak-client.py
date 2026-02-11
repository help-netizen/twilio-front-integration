#!/usr/bin/env python3
"""
Fix Keycloak client config for CRM testing.
Sets fullScopeAllowed=true, directAccessGrantsEnabled=true,
assigns owner_admin role to admin@crm.local, and verifies token.
"""
import urllib.request
import json
import base64
import sys

KC = 'http://localhost:8080'
REALM = 'crm-prod'

def api(method, path, data=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(f'{KC}{path}', body, headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        content = resp.read().decode()
        return resp.status, json.loads(content) if content else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def get_token():
    data = b'grant_type=password&client_id=admin-cli&username=admin&password=admin'
    req = urllib.request.Request(f'{KC}/realms/master/protocol/openid-connect/token', data)
    resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
    return resp['access_token']

print('1. Getting admin token...')
token = get_token()
print('   ✅ Got token')

# Find client UUID
print('2. Finding crm-web client...')
code, clients = api('GET', f'/admin/realms/{REALM}/clients?clientId=crm-web', token=token)
if not clients:
    print('   ❌ Client not found')
    sys.exit(1)
client_uuid = clients[0]['id']
print(f'   ✅ Client UUID: {client_uuid}')

# Update client: fullScopeAllowed=true, directAccessGrantsEnabled=true, publicClient=true
print('3. Updating client config...')
client_data = clients[0]
client_data['fullScopeAllowed'] = True
client_data['directAccessGrantsEnabled'] = True
client_data['publicClient'] = True
code, _ = api('PUT', f'/admin/realms/{REALM}/clients/{client_uuid}', data=client_data, token=token)
print(f'   {"✅" if code == 204 else "❌"} Update status: {code}')

# Find admin user
print('4. Finding admin@crm.local...')
code, users = api('GET', f'/admin/realms/{REALM}/users?username=admin@crm.local', token=token)
if not users:
    print('   ❌ User not found')
    sys.exit(1)
user_id = users[0]['id']
print(f'   ✅ User ID: {user_id}')

# Get owner_admin role
print('5. Getting owner_admin role...')
code, role = api('GET', f'/admin/realms/{REALM}/roles/owner_admin', token=token)
role_id = role['id']
print(f'   ✅ Role ID: {role_id}')

# Assign role to user
print('6. Assigning owner_admin to admin@crm.local...')
code, _ = api('POST', f'/admin/realms/{REALM}/users/{user_id}/role-mappings/realm',
              data=[{'id': role_id, 'name': 'owner_admin'}], token=token)
print(f'   {"✅" if code in (204, None) else "⚠️"} Assign status: {code}')

# Verify token now has roles
print('7. Verifying token has roles...')
data = b'grant_type=password&client_id=crm-web&username=admin@crm.local&password=admin123'
req = urllib.request.Request(f'{KC}/realms/{REALM}/protocol/openid-connect/token', data)
tok = json.loads(urllib.request.urlopen(req, timeout=10).read())['access_token']
payload = tok.split('.')[1]
payload += '=' * (4 - len(payload) % 4)
decoded = json.loads(base64.b64decode(payload))

realm_access = decoded.get('realm_access', {})
realm_roles = decoded.get('realm_roles', [])
print(f'   realm_access.roles: {realm_access.get("roles", "MISSING")}')
print(f'   realm_roles: {realm_roles or "MISSING"}')

all_roles = set()
if 'roles' in realm_access:
    all_roles.update(realm_access['roles'])
if realm_roles:
    all_roles.update(realm_roles)

if 'owner_admin' in all_roles:
    print('   ✅ owner_admin found in token!')
else:
    print('   ❌ owner_admin NOT in token')
    print(f'   All claims: {list(decoded.keys())}')

print('\n✅ Done!')
