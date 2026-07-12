#!/bin/bash
# GOOGLE-SSO-FIX-001 + AUTH-IDP-LINK-001 — apply/refresh the Google identity
# provider on a RUNNING Keycloak.
#
# WHY THIS EXISTS
#   `--import-realm` only configures a realm on its FIRST import. Prod already has
#   the crm-prod realm, so edits to keycloak/realm-export.json never reach it.
#   This script talks to the live Admin REST API and is fully idempotent
#   (create-or-update), so it can be run against prod to (re)provision:
#     • the `google` OIDC identity provider (trustEmail, PKCE-friendly),
#     • given_name→firstName / family_name→lastName / email attribute mappers,
#     • the first-broker-login behavior for AUTH-IDP-LINK-001.
#
# AUTH-IDP-LINK-001 — link, never duplicate. When a Google sign-in's email matches
#   an existing account, the user must CONFIRM with their password (link), not get
#   a second account. This is exactly what the built-in "first broker login" flow
#   already does (Handle Existing Account → Confirm link → Username Password Form),
#   so the IdP binds THAT flow — NOT the old silent "auto link" flow (which linked
#   with no password and is now deprecated).
#   The one hole was the leading Review-Profile step: it showed an EDITABLE email,
#   so a user could change one digit to dodge the match and mint a duplicate
#   (prod: a5085140320 vs a5085150320). Fix = turn Review Profile OFF
#   (update.profile.on.first.login=off) so the trusted Google email is used as-is;
#   and make lastName OPTIONAL so an account without a family name still creates
#   without the review screen. firstName/email stay required.
#
# USAGE
#   KC_URL=https://auth.albusto.com \
#   KEYCLOAK_ADMIN_USER=admin KEYCLOAK_ADMIN_PASSWORD=... \
#   GOOGLE_IDP_CLIENT_ID=xxxx.apps.googleusercontent.com \
#   GOOGLE_IDP_CLIENT_SECRET=yyyy \
#   ./scripts/setup-google-idp.sh
#
# Google Cloud → Credentials → OAuth 2.0 Client (Web application) must list this
# authorized redirect URI:
#   ${KC_URL}/realms/${REALM}/broker/google/endpoint

set -euo pipefail

KC_URL="${KC_URL:-http://localhost:8080}"
REALM="${REALM:-crm-prod}"
KC_ADMIN="${KEYCLOAK_ADMIN_USER:-admin}"
KC_ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
CLIENT_ID="${GOOGLE_IDP_CLIENT_ID:-}"
CLIENT_SECRET="${GOOGLE_IDP_CLIENT_SECRET:-}"
# AUTH-IDP-LINK-001: bind the BUILT-IN first-broker-login flow (password on email
# match), not a custom silent auto-link flow.
FLOW_ALIAS="first broker login"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "❌ GOOGLE_IDP_CLIENT_ID and GOOGLE_IDP_CLIENT_SECRET are required." >&2
  exit 1
fi

api() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" "${KC_URL}/admin/realms/${REALM}${path}" \
      -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      -d "$body" -w $'\n%{http_code}'
  else
    curl -s -X "$method" "${KC_URL}/admin/realms/${REALM}${path}" \
      -H "Authorization: Bearer ${TOKEN}" -w $'\n%{http_code}'
  fi
}

echo "🔑 Authenticating as ${KC_ADMIN} on ${KC_URL} ..."
TOKEN=$(curl -s -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=admin-cli&username=${KC_ADMIN}&password=${KC_ADMIN_PASS}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
[ -n "$TOKEN" ] || { echo "❌ admin auth failed" >&2; exit 1; }
echo "✅ Got admin token"

# ── 1. First-broker-login behavior (AUTH-IDP-LINK-001) ──────────────────────
# We do NOT create a custom flow. The built-in "first broker login" already links
# on email match with a password confirmation. We only need to (a) turn OFF the
# Review-Profile screen (so the trusted Google email is used as-is — no editable
# field to dodge the match with), and (b) make lastName optional so a no-family-name
# Google account still creates without a review screen.
echo ""
echo "🔧 Configuring built-in 'first broker login' → Review Profile OFF ..."
RP_CFG_ID=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${KC_URL}/admin/realms/${REALM}/authentication/flows/first%20broker%20login/executions" \
  | python3 -c "import sys,json; print(next((e.get('authenticationConfig','') for e in json.load(sys.stdin) if e.get('providerId')=='idp-review-profile'), ''))")
if [ -n "$RP_CFG_ID" ]; then
  curl -s -X PUT "${KC_URL}/admin/realms/${REALM}/authentication/config/${RP_CFG_ID}" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d '{"id":"'"${RP_CFG_ID}"'","alias":"review profile config","config":{"update.profile.on.first.login":"off"}}' \
    -o /dev/null -w '   review-profile config → %{http_code}\n'
else
  echo "   ⚠️  idp-review-profile has no config resource; set update.profile.on.first.login=off in the console"
fi

echo "👤 Making lastName optional (Realm → User profile) ..."
curl -s -H "Authorization: Bearer ${TOKEN}" "${KC_URL}/admin/realms/${REALM}/users/profile" \
  | python3 - "$KC_URL" "$REALM" "$TOKEN" <<'PY'
import sys, json, urllib.request
prof = json.load(sys.stdin)
kc, realm, token = sys.argv[1:4]
changed = False
for a in prof.get("attributes", []):
    if a.get("name") == "lastName" and "required" in a:
        del a["required"]; changed = True
if changed:
    r = urllib.request.Request(f"{kc}/admin/realms/{realm}/users/profile",
        data=json.dumps(prof).encode(), method="PUT",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    urllib.request.urlopen(r); print("   lastName → optional")
else:
    print("   lastName already optional")
PY

# ── 2. Google identity provider (create or update) ──────────────────────────
echo ""
echo "🌐 Ensuring Google identity provider ..."
IDP_BODY=$(python3 - "$CLIENT_ID" "$CLIENT_SECRET" "$FLOW_ALIAS" <<'PY'
import sys, json
cid, secret, flow = sys.argv[1:4]
print(json.dumps({
  "alias": "google", "providerId": "google", "enabled": True,
  "trustEmail": True, "storeToken": False, "addReadTokenRoleOnCreate": False,
  "authenticateByDefault": False, "linkOnly": False, "hideOnLoginPage": False,
  "firstBrokerLoginFlowAlias": flow,
  "config": {"clientId": cid, "clientSecret": secret, "useJwksUrl": "true",
             "syncMode": "IMPORT", "defaultScope": "openid profile email"},
}))
PY
)

EXISTS_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  "${KC_URL}/admin/realms/${REALM}/identity-provider/instances/google")

if [ "$EXISTS_CODE" = "200" ]; then
  curl -s -X PUT "${KC_URL}/admin/realms/${REALM}/identity-provider/instances/google" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d "$IDP_BODY" -o /dev/null -w '   update IdP → %{http_code}\n'
else
  curl -s -X POST "${KC_URL}/admin/realms/${REALM}/identity-provider/instances" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d "$IDP_BODY" -o /dev/null -w '   create IdP → %{http_code}\n'
fi

# ── 3. Attribute mappers (given/family/email) ───────────────────────────────
echo ""
echo "🧩 Ensuring attribute mappers ..."
MAPPERS=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${KC_URL}/admin/realms/${REALM}/identity-provider/instances/google/mappers")

ensure_mapper() { # name claim user_attr
  local name="$1" claim="$2" attr="$3"
  local have
  have=$(echo "$MAPPERS" | python3 -c "import sys,json; print(any(m.get('name')=='${name}' for m in json.load(sys.stdin)))")
  if [ "$have" = "True" ]; then
    echo "   ⏭️  mapper '${name}' exists"
    return
  fi
  curl -s -X POST "${KC_URL}/admin/realms/${REALM}/identity-provider/instances/google/mappers" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d '{"name":"'"${name}"'","identityProviderAlias":"google","identityProviderMapper":"oidc-user-attribute-idp-mapper","config":{"syncMode":"INHERIT","claim":"'"${claim}"'","user.attribute":"'"${attr}"'"}}' \
    -o /dev/null -w "   + mapper '${name}' → %{http_code}\n"
}

ensure_mapper "email" "email" "email"
ensure_mapper "given name" "given_name" "firstName"
ensure_mapper "family name" "family_name" "lastName"

echo ""
echo "════════════════════════════════════════"
echo "✅ Google identity provider ready on realm '${REALM}'"
echo "   Broker redirect URI (must be in Google Cloud):"
echo "     ${KC_URL}/realms/${REALM}/broker/google/endpoint"
echo "════════════════════════════════════════"
