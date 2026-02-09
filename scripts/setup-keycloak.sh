#!/bin/bash
# Keycloak Local Setup Script
# Configures realm crm-prod, client crm-web, roles, and a test user
# via Keycloak Admin REST API

set -e

KC_URL="http://localhost:8080"
KC_ADMIN="admin"
KC_ADMIN_PASS="admin"
REALM="crm-prod"
CLIENT_ID="crm-web"
REDIRECT_URI="http://localhost:3001/*"

echo "🔑 Getting admin access token..."
ADMIN_TOKEN=$(curl -s -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=admin-cli&username=${KC_ADMIN}&password=${KC_ADMIN_PASS}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

if [ -z "$ADMIN_TOKEN" ]; then
  echo "❌ Failed to get admin token. Is Keycloak running?"
  exit 1
fi
echo "✅ Got admin token"

# ── 1. Create realm ──
echo ""
echo "🏗️  Creating realm '${REALM}'..."
REALM_EXISTS=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${KC_URL}/admin/realms/${REALM}")

if [ "$REALM_EXISTS" = "200" ]; then
  echo "   Realm already exists, skipping"
else
  curl -s -X POST "${KC_URL}/admin/realms" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{
      "realm": "'"${REALM}"'",
      "enabled": true,
      "registrationAllowed": false,
      "resetPasswordAllowed": true,
      "verifyEmail": false,
      "loginWithEmailAllowed": true,
      "duplicateEmailsAllowed": false,
      "rememberMe": false,
      "ssoSessionIdleTimeout": 1800,
      "ssoSessionMaxLifespan": 36000,
      "accessTokenLifespan": 300,
      "revokeRefreshToken": true,
      "refreshTokenMaxReuse": 0,
      "bruteForceProtected": true,
      "maxFailureWaitSeconds": 900,
      "minimumQuickLoginWaitSeconds": 60,
      "waitIncrementSeconds": 60,
      "maxDeltaTimeSeconds": 43200,
      "failureFactor": 8,
      "eventsEnabled": true,
      "adminEventsEnabled": true,
      "adminEventsDetailsEnabled": true,
      "eventsExpiration": 7776000
    }'
  echo "✅ Realm '${REALM}' created"
fi

# ── 2. Create realm roles ──
echo ""
echo "🎭 Creating CRM roles..."
for ROLE in owner_admin dispatcher technician accountant viewer; do
  ROLE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "${KC_URL}/admin/realms/${REALM}/roles" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"name":"'"${ROLE}"'","description":"CRM role: '"${ROLE}"'"}')
  
  if [ "$ROLE_CODE" = "201" ]; then
    echo "   ✅ Role '${ROLE}' created"
  elif [ "$ROLE_CODE" = "409" ]; then
    echo "   ⏭️  Role '${ROLE}' already exists"
  else
    echo "   ⚠️  Role '${ROLE}' returned code ${ROLE_CODE}"
  fi
done

# ── 3. Create OIDC client ──
echo ""
echo "🔐 Creating client '${CLIENT_ID}'..."
CLIENT_EXISTS=$(curl -s \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${KC_URL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))")

if [ "$CLIENT_EXISTS" != "0" ]; then
  echo "   Client already exists, skipping"
  CLIENT_UUID=$(curl -s \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${KC_URL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
else
  CLIENT_CREATE_RESP=$(curl -s -X POST "${KC_URL}/admin/realms/${REALM}/clients" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{
      "clientId": "'"${CLIENT_ID}"'",
      "name": "CRM Web Application",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": true,
      "implicitFlowEnabled": false,
      "serviceAccountsEnabled": false,
      "redirectUris": ["'"${REDIRECT_URI}"'", "http://localhost:3000/*"],
      "webOrigins": ["http://localhost:3001", "http://localhost:3000"],
      "fullScopeAllowed": false,
      "attributes": {
        "pkce.code.challenge.method": "S256"
      }
    }' -w '\n%{http_code}')
  
  HTTP_CODE=$(echo "$CLIENT_CREATE_RESP" | tail -1)
  if [ "$HTTP_CODE" = "201" ]; then
    echo "   ✅ Client '${CLIENT_ID}' created"
  else
    echo "   ⚠️  Client creation returned: ${HTTP_CODE}"
    echo "$CLIENT_CREATE_RESP"
  fi
  
  CLIENT_UUID=$(curl -s \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${KC_URL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
fi

echo "   Client UUID: ${CLIENT_UUID}"

# Get client secret
CLIENT_SECRET=$(curl -s \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${KC_URL}/admin/realms/${REALM}/clients/${CLIENT_UUID}/client-secret" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('value',''))")
echo "   Client Secret: ${CLIENT_SECRET}"

# ── 4. Add role mappers to client ──
echo ""
echo "📋 Adding protocol mappers..."
# Realm roles mapper
curl -s -X POST "${KC_URL}/admin/realms/${REALM}/clients/${CLIENT_UUID}/protocol-mappers/models" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "realm roles",
    "protocol": "openid-connect",
    "protocolMapper": "oidc-usermodel-realm-role-mapper",
    "config": {
      "multivalued": "true",
      "claim.name": "realm_access.roles",
      "jsonType.label": "String",
      "id.token.claim": "true",
      "access.token.claim": "true",
      "userinfo.token.claim": "true"
    }
  }' -o /dev/null -w '%{http_code}' && echo " realm roles mapper done"

# ── 5. Create test user ──
echo ""
echo "👤 Creating test user..."
TEST_USER_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "${KC_URL}/admin/realms/${REALM}/users" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin@crm.local",
    "email": "admin@crm.local",
    "firstName": "CRM",
    "lastName": "Admin",
    "enabled": true,
    "emailVerified": true,
    "credentials": [{
      "type": "password",
      "value": "admin123",
      "temporary": false
    }]
  }')

if [ "$TEST_USER_CODE" = "201" ]; then
  echo "   ✅ Test user 'admin@crm.local' created (password: admin123)"
elif [ "$TEST_USER_CODE" = "409" ]; then
  echo "   ⏭️  Test user already exists"
else
  echo "   ⚠️  User creation returned: ${TEST_USER_CODE}"
fi

# Assign owner_admin role to test user
TEST_USER_ID=$(curl -s \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${KC_URL}/admin/realms/${REALM}/users?username=admin@crm.local" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")

if [ -n "$TEST_USER_ID" ]; then
  ROLE_ID=$(curl -s \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${KC_URL}/admin/realms/${REALM}/roles/owner_admin" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  
  curl -s -X POST \
    "${KC_URL}/admin/realms/${REALM}/users/${TEST_USER_ID}/role-mappings/realm" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '[{"id":"'"${ROLE_ID}"'","name":"owner_admin"}]'
  echo "   ✅ Assigned 'owner_admin' role to test user"
fi

# ── Summary ──
echo ""
echo "════════════════════════════════════════"
echo "✅ Keycloak Setup Complete!"
echo "════════════════════════════════════════"
echo ""
echo "  Keycloak Admin:  ${KC_URL}/admin"
echo "  Realm:           ${REALM}"
echo "  Client ID:       ${CLIENT_ID}"
echo "  Client Secret:   ${CLIENT_SECRET}"
echo "  OIDC Issuer:     ${KC_URL}/realms/${REALM}"
echo ""
echo "  Test User:       admin@crm.local"
echo "  Test Password:   admin123"
echo "  Test Role:       owner_admin"
echo ""
echo "  Add to .env:"
echo "    FEATURE_AUTH_ENABLED=true"
echo "    KEYCLOAK_REALM_URL=${KC_URL}/realms/${REALM}"
echo "    KEYCLOAK_CLIENT_ID=${CLIENT_ID}"
echo "    KEYCLOAK_CLIENT_SECRET=${CLIENT_SECRET}"
echo ""
