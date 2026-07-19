# RBAC-WAVE3-001 — MCP agent-tool transport

## Decisions

The authenticated HTTP transports are CRM-user surfaces: `src/server.js:262,266`
mount them behind `authenticate, requireCompanyAccess`. CRM automation is the only
in-process MCP executor caller (`agentHandlers.js:16-30`); it uses the durable task's
company and an explicit read-only machine permission set. Public HTTP uses a timing-safe
bearer token and env-bound company/user context; stdio is env-bound.

Sara does **not** call MCP. Her 15 deployed tool definitions target `/api/vapi-tools`
(`lead-qualifier-v2.json:21-27` and peers), which authenticates `x-vapi-secret`
(`vapi-tools.js:51-65`) and calls `agentSkills.runSkill` directly
(`vapi-tools.js:133-143`). Outcome **(a)**: her identity/path and all 15 tools are
unchanged; no migration or grant is required.

The caller cannot choose a tenant. MCP executors derive company only from
`req.companyFilter.company_id`; public/stdio use server environment; automation uses
`task.company_id`. `company_id` and `companyId` tool arguments are stripped before
validation/dispatch. No cross-tenant action hole was found.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET /api/{crm,agent-skills}/mcp/tools` and JSON-RPC `tools/list` | authenticated `req.companyFilter.company_id` | tool registry name | each tool's map below | filtered to effective permissions | Unmapped tools are not advertised. |
| `POST /api/crm/mcp/call` and JSON-RPC `tools/call` | authenticated `req.companyFilter.company_id` | CRM entity id/filter | each tool's map below | contacts/leads: admin/manager/dispatcher ✓, provider ✗; tasks: all ✓; writes: admin/manager ✓ | Permission is checked before argument validation and dispatch; write confirmation remains additive. |
| `POST /api/agent-skills/mcp/call` and JSON-RPC `tools/call` | authenticated `req.companyFilter.company_id` | verified contact plus job/lead/document id | each tool's map below | reads follow existing catalog roles; human writes additionally need unseeded `service.crm.write` | Skill verification/ownership and write confirmation remain additive. |
| public/stdio CRM MCP | env-bound company/user | machine bearer token or process environment | explicit contacts/leads/tasks read scope; `sales.crm.write` only when enabled | machine identity only | Payload cannot select company; writes remain off by default. |
| public/stdio service MCP | env-bound company | machine bearer token or process environment | explicit read scope; explicit service/business write scope only when enabled | machine identity only | Payload cannot select company; writes remain off by default. |
| Sara `/api/vapi-tools` | hard-bound default company | `x-vapi-secret`; skill name | existing skill L0/L1 and ownership gates | Sara machine identity ✓ | Separate path; Wave 3 does not intercept or alter it. |

## Per-tool permission map

| tools | required permission(s) |
|---|---|
| `svc.identify_caller`, `svc.get_customer_overview` | `contacts.view` |
| `svc.get_job_status`, `svc.get_appointments`, `svc.get_job_history` | `jobs.view` |
| `svc.get_estimate_summary` | `estimates.view` |
| `svc.get_invoice_summary` | `invoices.view` |
| `svc.reschedule_appointment` | `jobs.edit` + framework `service.crm.write` + confirmation |
| `svc.cancel_appointment` | `jobs.close` + framework `service.crm.write` + confirmation |
| `svc.book_on_lead` | `leads.edit` + `leads.create` + framework `service.crm.write` + confirmation |
| CRM account/contact/activity/note/metadata/workflow/account-list reads | `contacts.view` |
| CRM deal/pipeline/forecast/deal-list/history reads | `leads.view` |
| CRM task reads | `tasks.view` |
| CRM deal/task/note writes | `sales.crm.write` + confirmation |

All registry entries declare `requiredPermissions`. Authorization requires every
declared key; a missing/empty declaration fails closed. No permission migration is
shipped: existing fixed-role seeds already define this matrix.

## Test contract

- `T-own`: allowed `/call` and JSON-RPC paths dispatch with the authenticated company.
- `T-foreign`/`T-blast`: caller-supplied `company_id` is removed and cannot replace the authenticated/env/task company; no foreign service call occurs.
- `R-matrix`: every fixed-role allow and deny cell is table-tested from migrations 050/088; a read-only caller cannot invoke a write tool.
- Discovery is permission-filtered; an unmapped tool is denied before dispatch.
- Sara proof parses the deployed assistant: exactly 15 `/api/vapi-tools` definitions, all still registered in the provider-neutral skill registry.
- Sabotage: granting `svc.reschedule_appointment` on `jobs.view` makes the read-only deny test fail; restore before delivery.
