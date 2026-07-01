#!/bin/bash
# GOOGLE-SSO-FIX-001 — apply/refresh the Google identity provider on a RUNNING Keycloak.
#
# WHY THIS EXISTS
#   `--import-realm` only configures a realm on its FIRST import. Prod already has
#   the crm-prod realm, so edits to keycloak/realm-export.json never reach it.
#   This script talks to the live Admin REST API and is fully idempotent
#   (create-or-update), so it can be run against prod to (re)provision:
#     • the `google` OIDC identity provider (trustEmail, PKCE-friendly),
#     • given_name→firstName / family_name→lastName / email attribute mappers,
#     • a "first broker login auto link" flow that auto-links a Google identity to
#       an existing account when the email is verified (no manual-link prompt).
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
FLOW_ALIAS="first broker login auto link"
FLOW_ENC="first%20broker%20login%20auto%20link"

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

# ── 1. First-broker-login auto-link flow ────────────────────────────────────
echo ""
echo "🔗 Ensuring auth flow '${FLOW_ALIAS}' ..."
FLOWS=$(curl -s -H "Authorization: Bearer ${TOKEN}" "${KC_URL}/admin/realms/${REALM}/authentication/flows")
FLOW_EXISTS=$(echo "$FLOWS" | python3 -c "import sys,json; print(any(f.get('alias')=='${FLOW_ALIAS}' for f in json.load(sys.stdin)))")

if [ "$FLOW_EXISTS" = "True" ]; then
  echo "   ⏭️  flow already exists"
else
  curl -s -X POST "${KC_URL}/admin/realms/${REALM}/authentication/flows" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d '{"alias":"'"${FLOW_ALIAS}"'","description":"GOOGLE-SSO-FIX-001 auto-link on verified email","providerId":"basic-flow","topLevel":true,"builtIn":false}' \
    -o /dev/null -w '   create flow → %{http_code}\n'

  # Append executions (they land as REQUIRED/DISABLED; we set requirements next).
  for PROVIDER in idp-review-profile idp-create-user-if-unique idp-auto-link; do
    curl -s -X POST "${KC_URL}/admin/realms/${REALM}/authentication/flows/${FLOW_ENC}/executions/execution" \
      -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      -d '{"provider":"'"${PROVIDER}"'"}' \
      -o /dev/null -w "   + ${PROVIDER} → %{http_code}\n"
  done

  # Set requirements: review-profile DISABLED, the other two ALTERNATIVE.
  EXECS=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
    "${KC_URL}/admin/realms/${REALM}/authentication/flows/${FLOW_ENC}/executions")
  echo "$EXECS" | python3 - "$KC_URL" "$REALM" "$TOKEN" "$FLOW_ENC" <<'PY'
import sys, json, urllib.request
execs = json.load(sys.stdin)
kc, realm, token, flow_enc = sys.argv[1:5]
want = {"idp-review-profile": "DISABLED",
        "idp-create-user-if-unique": "ALTERNATIVE",
        "idp-auto-link": "ALTERNATIVE"}
for e in execs:
    req = want.get(e.get("providerId"))
    if not req:
        continue
    e["requirement"] = req
    body = json.dumps(e).encode()
    r = urllib.request.Request(
        f"{kc}/admin/realms/{realm}/authentication/flows/{flow_enc}/executions",
        data=body, method="PUT",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    urllib.request.urlopen(r)
    print(f"   set {e['providerId']} → {req}")
PY
  echo "   ✅ flow configured"
fi

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
