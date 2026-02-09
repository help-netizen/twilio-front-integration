#!/usr/bin/env bash
# =============================================================================
# dev-start.sh — Start local development environment
# =============================================================================
# Starts ngrok tunnel, configures webhooks, starts backend + frontend
#
# Usage:
#   ./scripts/dev-start.sh           # Start everything (ngrok + backend + frontend)
#   ./scripts/dev-start.sh --no-ngrok # Start without ngrok (webhooks won't work)
#   ./scripts/dev-start.sh --backend-only  # Start only backend with ngrok
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_PORT="${PORT:-3000}"
FRONTEND_PORT=3001
NGROK_API="http://localhost:4040/api/tunnels"
PIDS=()

# Twilio phone number SIDs to update
PHONE_SIDS=(
    "PNd4a275cf0cd02292bc69df105b4e6b7d"  # +1 (877) 419-4983
    "PNec159049f9d2a07f464d9d0b9fe9c30a"  # +1 (617) 500-6181
    "PN334757241793e249e3f73c62cb88accc"  # +1 (617) 992-7291
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[dev]${NC} $1"; }
warn() { echo -e "${YELLOW}[dev]${NC} $1"; }
error() { echo -e "${RED}[dev]${NC} $1"; }
info() { echo -e "${BLUE}[dev]${NC} $1"; }

# Cleanup on exit
cleanup() {
    log "Shutting down..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    # Kill processes on ports
    lsof -ti:$BACKEND_PORT | xargs kill 2>/dev/null || true
    lsof -ti:$FRONTEND_PORT | xargs kill 2>/dev/null || true
    log "Done."
}
trap cleanup EXIT INT TERM

# =============================================================================
# Step 0: Parse arguments
# =============================================================================
USE_NGROK=true
BACKEND_ONLY=false

for arg in "$@"; do
    case $arg in
        --no-ngrok) USE_NGROK=false ;;
        --backend-only) BACKEND_ONLY=true ;;
    esac
done

# =============================================================================
# Step 1: Kill existing processes
# =============================================================================
log "Stopping existing processes..."
lsof -ti:$BACKEND_PORT | xargs kill 2>/dev/null || true
lsof -ti:$FRONTEND_PORT | xargs kill 2>/dev/null || true
pkill -f "ngrok http" 2>/dev/null || true
sleep 1

# =============================================================================
# Step 2: Copy .env.development → .env (if .env.development exists)
# =============================================================================
if [ -f "$PROJECT_DIR/.env.development" ]; then
    cp "$PROJECT_DIR/.env.development" "$PROJECT_DIR/.env"
    log "Loaded .env.development → .env"
fi

# =============================================================================
# Step 3: Start ngrok
# =============================================================================
NGROK_URL=""
if [ "$USE_NGROK" = true ]; then
    log "Starting ngrok tunnel on port $BACKEND_PORT..."
    ngrok http $BACKEND_PORT --log=stdout > /dev/null 2>&1 &
    PIDS+=($!)

    # Wait for ngrok to start
    for i in $(seq 1 10); do
        sleep 1
        NGROK_URL=$(curl -s "$NGROK_API" 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for t in data.get('tunnels', []):
        if t.get('proto') == 'https':
            print(t['public_url'])
            break
except: pass
" 2>/dev/null)
        if [ -n "$NGROK_URL" ]; then
            break
        fi
    done

    if [ -z "$NGROK_URL" ]; then
        error "Failed to get ngrok URL after 10s"
        exit 1
    fi

    log "Ngrok URL: $NGROK_URL"

    # Update .env with ngrok URL
    if grep -q "^WEBHOOK_BASE_URL=" "$PROJECT_DIR/.env" 2>/dev/null; then
        sed -i '' "s|^WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$NGROK_URL|" "$PROJECT_DIR/.env"
    else
        echo "WEBHOOK_BASE_URL=$NGROK_URL" >> "$PROJECT_DIR/.env"
    fi

    if grep -q "^CALLBACK_HOSTNAME=" "$PROJECT_DIR/.env" 2>/dev/null; then
        sed -i '' "s|^CALLBACK_HOSTNAME=.*|CALLBACK_HOSTNAME=$NGROK_URL|" "$PROJECT_DIR/.env"
    else
        echo "CALLBACK_HOSTNAME=$NGROK_URL" >> "$PROJECT_DIR/.env"
    fi

    log "Updated .env with ngrok URL"

    # =========================================================================
    # Step 4: Update Twilio phone number webhooks
    # =========================================================================
    if command -v twilio &>/dev/null; then
        log "Updating Twilio phone number webhooks..."
        for sid in "${PHONE_SIDS[@]}"; do
            twilio api:core:incoming-phone-numbers:update \
                --sid "$sid" \
                --voice-url "$NGROK_URL/webhooks/twilio/voice-inbound" \
                --status-callback "$NGROK_URL/webhooks/twilio/voice-status" \
                -o json > /dev/null 2>&1 && \
                info "  Updated $sid ✓" || \
                warn "  Failed to update $sid"
        done
        log "Twilio webhooks pointed to ngrok ✓"
    else
        warn "Twilio CLI not found — update phone number webhooks manually"
    fi
else
    warn "Ngrok disabled — webhooks will not be received locally"
fi

# =============================================================================
# Step 5: Start backend
# =============================================================================
log "Starting backend on port $BACKEND_PORT..."
cd "$PROJECT_DIR"
node src/server.js &
PIDS+=($!)
sleep 2

# =============================================================================
# Step 6: Start frontend
# =============================================================================
if [ "$BACKEND_ONLY" = false ]; then
    log "Starting frontend on port $FRONTEND_PORT..."
    cd "$PROJECT_DIR/frontend"
    npx vite --host --port $FRONTEND_PORT &
    PIDS+=($!)
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN} ✅ Development environment ready${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e " Backend:   ${BLUE}http://localhost:$BACKEND_PORT${NC}"
if [ "$BACKEND_ONLY" = false ]; then
    echo -e " Frontend:  ${BLUE}http://localhost:$FRONTEND_PORT${NC}"
fi
if [ -n "$NGROK_URL" ]; then
    echo -e " Ngrok:     ${BLUE}$NGROK_URL${NC}"
    echo -e " Dashboard: ${BLUE}http://localhost:4040${NC}"
fi
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""

# Keep alive
wait
