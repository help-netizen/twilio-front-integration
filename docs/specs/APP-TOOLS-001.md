<!-- GENERATED FILE — run `npm run gen:app-tools-doc` after changing the runtime catalog. -->

# APP-TOOLS-001 — App Studio tools (MCP + gateway API)

This reference is generated from the same 11 descriptors used by Albusto App Studio and the service CRM MCP registry.

Exactly 11 tools are available: `svc.list_jobs`, `svc.get_job`, `svc.list_tasks`, `svc.create_task`, `svc.list_estimates`, `svc.get_estimate`, `svc.add_note`, `svc.list_leads`, `svc.get_lead`, `svc.list_invoices`, `svc.list_payments`.

## Availability and transport

- App code calls `await ctx.callTool(name, args)`. It has no `fetch`, general HTTP API, network access, filesystem, dependencies, or arbitrary egress from the isolate.
- The internal gateway transport returns `{"ok":true,"data":<tool output>,"request_id":"..."}`. `ctx.callTool` unwraps it and returns only `<tool output>`.
- MCP `tools/list` exposes the same input and output schemas; a successful MCP call places the documented tool output in `structuredContent`.
- The CRM write tools are `svc.create_task`, `svc.add_note`; no send, message-delivery, trigger, scheduler, payment mutation, invoice mutation, or external-egress tool is available to App Studio.
- Live company, role, provider, Task-content, consent, masking, audit, rate, and run-call controls can narrow every call.

Arguments are JSON objects. Unknown parameters are rejected. Dates use the exact `YYYY-MM-DD` calendar form described by each parameter; timestamps in responses use ISO 8601.

## `svc.list_jobs`

List visible company Jobs with exact status, text, and inclusive start-date filters. Results are ordered by most recently updated first.

Tool kind: `read`.

Required live permission: `jobs.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `status` | no | string ("Submitted", "Waiting for parts", "Part arrived", "Follow Up with Client", "Visit completed", "Job is Done", "Rescheduled", "Canceled", "On the way") | omitted | Exact Albusto Job workflow status to include. Omit to include every status. Returned Job rows expose this value as `blanc_status`; they do not contain a `status` field. |
| `search` | no | string | omitted | Case-insensitive text matching the Job # (`job_seq`), legacy number, public code, service name, customer name, customer phone, address, tag name, or searchable custom metadata. Omit for no text filter. |
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
| `results[].job_number` | string \| null | Legacy Zenbooker number; null for native jobs. |
| `results[].job_seq` | integer \| null | Per-company Job # shown in the app. |
| `results[].public_code` | string \| null | Durable global job code for /j/:code links. |
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

Tool kind: `read`.

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
| `job_number` | string \| null | Legacy Zenbooker number; null for native jobs. |
| `job_seq` | integer \| null | Per-company Job # shown in the app. |
| `public_code` | string \| null | Durable global job code for /j/:code links. |
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

Tool kind: `read`.

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

## `svc.create_task`

Create an unassigned open Task that is visible to people in Albusto. Repeated open Tasks are deduplicated by installation, parent, and description. App runs may make at most 3 write calls.

Tool kind: `write`.

Required live permission: `tasks.create`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `parent_type` | yes | string ("job", "lead", "estimate", "invoice", "contact") | none | Parent entity kind for the new Task: `job`, `lead`, `estimate`, `invoice`, or `contact`. |
| `parent_id` | yes | integer | none | Positive Albusto parent entity ID. The parent must belong to the installation company. |
| `description` | yes | string | none | Task text shown to people in Albusto. It must be non-empty and contain at most 500 characters after trimming. |
| `due_at` | no | string, date-or-date-time | omitted | Optional due date or timestamp. A `YYYY-MM-DD` date means midnight at the start of that company-local calendar date. A timestamp must be ISO 8601 with `Z` or an explicit offset. |

### Response

The open Task identity and whether an existing Task was reused.

| Field | Type / values | Meaning |
|---|---|---|
| `task_id` | integer \| string | Albusto Task ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `status` | string ("open") | Task status. |
| `deduplicated` | boolean | True only when an existing matching open Task was returned instead of creating another row. |

- The created Task is open, visible to people in Albusto, unassigned, and authored by the installation agent principal.

- If this installation already has an open Task with the same parent and description, no Task is created and `deduplicated` is true.

- Each invocation consumes one of the run's 3 write calls, including a deduplicated invocation.

### Errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | The arguments do not match the documented input schema. |
| `TOOL_NOT_CONSENTED` | The published app version or installation did not grant this tool. |
| `ACCESS_DENIED` | The live delegating user lacks the required business permission. |
| `RUN_CALL_LIMIT` | The run used its allowed gateway calls. |
| `RATE_LIMITED` | The installation exceeded its gateway request budget. |
| `AUDIT_UNAVAILABLE` | Albusto could not persist the required audit record, so no data was released. |
| `NOT_FOUND` | The Task parent does not exist or is outside the live company scope. |
| `WRITE_CALL_LIMIT` | The run used its 3 allowed write calls. |
| `TASK_DAILY_LIMIT` | The installation created its daily maximum of 100 Tasks. |

### Example

**Create an attention Task for an Estimate**

```js
export async function run(ctx) {
    return ctx.callTool('svc.create_task', {
        parent_type: 'estimate',
        parent_id: 41,
        description: 'Review the approved estimate parts before ordering.',
        due_at: ctx.input.today,
    });
}
```

## `svc.list_estimates`

List company-owned Estimates with exact status, accepted-date, and text filters. Results are ordered by newest creation time first.

Tool kind: `read`.

Required live permission: `estimates.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `status` | no | string ("draft", "sent", "viewed", "approved", "declined") | omitted | Exact Estimate status to include: `draft`, `sent`, `viewed`, `approved`, or `declined`. Omit to include every status. |
| `accepted_from` | no | string, date | omitted | Inclusive lower bound on Estimate `accepted_at`, formatted `YYYY-MM-DD`. The boundary is midnight at the start of that calendar date in the owning company timezone. Estimates without `accepted_at` do not match. Missing or invalid company timezone configuration falls back to UTC. Omit for no lower bound. |
| `accepted_to` | no | string, date | omitted | Inclusive upper calendar date for Estimate `accepted_at`, formatted `YYYY-MM-DD`. The full company-local day is included by using the following calendar date's midnight as an exclusive bound. Estimates without `accepted_at` do not match. Missing or invalid company timezone configuration falls back to UTC. Omit for no upper bound. |
| `search` | no | string | omitted | Case-insensitive text contained in the Estimate number, summary, or notes. Omit for no text filter. |
| `limit` | no | integer | `50` | Maximum Estimate rows to return, from 1 through 100. Defaults to 50. |
| `offset` | no | integer | `0` | Zero-based row offset. Defaults to 0. Add `limit` while `pagination.has_more` is true to retrieve later pages. |

### Response

A page of company-owned Estimates and pagination metadata.

| Field | Type / values | Meaning |
|---|---|---|
| `results` | array<object> | Estimate summary rows for this page. |
| `results[].id` | integer \| string | Albusto Estimate ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `results[].estimate_number` | string | Human-readable Estimate number. |
| `results[].status` | string ("draft", "sent", "viewed", "approved", "declined") | Current Estimate status. |
| `results[].subtotal` | string \| number | Estimate subtotal before tax. |
| `results[].tax_amount` | string \| number | Estimate tax amount. |
| `results[].total` | string \| number | Estimate total including tax. |
| `results[].contact_id` | integer \| string \| null | Linked Contact ID, when one exists. |
| `results[].job_id` | integer \| string \| null | Linked Job ID, when one exists. |
| `results[].lead_id` | integer \| string \| null | Linked Lead ID, when one exists. |
| `results[].accepted_at` | string \| null, date-time | Approval timestamp in ISO 8601 format; null until the Estimate is approved. |
| `results[].created_at` | string, date-time | Creation timestamp in ISO 8601 format. |
| `results[].items_count` | integer | Number of line items on the Estimate. |
| `results[].order_list_count` | integer | Number of internal parts-to-order rows. This can be zero. |
| `pagination` | object | Offset pagination metadata for the returned Estimate page. |
| `pagination.mode` | string ("offset") | Pagination mode. Estimate pages always use `offset`. |
| `pagination.limit` | integer | Applied page size. |
| `pagination.returned` | integer | Number of Estimate rows in this page. |
| `pagination.has_more` | boolean | Whether another Estimate page exists. |
| `pagination.next_cursor` | string \| null | Always null because Estimate pages use offset pagination. |
| `pagination.total` | integer | Total matching Estimates. |

- The value returned by `ctx.callTool` is the documented object itself; the internal gateway envelope is already removed.

- `accepted_from` and `accepted_to` are inclusive company-calendar dates applied only to `accepted_at`; the upper bound includes the entire selected day.

- `order_list_count` can be zero. Use `svc.get_estimate` to read the internal parts list for a selected Estimate.

- Use offset pagination. Results are ordered by `created_at` descending, then Estimate ID descending.

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

**List approved Estimates accepted today**

```js
export async function run(ctx) {
    return ctx.callTool('svc.list_estimates', {
        status: 'approved',
        accepted_from: ctx.input.today,
        accepted_to: ctx.input.today,
        offset: 0,
        limit: 100,
    });
}
```

## `svc.get_estimate`

Get one company-owned Estimate with its customer-facing line items and internal parts-to-order list.

Tool kind: `read`.

Required live permission: `estimates.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `estimate_id` | yes | integer | none | Positive Albusto Estimate ID, usually taken from `svc.list_estimates().results[].id`. |

### Response

One company-owned Estimate with line items and its internal parts-to-order list.

| Field | Type / values | Meaning |
|---|---|---|
| `id` | integer \| string | Albusto Estimate ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `estimate_number` | string | Human-readable Estimate number. |
| `status` | string ("draft", "sent", "viewed", "approved", "declined") | Current Estimate status. |
| `subtotal` | string \| number | Estimate subtotal before tax. |
| `tax_amount` | string \| number | Estimate tax amount. |
| `total` | string \| number | Estimate total including tax. |
| `contact_id` | integer \| string \| null | Linked Contact ID, when one exists. |
| `job_id` | integer \| string \| null | Linked Job ID, when one exists. |
| `lead_id` | integer \| string \| null | Linked Lead ID, when one exists. |
| `accepted_at` | string \| null, date-time | Approval timestamp in ISO 8601 format; null until the Estimate is approved. |
| `created_at` | string, date-time | Creation timestamp in ISO 8601 format. |
| `items_count` | integer | Number of line items on the Estimate. |
| `order_list_count` | integer | Number of internal parts-to-order rows. This can be zero. |
| `items` | array<object> | Customer-facing Estimate line items in their saved display order. This array may be empty. |
| `items[].name` | string | Line-item name. |
| `items[].description` | string \| null | Line-item description, when present. |
| `items[].quantity` | string \| number | Line-item quantity. |
| `items[].unit` | string \| null | Unit label, when present. |
| `items[].unit_price` | string \| number | Price per unit. |
| `items[].amount` | string \| number | Extended line amount. |
| `items[].item_type` | string \| null | Line-item type, when classified. |
| `order_list` | array<object> | Internal parts-to-order rows. This array may be empty. |
| `order_list[].part_number` | string | Manufacturer or distributor part number. |
| `order_list[].part_name` | string | English part name. |
| `order_list[].quantity` | number | Quantity to order. |

- The value returned by `ctx.callTool` is the Estimate object itself, not a `results` envelope.

- `items` and `order_list` are always arrays and may be empty.

- `order_list` is the internal parts-to-order list. Each row contains only `part_number`, `part_name`, and `quantity`; it does not contain prices.

### Errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | The arguments do not match the documented input schema. |
| `TOOL_NOT_CONSENTED` | The published app version or installation did not grant this tool. |
| `ACCESS_DENIED` | The live delegating user lacks the required business permission. |
| `RUN_CALL_LIMIT` | The run used its allowed gateway calls. |
| `RATE_LIMITED` | The installation exceeded its gateway request budget. |
| `AUDIT_UNAVAILABLE` | Albusto could not persist the required audit record, so no data was released. |
| `NOT_FOUND` | The Estimate does not exist or is outside the live company scope. |

### Example

**Read the parts required by an approved Estimate**

```js
export async function run(ctx) {
    const page = await ctx.callTool('svc.list_estimates', {
        status: 'approved',
        offset: 0,
        limit: 1,
    });
    if (page.results.length === 0) return [];
    const estimate = await ctx.callTool('svc.get_estimate', {
        estimate_id: Number(page.results[0].id),
    });
    return estimate.order_list;
}
```

## `svc.add_note`

Add an internal text Note to a company-owned Job or Lead. The same installation, parent, and text are deduplicated for 24 hours; App runs share a maximum of 3 write calls.

Tool kind: `write`.

Required live permission: `jobs.edit or jobs.done_pending_approval or leads.edit`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `parent_type` | yes | string ("job", "lead") | none | Parent entity kind for the Note: `job` or `lead`. |
| `parent_id` | yes | integer | none | Positive Albusto Job or Lead numeric ID. The parent must belong to the installation company. |
| `text` | yes | string | none | Internal Note text shown to people in Albusto. It must be non-empty and contain at most 1000 characters after trimming. |

### Response

The internal Note identity and whether an existing recent Note was reused.

| Field | Type / values | Meaning |
|---|---|---|
| `note_id` | string | Albusto Note UUID. |
| `deduplicated` | boolean | True only when the same installation already added the same text to the same parent during the preceding 24 hours. |

- The Note is authored by the installation agent principal and marked with its App Studio source and installation ID.

- If this installation added the same text to the same parent during the preceding 24 hours, no Note is created and `deduplicated` is true.

- Each invocation consumes one of the run's 3 shared write calls, including a deduplicated invocation and calls to `svc.create_task`.

### Errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | The arguments do not match the documented input schema. |
| `TOOL_NOT_CONSENTED` | The published app version or installation did not grant this tool. |
| `ACCESS_DENIED` | The live delegating user lacks the required business permission. |
| `RUN_CALL_LIMIT` | The run used its allowed gateway calls. |
| `RATE_LIMITED` | The installation exceeded its gateway request budget. |
| `AUDIT_UNAVAILABLE` | Albusto could not persist the required audit record, so no data was released. |
| `NOT_FOUND` | The Note parent does not exist or is outside the live company scope. |
| `WRITE_CALL_LIMIT` | The run used its 3 allowed write calls shared by every App Studio write tool. |
| `NOTE_DAILY_LIMIT` | The installation created its daily maximum of 100 Notes. |

### Example

**Add an internal Note to a Lead**

```js
export async function run(ctx) {
    return ctx.callTool('svc.add_note', {
        parent_type: 'lead',
        parent_id: Number(ctx.input.lead_id),
        text: 'Customer requested a follow-up before scheduling.',
    });
}
```

## `svc.list_leads`

List company-owned Leads with exact status, source, company-calendar creation-date, and text filters. Results are PII-lean and ordered by newest creation time first.

Tool kind: `read`.

Required live permission: `leads.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `status` | no | string | omitted | Exact Lead workflow status to include. Omit to include every status. |
| `source` | no | string | omitted | Exact Lead acquisition source (`job_source`) to include. Omit to include every source. |
| `created_from` | no | string, date | omitted | Inclusive lower bound on Lead `created_at`, formatted `YYYY-MM-DD`. The boundary is midnight at the start of that calendar date in the owning company timezone. Missing or invalid company timezone configuration falls back to UTC. Omit for no lower bound. |
| `created_to` | no | string, date | omitted | Inclusive upper calendar date for Lead `created_at`, formatted `YYYY-MM-DD`. The full company-local day is included by using the following calendar date's midnight as an exclusive bound. Missing or invalid company timezone configuration falls back to UTC. Omit for no upper bound. |
| `search` | no | string | omitted | Case-insensitive text contained in the Lead UUID, serial ID, customer name, city, state, or source. Phone and email are not searched or returned by this list tool. |
| `limit` | no | integer | `50` | Maximum Lead rows to return, from 1 through 100. Defaults to 50. |
| `offset` | no | integer | `0` | Zero-based row offset. Defaults to 0. Add `limit` while `pagination.has_more` is true to retrieve later pages. |

### Response

A PII-lean page of company-owned Leads and pagination metadata.

| Field | Type / values | Meaning |
|---|---|---|
| `results` | array<object> | Lead summary rows for this page; phone and email are intentionally absent. |
| `results[].id` | integer \| string | Albusto Lead ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `results[].uuid` | string | Stable Lead UUID used by existing Albusto interfaces. |
| `results[].serial_id` | integer \| string | Human-readable or numeric Lead serial ID. |
| `results[].status` | string | Current Lead workflow status. |
| `results[].source` | string \| null | Lead acquisition source, backed by `job_source`. |
| `results[].job_source` | string \| null | Stored Lead acquisition source; equal to `source`. |
| `results[].first_name` | string \| null | Customer first name. |
| `results[].last_name` | string \| null | Customer last name. |
| `results[].city` | string \| null | Service city. |
| `results[].state` | string \| null | Service state or region. |
| `results[].created_at` | string, date-time | Lead creation timestamp in ISO 8601 format. |
| `results[].converted_at` | string \| null, date-time | Lead conversion timestamp in ISO 8601 format, when converted. |
| `results[].contact_id` | integer \| string \| null | Linked Contact ID, when one exists. |
| `results[].converted_to_job` | boolean | Whether the Lead has been converted to a Job. |
| `pagination` | object | Offset pagination metadata for the returned Lead page. |
| `pagination.mode` | string ("offset") | Pagination mode. Lead pages always use `offset`. |
| `pagination.limit` | integer | Applied page size. |
| `pagination.returned` | integer | Number of Lead rows in this page. |
| `pagination.has_more` | boolean | Whether another Lead page exists. |
| `pagination.next_cursor` | string \| null | Always null because Lead pages use offset pagination. |
| `pagination.total` | integer | Total matching Lead rows. |

- List rows intentionally omit phone, email, street address, job type, and Lead notes. Use `svc.get_lead` for one selected Lead when those fields are needed.

- `source` and `job_source` are equal aliases of the stored Lead acquisition source.

- `created_from` and `created_to` are inclusive company-calendar dates; the upper bound includes the entire selected day.

- Use offset pagination. Results are ordered by `created_at` descending, then Lead ID descending.

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

**List Leads created today without exposing phone or email**

```js
export async function run(ctx) {
    return ctx.callTool('svc.list_leads', {
        created_from: ctx.input.today,
        created_to: ctx.input.today,
        offset: 0,
        limit: 100,
    });
}
```

## `svc.get_lead`

Get one company-owned Lead by numeric Albusto ID, including its direct contact fields and Lead notes.

Tool kind: `read`.

Required live permission: `leads.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `lead_id` | yes | integer | none | Positive Albusto Lead ID, usually taken from `svc.list_leads().results[].id`. |

### Response

One company-owned Lead including its direct contact and request-detail fields.

| Field | Type / values | Meaning |
|---|---|---|
| `id` | integer \| string | Albusto Lead ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `uuid` | string | Stable Lead UUID used by existing Albusto interfaces. |
| `serial_id` | integer \| string | Human-readable or numeric Lead serial ID. |
| `status` | string | Current Lead workflow status. |
| `source` | string \| null | Lead acquisition source, backed by `job_source`. |
| `job_source` | string \| null | Stored Lead acquisition source; equal to `source`. |
| `first_name` | string \| null | Customer first name. |
| `last_name` | string \| null | Customer last name. |
| `city` | string \| null | Service city. |
| `state` | string \| null | Service state or region. |
| `created_at` | string, date-time | Lead creation timestamp in ISO 8601 format. |
| `converted_at` | string \| null, date-time | Lead conversion timestamp in ISO 8601 format, when converted. |
| `contact_id` | integer \| string \| null | Linked Contact ID, when one exists. |
| `converted_to_job` | boolean | Whether the Lead has been converted to a Job. |
| `phone` | string \| null | Lead phone number. |
| `email` | string \| null | Lead email address. |
| `address` | string \| null | Lead service street address. |
| `job_type` | string \| null | Requested service or Job type. |
| `lead_notes` | string \| null | Lead request notes or problem description. |

- The value returned by `ctx.callTool` is the Lead object itself, not a `results` envelope.

- Unlike `svc.list_leads`, this detail tool includes phone, email, street address, job type, and Lead notes.

- `source` and `job_source` are equal aliases of the stored Lead acquisition source.

### Errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | The arguments do not match the documented input schema. |
| `TOOL_NOT_CONSENTED` | The published app version or installation did not grant this tool. |
| `ACCESS_DENIED` | The live delegating user lacks the required business permission. |
| `RUN_CALL_LIMIT` | The run used its allowed gateway calls. |
| `RATE_LIMITED` | The installation exceeded its gateway request budget. |
| `AUDIT_UNAVAILABLE` | Albusto could not persist the required audit record, so no data was released. |
| `NOT_FOUND` | The Lead does not exist or is outside the live company scope. |

### Example

**Open the first matching Lead**

```js
export async function run(ctx) {
    const page = await ctx.callTool('svc.list_leads', { offset: 0, limit: 1 });
    if (page.results.length === 0) return null;
    return ctx.callTool('svc.get_lead', {
        lead_id: Number(page.results[0].id),
    });
}
```

## `svc.list_invoices`

List company-owned Invoices with exact status, Job, and company-calendar creation-date filters. Results are ordered by newest creation time first.

Tool kind: `read`.

Required live permission: `invoices.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `status` | no | string | omitted | Exact Invoice status to include. Omit to include every status. |
| `job_id` | no | integer | omitted | Restrict results to one positive Albusto Job ID. Omit to include Invoices for every Job. |
| `created_from` | no | string, date | omitted | Inclusive lower bound on Invoice `created_at`, formatted `YYYY-MM-DD`, at company-local midnight. Missing or invalid company timezone configuration falls back to UTC. Omit for no lower bound. |
| `created_to` | no | string, date | omitted | Inclusive upper calendar date for Invoice `created_at`, formatted `YYYY-MM-DD`. The following company-local midnight is used as an exclusive bound. Missing or invalid company timezone configuration falls back to UTC. Omit for no upper bound. |
| `limit` | no | integer | `50` | Maximum Invoice rows to return, from 1 through 100. Defaults to 50. |
| `offset` | no | integer | `0` | Zero-based row offset. Defaults to 0. Add `limit` while `pagination.has_more` is true to retrieve later pages. |

### Response

A page of company-owned Invoices and pagination metadata.

| Field | Type / values | Meaning |
|---|---|---|
| `results` | array<object> | Invoice summary rows for this page. |
| `results[].id` | integer \| string | Albusto Invoice ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `results[].invoice_number` | string | Human-readable Invoice number. |
| `results[].status` | string | Current Invoice status. |
| `results[].total` | string \| number | Invoice total. |
| `results[].amount_paid` | string \| number | Amount already paid against the Invoice. |
| `results[].balance_due` | string \| number | Outstanding amount calculated as total minus amount paid. |
| `results[].job_id` | integer \| string \| null | Linked Job ID, when one exists. |
| `results[].contact_id` | integer \| string \| null | Linked Contact ID, when one exists. |
| `results[].created_at` | string, date-time | Invoice creation timestamp in ISO 8601 format. |
| `results[].due_at` | string \| null, date-time | Invoice due timestamp in ISO 8601 format, when set. |
| `pagination` | object | Offset pagination metadata for the returned Invoice page. |
| `pagination.mode` | string ("offset") | Pagination mode. Invoice pages always use `offset`. |
| `pagination.limit` | integer | Applied page size. |
| `pagination.returned` | integer | Number of Invoice rows in this page. |
| `pagination.has_more` | boolean | Whether another Invoice page exists. |
| `pagination.next_cursor` | string \| null | Always null because Invoice pages use offset pagination. |
| `pagination.total` | integer | Total matching Invoice rows. |

- `balance_due` is calculated as `total - amount_paid` so stale materialized balances are not exposed.

- `due_at` is the Invoice due timestamp stored by Albusto as `due_date`.

- `created_from` and `created_to` are inclusive company-calendar dates.

- Use offset pagination. Results are ordered by `created_at` descending, then Invoice ID descending.

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

**List open Invoices created today**

```js
export async function run(ctx) {
    return ctx.callTool('svc.list_invoices', {
        status: 'sent',
        created_from: ctx.input.today,
        created_to: ctx.input.today,
        offset: 0,
        limit: 100,
    });
}
```

## `svc.list_payments`

List company-owned canonical payment-ledger rows with Job, Invoice, and company-calendar paid-date filters. Results are ordered by newest paid time first.

Tool kind: `read`.

Required live permission: `payments.view or financial_data.view`.

### Parameters

| Parameter | Required | Type / values | Default | Meaning |
|---|:---:|---|---|---|
| `job_id` | no | integer | omitted | Restrict results to one positive Albusto Job ID. Callers with only `financial_data.view` must provide an assigned Job ID. |
| `invoice_id` | no | integer | omitted | Restrict results to one positive Albusto Invoice ID. Omit to include payments for every Invoice in the allowed Job scope. |
| `paid_from` | no | string, date | omitted | Inclusive lower bound on payment time, formatted `YYYY-MM-DD`. Canonical `processed_at` is used when present, otherwise `created_at`; the boundary is company-local midnight. Missing or invalid company timezone configuration falls back to UTC. |
| `paid_to` | no | string, date | omitted | Inclusive upper calendar date for payment time, formatted `YYYY-MM-DD`. The following company-local midnight is used as an exclusive bound. Missing or invalid company timezone configuration falls back to UTC. |
| `limit` | no | integer | `50` | Maximum Payment rows to return, from 1 through 100. Defaults to 50. |
| `offset` | no | integer | `0` | Zero-based row offset. Defaults to 0. Add `limit` while `pagination.has_more` is true to retrieve later pages. |

### Response

A page of company-owned canonical payment ledger rows and pagination metadata.

| Field | Type / values | Meaning |
|---|---|---|
| `results` | array<object> | Payment ledger rows for this page. |
| `results[].id` | integer \| string | Canonical Albusto payment ledger row ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers. |
| `results[].amount` | string \| number | Signed canonical ledger amount. |
| `results[].status` | string | Canonical payment transaction status. |
| `results[].method` | string \| null | Canonical payment method (`payment_method`), when present. |
| `results[].job_id` | integer \| string \| null | Linked Job ID, when one exists. |
| `results[].invoice_id` | integer \| string \| null | Linked Invoice ID, when one exists. |
| `results[].paid_at` | string, date-time | Canonical processed time, or creation time when not separately processed, in ISO 8601 format. |
| `pagination` | object | Offset pagination metadata for the returned Payment page. |
| `pagination.mode` | string ("offset") | Pagination mode. Payment pages always use `offset`. |
| `pagination.limit` | integer | Applied page size. |
| `pagination.returned` | integer | Number of Payment rows in this page. |
| `pagination.has_more` | boolean | Whether another Payment page exists. |
| `pagination.next_cursor` | string \| null | Always null because Payment pages use offset pagination. |
| `pagination.total` | integer | Total matching Payment rows. |

- Rows come only from the canonical `payment_transactions` ledger. The legacy Zenbooker landing table never contributes a row.

- `paid_at` is canonical `processed_at` when present and otherwise the ledger row creation time.

- `method` is the canonical `payment_method` and can be null only in synthetic or legacy-compatible data.

- Callers with `payments.view` may list the company ledger; callers with only `financial_data.view` must provide a Job assigned to them.

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

**List payments recorded today for one Job**

```js
export async function run(ctx) {
    return ctx.callTool('svc.list_payments', {
        job_id: Number(ctx.input.job_id),
        paid_from: ctx.input.today,
        paid_to: ctx.input.today,
        offset: 0,
        limit: 100,
    });
}
```
