# Blanc Contact Center — Project Context

Reference file for the orchestrate skill. Contains project stack,
security rules, and protected files that ALL agents must respect.

## Technology Stack

| Layer | Technology |
|---|---|
| Backend | Node.js / Express 5, PostgreSQL (pg), CommonJS |
| Frontend | Vite + React + TypeScript, Shadcn/ui, Lucide React, React Router v6, React Query |
| Integrations | Twilio (Voice SDK, SMS/Conversations API), Front (Channel API, JWT), Zenbooker (Booking/Contacts API), Google Places |
| Real-time | SSE (Server-Sent Events), WebSocket (Twilio Device) |
| Tests | Jest |
| Deploy | Fly.io (Docker) |
| AI | Gemini API (summaries, transcripts, polish) |

## Architecture Overview

```
[Twilio / Front / Zenbooker / Google / Gemini / Vapi]
                     |
          [src/server.js runtime shell]
             | auth / routing / SSE / static
      [backend/src application modules] <-> [PostgreSQL]
             |
       [backend/src/services/realtimeService]
             |
      [frontend/src SPA via Vite]
```

- `src/` — runtime shell and legacy adapter layer
- `backend/src/` — main backend (routes, services, db)
- `frontend/src/` — React SPA (pages, components, hooks)
- `voice-agent/` — AI/voice flow configuration

## Key Conventions

- **Modular structure:** backend routes/services/db, frontend pages/components/hooks
- **DRY:** No duplication of functionality
- **TypeScript strict typing** on frontend
- **React Query** for data fetching (Pulse), `authedFetch` for other requests
- **SSE** for real-time updates
- **Timezone:** All dates normalized to `company.timezone` (default `America/New_York`)

## Security Rules (CRITICAL)

These rules are mandatory for ALL code changes:

1. **Middleware:** All API routes must use `authenticate, requireCompanyAccess`
2. **company_id:** Obtained ONLY via `req.companyFilter?.company_id`
   - **NEVER** use `req.companyId` — it does not exist
3. **SQL isolation:** ALL SQL queries MUST filter by `company_id` — cross-company data leaks are forbidden
4. **Access by ID:** GET/PATCH/DELETE by entity_id must check `AND company_id = $N` (foreign data -> 404)
5. **Tests:** Every feature with API must have tests for middleware (401/403) and data isolation

## Protected Files (DO NOT MODIFY)

These files must not be changed unless there is an explicit, approved plan:

- `src/server.js` — core Express middleware and SSE infrastructure
- `frontend/src/lib/authedFetch.ts` — auth wrapper
- `frontend/src/hooks/useRealtimeEvents.ts` — SSE hooks
- `backend/db/` — database schema and migrations (change only via tasks with explicit plan)
- Any file containing the comment `// PROTECTED - DO NOT MODIFY`

## Project Documents Location

| Document | Path |
|---|---|
| Requirements | `Docs/requirements.md` |
| Architecture | `Docs/architecture.md` |
| Tasks | `Docs/tasks.md` |
| Changelog | `Docs/changelog.md` |
| Project Spec | `Docs/project-spec.md` |
| Feature Specs | `Docs/specs/` |
| Test Cases | `Docs/test-cases/` |
| Agent Instructions | `docs/agents/agent-01-product-requirements.md` through `agent-09-project-spec.md` |
