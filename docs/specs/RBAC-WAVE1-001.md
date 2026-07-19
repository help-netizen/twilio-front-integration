# RBAC-WAVE1-001 — high-damage route gates

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `POST /api/note-attachments/upload` | `req.companyFilter.company_id`; seeded `job_visibility` scope | `entity_type` + company-scoped entity id/lead UUID | job: `jobs.edit` OR `jobs.done_pending_approval`; lead: `leads.edit`; contact: `contacts.edit` | job: tenant_admin ✓, manager ✓, dispatcher ✓, provider ✓ assigned/✗ unassigned; lead/contact: tenant_admin ✓, manager ✓, dispatcher ✓, provider ✗ | Lead UUID and numeric ids are resolved with `company_id`; foreign/unassigned job returns 404 before S3 upload. |
| `GET /api/note-attachments/:id/url` | `req.companyFilter.company_id`; seeded `job_visibility` scope | attachment id, then stored `entity_type`/entity id | job: `jobs.view`; lead: `leads.view`; contact: `contacts.view` | job: tenant_admin ✓, manager ✓, dispatcher ✓, provider ✓ assigned/✗ unassigned; lead/contact: tenant_admin ✓, manager ✓, dispatcher ✓, provider ✗ | Attachment metadata is loaded by `(id, company_id)` and provider job assignment is checked before RBAC/S3, so inaccessible ids are 404 rather than 403. |
| `DELETE /api/note-attachments/:id` | `req.companyFilter.company_id`; seeded `job_visibility` scope | attachment id, then stored `entity_type`/entity id/stage owner | job: `jobs.edit`, or `jobs.done_pending_approval` for the provider's own staged upload; lead: `leads.edit`; contact: `contacts.edit` | job: tenant_admin ✓, manager ✓, dispatcher ✓; provider ✓ assigned own staged/✗ unassigned or committed; lead/contact: tenant_admin ✓, manager ✓, dispatcher ✓, provider ✗ | Preload/delete bind `(id, company_id)` and provider assignment; inaccessible id is 404 with no DB/S3 delete. Provider fallback cannot delete committed/other-user attachments. |
| `GET /api/portal/links` | inline `authenticate, requireCompanyAccess` → `req.companyFilter.company_id` | contact id; requested scope/document type | `estimates.send`, `invoices.send`, or both for full scope | tenant_admin ✓, manager ✓, provider ✓; dispatcher ✗ | `generatePortalLink` validates the contact's `company_id` before token creation; foreign contact is 404 with no token. |
| `GET /api/voice/token` | authenticated mount → `req.companyFilter.company_id` | membership user id + company id | `phone_calls.use` | tenant_admin ✓, manager ✓, dispatcher ✓, provider ✓ | Membership lookup and Twilio credential selection bind company; profile flag and group membership remain additional controls. |
| `GET /api/voice/phone-access` | authenticated mount → `req.companyFilter.company_id` | membership user id + company id | `phone_calls.use` | tenant_admin ✓, manager ✓, dispatcher ✓, provider ✓ | Membership and group checks bind company; no caller-selected tenant/entity id. |
| `POST /api/voice/presence` | authenticated mount → `req.companyFilter.company_id` | current user id + company id | `phone_calls.use` | tenant_admin ✓, manager ✓, dispatcher ✓, provider ✓ | Presence upsert key is `(company_id, user_id)`; no caller-selected tenant/entity id. |
| `GET /api/voice/check-busy` | authenticated mount → `req.companyFilter.company_id` | phone + company id | `phone_calls.use` | tenant_admin ✓, manager ✓, dispatcher ✓, provider ✓ | Phone is a shared natural key; lookup and stale-call update now bind `company_id` (`T-blast`). |
| `GET /api/voice/blanc-numbers` | authenticated mount → `req.companyFilter.company_id` | company id + current user's group membership | `phone_calls.use` | tenant_admin ✓, manager ✓, dispatcher ✓, provider ✓ | Number and group joins bind company; no caller-selected tenant/entity id. |

## Role-holder proof and outcomes

The fixed role keys come from `company_role_configs` in migrations 046/050. Runtime checks use effective permissions from `company_role_permissions` plus member overrides. Every key below is present in `permissionCatalog.js`.

| handler | outcome | seed proof |
|---|---|---|
| attachment `POST /upload` | **(b)** for jobs; **(a)** for leads/contacts | Migration 050 gives `jobs.edit` to tenant_admin/manager/dispatcher and `jobs.done_pending_approval` to all four roles. The latter is the existing job-note mutation gate, so provider mobile upload remains available without granting broad `jobs.edit`; the provider's seeded `job_visibility: assigned_only` is enforced. Migration 050 gives lead/contact edit only to the three office roles. |
| attachment `GET /:id/url` | **(a)** | Migration 050 gives `jobs.view` to all four roles and lead/contact view to tenant_admin/manager/dispatcher only; provider job visibility remains assigned-only. |
| attachment `DELETE /:id` | **(b)** for jobs; **(a)** for leads/contacts | Same write matrix as upload, but the provider fallback is limited to its own staged upload; committed job attachment removal remains behind the author-aware job-note mutation flow. |
| portal `GET /links` | **(b)** | `contacts.view` would lock out provider finance. The scope-specific send keys directly express authority to create the customer-document link: migrations 050 and 138 prove tenant_admin/manager/provider hold both send keys, while dispatcher holds neither. Thus tenant_admin/manager/provider retain legitimate document-sharing access and dispatcher is denied. |
| voice `GET /token` | **(a)** | Migration 050 grants `phone_calls.use` to tenant_admin, manager, dispatcher, and provider; the existing per-user `phone_calls_allowed` and group checks remain. |
| voice `GET /phone-access` | **(a)** | Same four-role `phone_calls.use` seed; this preserves dispatcher softphone and provider mobile checks. |
| voice `POST /presence` | **(a)** | Same four-role `phone_calls.use` seed; dispatcher/provider presence heartbeats remain allowed. |
| voice `GET /check-busy` | **(a)** | Same four-role `phone_calls.use` seed; every legitimate caller role retains the outbound collision check. |
| voice `GET /blanc-numbers` | **(a)** | Same four-role `phone_calls.use` seed; existing group assignment still limits the returned caller IDs. |

No outcome **(c)** is needed; no permission migration is shipped.

## Test contract

- `T-own`: allow cases exercise every handler with the selected company.
- `T-foreign`: attachment upload/URL/delete and portal contact tests return 404 before side effects. Voice routes have no caller-selected tenant/entity id.
- `T-blast`: `/check-busy` asserts the shared phone predicate includes `company_id`; other natural/external identifiers are already paired with company in their route/service lookup.
- `R-matrix`: provider deny cells cover lead/contact and unassigned-job attachments; dispatcher deny cells cover each portal scope; all seeded voice roles are allow cells, with an effective-permission deny control for every handler.
- Sabotage: removing one added `phone_calls.use` gate makes its deny test fail; restore before delivery.
