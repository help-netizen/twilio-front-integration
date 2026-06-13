# Environment Setup Guide

## Quick Start

### Local Development (with ngrok)

```bash
npm run dev:local
```

This single command:
1. Stops existing processes on ports 3000/3001
2. Copies `.env.development` → `.env`
3. Starts ngrok tunnel and detects the URL
4. Updates `.env` with the ngrok URL (`WEBHOOK_BASE_URL`, `CALLBACK_HOSTNAME`)
5. Updates all Twilio phone number webhooks to ngrok
6. Starts backend (port 3000) and frontend (port 3001)

After starting:
- Frontend: http://localhost:3001
- Backend: http://localhost:3000
- Ngrok dashboard: http://localhost:4040

### Deploy to Production

```bash
npm run deploy:prod
```

This:
1. Updates all Twilio phone number webhooks to `https://api.albusto.com`
2. Deploys `master` to the Vultr server (`deploy@108.61.87.117`) via `git archive | ssh ... tar -x -C /opt/albusto/app`
3. Rebuilds and restarts the app container: `cd /opt/albusto && docker compose build app && docker compose up -d app`

Production runs on Vultr with docker compose (app + postgres:17 + keycloak):
- App: https://app.albusto.com
- API / webhooks: https://api.albusto.com
- Keycloak: https://auth.albusto.com

> The old Fly.io app (`abc-metrics.fly.dev`) is kept alive only to serve `/pulse` on a frozen DB — do not deploy to it.

### Switch Webhooks Only (no deploy)

```bash
npm run webhooks:prod     # Point webhooks to production
npm run dev:local         # Point webhooks to ngrok (local)
```

---

## Environment Files

| File | Purpose | Git tracked? |
|------|---------|:---:|
| `.env` | Active config (loaded by server) | ❌ |
| `.env.development` | Local dev config with real secrets | ❌ |
| `.env.production` | Production config template | ❌ |

### Key Environment Variables

| Variable | Development | Production |
|----------|-------------|------------|
| `NODE_ENV` | `development` | `production` |
| `WEBHOOK_BASE_URL` | `https://*.ngrok-free.dev` (auto-set) | `https://api.albusto.com` |
| `CALLBACK_HOSTNAME` | Same as WEBHOOK_BASE_URL | Same as WEBHOOK_BASE_URL |
| `DATABASE_URL` | `postgresql://localhost/twilio_calls` | docker compose postgres (set in `/opt/albusto/.env` on the server) |
| `FEATURE_AUTH_ENABLED` | `true` | `true` |

### How Webhook URLs Work

```
Twilio Phone Number Config:
  voiceUrl       → {WEBHOOK_BASE_URL}/webhooks/twilio/voice-inbound
  statusCallback → {WEBHOOK_BASE_URL}/webhooks/twilio/voice-status

TwiML Response (generated per call):
  <Dial action="{WEBHOOK_BASE_URL}/webhooks/twilio/dial-action">
    <Sip statusCallback="{WEBHOOK_BASE_URL}/webhooks/twilio/voice-status"
         statusCallbackEvent="initiated ringing answered completed">
  </Dial>
```

The `WEBHOOK_BASE_URL` must match where Twilio can reach the server:
- **Local dev**: ngrok URL (set automatically by `dev-start.sh`)
- **Production**: `https://api.albusto.com` (set in the server's environment, `/opt/albusto/.env`)

---

## Managed Twilio Phone Numbers

| Number | SID | Role |
|--------|-----|------|
| +1 (508) 682-5820 | `PN898f143454169b9af67b0561163e7ac2` | Production |
| +1 (617) 644-4408 | `PN0d551425c8ac99cb7186efa356d315ed` | Production |
| +1 (508) 444-0808 | `PN32e839a2db0bb7035357c78cf5749f82` | Production |
| +1 (508) 290-4442 | `PN5962e36c39c4530a072cdeb968eb7c08` | Production |
| +1 (617) 500-6181 | `PNec159049f9d2a07f464d9d0b9fe9c30a` | Production |
| +1 (617) 404-4425 | `PNdcd4e308ee3e26987e98434d81784446` | Production |
| +1 (617) 992-7291 | `PN334757241793e249e3f73c62cb88accc` | Dev/ngrok only |

---

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev:local` | `./scripts/dev-start.sh` | Full local dev (ngrok + backend + frontend) |
| `dev:backend` | `./scripts/dev-start.sh --backend-only` | Backend + ngrok only |
| `deploy:prod` | `./scripts/prod-deploy.sh` | Deploy to Vultr + update webhooks |
| `webhooks:prod` | `./scripts/prod-deploy.sh --webhooks-only` | Just switch webhooks to prod |
| `start` | `node src/server.js` | Start backend only (used in the prod container) |
| `dev` | `nodemon src/server.js` | Start backend with auto-reload |

---

## Troubleshooting

### Webhooks not arriving
1. Check ngrok dashboard: http://localhost:4040
2. Verify phone numbers point to ngrok: `twilio phone-numbers:list -o json | python3 -c "import json,sys; [print(p['phoneNumber'], p['voiceUrl']) for p in json.load(sys.stdin)]"`
3. Verify `WEBHOOK_BASE_URL` in `.env` matches ngrok URL

### "in-progress" events missing
The TwiML `statusCallbackEvent` must include `answered`. Verify at `/webhooks/twilio/voice-inbound` or `/twiml/voice`.

### Duration shows wrong value
Enrichment from Twilio API may fail if the call just ended. Check backend logs for `Enriched from Twilio API` message.
