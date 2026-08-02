<!-- GENERATED FILE — run `npm run gen:app-tools-doc` after changing the runtime catalog. -->

# APP-TOOLS-001 — App Studio tools (MCP + gateway API)

This reference is generated from the same three read-only descriptors used by Albusto App Studio and the service CRM MCP registry.

Exactly 3 tools are available: `svc.list_jobs`, `svc.get_job`, `svc.list_tasks`.

## Availability and transport

- App code calls `await ctx.callTool(name, args)`. It has no `fetch`, general HTTP API, network access, filesystem, dependencies, or arbitrary egress from the isolate.
- The internal gateway transport returns `{"ok":true,"data":<tool output>,"request_id":"..."}`. `ctx.callTool` unwraps it and returns only `<tool output>`.
- MCP `tools/list` exposes the same input and output schemas; a successful MCP call places the documented tool output in `structuredContent`.
- No write, send, message-delivery, trigger, scheduler, Contact, Call, Finance, or external-egress tool is available to App Studio.
- Live company, role, provider, Task-content, consent, masking, audit, rate, and run-call controls can narrow every call.

Arguments are JSON objects. Unknown parameters are rejected. Dates use the exact `YYYY-MM-DD` calendar form described by each parameter; timestamps in responses use ISO 8601.

## `svc.list_jobs`

List visible company Jobs with exact status, text, and inclusive start-date filters. Results are ordered by most recently updated first.

Required live permission: `jobs.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `status` | no | string ("Submitted", "Waiting for parts", "Part arrived", "Follow Up with Client", "Visit completed", "Job is Done", "Rescheduled", "Canceled", "On the way") | omitted | Exact Albusto Job workflow status to include. Omit to include every status. Returned Job rows expose this value as `blanc_status`; they do not contain a `status` field. |
| `search` | no | string | omitted | Case-insensitive text contained in the Job number, service name, customer name, customer phone, address, tag name, or searchable custom metadata. Omit for no text filter. |
| `start_date` | no | string, date | omitted | Inclusive lower bound on Job `start_date`, formatted `YYYY-MM-DD`. The boundary is midnight at the start of that calendar date in the owning company timezone. Missing or invalid company timezone configuration falls back to UTC. Omit for no lower bound. |
| `end_date` | no | string, date | omitted | Inclusive upper calendar date for Job `start_date`, formatted `YYYY-MM-DD`. The full day is included by using the following calendar date's midnight in the owning company timezone as an exclusive bound. Missing or invalid company timezone configuration falls back to UTC. Omit for no upper bound. |
| `only_open` | no | boolean | `false` | When true, excludes `Job is Done` and `Canceled`. Defaults to false; it does not mean "scheduled today" and does not replace date filters. |
| `limit` | no | integer | `50` | Maximum Job rows to return, from 1 through 100. Defaults to 50. |
| `offset` | no | integer | `0` | Zero-based row offset. Defaults to 0. Pass it explicitly and add `limit` while `has_more` is true to retrieve later pages. |

### Response

A page of visible Jobs and pagination metadata.

| Field | Type / values | Meaning |
|---|---|---|
| `results` | array<object> | Job rows for this page. |
| `results[].id` | integer \| string | Albusto Job ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `results[].lead_id` | integer \| string \| null | Linked Lead ID, when one exists. |
| `results[].lead_serial_id` | string \| null | Human-readable linked Lead serial ID. |
| `results[].contact_id` | integer \| string \| null | Linked Contact ID. |
| `results[].zenbooker_job_id` | string \| null | Linked Zenbooker Job ID, when synchronized. |
| `results[].blanc_status` | string | Current Albusto Job workflow status. This is the status field to use. |
| `results[].zb_status` | string \| null | Current provider substatus, when available. |
| `results[].zb_rescheduled` | boolean | Whether the provider marks the Job as rescheduled. |
| `results[].zb_canceled` | boolean | Whether the provider marks the Job as canceled. |
| `results[].job_number` | string \| null | Human-readable Job number. |
| `results[].service_name` | string \| null | Service name. |
| `results[].start_date` | string \| null, date-time | Scheduled start timestamp in ISO 8601 format. |
| `results[].end_date` | string \| null, date-time | Scheduled end timestamp in ISO 8601 format. |
| `results[].customer_name` | string \| null | Customer display name. |
| `results[].customer_phone` | string \| null | Customer phone; the field can be omitted by masking. |
| `results[].customer_email` | string \| null | Customer email. |
| `results[].address` | string \| null | Service street address. |
| `results[].city` | string \| null | Service city. |
| `results[].postal_code` | string \| null | Service postal code when the projection supplies it. |
| `results[].territory` | string \| null | Service territory. |
| `results[].invoice_total` | string \| number \| null | Provider invoice total when available. |
| `results[].invoice_status` | string \| null | Provider invoice status when available. |
| `results[].assigned_techs` | array<object> | Assigned technician summaries. |
| `results[].assigned_provider_user_ids` | array<string> | Albusto user IDs mirrored as assigned providers. |
| `results[].notes` | array<object> | Safe Job note summaries; secret-bearing keys are removed. |
| `results[].tags` | array<object> | Job tags. |
| `results[].tags[].id` | integer \| string | Tag ID. |
| `results[].tags[].name` | string | Tag name. |
| `results[].tags[].color` | string \| null | Tag color token. |
| `results[].tags[].is_active` | boolean | Whether the tag is active. |
| `results[].job_type` | string \| null | Job type inherited from the originating Lead when available. |
| `results[].job_source` | string \| null | Job acquisition source when available. |
| `results[].description` | string \| null | Job description. |
| `results[].comments` | string \| null | Job comments. |
| `results[].metadata` | object | Safe app-visible custom metadata. |
| `results[].company_id` | string | Owning company ID derived by the gateway; never accepted as input. |
| `results[].created_at` | string \| null, date-time | Creation timestamp in ISO 8601 format. |
| `results[].updated_at` | string \| null, date-time | Last update timestamp in ISO 8601 format. |
| `results[].lat` | number \| null | Service latitude when available. |
| `results[].lng` | number \| null | Service longitude when available. |
| `results[].amount_paid` | string \| number \| null | Locally recorded paid amount when an invoice exists. |
| `results[].balance_due` | string \| number \| null | Locally calculated outstanding amount when an invoice exists. |
| `total` | integer \| null | Total matching Jobs when calculated for this page. |
| `offset` | integer | Applied zero-based offset. |
| `limit` | integer | Applied page size. |
| `has_more` | boolean | Whether another page exists. |
| `facets` | object \| null | Available list facets when calculated for this page. |
| `facets.providers` | array<string> | Distinct visible provider names. |
| `pagination` | object | Pagination metadata for the returned page. |
| `pagination.mode` | string ("offset", "cursor") | Pagination mode: `offset` when offset was supplied, otherwise `cursor`. |
| `pagination.limit` | integer | Applied page size. |
| `pagination.returned` | integer | Number of rows in this page. |
| `pagination.has_more` | boolean | Whether another page exists. |
| `pagination.next_cursor` | string \| null | Opaque next-page cursor. Phase 1 App Studio descriptors do not accept it as input. |
| `pagination.total` | integer \| null | Total matching rows when calculated for this page. |

- The value returned by `ctx.callTool` is the documented object itself; the internal gateway envelope is already removed.

- Read Job status from `blanc_status`. There is no `status` field in a Job row.

- Sensitive provider payloads are removed. Phone-bearing fields may also be absent when company masking applies.

- Use offset pagination. Although `pagination.next_cursor` may be present, this Phase 1 descriptor does not accept a cursor argument.

### Errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | The arguments do not match the documented input schema. |
| `TOOL_NOT_CONSENTED` | The published app version or installation did not grant this tool. |
| `ACCESS_DENIED` | The live delegating user lacks the required business permission. |
| `RUN_CALL_LIMIT` | The run used its allowed gateway calls. |
| `RATE_LIMITED` | The installation exceeded its gateway request budget. |
| `AUDIT_UNAVAILABLE` | Albusto could not persist the required audit record, so no data was released. |

### Example

**Count every Job scheduled for today**

```js
export async function run(ctx) {
    const today = ctx.input.today;
    const page = await ctx.callTool('svc.list_jobs', {
        start_date: today,
        end_date: today,
        offset: 0,
        limit: 100,
    });
    return { count: page.results.length, has_more: page.has_more };
}
```

## `svc.get_job`

Get one visible company-owned Job by its Albusto numeric ID.

Required live permission: `jobs.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `job_id` | yes | integer | none | Positive Albusto Job ID, usually taken from `svc.list_jobs().results[].id`. |

### Response

One visible Job object. It has `blanc_status` and intentionally has no `status` or raw provider payload.

| Field | Type / values | Meaning |
|---|---|---|
| `id` | integer \| string | Albusto Job ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `lead_id` | integer \| string \| null | Linked Lead ID, when one exists. |
| `lead_serial_id` | string \| null | Human-readable linked Lead serial ID. |
| `contact_id` | integer \| string \| null | Linked Contact ID. |
| `zenbooker_job_id` | string \| null | Linked Zenbooker Job ID, when synchronized. |
| `blanc_status` | string | Current Albusto Job workflow status. This is the status field to use. |
| `zb_status` | string \| null | Current provider substatus, when available. |
| `zb_rescheduled` | boolean | Whether the provider marks the Job as rescheduled. |
| `zb_canceled` | boolean | Whether the provider marks the Job as canceled. |
| `job_number` | string \| null | Human-readable Job number. |
| `service_name` | string \| null | Service name. |
| `start_date` | string \| null, date-time | Scheduled start timestamp in ISO 8601 format. |
| `end_date` | string \| null, date-time | Scheduled end timestamp in ISO 8601 format. |
| `customer_name` | string \| null | Customer display name. |
| `customer_phone` | string \| null | Customer phone; the field can be omitted by masking. |
| `customer_email` | string \| null | Customer email. |
| `address` | string \| null | Service street address. |
| `city` | string \| null | Service city. |
| `postal_code` | string \| null | Service postal code when the projection supplies it. |
| `territory` | string \| null | Service territory. |
| `invoice_total` | string \| number \| null | Provider invoice total when available. |
| `invoice_status` | string \| null | Provider invoice status when available. |
| `assigned_techs` | array<object> | Assigned technician summaries. |
| `assigned_provider_user_ids` | array<string> | Albusto user IDs mirrored as assigned providers. |
| `notes` | array<object> | Safe Job note summaries; secret-bearing keys are removed. |
| `tags` | array<object> | Job tags. |
| `tags[].id` | integer \| string | Tag ID. |
| `tags[].name` | string | Tag name. |
| `tags[].color` | string \| null | Tag color token. |
| `tags[].is_active` | boolean | Whether the tag is active. |
| `job_type` | string \| null | Job type inherited from the originating Lead when available. |
| `job_source` | string \| null | Job acquisition source when available. |
| `description` | string \| null | Job description. |
| `comments` | string \| null | Job comments. |
| `metadata` | object | Safe app-visible custom metadata. |
| `company_id` | string | Owning company ID derived by the gateway; never accepted as input. |
| `created_at` | string \| null, date-time | Creation timestamp in ISO 8601 format. |
| `updated_at` | string \| null, date-time | Last update timestamp in ISO 8601 format. |
| `lat` | number \| null | Service latitude when available. |
| `lng` | number \| null | Service longitude when available. |

- The value returned by `ctx.callTool` is the Job object itself, not a `results` envelope.

- Read Job status from `blanc_status`. There is no `status` field in the Job object.

- Sensitive provider payloads are removed. Phone-bearing fields may also be absent when company masking applies.

### Errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | The arguments do not match the documented input schema. |
| `TOOL_NOT_CONSENTED` | The published app version or installation did not grant this tool. |
| `ACCESS_DENIED` | The live delegating user lacks the required business permission. |
| `RUN_CALL_LIMIT` | The run used its allowed gateway calls. |
| `RATE_LIMITED` | The installation exceeded its gateway request budget. |
| `AUDIT_UNAVAILABLE` | Albusto could not persist the required audit record, so no data was released. |
| `NOT_FOUND` | The Job does not exist or is outside the live company/provider scope. |

### Example

**Open the first visible Job**

```js
export async function run(ctx) {
    const page = await ctx.callTool('svc.list_jobs', { offset: 0, limit: 1 });
    if (page.results.length === 0) return null;
    return ctx.callTool('svc.get_job', { job_id: Number(page.results[0].id) });
}
```

## `svc.list_tasks`

List visible company Tasks with status, parent, due-date, overdue, and text filters. Results are ordered by due date ascending, with undated Tasks last.

Required live permission: `tasks.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `status` | no | string ("open", "done", "all") | `"open"` | Task status to include: `open`, `done`, or `all`. Defaults to `open`. |
| `parent_type` | no | string ("job", "lead", "estimate", "invoice", "contact", "timeline") | omitted | Restrict Tasks to one parent kind: `job`, `lead`, `estimate`, `invoice`, `contact`, or `timeline`. Omit for every parent kind. |
| `overdue` | no | boolean | `false` | When true, returns only open Tasks whose non-null `due_at` is earlier than the current time. Defaults to false. |
| `due_from` | no | string, date | omitted | Inclusive lower bound on Task `due_at`, formatted `YYYY-MM-DD`, at midnight at the start of that calendar date in the owning company timezone. Missing or invalid company timezone configuration falls back to UTC. Omit for no lower bound. |
| `due_to` | no | string, date | omitted | Inclusive upper calendar date for Task `due_at`, formatted `YYYY-MM-DD`. The full day is included by using the following calendar date's midnight in the owning company timezone as an exclusive bound. Missing or invalid company timezone configuration falls back to UTC. Omit for no upper bound. |
| `search` | no | string | omitted | Case-insensitive text contained in the Task description, parent label, or assignee name. Omit for no text filter. |
| `limit` | no | integer | `50` | Maximum Task rows to return, from 1 through 100. Defaults to 50. |
| `offset` | no | integer | `0` | Zero-based row offset. Defaults to 0. Pass it explicitly and add `limit` while `pagination.has_more` is true to retrieve later pages. |

### Response

A page of visible Tasks and pagination metadata.

| Field | Type / values | Meaning |
|---|---|---|
| `tasks` | array<object> | Task rows for this page. This key is `tasks`, not `results`. |
| `tasks[].id` | integer \| string | Albusto Task ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `tasks[].company_id` | string | Owning company ID derived by the gateway; never accepted as input. |
| `tasks[].description` | string | Task text. |
| `tasks[].status` | string ("open", "done") | Task status. |
| `tasks[].due_at` | string \| null, date-time | Due timestamp in ISO 8601 format. |
| `tasks[].completed_at` | string \| null, date-time | Completion timestamp in ISO 8601 format. |
| `tasks[].created_at` | string \| null, date-time | Creation timestamp in ISO 8601 format. |
| `tasks[].owner_user_id` | string \| null | Owning Albusto user ID. |
| `tasks[].author_user_id` | string \| null | Authoring Albusto user ID. |
| `tasks[].thread_id` | integer \| string \| null | Parent timeline ID for conversation Tasks. |
| `tasks[].kind` | string \| null | Task kind. |
| `tasks[].agent_type` | string \| null | Agent type for agent-created Tasks. |
| `tasks[].agent_output` | object \| array<any> \| string \| number \| boolean \| null | Safe structured agent output when available. |
| `tasks[].actions` | array<object> \| null | Available Task actions when present. |
| `tasks[].assignee_name` | string \| null | Assignee display name. |
| `tasks[].assignee_email` | string \| null | Assignee email. |
| `tasks[].author_name` | string \| null | Author display name. |
| `tasks[].parent_type` | string \| null ("job", "lead", "estimate", "invoice", "contact", "timeline", null) | Parent entity kind. |
| `tasks[].parent_id` | integer \| string \| null | Parent entity ID. |
| `tasks[].parent_label` | string \| null | Human-readable parent label. |
| `pagination` | object | Pagination metadata for the returned page. |
| `pagination.mode` | string ("offset", "cursor") | Pagination mode: `offset` when offset was supplied, otherwise `cursor`. |
| `pagination.limit` | integer | Applied page size. |
| `pagination.returned` | integer | Number of rows in this page. |
| `pagination.has_more` | boolean | Whether another page exists. |
| `pagination.next_cursor` | string \| null | Opaque next-page cursor. Phase 1 App Studio descriptors do not accept it as input. |
| `pagination.total` | integer \| null | Total matching rows when calculated for this page. |

- Task rows are under `tasks`, not `results`.

- The value returned by `ctx.callTool` is the documented object itself; the internal gateway envelope is already removed.

- Users without `tasks.manage` receive only Tasks they own or authored.

- Use offset pagination. Although `pagination.next_cursor` may be present, this Phase 1 descriptor does not accept a cursor argument.

### Errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | The arguments do not match the documented input schema. |
| `TOOL_NOT_CONSENTED` | The published app version or installation did not grant this tool. |
| `ACCESS_DENIED` | The live delegating user lacks the required business permission. |
| `RUN_CALL_LIMIT` | The run used its allowed gateway calls. |
| `RATE_LIMITED` | The installation exceeded its gateway request budget. |
| `AUDIT_UNAVAILABLE` | Albusto could not persist the required audit record, so no data was released. |

### Example

**List open Tasks due today**

```js
export async function run(ctx) {
    const today = ctx.input.today;
    const page = await ctx.callTool('svc.list_tasks', {
        status: 'open',
        due_from: today,
        due_to: today,
        offset: 0,
        limit: 100,
    });
    return page.tasks
        .map((task) => ({
            id: task.id,
            description: task.description,
            parent: task.parent_label,
        }));
}
```
