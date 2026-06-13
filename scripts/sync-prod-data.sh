#!/usr/bin/env bash
# =============================================================================
# sync-prod-data.sh — Copy last 100 calls + 100 SMS from prod to local DB.
#
# Prerequisites: ssh access to the Vultr prod server, local PostgreSQL running
# with schema.
# Usage: ./scripts/sync-prod-data.sh
# =============================================================================
set -euo pipefail

PROD_SSH="${PROD_SSH:-deploy@108.61.87.117}"
PROD_APP_DIR="${PROD_APP_DIR:-/opt/albusto}"
PROD_SERVICE="${PROD_SERVICE:-app}"
DUMP_FILE="/tmp/crm-prod-export.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

info()  { echo -e "\033[1;34m→\033[0m $*"; }
ok()    { echo -e "\033[1;32m✓\033[0m $*"; }
fail()  { echo -e "\033[1;31m✗\033[0m $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Pre-flight
# ---------------------------------------------------------------------------
info "Pre-flight checks…"
command -v ssh  >/dev/null 2>&1 || fail "ssh not found"
command -v node >/dev/null 2>&1 || fail "node not found"
ssh "$PROD_SSH" "echo ok" >/dev/null 2>&1 \
  || fail "Cannot ssh to $PROD_SSH. Check your SSH key / access."
ok "Ready"

# ---------------------------------------------------------------------------
# 2. Export from prod (run export script on prod server via stdin)
# ---------------------------------------------------------------------------
info "Exporting from production…"
ssh "$PROD_SSH" "cd $PROD_APP_DIR && docker compose exec -T $PROD_SERVICE node -" \
  < "$SCRIPT_DIR/export-prod-data.js" > "$DUMP_FILE" 2>/dev/null
ok "Export saved to $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# ---------------------------------------------------------------------------
# 3. Import to local DB
# ---------------------------------------------------------------------------
info "Importing to local DB…"
node "$SCRIPT_DIR/import-local-data.js" < "$DUMP_FILE"
ok "Import complete"

# ---------------------------------------------------------------------------
# 4. Cleanup
# ---------------------------------------------------------------------------
rm -f "$DUMP_FILE"
ok "Temp file cleaned up"

echo ""
echo "Done! Open http://localhost:3001/pulse to see timelines."
