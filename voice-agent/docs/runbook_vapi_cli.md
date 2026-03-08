# Vapi CLI Runbook — Voice Agent Operations

## Overview

This runbook covers all Vapi CLI operations needed for the VAPI Voice Agent project. The Vapi CLI provides full feature parity with the Vapi Dashboard.

---

## Prerequisites

```bash
# Verify Vapi CLI is installed
vapi --version

# Check authentication status
vapi auth status

# If not logged in:
vapi login

# Switch between accounts (if multiple orgs)
vapi auth switch <account-name>
```

---

## 1. Assistant Management

### List all assistants
```bash
vapi assistant list
```

### Get assistant details
```bash
vapi assistant get <assistant-id>
```

### Create a new assistant
```bash
# Interactive mode — follow prompts
vapi assistant create
```

### Update an assistant
```bash
vapi assistant update <assistant-id>
```

### Delete an assistant
```bash
vapi assistant delete <assistant-id>
```

---

## 2. Phone Number Management

### List phone numbers
```bash
vapi phone list
```

### Get phone number details
```bash
# Find the phone number ID from `vapi phone list` output
vapi phone get <phone-number-id>
```

### Update phone number configuration
```bash
# Update squad binding, server URL, etc.
vapi phone update <phone-number-id>
```

### Import a Twilio number
Import is done through the **Vapi Dashboard** (Phone Numbers → Import):
1. Go to [dashboard.vapi.ai](https://dashboard.vapi.ai) → Phone Numbers
2. Click "Import"
3. Enter:
   - Phone number in E.164 format
   - Twilio Account SID
   - Twilio Auth Token
4. Click "Import"

After import, verify via CLI:
```bash
vapi phone list
```

---

## 3. Squad Management

> **Note:** Squad management via CLI may require the Vapi API directly. Check `vapi --help` for available commands. If not available in CLI, use the Dashboard or direct API calls.

### Via Dashboard
1. Go to [dashboard.vapi.ai](https://dashboard.vapi.ai)
2. Navigate to Squads
3. Create/edit squad with members

### Via API (curl)
```bash
# Create squad
curl -X POST https://api.vapi.ai/squad \
  -H "Authorization: Bearer $VAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Appliance Inbound Entry Squad",
    "members": [
      {
        "assistantId": "<ASSISTANT_ID>"
      }
    ]
  }'

# List squads
curl https://api.vapi.ai/squad \
  -H "Authorization: Bearer $VAPI_API_KEY"

# Get squad
curl https://api.vapi.ai/squad/<squad-id> \
  -H "Authorization: Bearer $VAPI_API_KEY"
```

---

## 4. Call Operations

### List recent calls
```bash
vapi call list
```

### Get call details
```bash
vapi call get <call-id>
```

### Make an outbound test call
```bash
vapi call create
```

---

## 5. Local Webhook Testing

Vapi CLI's `listen` command is a **local forwarder only** — it does NOT create a public URL. You need a separate tunnel service.

```bash
# Terminal 1: Start tunnel
ngrok http 4242

# Terminal 2: Forward Vapi webhooks to your local server
vapi listen --forward-to localhost:3000/webhook
```

Update the Vapi phone number's server URL to use the ngrok public URL.

---

## 6. Logs and Debugging

```bash
# System logs
vapi logs list

# Call-specific logs
vapi logs calls <call-id>

# Error logs
vapi logs errors

# Webhook logs
vapi logs webhooks
```

---

## 7. MCP Integration (IDE Enhancement)

```bash
# Auto-configure all supported IDEs
vapi mcp setup

# Or for a specific IDE
vapi mcp setup cursor
vapi mcp setup windsurf
vapi mcp setup vscode
```

---

## 8. Stage 1 Verification Checklist

After provisioning all Vapi entities, run this checklist:

```bash
# 1. Verify assistant exists
vapi assistant list
# → Should show "Entry Greeter" or "entry_greeter"

# 2. Verify phone number is imported
vapi phone list
# → Should show the imported Twilio number

# 3. Verify calls work
# → Make a test inbound call and check:
vapi call list
# → Should show the test call with status "completed"
```

---

## Safety Rules

1. **Always verify org** — run `vapi auth status` before making changes
2. **Use the correct environment** — switch accounts for dev/uat/prod
3. **Never delete production entities** without a rollback plan
4. **Test locally first** — use `vapi listen` + ngrok for development
