#!/usr/bin/env bash
# =============================================================================
# restart.sh — Git commit + restart all local services
# =============================================================================
# Quick restart: commits changes, restarts keycloak/backend/frontend
#
# Usage:
#   ./scripts/restart.sh              # Commit + restart all
#   ./scripts/restart.sh --no-commit  # Restart only, skip git commit
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_PORT=3000
FRONTEND_PORT=3001
PIDS=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[restart]${NC} $1"; }
warn() { echo -e "${YELLOW}[restart]${NC} $1"; }
error(){ echo -e "${RED}[restart]${NC} $1"; }

# Cleanup on exit
cleanup() {
    log "Shutting down..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    lsof -ti:$BACKEND_PORT | xargs kill 2>/dev/null || true
    lsof -ti:$FRONTEND_PORT | xargs kill 2>/dev/null || true
    log "Done."
}
trap cleanup EXIT INT TERM

# Parse args
SKIP_COMMIT=false
for arg in "$@"; do
    case $arg in
        --no-commit) SKIP_COMMIT=true ;;
    esac
done

cd "$PROJECT_DIR"

# =============================================================================
# Step 1: Git commit
# =============================================================================
if [ "$SKIP_COMMIT" = false ]; then
    TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
    git add -A
    if git diff --cached --quiet; then
        warn "No changes to commit"
    else
        git commit -m "wip: auto-commit $TIMESTAMP"
        log "Committed changes at $TIMESTAMP"
    fi
fi

# =============================================================================
# Step 2: Kill existing processes
# =============================================================================
log "Stopping existing processes..."
lsof -ti:$BACKEND_PORT | xargs kill 2>/dev/null || true
lsof -ti:$FRONTEND_PORT | xargs kill 2>/dev/null || true
sleep 1

# =============================================================================
# Step 3: Start backend
# =============================================================================
log "Starting backend on :$BACKEND_PORT..."
node src/server.js &
PIDS+=($!)
sleep 2

# =============================================================================
# Step 4: Start frontend
# =============================================================================
log "Starting frontend on :$FRONTEND_PORT..."
cd "$PROJECT_DIR/frontend"
npx vite --host --port $FRONTEND_PORT &
PIDS+=($!)

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN} Local environment restarted${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e " Backend:  ${BLUE}http://localhost:$BACKEND_PORT${NC}"
echo -e " Frontend: ${BLUE}http://localhost:$FRONTEND_PORT${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""

# Keep alive
wait
