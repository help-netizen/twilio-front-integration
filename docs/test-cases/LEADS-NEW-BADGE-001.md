# Test Cases — LEADS-NEW-BADGE-001

Backend = Jest (`tests/leadsNewCount.test.js`). Frontend = manual/dev-preview (no FE harness).

## P0

| ID | Type | Scenario | Expected |
|----|------|----------|----------|
| TC-1 | Jest ✅ | `countNewLeads('c1')` | Query scoped by `company_id=$1` + `status=ANY(['Submitted','New','Review'])` + `lead_lost=false`; returns the count |
| TC-2 | Jest ✅ | `countNewLeads(null)` | Returns 0, no query (no cross-tenant default) |
| TC-3 | Jest ✅ | `markLost` emits `lead.updated` | Payload `{company_id,status,lead_id}` only — NO phone/name/email (PII-free over the global channel) |
| TC-4 | Jest ✅ | broadcast throws during a lead write | Write still succeeds (best-effort emit) |
| TC-5 | Jest ✅ | emit with no companyId | No broadcast |
| TC-6 | Manual | `GET /api/leads/new-count` without `leads.view` | 403; with it → `{data:{count}}`, scoped to caller's company |
| TC-7 | Manual | `GET /api/leads/new-count` route resolution | Hits the count handler, NOT `/:uuid` (not treated as uuid="new-count") |

## P1

| ID | Type | Scenario | Expected |
|----|------|----------|----------|
| TC-8 | Manual (E2E) | Create a lead (manual/VAPI/web form) | Leads nav badge increments live (SSE) for that company only; other tenants unaffected |
| TC-9 | Manual (E2E) | Move a new lead to Contacted / mark lost / convert | Badge decrements live |
| TC-10 | Manual | Open the Leads page | Badge does NOT clear (no read/unread) — only actioning leads changes it |
| TC-11 | Manual | SSE drop / reconnect | Badge still corrects within 60s (poll fallback) |
| TC-12 | Build | `cd frontend && tsc -b` | exit 0 |

## Regression
- TC-R1: Pulse badge unchanged (same class/behavior).
- TC-R2: existing `leadsService.convert.test.js` stays green (convert now also emits `lead.updated`).
- TC-R3: leads list/detail routes unaffected by the new `/new-count` route.
