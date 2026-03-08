#!/usr/bin/env bash
# ============================================================
# verify-number.sh — Verify Twilio number configuration
# ============================================================
# Usage: ./verify-number.sh -p <profile> [-n <number>]
# ============================================================
set -euo pipefail

PROFILE=""
NUMBER=""

usage() {
  echo "Usage: $0 -p <profile> [-n <phone-number-e164>]"
  echo ""
  echo "  -p  Twilio CLI profile (required, e.g. abc-dev)"
  echo "  -n  Phone number in E.164 format (optional, shows all if omitted)"
  echo ""
  echo "Examples:"
  echo "  $0 -p abc-dev"
  echo "  $0 -p abc-dev -n +16179927291"
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

if [[ -z "$PROFILE" ]]; then
  echo "❌ ERROR: -p <profile> is required"
  usage
fi

echo "🔍 Verifying numbers for profile: $PROFILE"
echo "---"

if [[ -n "$NUMBER" ]]; then
  echo "📞 Looking up number: $NUMBER"
  twilio phone-numbers:list -p "$PROFILE" -o json | \
    python3 -c "
import json, sys
data = json.load(sys.stdin)
for num in data:
    if num.get('phoneNumber') == '$NUMBER':
        print(json.dumps(num, indent=2))
        sys.exit(0)
print('❌ Number not found in this profile')
sys.exit(1)
"
else
  echo "📋 All numbers in profile '$PROFILE':"
  twilio phone-numbers:list -p "$PROFILE" -o json | \
    python3 -c "
import json, sys
data = json.load(sys.stdin)
for num in data:
    print(f\"  📞 {num.get('phoneNumber', 'N/A')}\")
    print(f\"     SID:          {num.get('sid', 'N/A')}\")
    print(f\"     Friendly:     {num.get('friendlyName', 'N/A')}\")
    print(f\"     Voice URL:    {num.get('voiceUrl', '(none)')}\")
    print(f\"     Voice App:    {num.get('voiceApplicationSid', '(none)')}\")
    print(f\"     Trunk:        {num.get('trunkSid', '(none)')}\")
    print()
"
fi
