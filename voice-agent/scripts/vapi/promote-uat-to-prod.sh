#!/usr/bin/env bash
# ============================================================
# promote-uat-to-prod.sh — Promote UAT config to PROD
# ============================================================
# Usage: ./promote-uat-to-prod.sh
#
# ⚠️ PRODUCTION PROMOTION — Extra caution required.
# ============================================================
set -euo pipefail

echo "🚀 Promote UAT → PROD"
echo "======================"
echo ""
echo "⚠️  THIS IS A PRODUCTION PROMOTION"
echo "⚠️  Ensure UAT has been fully tested and verified"
echo ""

read -p "Have you completed all UAT acceptance tests? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Promotion cancelled — complete UAT testing first"
  exit 0
fi

echo ""
echo "Step 1: Verify UAT state"
echo "  Run: vapi auth switch <uat-account>"
echo "  Run: vapi assistant list"
echo "  Run: vapi phone list"
echo "  Confirm all entities match expected config"
echo ""

echo "Step 2: Record pre-promotion PROD state"
echo "  Run: vapi auth switch <prod-account>"
echo "  Run: vapi assistant list  → save output"
echo "  Run: vapi phone list      → save output"
echo "  Run: twilio phone-numbers:list -p abc-prod -o json > /tmp/prod-pre-promote-$(date +%Y%m%d).json"
echo ""

echo "Step 3: Switch to PROD account"
echo "  Run: vapi auth switch <prod-account>"
echo "  Run: vapi auth status  (confirm you're in PROD)"
echo ""

echo "Step 4: Create/update assistant in PROD"
echo "  Use the same config from config/vapi/assistants/entry_greeter.yaml"
echo "  Run: vapi assistant create  (or update existing)"
echo "  Note the PROD assistant ID"
echo ""

echo "Step 5: Create/update squad in PROD"
echo "  Reference the PROD assistant ID"
echo "  Create squad via Dashboard or API"
echo "  Note the PROD squad ID"
echo ""

echo "Step 6: Verify PROD phone number binding"
echo "  Run: vapi phone list"
echo "  Update phone number to point to PROD squad"
echo ""

echo "Step 7: Smoke test PROD"
echo "  Call the PROD number"
echo "  Verify greeting plays correctly"
echo "  Run: vapi call list"
echo ""

echo "Step 8: Update inventory and configs"
echo "  Update config/environments/prod.yaml with actual IDs"
echo "  Update config/twilio/numbers/inbound_number_inventory.yaml"
echo "  Commit changes"
echo ""

echo "Step 9: Monitor"
echo "  Run: twilio debugger:logs:list -p abc-prod --streaming"
echo "  Watch for errors during first 30 minutes"
echo ""

echo "✅ Production promotion checklist complete"
