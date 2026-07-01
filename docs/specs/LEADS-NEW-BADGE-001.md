# LEADS-NEW-BADGE-001 — "new leads" counter badge in navigation

**Status:** Implemented (pending deploy) · **Area:** Frontend nav + Leads backend (count + SSE)

## Problem
When a new lead arrives, the dispatcher doesn't notice it (notifications may/may not be on).
Provide an at-a-glance indicator: a number-in-a-circle badge on the **Leads** nav item, exactly
like the Pulse "new events" badge.

## Behavior
- The badge shows the **count of new/unactioned leads** for the user's company:
  `status ∈ {Submitted, New, Review}` AND `lead_lost = false`. (`Submitted` is the DB default
  on creation; `New`/`Review` are the other pre-contact states.)
- **NO per-lead read/unread state.** The badge is purely status-derived: it does NOT clear when
  the user opens the Leads page — it clears only as leads leave the new set (contacted / qualified
  / converted / lost). It's a persistent "N leads awaiting triage" indicator.
- **Scope:** all new leads of the tenant (company-scoped), not per-user (new leads are typically
  unassigned; the dispatcher triages all).
- **Freshness (hybrid):** initial fetch on mount + on route change; a 60s poll; and live SSE
  refresh on `lead.created` / `lead.updated`. The poll is the fallback for missed events/reconnects.
- **Rendering:** reuses the Pulse badge (`.pulse-unread-badge`, number, "9+" cap), desktop + mobile.
- **Visibility/permission:** follows the Leads nav item (`leads.view`); count endpoint gated `leads.view`.

## API
`GET /api/leads/new-count` → `successResponse({ count })` (i.e. `{ ok, data: { count }, meta }`).
Gated `requirePermission('leads.view')`; company-scoped via `req.companyFilter.company_id`.
Placed **above** the `/:uuid` route (else Express matches it as `uuid="new-count"`).

## SSE
`realtimeService.broadcast` fans out to ALL connected clients (no per-tenant channel). Therefore:
- Payload is **minimal & PII-free**: `{ company_id, status, lead_id }` only.
- The client refetches its own company-scoped count and **only** when `event.company_id === company.id`.
- Emitted from `leadsService`: `lead.created` on `createLead` (the single creation chokepoint —
  covers manual + VAPI + web-form/integration paths); `lead.updated` on `updateLead` (status change
  only), `markLost`, `activateLead`, `convertLead`. Emits are best-effort (a broadcast failure never
  breaks the lead write). Missed emits self-heal within 60s via the poll.
- Routed to the client through the existing `useRealtimeEvents` generic-event channel (added
  `lead.created`/`lead.updated` to `genericEventTypes`; consumed via `onGenericEvent`).

## Files
- `backend/src/services/leadsService.js` — `NEW_LEAD_STATUSES`, `countNewLeads`, `emitLeadChange` + 5 emit sites.
- `backend/src/routes/leads.js` — `GET /new-count` (before `/:uuid`).
- `frontend/src/hooks/useRealtimeEvents.ts` — `lead.created`/`lead.updated` added to generic events (additive; protected file).
- `frontend/src/components/layout/AppLayout.tsx` — `leadsNewCount` state + fetch + 60s poll + SSE handler.
- `frontend/src/components/layout/appLayoutNavigation.tsx` — badge on Leads (desktop + mobile) + `position:relative`.
- `tests/leadsNewCount.test.js`.

## Non-goals
No read/unread tracking, no migration (indexes + `lead_lost` already exist), no new permission,
no change to the global-broadcast SSE architecture (noted as a separate concern).
