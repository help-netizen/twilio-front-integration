# AUTO-001 — Test Cases
## P0 backend
- TC-01: GET /catalog returns event/action/agent types (auth required → 401 без токена; 403 без tenant.company.manage)
- TC-02: POST /rules with unknown action type → 422
- TC-03: POST /rules with run_agent_task + unknown agent_type → 422
- TC-04: rules/runs and rule by id from another company → 404
- TC-05: seed-defaults idempotent (twice → 2 rules, not 4), is_system=true
- TC-06: agentWorker claims a queued task atomically, sets running→succeeded, emits agent_task.succeeded
- TC-07: agentWorker unknown agent_type → failed, no crash, error recorded
- TC-08: agentWorker mcp_tool handler builds tenant context and calls executor
- TC-09: retry of failed agent task re-queues; retry of running → 409
- TC-10: AR migration — when flag on, sms.inbound event triggers seed rule (set_action_required + create_task); when off, arConfigHelper path used
## P1 frontend
- TC-20: AutomationPage lists rules, create via editor persists (manual)
- TC-21: template preview renders {{contact.name}} sample (manual)
