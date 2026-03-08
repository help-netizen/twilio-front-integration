#!/usr/bin/env bash
# ============================================================
# promote-dev-to-uat.sh — Promote DEV config to UAT
# ============================================================
# Usage: ./promote-dev-to-uat.sh
#
# This script provides a checklist and commands for promoting
# Vapi entities from DEV to UAT. Since Vapi doesn't have
# built-in environment promotion, this is a guided process.
# ============================================================
set -euo pipefail

echo "🚀 Promote DEV → UAT"
echo "====================="
echo ""
echo "This is a guided promotion process. Follow each step."
echo ""

echo "Step 1: Verify DEV state"
echo "  Run: vapi assistant list"
echo "  Run: vapi phone list"
echo "  Confirm all entities are working correctly in DEV"
echo ""

echo "Step 2: Switch to UAT account"
echo "  Run: vapi auth switch <uat-account>"
echo "  Run: vapi auth status  (confirm you're in UAT)"
echo ""

echo "Step 3: Create/update assistant in UAT"
echo "  Use the same config from config/vapi/assistants/entry_greeter.yaml"
echo "  Run: vapi assistant create  (or update existing)"
echo "  Note the new assistant ID"
echo ""

echo "Step 4: Create/update squad in UAT"
echo "  Reference the UAT assistant ID in the squad config"
echo "  Create squad via Dashboard or API"
echo "  Note the new squad ID"
echo ""

echo "Step 5: Verify UAT phone number binding"
echo "  Run: vapi phone list"
echo "  Update phone number to point to UAT squad"
echo "  Run: vapi phone update <phone-id>"
echo ""

echo "Step 6: Test UAT"
echo "  Call the UAT number"
echo "  Verify greeting plays correctly"
echo "  Run: vapi call list  (confirm call appeared)"
echo ""

echo "Step 7: Update inventory"
echo "  Update config/environments/uat.yaml with actual IDs"
echo "  Commit changes"
echo ""

echo "✅ Promotion checklist complete"
