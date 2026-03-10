# Runbook — Vapi Agent Node Operations

## Overview

This runbook covers operations for the Vapi Agent Node — the SIP-bridged AI component inside Blanc call flows.

---

## Architecture Reference

```
Caller → Twilio → Blanc Group Flow → Vapi Agent Node
  → Twilio <Dial><Sip> → sip:blanc-ai-{env}@sip.vapi.ai
  → Vapi SIP resource → assistant-request → Blanc resolver
  → Vapi assistant → greeting
  → SIP leg ends → Twilio action callback → Blanc flow resumes
```

---

## 1. Vapi SIP Phone Number Resource

### List SIP resources
```bash
export PATH="$HOME/.vapi/bin:$PATH"
vapi phone list
```

### Create SIP resource
```bash
# Via API (CLI may not support SIP type directly)
curl -X POST https://api.vapi.ai/phone-number \
  -H "Authorization: Bearer $VAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "vapi",
    "sipUri": "sip:blanc-ai-dev@sip.vapi.ai",
    "assistantId": null,
    "serverUrl": "https://dev-blanc.example.com/api/vapi/runtime"
  }'
```

### Verify SIP resource
```bash
vapi phone get <phone-number-id>
# Check: sipUri, serverUrl, and assistantId=null
```

### Update serverUrl
```bash
vapi phone update <phone-number-id>
# Or via API:
curl -X PATCH https://api.vapi.ai/phone-number/<id> \
  -H "Authorization: Bearer $VAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"serverUrl": "https://new-url.example.com/api/vapi/runtime"}'
```

---

## 2. Runtime Resolver Endpoint

### Check health
```bash
curl -X POST https://dev-blanc.example.com/api/vapi/runtime \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "type": "assistant-request",
      "call": {
        "id": "test-call",
        "headers": {
          "x-blanc-company-id": "abc_homes",
          "x-blanc-group-id": "grp_001",
          "x-blanc-assistant-profile": "greeting_only_v1"
        }
      }
    }
  }'
```

Expected response:
```json
{ "assistantId": "asst_..." }
```

### Performance check
Response must be < 2 seconds. If slower, check:
- Database/cache connectivity
- Profile registry initialization
- External dependencies

---

## 3. TwiML Verification

### Test the Dial action callback
```bash
curl -X POST "https://dev-blanc.example.com/api/twilio/vapi-agent-action?flowId=test&nodeId=test&groupId=test" \
  -d "DialCallStatus=completed" \
  -d "CallSid=CA_test" \
  -d "DialCallDuration=30"
```

Expected: TwiML response with `<Say>` + `<Hangup/>`

---

## 4. SIP Header Debugging

If Vapi isn't receiving headers correctly:

1. Check TwiML output from Blanc (the `<Sip>` element should contain `?x-blanc-*` params)
2. Verify URL encoding in SIP URI query string
3. Check Vapi call logs for received headers:
   ```bash
   vapi call list
   vapi call get <call-id>
   ```

---

## 5. Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Vapi not answering | SIP resource missing or wrong serverUrl | `vapi phone list`, verify sipUri |
| No assistant-request received | serverUrl incorrect or unreachable | Check URL, test with curl |
| Slow resolution | Heavy lookup in resolver | Simplify, add caching |
| Flow doesn't resume after AI | Missing `action` attribute in TwiML | Verify `buildVapiSipTwiml.ts` |
| Wrong assistant loaded | Profile not in registry | Check `resolveAssistantForCall.ts` |
