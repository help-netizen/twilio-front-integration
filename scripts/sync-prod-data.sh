#!/usr/bin/env bash
# =============================================================================
# sync-prod-data.sh — Copy last 100 calls + 100 SMS from prod to local DB.
#
# Prerequisites: fly CLI authenticated, local PostgreSQL running with schema.
# Usage: ./scripts/sync-prod-data.sh
# =============================================================================
set -euo pipefail

FLY_APP="abc-metrics"
DUMP_FILE="/tmp/crm-prod-export.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

info()  { echo -e "\033[1;34m→\033[0m $*"; }
ok()    { echo -e "\033[1;32m✓\033[0m $*"; }
fail()  { echo -e "\033[1;31m✗\033[0m $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Pre-flight
# ---------------------------------------------------------------------------
info "Pre-flight checks…"
command -v fly  >/dev/null 2>&1 || fail "fly CLI not found"
command -v node >/dev/null 2>&1 || fail "node not found"
fly ssh console -a "$FLY_APP" -C "echo ok" >/dev/null 2>&1 \
  || fail "Cannot ssh to $FLY_APP. Run: fly auth login"
ok "Ready"

# ---------------------------------------------------------------------------
# 2. Export from prod (run export script on prod server via stdin)
# ---------------------------------------------------------------------------
info "Exporting from production…"
fly ssh console -a "$FLY_APP" -C "node -" < "$SCRIPT_DIR/export-prod-data.js" > "$DUMP_FILE" 2>/dev/null
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
