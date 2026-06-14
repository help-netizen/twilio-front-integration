#!/usr/bin/env bash
# =============================================================================
# prod-deploy.sh — Deploy to production (Vultr)
# =============================================================================
# Repoints Twilio webhooks to production, then deploys to the Vultr server
# (app.albusto.com / api.albusto.com, /opt/albusto via docker compose).
#
# Usage:
#   ./scripts/prod-deploy.sh             # Deploy + update webhooks
#   ./scripts/prod-deploy.sh --webhooks-only  # Only update webhooks
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PROD_URL="https://api.albusto.com"
PROD_SSH="deploy@108.61.87.117"
PROD_APP_DIR="/opt/albusto"

# Twilio phone number SIDs (prod only — +16179927291 reserved for dev/ngrok)
PHONE_SIDS=(
    "PN898f143454169b9af67b0561163e7ac2"  # +1 (508) 682-5820
    "PN0d551425c8ac99cb7186efa356d315ed"  # +1 (617) 644-4408
    "PN32e839a2db0bb7035357c78cf5749f82"  # +1 (508) 444-0808
    "PN5962e36c39c4530a072cdeb968eb7c08"  # +1 (508) 290-4442
    "PNec159049f9d2a07f464d9d0b9fe9c30a"  # +1 (617) 500-6181
    "PNdcd4e308ee3e26987e98434d81784446"  # +1 (617) 404-4425
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
            --voice-fallback-url "$PROD_URL/webhooks/twilio/voice-fallback" \
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
# Step 2: Deploy to Vultr (git archive over ssh + docker compose rebuild)
# =============================================================================
log "Deploying master to $PROD_SSH:$PROD_APP_DIR/app ..."
cd "$PROJECT_DIR"
git archive master | ssh "$PROD_SSH" "tar -x -C $PROD_APP_DIR/app"

log "Rebuilding and restarting app container..."
ssh "$PROD_SSH" "cd $PROD_APP_DIR && docker compose build app && docker compose up -d app"

# =============================================================================
# Step 3: Invalidate all Keycloak sessions so users re-login with fresh assets
# =============================================================================
# A frontend rebuild changes Vite bundle hashes; clients still running the old
# bundle fail to lazy-load code-split chunks (blank sections). Forcing a global
# logout makes everyone reload index.html + the new chunks on their next action.
log "Invalidating all Keycloak sessions (force re-login after deploy)..."
ssh "$PROD_SSH" 'sleep 4; docker exec albusto-app-1 node -e "
(async () => {
  const base = process.env.KEYCLOAK_REALM_URL.replace(/\/realms\/.*\$/, \"\");
  const realm = process.env.KEYCLOAK_REALM || \"crm-prod\";
  const tj = await (await fetch(base+\"/realms/master/protocol/openid-connect/token\",{method:\"POST\",headers:{\"Content-Type\":\"application/x-www-form-urlencoded\"},body:new URLSearchParams({grant_type:\"password\",client_id:\"admin-cli\",username:process.env.KEYCLOAK_ADMIN_USER||\"admin\",password:process.env.KEYCLOAK_ADMIN_PASSWORD||\"admin\"})})).json();
  const r = await fetch(base+\"/admin/realms/\"+realm+\"/logout-all\",{method:\"POST\",headers:{Authorization:\"Bearer \"+tj.access_token}});
  console.log(\"[prod] logout-all status \"+r.status);
})().catch(e => console.error(\"[prod] logout-all failed (non-fatal):\", e.message));
"' || warn "Session invalidation failed (non-fatal) — users may need to re-login manually"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN} ✅ Production deployment complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e " App:      ${BLUE}https://app.albusto.com${NC}"
echo -e " API:      ${BLUE}$PROD_URL${NC}"
echo -e " Webhooks: ${BLUE}$PROD_URL/webhooks/twilio/*${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
