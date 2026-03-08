#!/usr/bin/env bash
# ============================================================
# rollback-voice-url.sh — Restore voice URL to last-known-good
# ============================================================
# Usage: ./rollback-voice-url.sh -p <profile> -n <number/SID>
#
# Reads the last-known-good URL from the inventory file and
# restores it. Always shows current state before and after.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY_FILE="$SCRIPT_DIR/../../config/twilio/numbers/inbound_number_inventory.yaml"

PROFILE=""
NUMBER=""

usage() {
  echo "Usage: $0 -p <profile> -n <number-or-sid>"
  echo ""
  echo "  -p  Twilio CLI profile (required)"
  echo "  -n  Phone number (E.164) or SID (required)"
  echo ""
  echo "Reads last-known-good URL from:"
  echo "  $INVENTORY_FILE"
  exit 1
}

while getopts "p:n:h" opt; do
  case $opt in
    p) PROFILE="$OPTARG" ;;
    n) NUMBER="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$PROFILE" || -z "$NUMBER" ]]; then
  echo "❌ ERROR: -p and -n are required"
  usage
fi

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "❌ ERROR: Inventory file not found: $INVENTORY_FILE"
  echo "   Cannot determine last-known-good URL"
  exit 1
fi

# Read last-known-good from inventory
LAST_GOOD_URL=$(python3 -c "
import yaml, sys
with open('$INVENTORY_FILE') as f:
    data = yaml.safe_load(f)
url = data.get('last_known_good', {}).get('voice_url', '')
if not url:
    print('', end='')
else:
    print(url, end='')
" 2>/dev/null || echo "")

if [[ -z "$LAST_GOOD_URL" ]]; then
  echo "❌ ERROR: No last-known-good URL found in inventory file"
  echo "   Please update $INVENTORY_FILE with a valid voice_url"
  exit 1
fi

echo "🔄 Rollback Voice URL"
echo "   Profile:           $PROFILE"
echo "   Number:            $NUMBER"
echo "   Rollback to:       $LAST_GOOD_URL"
echo ""

# Show current state
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
        break
" || echo "   ⚠️ Could not read current state"

echo ""
read -p "Proceed with rollback? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Rollback cancelled"
  exit 0
fi

echo "⚠️  Rolling back..."
twilio phone-numbers:update "$NUMBER" \
  -p "$PROFILE" \
  --voice-url "$LAST_GOOD_URL" \
  --voice-method POST

echo ""
echo "✅ Rollback complete"
echo ""

# Verify
echo "📋 Verification:"
twilio phone-numbers:list -p "$PROFILE" -o json | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for num in data:
    pn = num.get('phoneNumber', '')
    sid = num.get('sid', '')
    if pn == '$NUMBER' or sid == '$NUMBER':
        print(f\"   Voice URL: {num.get('voiceUrl', '(none)')}\")
        break
"
