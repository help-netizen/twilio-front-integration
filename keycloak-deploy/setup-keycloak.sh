#!/bin/bash
# Setup Keycloak realm, client and admin user for production
set -e

KC_URL="https://abc-keycloak.fly.dev"
REALM="crm-prod"
CLIENT_ID="crm-web"
ADMIN_EMAIL="office@bostonmasters.com"
ADMIN_PASSWORD="BostonMasters2026!"  # Initial password, user will be forced to change

# Get admin token
echo "🔑 Getting admin token..."
TOKEN=$(curl -s -X POST "$KC_URL/realms/master/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'username=admin' \
  -d 'password=Kc-Admin-2026!' \
  -d 'grant_type=password' \
  -d 'client_id=admin-cli' | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token','FAILED'))")

if [ "$TOKEN" = "FAILED" ] || [ -z "$TOKEN" ]; then
  echo "❌ Failed to get admin token"
  exit 1
fi
echo "✅ Admin token obtained"

# 1. Create realm
echo "🏢 Creating realm: $REALM..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$KC_URL/admin/realms" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"realm\": \"$REALM\",
    \"enabled\": true,
    \"displayName\": \"ABC Metrics CRM\",
    \"loginWithEmailAllowed\": true,
    \"duplicateEmailsAllowed\": false,
    \"registrationAllowed\": false,
    \"resetPasswordAllowed\": true,
    \"accessTokenLifespan\": 300,
    \"ssoSessionIdleTimeout\": 1800,
    \"ssoSessionMaxLifespan\": 36000
  }")

if [ "$HTTP_CODE" = "201" ]; then
  echo "✅ Realm created"
elif [ "$HTTP_CODE" = "409" ]; then
  echo "⚠️  Realm already exists, continuing..."
else
  echo "❌ Failed to create realm (HTTP $HTTP_CODE)"
  exit 1
fi

# 2. Create public client for SPA
echo "🖥️  Creating client: $CLIENT_ID..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$KC_URL/admin/realms/$REALM/clients" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"clientId\": \"$CLIENT_ID\",
    \"name\": \"CRM Web Application\",
    \"enabled\": true,
    \"publicClient\": true,
    \"directAccessGrantsEnabled\": true,
    \"standardFlowEnabled\": true,
    \"implicitFlowEnabled\": false,
    \"rootUrl\": \"https://abc-metrics.fly.dev\",
    \"baseUrl\": \"https://abc-metrics.fly.dev\",
    \"redirectUris\": [
      \"https://abc-metrics.fly.dev/*\",
      \"http://localhost:3003/*\",
      \"http://localhost:5173/*\"
    ],
    \"webOrigins\": [
      \"https://abc-metrics.fly.dev\",
      \"http://localhost:3003\",
      \"http://localhost:5173\"
    ],
    \"attributes\": {
      \"pkce.code.challenge.method\": \"S256\"
    },
    \"protocolMappers\": [
      {
        \"name\": \"realm-roles\",
        \"protocol\": \"openid-connect\",
        \"protocolMapper\": \"oidc-usermodel-realm-role-mapper\",
        \"consentRequired\": false,
        \"config\": {
          \"multivalued\": \"true\",
          \"claim.name\": \"realm_roles\",
          \"id.token.claim\": \"true\",
          \"access.token.claim\": \"true\",
          \"userinfo.token.claim\": \"true\"
        }
      }
    ]
  }")

if [ "$HTTP_CODE" = "201" ]; then
  echo "✅ Client created"
elif [ "$HTTP_CODE" = "409" ]; then
  echo "⚠️  Client already exists, continuing..."
else
  echo "❌ Failed to create client (HTTP $HTTP_CODE)"
  exit 1
fi

# 3. Create realm roles
echo "👥 Creating realm roles..."
for ROLE in super_admin company_admin company_member; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$KC_URL/admin/realms/$REALM/roles" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"name\": \"$ROLE\"}")
  if [ "$HTTP_CODE" = "201" ]; then
    echo "  ✅ Role '$ROLE' created"
  elif [ "$HTTP_CODE" = "409" ]; then
    echo "  ⚠️  Role '$ROLE' already exists"
  else
    echo "  ❌ Failed to create role '$ROLE' (HTTP $HTTP_CODE)"
  fi
done

# 4. Create super admin user
echo "👤 Creating super admin user: $ADMIN_EMAIL..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$KC_URL/admin/realms/$REALM/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"username\": \"$ADMIN_EMAIL\",
    \"email\": \"$ADMIN_EMAIL\",
    \"firstName\": \"Admin\",
    \"lastName\": \"Boston Masters\",
    \"enabled\": true,
    \"emailVerified\": true,
    \"credentials\": [{
      \"type\": \"password\",
      \"value\": \"$ADMIN_PASSWORD\",
      \"temporary\": false
    }]
  }")

if [ "$HTTP_CODE" = "201" ]; then
  echo "✅ User created"
elif [ "$HTTP_CODE" = "409" ]; then
  echo "⚠️  User already exists, continuing..."
else
  echo "❌ Failed to create user (HTTP $HTTP_CODE)"
fi

# 5. Assign super_admin role to the user
echo "🔐 Assigning super_admin role..."
# Get user ID
USER_ID=$(curl -s "$KC_URL/admin/realms/$REALM/users?email=$ADMIN_EMAIL" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; users=json.load(sys.stdin); print(users[0]['id'] if users else 'NOTFOUND')")

if [ "$USER_ID" = "NOTFOUND" ] || [ -z "$USER_ID" ]; then
  echo "❌ Could not find user ID"
  exit 1
fi
echo "  User ID: $USER_ID"

# Get role ID
ROLE_ID=$(curl -s "$KC_URL/admin/realms/$REALM/roles/super_admin" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','NOTFOUND'))")

echo "  Role ID: $ROLE_ID"

# Assign role
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$KC_URL/admin/realms/$REALM/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "[{\"id\": \"$ROLE_ID\", \"name\": \"super_admin\"}]")

if [ "$HTTP_CODE" = "204" ]; then
  echo "✅ super_admin role assigned"
else
  echo "⚠️  Role assignment returned HTTP $HTTP_CODE"
fi

echo ""
echo "========================================="
echo "✅ Keycloak setup complete!"
echo "========================================="
echo ""
echo "  Realm:    $REALM"
echo "  Client:   $CLIENT_ID"
echo "  Admin:    $ADMIN_EMAIL"
echo "  Password: $ADMIN_PASSWORD"
echo ""
echo "  Admin Console: $KC_URL/admin/master/console/"
echo "  Realm URL:     $KC_URL/realms/$REALM"
echo ""
