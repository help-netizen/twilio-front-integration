#!/usr/bin/env bash
# ============================================================
# set-voice-url.sh — Update the voice webhook URL for a number
# ============================================================
# Usage: ./set-voice-url.sh -p <profile> -n <number/SID> -u <url>
# ============================================================
set -euo pipefail

PROFILE=""
NUMBER=""
URL=""
METHOD="POST"
DRY_RUN=false

usage() {
  echo "Usage: $0 -p <profile> -n <number-or-sid> -u <voice-url> [-m <method>] [--dry-run]"
  echo ""
  echo "  -p  Twilio CLI profile (required)"
  echo "  -n  Phone number (E.164) or SID (required)"
  echo "  -u  New voice URL (required)"
  echo "  -m  HTTP method (default: POST)"
  echo "  --dry-run  Show what would be done without making changes"
  echo ""
  echo "Example:"
  echo "  $0 -p abc-dev -n +16179927291 -u https://example.com/voice"
  exit 1
}

for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=true
  fi
done

while getopts "p:n:u:m:h" opt; do
  case $opt in
    p) PROFILE="$OPTARG" ;;
    n) NUMBER="$OPTARG" ;;
    u) URL="$OPTARG" ;;
    m) METHOD="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$PROFILE" || -z "$NUMBER" || -z "$URL" ]]; then
  echo "❌ ERROR: -p, -n, and -u are all required"
  usage
fi

# Validate URL is not localhost
if echo "$URL" | grep -qE "localhost|127\.0\.0\.1"; then
  echo "❌ ERROR: Cannot use localhost/127.0.0.1 as voice URL"
  echo "   Use a public tunnel (ngrok, cloudflared) instead"
  exit 1
fi

echo "🔧 Voice URL Update"
echo "   Profile:  $PROFILE"
echo "   Number:   $NUMBER"
echo "   New URL:  $URL"
echo "   Method:   $METHOD"
echo ""

# Show current state first
echo "📋 Current configuration:"
twilio phone-numbers:list -p "$PROFILE" -o json 2>/dev/null | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for num in data:
    pn = num.get('phoneNumber', '')
    sid = num.get('sid', '')
    if pn == '$NUMBER' or sid == '$NUMBER':
        print(f\"   Current Voice URL: {num.get('voiceUrl', '(none)')}\")
        print(f\"   Current Method:    {num.get('voiceMethod', '(none)')}\")
        break
" || echo "   ⚠️ Could not read current state"

echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo "🔶 DRY RUN — no changes made"
  echo "   Would run:"
  echo "   twilio phone-numbers:update $NUMBER -p $PROFILE --voice-url $URL --voice-method $METHOD"
  exit 0
fi

echo "⚠️  Updating voice URL..."
twilio phone-numbers:update "$NUMBER" \
  -p "$PROFILE" \
  --voice-url "$URL" \
  --voice-method "$METHOD"

echo ""
echo "✅ Voice URL updated successfully"
echo ""
echo "📝 IMPORTANT: Update the inventory file with this change:"
echo "   voice-agent/config/twilio/numbers/inbound_number_inventory.yaml"
