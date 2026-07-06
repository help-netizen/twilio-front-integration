# Albusto — Contact Center & Field-Service CRM

Multi-tenant CRM and contact center for home-services companies. One workspace
for every customer conversation (calls, SMS, email) and the work it produces
(leads, jobs, schedules, estimates, invoices, payments), with AI woven into the
operational flow — call summaries, live transcription, an inbound voice agent,
and an email-triage agent that turns important letters into dispatcher tasks.

> Historical note: this repository started in 2024 as a small "Twilio → Front"
> channel sync — hence its name. The Front integration is long gone; the repo
> now hosts the entire Albusto platform.

## What's inside

- **Pulse** — the unified inbox. One paginated timeline list across calls, SMS,
  and email per contact (both directions — including threads where the
  dispatcher wrote first), unread tracking, Action-Required tasks pinned on
  top, per-thread timeline with call recordings + transcripts, SMS chat, and
  email.
- **Telephony** — Twilio-backed multi-tenant phone system as a marketplace
  app: numbers (A2P onboarding), user groups, call-flow builder, audio
  library, routing logs, after-hours/autonomous mode, browser softphone
  (desktop), AI voice agent (VAPI) for inbound qualification.
- **CRM & field service** — leads, jobs (Zenbooker sync), visual schedule with
  slot recommendations (standalone slot-engine service), estimates & invoices
  (public pay pages, Stripe incl. Tap to Pay), price book, tasks across every
  entity, role-based access (4 roles, ~56 permissions, in-app access grid).
- **AI** — Gemini call summaries and text polish; Mail Secretary (marketplace
  app) that reads every inbound email, decides whether a dispatcher task is
  needed, explains why, and can create contacts for email-only leads; live
  call transcription (AssemblyAI bridge).
- **Marketplace** — per-company apps with install/provision lifecycle
  (google-email, telephony-twilio, stripe-payments, vapi-ai, smart-slot-engine,
  mail-secretary).
- **Field-tech iOS app** — native technician app in a separate repo
  (`albusto-mobile`): offline-first schedule/jobs, statuses, notes/photos,
  estimates & invoices with Price Book, tasks, search (backend contract:
  `/api/sync`, `/api/devices`).

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js / Express 5 (CommonJS), PostgreSQL (`pg`), SSE for realtime |
| Frontend | Vite + React + TypeScript, shadcn/ui, React Router v6, React Query |
| Auth | Keycloak (OIDC, multi-tenant realms, Google SSO) |
| Integrations | Twilio (Voice/SMS), Gmail (Pub/Sub push), Zenbooker, Stripe, Google Places, VAPI, Gemini, AssemblyAI |
| Tests | Jest (backend), instrumented browser checks (frontend) |
| Deploy | Docker Compose on a VPS (app + Keycloak + Postgres + slot-engine) |

## Repository layout

```
src/                  runtime shell: Express boot, route mounting, SSE, schedulers
backend/src/          application modules (routes / services / db queries)
backend/db/migrations plain-SQL migrations, numbered, with rollback_* twins
frontend/src/         React SPA (pages / components / hooks / services)
slot-engine/          standalone slot-recommendation service
voice-agent/          VAPI assistant configuration
Docs/                 living project docs — see below
scripts/              operational and verification scripts
tests/                backend Jest suites
```

## Documentation

The living documents (kept current by the development pipeline):

- `Docs/project-spec.md` — high-level system spec
- `Docs/requirements.md` / `Docs/architecture.md` — per-feature fragments
- `Docs/specs/` + `Docs/test-cases/` — detailed feature specs and test plans
- `Docs/changelog.md` — what shipped, newest first
- `CLAUDE.md` — UI design canon (layers, tokens, list shells)
- `.claude/skills/orchestrate/` — the 9-agent development pipeline used for
  feature work

## Development

```bash
npm install                        # root (backend deps)
node src/server.js                 # backend on :3000 (dev auth bypass without FEATURE_AUTH_ENABLED)

cd frontend && npm install
FRONTEND_PORT=3001 VITE_PROXY_TARGET=http://localhost:3000 npx vite
```

- Local Postgres database: `postgresql://localhost/twilio_calls` (override via
  `DATABASE_URL`). Apply migrations from `backend/db/migrations/` in order.
- Backend tests: `npx jest --testPathIgnorePatterns "/node_modules/"` from the
  repo root (add `--forceExit`; the suite holds an open handle).
- Frontend production check: `cd frontend && npm run build` (strict tsc).
- Real-behavior verification scripts live in `scripts/` (e.g.
  `node scripts/verify-email-outbound-001.js`) — they run against the real
  local DB, self-seed and self-clean.

## Production

Docker Compose on a VPS: `app` (this repo), `keycloak`, `postgres`,
`slot-engine`, fronted by Caddy (`app.` / `api.` / `auth.` subdomains).
Deploys ship the git tree via rsync, rebuild the app image, apply pending
SQL migrations, and force-logout Keycloak sessions (stale SPA chunks
otherwise break logged-in browsers). Production configuration lives in
`.env` on the server — never in the repo.

The product name in anything user-facing is **Albusto**. Internal design
tokens use the historical `--blanc-*` prefix — that name never ships in UI
text.
