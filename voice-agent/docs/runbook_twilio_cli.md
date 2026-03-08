# Twilio CLI Runbook — Voice Agent Operations

## Overview

This runbook covers all Twilio CLI operations needed for the VAPI Voice Agent project. Every command in this runbook **must** include the `-p <profile>` flag to ensure environment isolation.

---

## Prerequisites

```bash
# Verify Twilio CLI is installed
twilio --version

# List available profiles
twilio profiles:list

# Switch to the correct environment
twilio profiles:use abc-dev    # or abc-uat, abc-prod
```

---

## 1. Number Inventory — Inspect Current State

**When to use:** Before any changes, during audits, to verify environment.

```bash
# List all numbers in the current profile
twilio phone-numbers:list -p abc-dev -o json

# Save inventory snapshot
twilio phone-numbers:list -p abc-dev -o json > /tmp/twilio-inventory-$(date +%Y%m%d).json
```

**What to check in output:**
- `phoneNumber` — E.164 format
- `sid` — PN SID
- `friendlyName` — matches naming convention
- `voiceUrl` — where inbound calls are routed
- `voiceApplicationSid` — must be empty if using `voiceUrl`
- `trunkSid` — must be empty if using `voiceUrl`

---

## 2. Update Voice Webhook URL

**When to use:** Break-glass, local debugging, rollback.

```bash
# By phone number (E.164)
twilio phone-numbers:update +1XXXXXXXXXX \
  -p abc-dev \
  --voice-url https://example.com/twilio/inbound/voice \
  --voice-method POST

# By SID
twilio phone-numbers:update PNXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
  -p abc-dev \
  --voice-url https://example.com/twilio/inbound/voice \
  --voice-method POST
```

> ⚠️ **ALWAYS** record the previous `voiceUrl` in `config/twilio/numbers/inbound_number_inventory.yaml` before changing it.

---

## 3. Verify Webhook Was Updated

```bash
twilio phone-numbers:list -p abc-dev -o json | grep -A5 "voiceUrl"
```

---

## 4. Local Debugging with Tunnel

```bash
# 1. Start ngrok tunnel
ngrok http 3000

# 2. Copy the https URL from ngrok output
# 3. Update the number's voice URL to point to the tunnel
twilio phone-numbers:update +1XXXXXXXXXX \
  -p abc-dev \
  --voice-url https://<NGROK_SUBDOMAIN>.ngrok-free.app/twilio/inbound/voice \
  --voice-method POST

# 4. Make a test call to the number
# 5. Watch your local server for incoming requests

# 6. IMPORTANT: Restore the original voice URL when done!
```

> 🚫 **Never** use `localhost` or `127.0.0.1` as a voice URL — Twilio will reject it.

---

## 5. Stream Debugger Logs

**When to use:** During testing, incident diagnosis.

```bash
# One-time snapshot
twilio debugger:logs:list -p abc-dev -o json

# Live streaming (continuous)
twilio debugger:logs:list -p abc-dev --streaming
```

---

## 6. Search for Available Numbers (if needed)

```bash
twilio api:core:available-phone-numbers:local:list \
  --country-code US \
  --area-code 617 \
  -p abc-dev \
  -o json
```

---

## 7. Rollback Procedure

1. **Check current state:**
   ```bash
   twilio phone-numbers:list -p abc-dev -o json
   ```

2. **Read last-known-good from inventory file:**
   ```bash
   cat voice-agent/config/twilio/numbers/inbound_number_inventory.yaml
   ```

3. **Restore:**
   ```bash
   twilio phone-numbers:update +1XXXXXXXXXX \
     -p abc-dev \
     --voice-url <LAST_KNOWN_GOOD_URL> \
     --voice-method POST
   ```

4. **Verify:**
   ```bash
   twilio phone-numbers:list -p abc-dev -o json
   ```

5. **Update inventory file** with new timestamp and who performed the rollback.

---

## Safety Rules

1. **Always use `-p <profile>`** — never run commands without explicit profile
2. **Always check before updating** — run `list` before `update`
3. **Always record changes** — update the inventory YAML
4. **Never leave a tunnel URL as permanent** — always restore after debugging
5. **If `voiceUrl` update has no effect** — check `voiceApplicationSid` and `trunkSid`
