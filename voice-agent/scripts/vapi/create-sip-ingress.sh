#!/usr/bin/env bash
# ============================================================
# create-sip-ingress.sh — Create a Vapi SIP phone number resource
# ============================================================
# Usage: ./create-sip-ingress.sh -e <environment>
#
# Creates a SIP phone number resource in Vapi with:
#   - sipUri from environment config
#   - assistantId = null
#   - serverUrl pointing to Blanc runtime resolver
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/../../config"

ENV=""
DRY_RUN=false

usage() {
  echo "Usage: $0 -e <environment> [--dry-run]"
  echo ""
  echo "  -e  Environment (dev, uat, prod)"
  echo "  --dry-run  Show the API call without executing"
  echo ""
  echo "Example:"
  echo "  $0 -e dev"
  echo "  $0 -e prod --dry-run"
  exit 1
}

for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=true
  fi
done

while getopts "e:h" opt; do
  case $opt in
    e) ENV="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$ENV" ]]; then
  echo "❌ ERROR: -e <environment> is required"
  usage
fi

# Read SIP config
SIP_CONFIG="$CONFIG_DIR/vapi/sip_ingress/$ENV.yaml"
if [[ ! -f "$SIP_CONFIG" ]]; then
  echo "❌ ERROR: SIP config not found: $SIP_CONFIG"
  exit 1
fi

# Extract values from YAML
SIP_URI=$(python3 -c "
import yaml
with open('$SIP_CONFIG') as f:
    data = yaml.safe_load(f)
print(data['sip_ingress']['sipUri'])
")

SERVER_URL=$(python3 -c "
import yaml
with open('$SIP_CONFIG') as f:
    data = yaml.safe_load(f)
print(data['sip_ingress']['serverUrl'])
")

echo "🔧 Create Vapi SIP Ingress"
echo "   Environment:  $ENV"
echo "   SIP URI:      $SIP_URI"
echo "   Server URL:   $SERVER_URL"
echo "   Assistant ID: null (dynamic via runtime resolver)"
echo ""

# Check for VAPI_API_KEY
ENV_UPPER=$(echo "$ENV" | tr '[:lower:]' '[:upper:]')
API_KEY_VAR="VAPI_API_KEY_${ENV_UPPER}"
API_KEY="${!API_KEY_VAR:-${VAPI_API_KEY:-}}"

if [[ -z "$API_KEY" ]]; then
  echo "⚠️  No API key found in \$$API_KEY_VAR or \$VAPI_API_KEY"
  echo "   Set one of these environment variables and try again."
  exit 1
fi

PAYLOAD=$(cat <<EOF
{
  "provider": "vapi",
  "sipUri": "$SIP_URI",
  "assistantId": null,
  "serverUrl": "$SERVER_URL"
}
EOF
)

if [[ "$DRY_RUN" == true ]]; then
  echo "🔶 DRY RUN — would execute:"
  echo ""
  echo "curl -X POST https://api.vapi.ai/phone-number \\"
  echo "  -H 'Authorization: Bearer \$${API_KEY_VAR}' \\"
  echo "  -H 'Content-Type: application/json' \\"
  echo "  -d '$PAYLOAD'"
  exit 0
fi

echo "⚠️  Creating SIP phone number resource in Vapi..."
RESPONSE=$(curl -s -X POST https://api.vapi.ai/phone-number \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo ""
echo "📋 Response:"
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

# Extract the phone number ID
PHONE_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

if [[ -n "$PHONE_ID" ]]; then
  echo ""
  echo "✅ SIP ingress created successfully!"
  echo "   Phone Number ID: $PHONE_ID"
  echo ""
  echo "📝 Update $SIP_CONFIG with:"
  echo "   vapi_phone_number_id: \"$PHONE_ID\""
else
  echo ""
  echo "❌ Failed to create SIP ingress. Check the response above."
fi
