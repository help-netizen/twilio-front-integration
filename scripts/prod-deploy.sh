#!/usr/bin/env bash
# =============================================================================
# prod-deploy.sh — Deploy to production (Fly.io)
# =============================================================================
# Repoints Twilio webhooks to production, then deploys to Fly.io
#
# Usage:
#   ./scripts/prod-deploy.sh             # Deploy + update webhooks
#   ./scripts/prod-deploy.sh --webhooks-only  # Only update webhooks
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PROD_URL="https://abc-metrics.fly.dev"

# Twilio phone number SIDs (prod only — +16179927291 reserved for dev/testing)
PHONE_SIDS=(
    "PNd4a275cf0cd02292bc69df105b4e6b7d"  # +1 (877) 419-4983
    "PNec159049f9d2a07f464d9d0b9fe9c30a"  # +1 (617) 500-6181
)

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[prod]${NC} $1"; }
info() { echo -e "${BLUE}[prod]${NC} $1"; }
warn() { echo -e "${YELLOW}[prod]${NC} $1"; }

# =============================================================================
# Step 1: Update Twilio webhooks to production
# =============================================================================
log "Updating Twilio phone number webhooks to production..."
if command -v twilio &>/dev/null; then
    for sid in "${PHONE_SIDS[@]}"; do
        twilio api:core:incoming-phone-numbers:update \
            --sid "$sid" \
            --voice-url "$PROD_URL/webhooks/twilio/voice-inbound" \
            --status-callback "$PROD_URL/webhooks/twilio/voice-status" \
            -o json > /dev/null 2>&1 && \
            info "  Updated $sid ✓" || \
            warn "  Failed to update $sid"
    done
    log "Twilio webhooks pointed to production ✓"
else
    warn "Twilio CLI not found — update phone number webhooks manually"
fi

# Check --webhooks-only flag
for arg in "$@"; do
    if [ "$arg" = "--webhooks-only" ]; then
        log "Webhooks updated. Skipping deploy (--webhooks-only)."
        exit 0
    fi
done

# =============================================================================
# Step 2: Deploy to Fly.io
# =============================================================================
log "Deploying to Fly.io..."
cd "$PROJECT_DIR"
fly deploy

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN} ✅ Production deployment complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e " App:      ${BLUE}$PROD_URL${NC}"
echo -e " Webhooks: ${BLUE}$PROD_URL/webhooks/twilio/*${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
