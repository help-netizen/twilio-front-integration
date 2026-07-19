# RBAC-WAVE2-001 — business-data reads and configuration writes

## Decision record

`crm.js` is dormant in the current React frontend. A source-only search of
`frontend/src` for `/api/crm`, `accounts/stale`, `deals/attention`, `/pipeline`,
and CRM account/deal consumers returns no matches; the live references are the
backend mount and backend tests. Therefore Wave 2 takes option A: existing
semantic permissions (`contacts.view`, `leads.view`, `tasks.view`) with no new
`crm.view` key or migration.

The assistant remains isolated from customer/business records. Its structural
isolation suite permits only the published capability catalog, company-scoped
app/config status providers, the identity-free transcript store, and runtime
primitives; no lead/job/contact/call/payment query surface or MCP executor is
imported. The light `pulse.view` gate is sufficient and preserves all four
seeded roles.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET /api/crm/accounts*`, `/contacts*`, `/activities`, `/notes`, `/metadata`, `/lists/:listKey` | `req.companyFilter.company_id` passed to CRM services/queries | account/contact id or list key | `contacts.view` | tenant_admin ✓; manager ✓; dispatcher ✓; provider ✗ | Entity ids resolve with company; foreign ids are 404. Dormant frontend means no live role loses access. |
| `GET /api/crm/deals*`, `/pipeline` | `req.companyFilter.company_id` passed to CRM services/queries | deal id | `leads.view` | tenant_admin ✓; manager ✓; dispatcher ✓; provider ✗ | Deal ids and aggregates are company-scoped; foreign ids are 404. |
| `GET /api/crm/tasks` | `req.companyFilter.company_id` passed to task service/query | filters only | `tasks.view` | tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓ | No caller-selected entity id; base query is company-scoped. |
| `GET /events/calls` SSE | `authenticate` → `requireCompanyAccess`; subscriber stores `company_id`; every broadcast filters on event company | authenticated connection + event company | `pulse.view` | tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓ | A handshake gate alone was insufficient: the former process-wide fan-out was a tenancy leak. Unscoped events now fail closed; A events are never written to B. |
| `GET/POST/PATCH/DELETE /api/estimate-item-presets` | `req.companyFilter.company_id` in every query | preset id | read/use: `price_book.view`; writes: `price_book.manage` | view: all four ✓; manage: tenant_admin/manager ✓, dispatcher/provider ✗ | Provider estimate building remains live. Foreign preset ids return 404 and scoped writes leave the foreign row unchanged. |
| `POST /api/sync/today`, `/recent` | request `company_id` selects per-company Twilio client and is passed into reconcile writes | company Twilio subaccount | `reports.calls.view` | tenant_admin ✓; manager ✓; dispatcher ✓; provider ✗ | The live Calls refresh is available to its office roles; a tenant cannot trigger another tenant's Twilio/reconcile path. |
| `GET /api/telephony/provider/autonomous-mode` | `req.companyFilter.company_id` in `company_telephony` lookup | company id | `phone_calls.use` | tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓ | App-shell banner still loads for every seeded role; custom roles without telephony access are denied. |
| `POST /api/assistant/chat` | `req.companyFilter.company_id` for allowlisted capability/config status reads | no customer entity key | `pulse.view` | tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓ | No CRM business-data tool/import exists; transcript rows are identity-free by design. |

## Role-holder proof and outcomes

The fixed-role grants below come from migration 050 and every selected key is in
`permissionCatalog.js`. Migration 138 re-grants provider finance and adds
`lead_source.view`; it does not add contacts/leads visibility and therefore does
not change this matrix. Runtime checks still honor per-member overrides.

| handler | outcome | seed proof |
|---|---|---|
| CRM `GET /accounts/stale` | **(a)** | `contacts.view`: tenant_admin/manager/dispatcher; not provider. |
| CRM `GET /accounts/:id/key-contacts` | **(a)** | Same `contacts.view` matrix. |
| CRM `GET /accounts/:id` | **(a)** | Same `contacts.view` matrix. |
| CRM `GET /accounts` | **(a)** | Same `contacts.view` matrix. |
| CRM `GET /contacts/:id` | **(a)** | Same `contacts.view` matrix. |
| CRM `GET /contacts` | **(a)** | Same `contacts.view` matrix. |
| CRM `GET /deals/attention` | **(a)** | `leads.view`: tenant_admin/manager/dispatcher; not provider. |
| CRM `GET /deals/:id` | **(a)** | Same `leads.view` matrix. |
| CRM `GET /deals` | **(a)** | Same `leads.view` matrix. |
| CRM `GET /pipeline` | **(a)** | Same `leads.view` matrix. |
| CRM `GET /activities` | **(a)** | Same `contacts.view` matrix. |
| CRM `GET /tasks` | **(a)** | `tasks.view`: all four roles. |
| CRM `GET /notes` | **(a)** | Same `contacts.view` matrix. |
| CRM `GET /metadata` | **(a)** | Same `contacts.view` matrix. |
| CRM `GET /lists/:listKey` | **(a)** | Same `contacts.view` matrix. |
| events `GET /calls` | **(b)** | `pulse.view` is held by all four roles, preserving dispatcher and provider app-shell SSE. |
| presets `GET /` | **(a)** | `price_book.view` is held by all four roles, including provider. |
| presets `POST /:id/used` | **(a)** | Same `price_book.view` matrix. |
| presets `POST /` | **(a)** | `price_book.manage`: tenant_admin/manager; not dispatcher/provider. |
| presets `PATCH /:id` | **(a)** | Same `price_book.manage` matrix. |
| presets `DELETE /:id` | **(a)** | Same `price_book.manage` matrix. |
| sync `POST /today` | **(b)** | `reports.calls.view`: tenant_admin/manager/dispatcher; not provider, matching the live Calls page. |
| sync `POST /recent` | **(b)** | Same `reports.calls.view` matrix. |
| telephony `GET /autonomous-mode` | **(b)** | `phone_calls.use` is held by all four roles, so the app-wide banner is not locked out. |
| assistant `POST /chat` | **(b)** | `pulse.view` is held by all four roles, matching the app-wide feedback assistant. |

No outcome **(c)** is needed; no permission migration is shipped.

## Test contract

- `T-own`: allow cases exercise every Wave 2 handler using the authenticated company.
- `T-foreign`: all CRM/preset `:id` reads or mutations return 404 through company-scoped service/query paths; preset mutation tests prove the foreign snapshot is unchanged.
- `T-blast`: two SSE subscribers with the same call SID-shaped value receive events only in the event's company; unscoped events are delivered to neither. Manual sync passes the request company into tenant Twilio/reconcile paths.
- `R-matrix`: provider denies cover CRM contacts/leads and manual sync; dispatcher/provider denies cover every preset manage handler; effective-permission denies cover all-role gates; allow paths cover all 25 handlers.
- Role proof: `rbacWave2RoleSeeds.test.js` parses migration 050 and checks the exact expected fixed-role holders for every selected catalog key.
- Sabotage: remove one added CRM `contacts.view` gate; its provider deny case turns red; restore the exact edit before delivery.
