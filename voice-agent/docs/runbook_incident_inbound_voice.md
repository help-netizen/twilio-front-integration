# Incident Runbook — Inbound Voice Not Working

## Scope

This runbook covers diagnosis and recovery when inbound calls to the Voice Agent number are failing, producing errors, or not reaching the AI assistant.

---

## Symptoms

- Caller hears silence, error message, or busy tone
- Caller reaches Twilio default message ("technical difficulties")
- Vapi assistant does not pick up
- Call appears in Twilio logs but not in Vapi dashboard
- Call does not appear in either system

---

## Step 1 — Identify the Layer

```
Caller → [PSTN/Carrier] → [Twilio] → [Vapi] → [AI Assistant]
```

| Check | Command / Action |
|-------|-----------------|
| Carrier layer | Call the number from a different carrier/phone |
| Twilio layer | `twilio debugger:logs:list -p <profile> --streaming` |
| Vapi layer | Check Vapi Dashboard → Call Logs |
| Assistant layer | `vapi call list` — check if call reached assistant |

---

## Step 2 — Twilio-Level Diagnosis

### 2.1. Check number configuration
```bash
twilio phone-numbers:list -p <profile> -o json
```

Verify:
- [ ] `voiceUrl` is set and correct
- [ ] `voiceApplicationSid` is empty (or intentionally set)
- [ ] `trunkSid` is empty (or intentionally set)
- [ ] Number status is `active`

### 2.2. Check for errors
```bash
twilio debugger:logs:list -p <profile> -o json
```

Common errors:
- **11200** — HTTP retrieval failure (voice URL unreachable)
- **11205** — HTTP connection failure
- **11210** — HTTP timeout
- **12100** — Document parse failure (bad TwiML)

### 2.3. Test voice URL directly
```bash
curl -X POST <voice_url> \
  -d "CallSid=test" \
  -d "From=+15551234567" \
  -d "To=+1XXXXXXXXXX"
```

---

## Step 3 — Vapi-Level Diagnosis

### 3.1. Check Vapi Dashboard
1. Go to [dashboard.vapi.ai](https://dashboard.vapi.ai)
2. Check Phone Numbers — is the number active?
3. Check Call Logs — are calls appearing?
4. Check Assistant — is it configured and active?

### 3.2. Check via CLI
```bash
vapi phone list
vapi assistant list
vapi call list
vapi logs errors
```

---

## Step 4 — Break-Glass Recovery

### Option A — Reroute to diagnostic endpoint
```bash
twilio phone-numbers:update <NUMBER_OR_SID> \
  -p <profile> \
  --voice-url https://httpbin.org/post \
  --voice-method POST
```
Call the number → if call reaches httpbin, Twilio layer is healthy.

### Option B — Reroute to emergency TwiML
If you have a TwiML Bin set up:
```bash
twilio phone-numbers:update <NUMBER_OR_SID> \
  -p <profile> \
  --voice-url <TWIML_BIN_URL> \
  --voice-method POST
```

### Option C — Full rollback to last-known-good
```bash
# 1. Read last-known-good URL from inventory
cat voice-agent/config/twilio/numbers/inbound_number_inventory.yaml

# 2. Restore
twilio phone-numbers:update <NUMBER_OR_SID> \
  -p <profile> \
  --voice-url <LAST_KNOWN_GOOD_URL> \
  --voice-method POST

# 3. Verify
twilio phone-numbers:list -p <profile> -o json
```

---

## Step 5 — Post-Incident

1. **Update inventory file** with:
   - What happened
   - When it was detected
   - What was changed
   - Who changed it
   - When service was restored

2. **Root cause analysis:**
   - Was it a Vapi outage? Check [status.vapi.ai](https://status.vapi.ai)
   - Was it a Twilio outage? Check [status.twilio.com](https://status.twilio.com)
   - Was it a config change that wasn't tested?
   - Was it a webhook URL that expired (e.g., tunnel URL)?

3. **Prevent recurrence:**
   - Add monitoring if not present
   - Update fallback routes if needed
   - Document the incident in the change log

---

## Escalation

| Priority | Action |
|----------|--------|
| P1 — No calls working | Execute break-glass immediately, notify team |
| P2 — Intermittent failures | Check debugger logs, may be rate limits or timeouts |
| P3 — Quality issues | Check AI assistant config, voice/TTS settings |

## Contacts

- **Vapi Support:** [docs.vapi.ai/support](https://docs.vapi.ai/support)
- **Twilio Support:** [twilio.com/console/support](https://www.twilio.com/console/support)
- **Vapi Status:** [status.vapi.ai](https://status.vapi.ai)
- **Twilio Status:** [status.twilio.com](https://status.twilio.com)
