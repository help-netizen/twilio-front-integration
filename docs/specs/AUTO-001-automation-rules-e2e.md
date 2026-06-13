# AUTO-001 — Automation/Rules Engine E2E — Spec

## API (all under /api/automation, tenant.company.manage, company-scoped)
- `GET /catalog` → { event_types:[{key,label,sample_fields}], action_types:[{type,params_schema}], agent_types:[{type,label}] }
- `GET /rules` → existing; add `is_system` flag in rows
- `POST/PATCH/DELETE /rules[/:id]` → existing (validate actions/agent_types)
- `GET /rules/:id/runs` → existing
- `POST /rules/seed-defaults` → creates AR-equivalent seed rules for the company (idempotent, is_system=true)
- `GET /agent-tasks?status=` → list tasks kind=agent (company-scoped)
- `POST /agent-tasks/:id/retry` → re-queue a failed agent task

## Agent worker (backend, in-process)
- Loop interval 5s (env AGENT_WORKER_INTERVAL_MS). Per tick:
  claim up to N queued agent tasks atomically:
  `UPDATE tasks SET agent_status='running', updated_at=now()
   WHERE id IN (SELECT id FROM tasks WHERE kind='agent' AND agent_status='queued'
                AND company_id IS NOT NULL ORDER BY created_at LIMIT $N FOR UPDATE SKIP LOCKED)
   RETURNING *`
- For each: dispatch agentHandlers[agent_type](task) → output; on success
  agent_status='succeeded', status='done', emit agent_task.succeeded
  {company_id, agent_type, task_id, duration_ms}; on throw agent_status='failed',
  error in agent_output.error, emit agent_task.failed.
- Unknown agent_type → failed with clear error (no crash).
- Worker disabled when FEATURE_AGENT_WORKER!=='true' (default on in prod boot,
  off in tests).

## Agent handlers
- `mcp_tool`: input {tool, args}; builds synthetic context
  { user:{crmUser:{}}, companyFilter:{company_id} } and calls
  crmMcpToolExecutor.execute. Returns tool result.
- `summarize_thread`: input {timeline_id}; concatenates recent messages, returns
  a short summary (uses existing summary provider if configured, else heuristic).
- `noop`: echoes input (for tests/templates).

## AR migration
- `rulesSeed.seedDefaultRules(companyId)` inserts two is_system rules:
  1) trigger event `sms.inbound` → action set_action_required + create_task(p1,SLA10)
  2) trigger event `call.missed` → (disabled by default) create_task(p2,SLA30)
- When FEATURE_RULES_ENGINE_AR==='true': conversationsService/inboxWorker skip
  arConfigHelper path (rules engine handles it via emitted events sms.inbound /
  call.missed). Old path remains when flag off.
- conversationsService must emit `sms.inbound`; inboxWorker must emit
  `call.missed` to the bus (new emits, additive).

## Error contracts
- 401 no auth, 403 wrong permission, 404 foreign/missing rule|task,
  422 invalid rule (bad trigger/action/agent_type).

## Edge cases
- Rule with action referencing missing template field → renders empty (no throw).
- Agent task retried while running → 409.
- Seed-defaults called twice → no duplicates (unique on company_id+is_system+name).
